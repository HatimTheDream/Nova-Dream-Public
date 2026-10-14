/** Read-only maintained frontend plan transport. Exact source is embedded as data;
 * no caller-supplied program, root staging or effect launch is accepted. */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { releaseTransportSchema, runInstallTransport } from './release-adapters.mjs';

const need=(v,reason)=>{if(!v)throw Error(reason);};
const hash=z.string().regex(/^[a-f0-9]{64}$/),reference=z.object({path:z.string().min(1).max(4096),sha256:hash}).strict();
const version=z.string().regex(/^\d+\.\d+\.\d+$/);
export const frontendWorkerInstallationSchema=z.object({version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),candidateId:hash}).strict();
const planFields={operationId:z.uuid(),baseVersion:version,baseCandidateId:hash,serviceInputsSha256:hash,
  frontendId:hash,sourceRevision:z.string().regex(/^[a-f0-9]{40}$/),version,buildVersion:version,worker:reference,config:reference,operation:reference,
  assets:z.object({manifest:reference,signature:reference,archive:reference}).strict(),processIdentity:z.uuid(),workspaceEpoch:z.uuid()};
export const frontendPlanInputSchema=z.discriminatedUnion('format',[
  z.object({format:z.literal(1),...planFields}).strict(),
  z.object({format:z.literal(2),...planFields,workerInstallation:frontendWorkerInstallationSchema}).strict(),
]);
export function verifyFrontendWorkerInstallation(value) {
  need(value.format===1||value.format===2,'frontend-worker-identity-format');
  need(value.format!==1||!Object.hasOwn(value,'workerInstallation'),'frontend-worker-legacy-identity-changed');
  const installed=frontendWorkerInstallationSchema.parse(value.format===2?value.workerInstallation:{version:value.baseVersion,candidateId:value.baseCandidateId});
  need(value.worker.path===`/opt/nova-updater-${installed.version}-${installed.candidateId.slice(0,12)}/deploy/update-runner/frontend.py`
    &&value.worker.sha256==='73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171','frontend-installed-path-changed');
}
const source=()=>readFileSync(new URL('release-frontend-plan.py',import.meta.url));
export const frontendPlanImplementationIdentity=()=>sha256(source());
export function frontendPlanArguments(raw,mode,{plan,intent}={}) {
  const value=frontendPlanInputSchema.parse(raw),root=`/var/lib/nova-update/frontend/operator-inputs/${value.operationId}`;
  need(['plan','execute','resume'].includes(mode),'frontend-worker-mode-invalid');
  verifyFrontendWorkerInstallation(value);
  need(value.operation.path===`${root}/operation.json` && value.config.path==='/etc/nova-update/frontend.json','frontend-installed-path-changed');
  const args=['/usr/bin/python3','-B',value.worker.path,`--${mode}`,value.operation.path,'--config',value.config.path];
  if(mode==='execute') {
    need(reference.safeParse(plan).success&&reference.safeParse(intent).success&&plan.path===`${root}/plan.json`&&intent.path===`${root}/intent.json`,'frontend-exact-plan-and-intent-required');
    args.push('--plan-receipt',plan.path,'--intent',intent.path);
  } else need(plan===undefined&&intent===undefined,'frontend-observation-uses-original-inputs');
  return args;
}
export function buildFrontendPlanProgram(raw) {
  const input=frontendPlanInputSchema.parse(raw);frontendPlanArguments(input,'plan');
  const helper=source(),payload=Buffer.from(JSON.stringify({input,helper:helper.toString('base64'),sha256:sha256(helper)})).toString('base64');
  return `import base64,hashlib,json\nv=json.loads(base64.b64decode('${payload}',validate=True))\ns=base64.b64decode(v['helper'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\nn={'__name__':'nova_frontend_plan'}\nexec(compile(s,'verified-frontend-plan','exec'),n)\nprint(json.dumps(n['plan'](v['input']),separators=(',',':')))\n`;
}
export function verifyFrontendPlanResult(value,input) {
  frontendPlanInputSchema.parse(input);verifyFrontendWorkerInstallation(input);
  need(value?.format===1&&value.kind==='nova-maintained-frontend-plan'&&value.operationId===input.operationId
    &&value.workerSha256===input.worker.sha256&&value.readOnly===true&&value.capacityQualified===false&&value.effectDispatchQualified===false,'frontend-plan-producer-changed');
  need(typeof value.planRawBase64==='string'&&value.planRawBase64.length<=180000,'frontend-plan-raw-bound');
  const bytes=Buffer.from(value.planRawBase64,'base64');need(bytes.toString('base64')===value.planRawBase64&&sha256(bytes)===value.planSha256&&isDeepStrictEqual(JSON.parse(bytes),value.plan),'frontend-plan-raw-changed');
  const p=value.plan;
  need(p.format===1&&p.operationId===input.operationId&&p.operationSha256===input.operation.sha256&&p.configSha256===input.config.sha256
    &&p.manifestSha256===input.assets.manifest.sha256&&p.signatureSha256===input.assets.signature.sha256&&p.archiveSha256===input.assets.archive.sha256&&p.frontendId===input.frontendId,'frontend-plan-binding-changed');
  for(const name of ['live','health'])need(p[name]?.candidateId===input.baseCandidateId&&p[name].serviceInputsSha256===input.serviceInputsSha256&&p[name].epoch===input.workspaceEpoch,'frontend-plan-service-changed');
  need(p.health.processIdentity===input.processIdentity&&p.live.active===false&&isDeepStrictEqual(p.priorRecovery?.base,{candidateId:input.baseCandidateId,serviceInputsSha256:input.serviceInputsSha256,apiVersion:p.health.apiVersion,schemaVersion:p.health.schemaVersion}),'frontend-plan-process-or-recovery-changed');
  return bytes;
}
export async function requestFrontendPlan({transport,input},{run=runInstallTransport}={}) {
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});
  const response=await run(target,buildFrontendPlanProgram(input));
  if(response.uncertain||response.exitCode!==0)return {state:'uncertain',reason:'frontend-plan-response-unavailable',externalId:input.operationId,receipt:null,output:null};
  let value;try{value=JSON.parse(response.stdout);}catch{return {state:'uncertain',reason:'frontend-plan-response-unavailable',externalId:input.operationId,receipt:null,output:null};}
  verifyFrontendPlanResult(value,input);return {state:'completed',reason:'frontend-maintained-readonly-plan-produced',externalId:input.operationId,receipt:null,output:value};
}

