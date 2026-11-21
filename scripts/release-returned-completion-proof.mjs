/** Re-read the original protected rehearsal after its native return. */
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {sha256} from './release-plan.mjs';
import {verifyFullCompletion} from './release-delivery-full-host.mjs';

const requireValue = (v, message) => { if (!v) throw new Error(message); };
const limits = {};
for (const attempt of [1, 2, 3]) {
  const roles = ['capacity', 'capture-before', 'fork-observed', 'process', 'ready', 'started'];
  if (attempt < 3) roles.push('capture-closed', 'capture-writer', 'closed');
  for (const role of roles) limits[`startup-${attempt}-${role}.json`] =
    role === 'capture-before' || role === 'capture-closed' ? 131072 : 65536;
}
export const returnedRosterSchema = z.object(Object.fromEntries(Object.entries(limits).map(([name, max]) =>
  [name, z.object({bytes:z.number().int().positive().max(max), sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()])))
  .strict().refine(rows => Object.values(rows).reduce((n, row) => n + row.bytes, 0) <= 1024*1024,
                  'returned-startup-roster-too-large');

function program(values, roster) {
  const stock = readFileSync(new URL('full-host-primitives/collect-completion-template.py', import.meta.url));
  requireValue(sha256(stock) === '9e583a657a64e8defa79bd9f766dafab6d03ce995e66e0de5e61a1c338c6ff75', 'original-completion-template-changed');
  const originalLoop = [
    ' related={}',
    " for path in sorted(output.glob('startup-*.json')):",
    "  need(len(related)<32,'Bounded startup metadata required.');protected(path,private=True);need(path.stat().st_size<=65536,'Bounded startup receipt required.');related[path.name]=sha(path)",
  ].join('\n');
  const original = stock.toString('utf8');
  requireValue(original.split(originalLoop).length === 2, 'original-completion-loop-changed');
  const companion = readFileSync(new URL('full-host-primitives/collect-returned-completion.py', import.meta.url), 'utf8');
  // The planning response reports the bounded original lengths and hashes. Only the
  // independently pinned read emits the ordinary completion's original hash-map shape.
  const updated = original.replace(originalLoop, [
    ' rows=returned_roster(output,V,detail,EXPECTED_ROSTER)',
    " related=rows if EXPECTED_ROSTER is None else {name:row['sha256'] for name,row in rows.items()}",
  ].join('\n'));
  const source = Buffer.from(companion+'\n'+updated);
  const packet = Buffer.from(JSON.stringify({values, roster, source:source.toString('base64'), sha256:sha256(source)})).toString('base64');
  return `import base64,hashlib,json,signal,sys\np=json.loads(base64.b64decode('${packet}',validate=True))\ns=base64.b64decode(p['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==p['sha256']\nsignal.alarm(110)\ntry:\n exec(compile(s,'fixed-returned-rehearsal','exec'),{'__name__':'__main__','V':p['values'],'EXPECTED_ROSTER':p['roster']})\nexcept Exception as e:\n print(json.dumps({'state':'uncertain','reason':'returned-completion-unavailable','privateDiagnostic':{'type':type(e).__name__,'message':str(e)[:2000]}}));sys.exit(2)\n`;
}
export const buildReturnedCompletionPlanProgram = values => program(values, null);
export const buildReturnedCompletionProgram = (values, roster) => program(values, returnedRosterSchema.parse(roster));

export function verifyReturnedCompletion(value, values, roster) {
  const raw = verifyFullCompletion(value, values);
  const rows = returnedRosterSchema.parse(roster);
  requireValue(isDeepStrictEqual(value.relatedStartupReceiptHashes,
    Object.fromEntries(Object.entries(rows).map(([name,row])=>[name,row.sha256]))), 'returned-startup-receipt-hash-changed');
  const budgets = JSON.parse(raw.detailRaw).startupCapacityBudgets;
  const actual = [1,2,3].map(attempt=>({attempt,receiptSha256:rows[`startup-${attempt}-capacity.json`].sha256}));
  requireValue(isDeepStrictEqual(value.actualStartupCapacityReceiptRefs, actual) && Array.isArray(budgets)
    && isDeepStrictEqual(budgets.map(({attempt,receiptSha256})=>({attempt,receiptSha256})), actual),
    'returned-startup-capacity-commitment-changed');
  return raw;
}
