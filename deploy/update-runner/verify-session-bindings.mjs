#!/usr/bin/env node
/**
 * verify-session-bindings.mjs
 *
 * Verifies the derived config field
 *   plugins.entries['edition3-workspace'].config.sessionBindings
 * against its source of truth: the workspace store.
 *
 * WHY THIS EXISTS
 * ---------------
 * The application regenerates sessionBindings at every startup from
 *   store.internalList('assistant:conversation:')  (ORDER BY id)
 * filtered by (nativeId && !deleted), projected to {nativeKey, nativeId}.
 * The on-disk openclaw.json is therefore a build artifact that is legitimately
 * stale between restarts. Comparing it for exact equality with a pre-restart
 * snapshot produces false rejections (the 1.15.5 "18 vs 19" incident).
 *
 * The correct invariant is derivation-correctness:
 *   config.sessionBindings == derive(current store), exactly (order and set),
 * with per-binding provenance back to a real, non-deleted conversation record.
 *
 * This script re-derives the expected list with the SAME query the producer
 * uses (substr/ORDER BY id) and the SAME decryption (AES-256-GCM,
 * AAD = `service:${id}`), so it cannot drift from the application logic the
 * way a reimplementation in another language could.
 *
 * SECURITY NOTE
 * -------------
 * sessionBindings gates the `nova-plan-read-only` trusted pre-tool policy:
 * sessions missing from the set skip enforcement (fail-open). This check is
 * therefore strict in the correct direction:
 *   - a binding missing from the config that the store requires  -> FAIL
 *     (fail-open: policy would not be enforced for that session)
 *   - a binding present that no live record justifies            -> FAIL
 *     (fabricated, or references a deleted conversation)
 *   - wrong order                                                -> FAIL
 *     (the producer order is deterministic; anything else is tampering
 *      or a different producer)
 *   - a derived binding that fails shape validation              -> FAIL
 *     (fail-closed: the store contains a malformed record; the expected
 *      value cannot be trusted)
 *
 * COMPARISON
 * ----------
 * Bindings are compared as JSON tuples [nativeKey, nativeId], never as
 * delimiter-joined strings: a `|` inside a nativeKey could otherwise make two
 * different pairs compare equal.
 *
 * USAGE
 * -----
 *   node verify-session-bindings.mjs \
 *     --store <workspace dir containing workspace.sqlite> \
 *     --config <openclaw.json written by the candidate> \
 *     --key <keyfile | ->
 *
 * --key - reads the raw 32-byte workspace key from stdin (preferred: pipe it
 * from the existing protected unwrapping flow; this script never writes key
 * material to disk). A keyfile holding exactly 32 raw bytes is also accepted.
 *
 * The store directory should be QUIESCENT (service stopped, WAL checkpointed)
 * and correspond to the state the candidate started from. In the deployment
 * procedure that is the pre-start snapshot copy: no writers exist between the
 * snapshot and the candidate start, so snapshot store == startup store.
 *
 * SQLITE SAFETY
 * -------------
 * The script copies workspace.sqlite (+wal/+shm when present) to a disposable
 * temp dir and opens the COPY. Direct read-only access can modify retained
 * SHM files, so the live/snapshot originals are never opened in place.
 *
 * KEY AUTHENTICATION
 * ------------------
 * Before deriving, the script authenticates the key against the store's
 * key-check record (same check the application performs at startup). A wrong
 * key fails here, not as a confusing decryption error later. The epoch is
 * reported in the diagnostics for the operator's epoch checks.
 *
 * The workspace key is used in memory only, never logged or written.
 *
 * EXIT CODES
 *   0  PASS: bindings exactly equal the derived projection, provenance holds.
 *   2  FAIL: verification failed; JSON diagnostics on stdout, summary on stderr.
 *   1  Operational error (bad args, unreadable files, corrupt DB, bad key).
 */

import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv } from 'node:crypto';
import { readFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'assistant:conversation:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage() {
  return `usage: node verify-session-bindings.mjs --store <dir> --config <openclaw.json> --key <keyfile|->`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || !k.startsWith('--') || v === undefined) throw new Error(usage());
    out[k.slice(2)] = v;
  }
  for (const req of ['store', 'config', 'key']) {
    if (!out[req]) throw new Error(`missing --${req}\n${usage()}`);
  }
  return out;
}

function readKeyStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

