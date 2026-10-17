/** Signed obsolete-selector readiness, before ordinary frontend staging. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readEvidenceFile, readReleaseInputFile, sha256 } from './release-plan.mjs';
import { releaseTransportSchema, runInstallTransport } from './release-adapters.mjs';
const need=(v,why)=>{if(!v)throw Error(why);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const source=()=>readFileSync(new URL('release-frontend-readiness.py',import.meta.url));
export const frontendReadinessIdentity=()=>sha256(source());
export function frontendReadinessBinding(packet){return Object.fromEntries(['operationId','runId','baseCandidateId','serviceInputsSha256','workspaceEpoch','baseVersion','worker','config'].map(k=>[k,packet[k]]));}
export function buildFrontendReadinessProgram(value){
  need(['readiness-plan','readiness-execute','readiness-observe'].includes(value.mode),'frontend-readiness-mode-invalid');
  const bytes=source(),wire=Buffer.from(JSON.stringify({sourceBase64:bytes.toString('base64'),sourceSha256:sha256(bytes),value})).toString('base64');
  return `import base64,hashlib,json,sys\nv=json.loads(base64.b64decode('${wire}',validate=True))\ns=base64.b64decode(v['sourceBase64'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sourceSha256']\nn={'__name__':'frontend_readiness'}\nexec(compile(s,'fixed-frontend-readiness','exec'),n)\ntry:\n result=n['main'](v['value'],v['sourceSha256']);print(json.dumps(result,separators=(',',':')))\nexcept Exception as e:\n print(json.dumps({'state':'uncertain','reason':'frontend-readiness-original-result-unavailable','privateDiagnostic':{'exceptionType':type(e).__name__[:100],'message':str(e)[:2000]}},separators=(',',':')));sys.exit(2)\n`;
}
export function verifyFrontendReadinessPlan(plan,binding){
  need(plan?.format===1&&plan.readOnly===true&&isDeepStrictEqual(plan.binding,binding),'frontend-readiness-plan-binding-changed');
  need(plan.health?.base?.candidateId===binding.baseCandidateId&&plan.health.base.serviceInputsSha256===binding.serviceInputsSha256&&plan.health.epoch===binding.workspaceEpoch,'frontend-readiness-service-changed');
  if(plan.retirementRequired===false){
    need(plan.kind==='frontend-readiness-plan'&&plan.ready===true&&plan.operationId===binding.operationId&&plan.runId===binding.runId&&plan.sourceSha256===frontendReadinessIdentity()&&plan.health.frontend?.blocked!==true,'frontend-ready-proof-changed');
  }else{
    need(plan.retirementRequired===true&&plan.kind==='frontend-retirement-plan'&&plan.blockedDeliveryOperationId===binding.operationId
      &&plan.sources?.adapterSha256===frontendReadinessIdentity()&&isDeepStrictEqual(plan.sources.worker,binding.worker)&&isDeepStrictEqual(plan.sources.config,binding.config)
      &&plan.health.frontend?.blocked===true&&Number.isSafeInteger(plan.observedAtMilliseconds)&&plan.observedAtMilliseconds>=0&&plan.validForMilliseconds===120000&&plan.workerTimeoutSeconds===120&&plan.realHeartbeatWaitMaximumSeconds===35
      &&typeof plan.originalSelectorBase64==='string'&&sha256(Buffer.from(plan.originalSelectorBase64,'base64'))===plan.proof?.selectorSha256,'frontend-retirement-plan-changed');
  }
  return plan;
}
export async function ensureFrontendReadiness({context,packet,transport,storeReceipt,run=runInstallTransport}){
  const binding=frontendReadinessBinding(packet),path=name=>join(context.journal.directory,'delivery-evidence',context.intent.key+'-'+name);
  const read=name=>existsSync(path(name))?JSON.parse(readReleaseInputFile(path(name))):null;
  const save=(name,value)=>storeReceipt(context.journal,context.intent.key,name,encoded(value));
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});
  const invoke=async value=>{
    const raw=await run(target,buildFrontendReadinessProgram(value),{captureDiagnostics:true});let result;
    try{result=JSON.parse(raw.stdout);}catch{}
    if(raw.uncertain||raw.exitCode!==0||result?.state==='uncertain'||!result){
      const diagnostic={format:1,operationId:binding.operationId,mode:value.mode,transportUncertain:raw.uncertain===true,exitCode:raw.exitCode??null,stdout:String(raw.stdout??'').slice(0,131072),stderr:String(raw.stderr??'').slice(0,65536)};
      return {state:'uncertain',reason:'frontend-readiness-original-result-unavailable',externalId:binding.operationId,receipt:null,output:{privateDiagnostic:save('frontend-readiness-failure-'+sha256(encoded(diagnostic))+'.json',diagnostic)}};
    }
    return result;
  };
  let plan=read('frontend-readiness-plan.json');
  if(!plan){plan=await invoke({mode:'readiness-plan',binding});if(plan.state==='uncertain')return plan;verifyFrontendReadinessPlan(plan,binding);save('frontend-readiness-plan.json',plan);}
  verifyFrontendReadinessPlan(plan,binding);
  if(!plan.retirementRequired)return {state:'completed',output:plan,receipt:save('frontend-readiness-result.json',plan)};
  const intent={format:1,kind:'frontend-retirement-intent',operationId:plan.operationId,planSha256:sha256(encoded(plan)),adapterSha256:frontendReadinessIdentity(),execute:true};
  const dispatched=read('frontend-readiness-dispatch.json');let result;
  if(dispatched){need(isDeepStrictEqual(dispatched,intent),'frontend-readiness-original-dispatch-changed');result=await invoke({mode:'readiness-observe',binding,plan,intent});}
  else{
    need(typeof context.beforeNewEffect==='function','frontend-readiness-prerequisite-check-required');await context.beforeNewEffect();
    if(Date.now()-plan.observedAtMilliseconds>plan.validForMilliseconds){
      const output={format:1,kind:'frontend-retirement-plan-expired',operationId:binding.operationId,planSha256:intent.planSha256,originalObservedAtMilliseconds:plan.observedAtMilliseconds,validForMilliseconds:plan.validForMilliseconds};
      return {state:'failed',reason:'frontend-readiness-plan-expired-before-dispatch',externalId:binding.operationId,receipt:save('frontend-readiness-plan-expired.json',output),output};
    }
    save('frontend-readiness-dispatch.json',intent);
    result=await invoke({mode:'readiness-execute',binding,plan,intent});
  }
  if(result.state==='uncertain')return result;
  need(result.format===1&&result.kind==='frontend-retirement-record'&&result.operationId===plan.operationId&&isDeepStrictEqual(result.plan,plan)
    &&result.planSha256===intent.planSha256&&result.intentSha256===sha256(encoded(intent))&&result.adapterSha256===frontendReadinessIdentity(),'frontend-readiness-result-changed');
  const receipt=save('frontend-readiness-result-'+sha256(encoded(result))+'.json',result);
  if(result.phase==='refused')return {state:'failed',reason:'frontend-retirement-acknowledged-refused',externalId:binding.operationId,receipt,output:result};
  need(result.phase==='completed','frontend-readiness-original-operation-incomplete');
  return {state:'completed',output:result,receipt};
}
