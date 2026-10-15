/** Bounded, in-memory reuse within one read-only verification call tree.
 * No receipt, stat shortcut or caller flag establishes a pass. Effects suspend
 * reuse throughout nested calls; each outer invocation starts with an empty map.
 */
const slot = Symbol('release-verification-pass');
const known = new WeakSet();
const MAX_ENTRIES = 32, MAX_BINDING = 2 * 1024 ** 2, MAX_MS = 30000;
const active = context => {
  const pass = context?.[slot];
  return pass && known.has(pass) && pass.open ? pass : null;
};
const clear = pass => { pass.entries.clear(); pass.started = performance.now(); };

export async function withVerificationPass(context, action, { readOnly = false } = {}) {
  const inherited = active(context);
  // An explicitly read-only inspection inside an effect receives its own
  // fresh scope, which closes before the surrounding effect continues.
  if (inherited && (!inherited.suspended || !readOnly)) return action(context);
  const pass = { open: true, suspended: 0, started: performance.now(), entries: new Map() };
  known.add(pass);
  const scoped = { ...context, [slot]: pass };
  try { return await action(scoped); }
  finally { clear(pass); pass.open = false; }
}

/** Only synchronous, pure byte-verification functions may be reused. The
 * namespace is a factory-local object; binding contains every mutable input
 * used by that function. Failure never creates an entry. */
export function verificationOnce(context, namespace, binding, verify) {
  const pass = active(context);
  if (!pass || pass.suspended || performance.now() - pass.started >= MAX_MS) return verify();
  if ((typeof namespace !== 'object' || namespace === null) && typeof namespace !== 'function') throw Error('verification-namespace-required');
  const encoded = JSON.stringify(binding);
  if (typeof encoded !== 'string' || encoded.length > MAX_BINDING) throw Error('verification-binding-unbounded');
  const prior = pass.entries.get(namespace);
  if (prior?.binding === encoded) return prior.value;
  const value = verify();
  if (value && typeof value.then === 'function') throw Error('verification-must-be-synchronous');
  if (pass.entries.size < MAX_ENTRIES || pass.entries.has(namespace)) pass.entries.set(namespace, { binding: encoded, value });
  return value;
}

/** Includes writes to local receipts/journals and observe methods that may
 * reconcile receipts. Suspends nested reuse both before and after the action,
 * including errors/lost responses. No old entry crosses this boundary. */
export async function verificationEffect(context, action) {
  return withVerificationPass(context, async scoped => {
    const pass = active(scoped);
    clear(pass); pass.suspended++;
    try { return await action(scoped); }
    finally { clear(pass); pass.suspended--; }
  });
}