/** The missing capacity/staging producer must supply its completed output.
 * This adapter cannot ingest a hand-authored plan as a substitute for a host call. */
export function createFrontendRecoveryPlanAdapter({transport,storeReceipt,run=runInstallTransport}) {
  const expected=({descriptor,prior})=>{
    const c=prior.capacity;
    need(prior.route?.route==='frontend'&&c?.kind==='nova-delivery-frontend-capacity'&&c.capacityQualified===true
      &&c.operationId===descriptor.operation.id&&c.frontendStage?.kind==='nova-protected-frontend-stage','frontend-capacity-and-stage-producer-required');
    const input=frontendPlanInputSchema.parse(c.frontendStage.planInput);
    need(input.operationId===descriptor.operation.id&&input.baseCandidateId===descriptor.operation.priorCandidateId
      &&input.sourceRevision===descriptor.sources.private.commit&&input.version===descriptor.operation.version&&input.buildVersion===descriptor.operation.buildVersion
      &&input.frontendId===prior.sign?.frontendId&&input.serviceInputsSha256===prior.route.serviceInputsSha256
      &&input.assets.manifest.sha256===prior.sign.manifest.sha256&&input.assets.signature.sha256===prior.sign.signature.sha256&&input.assets.archive.sha256===prior.sign.archive.sha256,'frontend-staged-delivery-input-changed');
    return {transport,input,capacityOutputSha256:sha256(JSON.stringify(c)),implementationSha256:frontendPlanImplementationIdentity()};
  };
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'frontend-plan-delivery-input-changed');
  const observe=async context=>{
    const value=await requestFrontendPlan(context.intent.input,{run});
    if(value.state!=='completed')return value;
    const bytes=Buffer.from(value.output.planRawBase64,'base64');
    const workerPlan=storeReceipt(context.journal,context.intent.key,'frontend-worker-plan.json',bytes);
    const output={...value.output,key:context.intent.key,inputSha256:context.intent.inputSha256,workerPlan};
    const receipt=storeReceipt(context.journal,context.intent.key,'frontend-recovery-plan.json',Buffer.from(JSON.stringify(output)+'\n'));
    return {...value,output,receipt};
  };
  return {input:async context=>expected(context),validate,execute:observe,observe,verify:async(value,context)=>{
    if(value.externalId)need(value.externalId===context.descriptor.operation.id,'frontend-plan-operation-changed');
    if(value.state!=='completed')return;
    need(value.output?.key===context.intent.key&&value.output.inputSha256===context.intent.inputSha256&&isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output),'frontend-plan-receipt-changed');
    const raw=verifyFrontendPlanResult(value.output,context.intent.input.input);
    need(readEvidenceFile(value.output.workerPlan).equals(raw),'frontend-original-worker-plan-changed');
  }};
}

export const frontendPromotionIntegrationGaps=Object.freeze([
  'frontend-protected-staging-producer-not-integrated','frontend-capacity-producer-not-integrated',
  'frontend-finite-worker-dispatch-and-original-observation-not-integrated',
]);
