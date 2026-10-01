#!/usr/bin/env node
/**
 * test-verifier.mjs
 *
 * Reproduction test for the 1.15.5 sessionBindings incident.
 *
 * Builds a fixture workspace (SQLite + AES-256-GCM sealed records, same format
 * as the application store), a STALE config (simulating the pre-restart
 * on-disk config), and the REGENERATED config (what the candidate writes at
 * startup). Then proves:
 *
 *   1. The OLD check (snapshot equality: stale == regenerated) REJECTS the
 *      correct regenerated config  -> this is the false rejection from the
 *      incident. Reproduced.
 *   2. The NEW check (verify-session-bindings.mjs) ACCEPTS the regenerated
 *      config -> the fix works.
 *   3. The NEW check still REJECTS the stale config (it is genuinely
 *      fail-open: a required binding is missing).
 *   4. Adversarial mutations are all REJECTED by the NEW check:
 *      removed binding (fail-open), fabricated binding, binding referencing
 *      a deleted conversation, reordered bindings, malformed binding.
 *
 * Runs entirely on fixtures. Touches nothing live.
 * Exit 0: all expectations hold. Exit 1: any expectation violated.
 */

import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIER = join(HERE, '..', 'deploy', 'update-runner', 'verify-session-bindings.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'nova-bindings-test-'));

const KEY = randomBytes(32);
const PREFIX = 'assistant:conversation:';

function seal(key, aad, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function buildFixture() {
  rmSync(WORK, { recursive: true, force: true });
  const storeDir = join(WORK, 'store');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(WORK, 'test.key'), KEY);

  const uuidA = randomUUID(), uuidB = randomUUID(), uuidD = randomUUID();
  const db = new DatabaseSync(join(storeDir, 'workspace.sqlite'));
  db.exec(`CREATE TABLE service_records (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL)`);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  // key-check uses AAD 'key-check' (mirrors the application); epoch is plain text.
  db.prepare(`INSERT INTO meta VALUES (?,?)`).run(
    'key-check', seal(KEY, 'key-check', 'edition3').toString('base64'));
  db.prepare(`INSERT INTO meta VALUES (?,?)`).run('epoch', randomUUID());
  const ins = db.prepare(`INSERT INTO service_records VALUES (?,?,?)`);
  const convs = [
    // id order determines producer order (ORDER BY id)
    [`${PREFIX}conv-a`, { nativeKey: 'key-a', nativeId: uuidA }],
    [`${PREFIX}conv-b`, { nativeKey: 'key-b', nativeId: uuidB }],
    [`${PREFIX}conv-c`, { nativeKey: 'key-c' }],                       // no nativeId -> excluded
    [`${PREFIX}conv-d`, { nativeKey: 'key-d', nativeId: uuidD, deleted: true }], // tombstone -> excluded
  ];
  for (const [id, value] of convs) {
    ins.run(id, 1, seal(KEY, `service:${id}`, value));
  }
  db.close();

  const expected = [
    { nativeKey: 'key-a', nativeId: uuidA },
    { nativeKey: 'key-b', nativeId: uuidB },
  ];

  const staleConfig = {
    plugins: { entries: { 'edition3-workspace': { config: { sessionBindings: [expected[0]] } } } },
  };
  const regeneratedConfig = {
    plugins: { entries: { 'edition3-workspace': { config: { sessionBindings: expected } } } },
  };
  writeFileSync(join(WORK, 'stale.json'), JSON.stringify(staleConfig));
  writeFileSync(join(WORK, 'regenerated.json'), JSON.stringify(regeneratedConfig));
  writeFileSync(join(WORK, 'wrong.key'), randomBytes(32));
  return { storeDir, expected, uuidD };
}

/** Build a fixture store from an explicit list of [id, value] records. */
function buildCustomFixture(name, records) {
  const dir = join(WORK, `store-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'workspace.sqlite'));
  db.exec(`CREATE TABLE service_records (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL)`);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare(`INSERT INTO meta VALUES (?,?)`).run(
    'key-check', seal(KEY, 'key-check', 'edition3').toString('base64'));
  db.prepare(`INSERT INTO meta VALUES (?,?)`).run('epoch', randomUUID());
  const ins = db.prepare(`INSERT INTO service_records VALUES (?,?,?)`);
  for (const [id, value] of records) {
    ins.run(id, 1, seal(KEY, `service:${id}`, value));
  }
  db.close();
  return dir;
}

function writeConfig(name, sessionBindings) {
  const p = join(WORK, `${name}.json`);
  writeFileSync(p, JSON.stringify({
    plugins: { entries: { 'edition3-workspace': { config: { sessionBindings } } } },
  }));
  return p;
}

function runVerifier(configPath, storeDir, opts = {}) {
  const keyArg = opts.keyStdin ? '-' : join(WORK, 'test.key');
  const keyInput = opts.keyStdin ? opts.keyStdin : undefined; // Buffer to pipe, or undefined
  const wrongKey = opts.wrongKey;
  try {
    const out = execFileSync(
      process.execPath,
      [VERIFIER, '--store', storeDir, '--config', configPath, '--key',
       wrongKey ? join(WORK, 'wrong.key') : keyArg],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: keyInput }
    );
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

/** The OLD check from the incident: exact equality with the stale snapshot. */
function oldCheck(snapshotConfigPath, candidateConfigPath) {
  const a = JSON.parse(readFileSync(snapshotConfigPath, 'utf8'));
  const b = JSON.parse(readFileSync(candidateConfigPath, 'utf8'));
  const sa = a.plugins.entries['edition3-workspace'].config.sessionBindings;
  const sb = b.plugins.entries['edition3-workspace'].config.sessionBindings;
  return JSON.stringify(sa) === JSON.stringify(sb);
}

const results = [];
function expect(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function main() {
  const { storeDir, expected, uuidD } = buildFixture();
  const stale = join(WORK, 'stale.json');
  const regenerated = join(WORK, 'regenerated.json');

  // 1. Reproduce the incident: the OLD check rejects the CORRECT config.
  const oldResult = oldCheck(stale, regenerated);
  expect(
    'incident reproduced: snapshot-equality rejects the correct regenerated config',
    oldResult === false,
    'stale(1 binding) vs regenerated(2 bindings)'
  );

  // 2. The NEW check accepts the regenerated config.
  const r2 = runVerifier(regenerated, storeDir);
  expect('new check ACCEPTS the regenerated config', r2.code === 0, r2.stderr.trim().split('\n').pop());

  // 3. The NEW check rejects the stale config (genuinely fail-open).
  const r3 = runVerifier(stale, storeDir);
  const r3report = JSON.parse(r3.stdout);
  expect(
    'new check REJECTS the stale config',
    r3.code === 2 && (r3report.diagnostics.missingFromConfig?.length ?? 0) === 1,
    '1 required binding missing'
  );

  // 4. Adversarial cases, all must be rejected (exit 2).
  const mutate = (name, fn, checkDetail) => {
    const cfg = JSON.parse(readFileSync(regenerated, 'utf8'));
    const bindings = cfg.plugins.entries['edition3-workspace'].config.sessionBindings;
    fn(bindings);
    const p = join(WORK, `adv-${name}.json`);
    writeFileSync(p, JSON.stringify(cfg));
    const r = runVerifier(p, storeDir);
    const report = r.stdout ? JSON.parse(r.stdout) : {};
    expect(`adversarial '${name}' REJECTED`, r.code === 2, checkDetail(report));
  };

  mutate('removed-binding', (b) => b.pop(), (rep) =>
    `${rep.diagnostics.missingFromConfig?.length ?? 0} missing (fail-open flagged: ${rep.diagnostics.missingFromConfig?.[0]?.risk?.startsWith('FAIL-OPEN')})`);
  mutate('fabricated-binding', (b) => b.push({ nativeKey: 'ghost', nativeId: randomUUID() }), (rep) =>
    `${rep.diagnostics.extraInConfig?.length ?? 0} unjustified`);
  mutate('deleted-conversation', (b) => b.push({ nativeKey: 'key-d', nativeId: uuidD }), (rep) => {
    const x = rep.diagnostics.extraInConfig?.[0];
    return `extra references deleted record: ${x?.explainedBy?.deleted === true}`;
  });
  mutate('reordered', (b) => b.reverse(), (rep) =>
    `order mismatch flagged: ${!!rep.diagnostics.orderMismatch}`);
  mutate('malformed-uuid', (b) => { b[0].nativeId = 'not-a-uuid'; }, (rep) =>
    `${rep.diagnostics.malformedBindings?.length ?? 0} malformed`);
  mutate('swapped-identities', (b) => { const t = b[0].nativeId; b[0].nativeId = b[1].nativeId; b[1].nativeId = t; }, (rep) =>
    `rejected as ${(rep.diagnostics.missingFromConfig?.length ?? 0)} missing + ${(rep.diagnostics.extraInConfig?.length ?? 0)} extra`);

  // 5. Config without the field at all, while the store requires bindings -> reject.
  const noField = { plugins: { entries: { 'edition3-workspace': { config: {} } } } };
  const noFieldPath = join(WORK, 'adv-nofield.json');
  writeFileSync(noFieldPath, JSON.stringify(noField));
  const r5 = runVerifier(noFieldPath, storeDir);
  expect('absent field with required bindings REJECTED', r5.code === 2, 'fail-open, not silently optional');

  // 6. Pipe-collision regression: two records whose (nativeKey, nativeId) pairs
  // would compare equal under delimiter-joining ("p|q|not-a-uuid" for both)
  // must NOT be conflated. Derived shape validation fails closed first.
  const collidingDir = buildCustomFixture('collide', [
    [`${PREFIX}conv-x`, { nativeKey: 'p|q', nativeId: 'not-a-uuid' }],
    [`${PREFIX}conv-y`, { nativeKey: 'p', nativeId: 'q|not-a-uuid' }],
  ]);
  const collidingCfg = writeConfig('adv-collide', [
    { nativeKey: 'p|q', nativeId: 'not-a-uuid' },
  ]);
  const r6 = runVerifier(collidingCfg, collidingDir);
  const r6report = r6.stdout ? JSON.parse(r6.stdout) : {};
  expect(
    "pipe-collision records FAIL CLOSED (no conflation)",
    r6.code === 2 && (r6report.diagnostics.malformedDerivedBindings?.length ?? 0) === 2,
    '2 malformed derived bindings, failing closed'
  );

  // 7. Key via stdin: pipe the raw key, no key file on disk.
  const r7 = runVerifier(regenerated, storeDir, { keyStdin: KEY });
  expect('stdin key ACCEPTS the regenerated config', r7.code === 0,
    (r7.stderr.trim().split('\n').pop() || ''));

  // 8. Wrong key: must fail at key-check authentication (exit 1), not as a
  // confusing per-record decryption error.
  const r8 = runVerifier(regenerated, storeDir, { wrongKey: true });
  const r8report = r8.stdout ? JSON.parse(r8.stdout) : {};
  expect(
    'wrong key FAILS at key-check authentication',
    r8.code === 1 && /key-check mismatch|did not verify/.test(r8report.diagnostics.error || ''),
    'clear auth failure, not a decrypt error'
  );

  // 9. Disposable copy: store dir made read-only; verifier must still work
  // because it copies to a temp dir instead of opening in place.
  const roDir = buildCustomFixture('readonly', [
    [`${PREFIX}conv-a`, { nativeKey: 'key-a', nativeId: expected[0].nativeId }],
  ]);
  const roCfg = writeConfig('ro', [{ nativeKey: 'key-a', nativeId: expected[0].nativeId }]);
  chmodSync(join(roDir, 'workspace.sqlite'), 0o444);
  const r9 = runVerifier(roCfg, roDir);
  chmodSync(join(roDir, 'workspace.sqlite'), 0o644);
  expect('read-only store dir still verifies (disposable copy)', r9.code === 0,
    'original never opened for writing');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} expectations hold.`);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main();
