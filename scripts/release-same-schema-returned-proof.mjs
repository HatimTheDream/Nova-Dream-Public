/** Pinned read-only collection of the returned same-schema 2.28.50 prior. */
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {sha256} from './release-plan.mjs';
import {verifyFullCompletion} from './release-delivery-full-host.mjs';
import {RETAINED_BINDINGS_STARTUP_HELPERS} from './release-delivery-startup-retained.mjs';

const requireValue = (ok, reason) => { if (!ok) throw Error(reason); };
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const row = z.object({bytes:z.number().int().positive().max(65536), sha256:digest}).strict();
const names = [1,2,3].flatMap(n => ['capacity','fork-observed','process','ready','started',...(n<3?['closed']:[])]
  .map(role => `startup-${n}-${role}.json`));
export const returnedRosterSchema = z.object(Object.fromEntries(names.map(name => [name,row]))).strict()
  .refine(roster => Object.values(roster).reduce((total, r) => total+r.bytes, 0) <= 1024*1024,
    'same-schema-returned-roster-too-large');

function program(values, expected) {
  const read = name => readFileSync(new URL('full-host-primitives/'+name,import.meta.url));
  const common = read('collect-returned-completion.py');
  const template = read('collect-completion-template.py');
  requireValue(sha256(common)==='28bb7746980cbf7e2a357dbdb47283d479d18cee379f025f7b2ee2525171e5b3'
    && sha256(template)==='1fd2cc136decd4cf3f3ee9cb7fe85c6d5610583d987d4af6ac65fdffb840a665',
    'original-rehearsal-readers-changed');
  const original = template.toString('utf8');
  const begin = original.indexOf(" if V['stageResult']['helperHashes']==RETAINED_CAPTURE_HELPERS:\n");
  const end = original.indexOf(' budget_refs=',begin);
  requireValue(begin>=0 && end>begin && same(values.stageResult.helperHashes,RETAINED_BINDINGS_STARTUP_HELPERS),
    'same-schema-returned-helper-family-required');
  const strict = " rows=ordinary_return_roster(output,V,detail,EXPECTED_ROSTER)\n"
    +" related=rows if EXPECTED_ROSTER is None else {name:row['sha256'] for name,row in rows.items()}\n";
  const source = Buffer.concat([common,Buffer.from('\n'),read('collect-same-schema-returned-completion.py'),
    Buffer.from('\nRETAINED_CAPTURE_HELPERS = '+JSON.stringify(RETAINED_BINDINGS_STARTUP_HELPERS)+'\n'),
    Buffer.from(original.slice(0,begin)+strict+original.slice(end))]);
  const packet = Buffer.from(JSON.stringify({values,expected,source:source.toString('base64'),sha256:sha256(source)})).toString('base64');
  return `import base64,hashlib,json,signal,sys
p=json.loads(base64.b64decode('${packet}',validate=True))
s=base64.b64decode(p['source'],validate=True)
assert hashlib.sha256(s).hexdigest()==p['sha256']
signal.alarm(110)
try:
 exec(compile(s,'same-schema-returned-rehearsal','exec'),{'__name__':'__main__','V':p['values'],'EXPECTED_ROSTER':p['expected']})
except Exception as e:
 print(json.dumps({'state':'uncertain','reason':'same-schema-returned-completion-unavailable','privateDiagnostic':{'type':type(e).__name__,'message':str(e)[:1200]}}));sys.exit(2)
`;
}

export const buildReturnedCompletionPlanProgram = values => program(values,null);
export const buildReturnedCompletionProgram = (values, roster) => program(values,returnedRosterSchema.parse(roster));

export function verifyReturnedCompletion(value, values, roster) {
  const raw = verifyFullCompletion(value,values);
  const rows = returnedRosterSchema.parse(roster);
  const detail = JSON.parse(raw.detailRaw);
  requireValue(!Object.hasOwn(detail,'nativeCaptureSourceSha256')
    && same(values.stageResult.helperHashes,RETAINED_BINDINGS_STARTUP_HELPERS)
    && same(value.relatedStartupReceiptHashes,Object.fromEntries(Object.entries(rows).map(([key,r])=>[key,r.sha256]))),
    'same-schema-returned-evidence-changed');
  const budgets = [1,2,3].map(attempt => ({attempt,receiptSha256:rows[`startup-${attempt}-capacity.json`].sha256}));
  requireValue(Array.isArray(detail.startupCapacityBudgets)
    && same(detail.startupCapacityBudgets.map(({attempt,receiptSha256})=>({attempt,receiptSha256})),budgets)
    && same(value.actualStartupCapacityReceiptRefs,budgets),'same-schema-returned-capacity-changed');
  return raw;
}