/** Mirror of Store#open in the application: AES-256-GCM, iv(12)||tag(16)||ct. */
function openWithAad(key, aad, payload) {
  const bytes = Buffer.from(payload);
  if (bytes.length < 28) throw new Error(`payload too short (${bytes.length} bytes)`);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** Service records use AAD `service:${id}`. */
function openRecord(key, id, payload) {
  try {
    return openWithAad(key, `service:${id}`, payload);
  } catch (e) {
    throw new Error(`record ${id}: ${e.message}`);
  }
}

/**
 * Mirror of the producer in runtime.js:
 *   this.store.internalList('assistant:conversation:')
 *     .flatMap(c => c.nativeId && !c.deleted ? [{nativeKey, nativeId}] : [])
 * internalList = SELECT ... WHERE substr(id,1,?)=? ORDER BY id.
 */
function deriveBindings(db, key) {
  const rows = db
    .prepare(`SELECT id, revision, payload FROM service_records WHERE substr(id,1,?) = ? ORDER BY id`)
    .all(PREFIX.length, PREFIX);
  const bindings = [];
  const provenance = new Map(); // JSON tuple -> record id
  const seenRecords = [];
  for (const row of rows) {
    let conv;
    try {
      conv = openRecord(key, row.id, row.payload);
    } catch (e) {
      return { error: `decrypt failed for ${row.id} (revision ${row.revision}): ${e.message}` };
    }
    seenRecords.push({ id: row.id, revision: row.revision, nativeId: conv.nativeId ?? null, deleted: !!conv.deleted });
    if (conv.nativeId && !conv.deleted) {
      const b = { nativeKey: conv.nativeKey, nativeId: conv.nativeId };
      bindings.push(b);
      provenance.set(tupleKey(b), row.id);
    }
  }
  return { bindings, provenance, seenRecords };
}

/** Unambiguous binding identity: JSON tuple, never delimiter-joined. */
function tupleKey(b) {
  return JSON.stringify([b.nativeKey, b.nativeId]);
}

function validBindingShape(b) {
  return (
    b && typeof b === 'object' &&
    typeof b.nativeKey === 'string' && b.nativeKey.length >= 1 && b.nativeKey.length <= 300 &&
    typeof b.nativeId === 'string' && UUID_RE.test(b.nativeId) &&
    Object.keys(b).length === 2
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const report = { check: 'sessionBindings-derivation', pass: false, diagnostics: {} };
  const fail = (code, summary) => {
    console.log(JSON.stringify(report, null, 2));
    console.error(summary);
    process.exit(code);
  };

  // ---- Load key (file or stdin). Never written to disk. ----
  let key;
  try {
    const raw = args.key === '-' ? await readKeyStdin() : readFileSync(args.key);
    key = raw.length === 32 ? raw : null;
    if (!key) {
      const parsed = JSON.parse(raw.toString('utf8'));
      const b64 = parsed.key ?? parsed.workspaceKey ?? parsed;
      key = Buffer.from(typeof b64 === 'string' ? b64 : JSON.stringify(b64), 'base64');
    }
    if (key.length !== 32) throw new Error(`expected 32 bytes, got ${key.length}`);
  } catch (e) {
    report.diagnostics.error = `cannot load workspace key: ${e.message}`;
    fail(1, `FAIL: ${report.diagnostics.error}`);
  }

  // ---- Disposable SQLite copy. Never open the original in place. ----
  const scratch = join(tmpdir(), `verify-bindings-${process.pid}`);
  let db;
  try {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const storeDir = args.store.replace(/\/$/, '');
    for (const f of ['workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm']) {
      const src = join(storeDir, f);
      if (existsSync(src)) copyFileSync(src, join(scratch, f));
    }
    db = new DatabaseSync(join(scratch, 'workspace.sqlite'), { readOnly: true });
  } catch (e) {
    report.diagnostics.error = `cannot prepare disposable store copy: ${e.message}`;
    rmSync(scratch, { recursive: true, force: true });
    fail(1, `FAIL: ${report.diagnostics.error}`);
  }

  let derived;
  try {
    // ---- Authenticate the key the same way the application does. ----
    const check = db.prepare(`SELECT value FROM meta WHERE key='key-check'`).get();
    if (!check) throw new Error('store has no key-check record');
    let probe;
    try {
      // The application seals key-check with AAD 'key-check' (not 'service:key-check').
      probe = openWithAad(key, 'key-check', Buffer.from(check.value, 'base64'));
    } catch {
      throw new Error('workspace key did not verify (key-check mismatch)');
    }
    if (probe !== 'edition3') throw new Error('workspace key did not verify (key-check mismatch)');

    const epoch = db.prepare(`SELECT value FROM meta WHERE key='epoch'`).get();
    report.diagnostics.epoch = epoch ? epoch.value : null;

    derived = deriveBindings(db, key);
  } catch (e) {
    report.diagnostics.error = e.message;
    db.close();
    rmSync(scratch, { recursive: true, force: true });
    key.fill(0);
    fail(1, `FAIL: ${report.diagnostics.error}`);
  }
  db.close();
  rmSync(scratch, { recursive: true, force: true });
  // Best effort: drop key material from memory.
  key.fill(0);

  if (derived.error) {
    report.diagnostics.error = derived.error;
    fail(2, `FAIL: ${derived.error}`);
  }

  // ---- Derived bindings must themselves be well-formed. Fail closed. ----
  const malformedDerived = derived.bindings.filter((b) => !validBindingShape(b));
  if (malformedDerived.length) {
    report.diagnostics.malformedDerivedBindings = malformedDerived.map((b) => ({
      binding: b,
      record: derived.provenance.get(tupleKey(b)) ?? null,
    }));
    report.diagnostics.note =
      'the store contains malformed conversation records; the expected value cannot be trusted, failing closed';
    fail(2, `FAIL: ${malformedDerived.length} derived binding(s) fail shape validation; failing closed`);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(args.config, 'utf8'));
  } catch (e) {
    report.diagnostics.error = `cannot read config: ${e.message}`;
    fail(1, `FAIL: ${report.diagnostics.error}`);
  }

  const actual = config?.plugins?.entries?.['edition3-workspace']?.config?.sessionBindings;
  report.diagnostics.storeConversationRecords = derived.seenRecords.length;
  report.diagnostics.derivedBindingCount = derived.bindings.length;

  if (actual !== undefined && !Array.isArray(actual)) {
    report.diagnostics.error = 'config sessionBindings is present but not an array';
    fail(2, 'FAIL: config sessionBindings is present but not an array');
  }
  const actualList = actual ?? [];
  report.diagnostics.configBindingCount = actualList.length;
  report.diagnostics.configFieldPresent = actual !== undefined;

  // Shape validation first: malformed entries are never acceptable.
  const malformed = actualList.filter((b) => !validBindingShape(b));
  if (malformed.length) {
    report.diagnostics.malformedBindings = malformed;
    fail(2, `FAIL: ${malformed.length} config binding(s) fail shape validation (nativeKey 1-300 chars, nativeId UUID, no extra keys)`);
  }

  const expectedKeys = derived.bindings.map(tupleKey);
  const actualKeys = actualList.map(tupleKey);

  const missing = derived.bindings.filter((b) => !actualKeys.includes(tupleKey(b)));
  const extra = actualList.filter((b) => !expectedKeys.includes(tupleKey(b)));

  // Order check: same multiset but different order.
  const sameSet =
    missing.length === 0 && extra.length === 0 && actualList.length === derived.bindings.length;
  const orderOk = sameSet && actualKeys.every((k, i) => k === expectedKeys[i]);

  if (sameSet && orderOk) {
    report.pass = true;
    report.diagnostics.provenance = 'every binding traces to a live, non-deleted conversation record';
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `PASS: ${actualList.length} bindings exactly equal the derived projection ` +
      `(${derived.seenRecords.length} conversation records scanned, ` +
      `${derived.seenRecords.filter((r) => r.deleted).length} deleted excluded, ` +
      `${derived.seenRecords.filter((r) => !r.nativeId).length} without nativeId excluded).`
    );
    process.exit(0);
  }

  // Diagnostics: classify the difference so the operator knows the direction.
  if (missing.length) {
    // Fail-open direction: these sessions would skip the tool policy.
    report.diagnostics.missingFromConfig = missing.map((b) => ({
      ...b,
      record: derived.provenance.get(tupleKey(b)),
      risk: 'FAIL-OPEN: session would not be covered by the nova-plan-read-only policy',
    }));
  }
  if (extra.length) {
    report.diagnostics.extraInConfig = extra.map((b) => {
      // Does any record (even deleted / without nativeId) explain it?
      const rec = derived.seenRecords.find(
        (r) => r.nativeId === b.nativeId
      );
      return {
        ...b,
        explainedBy: rec
          ? { record: rec.id, deleted: rec.deleted, note: 'references a deleted or unbound conversation' }
          : { record: null, note: 'no conversation record justifies this binding' },
      };
    });
  }
  if (sameSet && !orderOk) {
    report.diagnostics.orderMismatch = {
      expected: expectedKeys,
      actual: actualKeys,
      note: 'same set, different order; the producer order (ORDER BY id) is deterministic, so this indicates tampering or a different producer',
    };
  }

  console.log(JSON.stringify(report, null, 2));
  const parts = [];
  if (missing.length) parts.push(`${missing.length} required binding(s) missing (fail-open)`);
  if (extra.length) parts.push(`${extra.length} unjustified binding(s) present`);
  if (sameSet && !orderOk) parts.push('binding order differs from producer order');
  console.error(`FAIL: ${parts.join('; ')}`);
  process.exit(2);
}

main();
