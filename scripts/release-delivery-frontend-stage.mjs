/** Protected frontend input and capacity producers; fixed source transport.
 * No installer, backup, owner-review ingestion or arbitrary command input. */
import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readEvidenceFile,readReleaseInputFile,sha256 } from './release-plan.mjs';
import { releaseTransportSchema,runInstallTransport } from './release-adapters.mjs';
import { frontendPlanInputSchema,verifyFrontendPlanResult,requestFrontendPlan,verifyFrontendWorkerInstallation } from './release-delivery-frontend-plan.mjs';
import { frontendExecutionRequest,frontendExecutionRequestSchema } from './release-delivery-frontend-executor.mjs';
import { ensureFrontendReadiness,frontendReadinessIdentity } from './release-delivery-frontend-readiness.mjs';
const need=(v,why)=>{if(!v)throw Error(why);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const source=()=>readFileSync(new URL('release-frontend-stage.py',import.meta.url));
export const frontendStageIdentity=()=>sha256(source());
const originalPath=(context,name)=>join(context.journal.directory,'delivery-evidence',`${context.intent.key}-${name}`);
function original(context,name,maximum=512*1024){
  const path=originalPath(context,name);if(!existsSync(path))return null;
  const raw=readReleaseInputFile(path);need(raw.length<=maximum,'frontend-local-record-bound');return JSON.parse(raw);
}
function record(storeReceipt,context,name,value){return storeReceipt(context.journal,context.intent.key,name,encoded(value));}
const outcome=(state,reason,output=null,receipt=null,externalId=null)=>({state,reason,output,receipt,externalId});
export function frontendStagePacket(input,runId){
  const {operation,sourceRevision,baseVersion,serviceInputsSha256,frontendId,worker,config,assets,workerInstallation}=input;
  const root=`/var/lib/nova-update/frontend/operator-inputs/${operation.id}`;
  const operationBytes=encoded({format:1,operationId:operation.id,manifestPath:root+'/frontend.json',signaturePath:root+'/frontend.sig',archivePath:root+'/frontend.tgz'});
  const files={'operation.json':operationBytes,'frontend.json':readEvidenceFile(assets.manifest,{maximum:128*1024}),'frontend.sig':readEvidenceFile(assets.signature,{maximum:64}),'frontend.tgz':readEvidenceFile(assets.archive,{maximum:128*1024**2}),
    'frontend-plan.py':readFileSync(new URL('release-frontend-plan.py',import.meta.url)),'frontend-executor.py':readFileSync(new URL('release-frontend-executor.py',import.meta.url))};
  const packet={format:workerInstallation===undefined?1:2,operationId:operation.id,runId,baseVersion,baseCandidateId:operation.priorCandidateId,serviceInputsSha256,frontendId,sourceRevision,version:operation.version,buildVersion:operation.buildVersion,workspaceEpoch:operation.workspaceEpoch,worker,config,
    ...(workerInstallation===undefined?{}:{workerInstallation}),
    files:Object.fromEntries(Object.entries(files).map(([name,raw])=>[name,{sha256:sha256(raw),bytes:raw.length,base64:raw.toString('base64')}]))};
  verifyFrontendWorkerInstallation(packet);
  const manifest=JSON.parse(files['frontend.json']);need(manifest.frontendId===frontendId&&manifest.sourceRevision===sourceRevision&&manifest.frontendVersion===operation.version&&manifest.frontendBuildVersion===operation.buildVersion&&manifest.base.candidateId===operation.priorCandidateId&&manifest.base.serviceInputsSha256===serviceInputsSha256,'frontend-stage-signed-input-changed');
  need(files['frontend.sig'].length===64&&sha256(files['frontend.tgz'])===manifest.artifact.sha256&&files['frontend.tgz'].length===manifest.artifact.bytes,'frontend-stage-artifact-changed');
  return packet;
}
export function buildFrontendStageProgram(value){
  need(['plan','stage','observe','capacity','bind','bind-observe'].includes(value.mode),'frontend-stage-mode-invalid');
  const helper=source(),payload=Buffer.from(JSON.stringify({sourceBase64:helper.toString('base64'),sourceSha256:sha256(helper),value})).toString('base64');
  return `import base64,hashlib,json,sys\nv=json.loads(base64.b64decode('${payload}',validate=True))\ns=base64.b64decode(v['sourceBase64'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sourceSha256']\nn={'__name__':'frontend_stage'}\nexec(compile(s,'fixed-frontend-stage','exec'),n)\ntry:\n result=n['main'](v['value']);print(json.dumps(result,separators=(',',':')))\nexcept Exception as e:\n print(json.dumps({'state':'uncertain','reason':'frontend-stage-original-result-unavailable','privateDiagnostic':{'mode':v['value']['mode'],'exceptionType':type(e).__name__[:100],'message':str(e)[:2000]}},separators=(',',':')));sys.exit(2)\n`;
}
function saveDiagnostic(context,storeReceipt,mode,raw,parseFailure=false){
  const bounded=(value,limit)=>typeof value==='string'?value.slice(0,limit):null;
  const diagnostic={format:1,kind:'private-frontend-transport-failure',operationId:context.descriptor.operation.id,phaseKey:context.intent.key,mode,
    parseFailure,transport:{uncertain:raw?.uncertain===true,exitCode:Number.isInteger(raw?.exitCode)?raw.exitCode:null,reasonCode:bounded(raw?.reasonCode,100),stdout:bounded(raw?.stdout,131072),stderr:bounded(raw?.stderr,131072),diagnosticsTruncated:raw?.diagnosticsTruncated===true||String(raw?.stdout??'').length>131072||String(raw?.stderr??'').length>131072}};
  return record(storeReceipt,context,`frontend-private-failure-${sha256(encoded(diagnostic))}.json`,diagnostic);
}
const failureOutput=result=>result?.privateDiagnostic?{privateDiagnostic:result.privateDiagnostic}:null;
async function invoke(transport,value,run,context,storeReceipt){
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});
  const raw=await run(target,buildFrontendStageProgram(value),{captureDiagnostics:true});
  let result,parseFailure=false;try{result=JSON.parse(raw.stdout);}catch{parseFailure=true;}
  if(raw.uncertain||raw.exitCode!==0||parseFailure||result?.state==='uncertain')return {state:'uncertain',privateDiagnostic:saveDiagnostic(context,storeReceipt,value.mode,raw,parseFailure)};
  return result;
}
export function verifyStageReceipt(receipt,packet){
  const root=`/var/lib/nova-update/frontend/operator-inputs/${packet.operationId}`,i=receipt?.identity;
  need(receipt?.format===1&&receipt.kind==='protected-frontend-input-stage'&&receipt.staged===true&&i?.operationId===packet.operationId&&i.runId===packet.runId&&i.packetSha256===sha256(encoded(packet))&&i.inputDirectory===root,'frontend-stage-receipt-identity-changed');
  frontendPlanInputSchema.parse(i.planInput);
  need(['format','operationId','workspaceEpoch','baseVersion','baseCandidateId','sourceRevision','frontendId','serviceInputsSha256','version','buildVersion'].every(k=>i.planInput[k]===packet[k])&&isDeepStrictEqual(i.planInput.workerInstallation,packet.workerInstallation)&&isDeepStrictEqual(i.planInput.worker,packet.worker)&&isDeepStrictEqual(i.planInput.config,packet.config)
    &&isDeepStrictEqual(i.planInput.operation,{path:root+'/operation.json',sha256:packet.files['operation.json'].sha256})&&isDeepStrictEqual(i.planInput.assets,Object.fromEntries([['manifest','json'],['signature','sig'],['archive','tgz']].map(([role,suffix])=>[role,{path:root+'/frontend.'+suffix,sha256:packet.files['frontend.'+suffix].sha256}]))),'frontend-stage-original-service-changed');
  need(isDeepStrictEqual(i.files,Object.fromEntries(Object.entries(packet.files).map(([name,row])=>[name,{path:root+'/'+name,sha256:row.sha256,bytes:row.bytes}]))),'frontend-stage-file-receipt-changed');
  need(receipt.intent?.operationId===packet.operationId&&receipt.intent.runId===packet.runId&&receipt.intent.packetSha256===i.packetSha256,'frontend-stage-intent-receipt-changed');
  return i.planInput;
}
export function verifyCapacity(value,{staged}){
  need(value?.format===1&&value.kind==='measured-frontend-stage-capacity'&&value.stagedInputsAlreadyPaid===staged&&value.expectedReclaimBytes===0&&value.newRecoveryCopies===0&&value.temporaryWritesBytes===0&&Array.isArray(value.filesystemGroups)&&value.filesystemGroups.length>=1&&value.filesystemGroups.length<=2,'frontend-capacity-producer-changed');
  const paths=new Set(),devices=new Set();for(const group of value.filesystemGroups){
    need(!devices.has(group.device)&&Number.isSafeInteger(group.device)&&group.reserveBytes===1536*1024**2&&group.allowanceBytes===256*1024**2,'frontend-capacity-reserve-or-device-changed');devices.add(group.device);
    need(['blockBytes','freeBytes','freeInodes','newBytes','newInodes','requiredFreeBytes','requiredFreeInodes'].every(k=>Number.isSafeInteger(group[k])&&group[k]>=0)&&group.blockBytes>0&&group.requiredFreeBytes===group.newBytes+group.reserveBytes+group.allowanceBytes&&group.requiredFreeInodes===group.newInodes+1024&&group.freeBytes>=group.requiredFreeBytes&&group.freeInodes>=group.requiredFreeInodes,'frontend-capacity-measurement-changed');
    for(const path of group.paths){need(['/var/lib/nova-update/frontend','/opt/nova/frontend'].includes(path)&&!paths.has(path),'frontend-capacity-path-changed');paths.add(path);}
  }need(paths.size===2,'frontend-capacity-filesystem-missing');
}
function stageInput(descriptor,prior,options){
  need(prior.route?.route==='frontend'&&prior.sign?.frontendId&&options?.worker&&options?.config&&options?.baseVersion,'frontend-stage-configuration-required');
  const value={operation:descriptor.operation,sourceRevision:descriptor.sources.private.commit,serviceInputsSha256:prior.route.serviceInputsSha256,frontendId:prior.sign.frontendId,
    baseVersion:options.baseVersion,worker:options.worker,config:options.config,...(options.workerInstallation===undefined?{}:{workerInstallation:options.workerInstallation}),assets:{manifest:prior.sign.manifest,signature:prior.sign.signature,archive:prior.sign.archive},implementationSha256:frontendStageIdentity(),readinessImplementationSha256:frontendReadinessIdentity()};
  // Validate locally without claiming that protected host inputs already exist.
  frontendStagePacket(value,descriptor.operation.id);return value;
}
export function createFrontendStageCapacityAdapter({transport,options,storeReceipt,run=runInstallTransport}){
  const expected=({descriptor,prior})=>stageInput(descriptor,prior,options);
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'frontend-stage-delivery-input-changed');
  const advance=async context=>{
    const packet=frontendStagePacket(context.intent.input,context.intent.key);let result;
    const dispatched=original(context,'frontend-stage-dispatch.json');
    if(dispatched){need(dispatched.packetSha256===sha256(encoded(packet)),'frontend-stage-original-dispatch-changed');result=await invoke(transport,{mode:'observe',packet},run,context,storeReceipt);}
    else {
      const readiness=await ensureFrontendReadiness({context,packet,transport,storeReceipt,run});
      if(readiness.state!=='completed')return readiness;
      let plan=original(context,'frontend-stage-plan.json');
      if(!plan){plan=await invoke(transport,{mode:'plan',packet},run,context,storeReceipt);if(!plan||plan.state==='uncertain')return outcome('uncertain','frontend-stage-plan-unavailable',failureOutput(plan),null,packet.operationId);record(storeReceipt,context,'frontend-stage-plan.json',plan);}
      need(plan.kind==='frontend-protected-stage-plan'&&plan.readOnly===true&&plan.identity?.packetSha256===sha256(encoded(packet)),'frontend-stage-plan-response-changed');verifyCapacity(plan.capacity,{staged:false});
      const intent={format:1,operationId:packet.operationId,runId:packet.runId,packetSha256:sha256(encoded(packet)),planSha256:sha256(encoded(plan))};
      need(typeof context.beforeNewEffect==='function','frontend-stage-prerequisite-check-required');await context.beforeNewEffect();
      record(storeReceipt,context,'frontend-stage-dispatch.json',intent);
      result=await invoke(transport,{mode:'stage',packet,plan,intent},run,context,storeReceipt);
    }
    if(!result||result.state==='uncertain')return outcome('uncertain','frontend-original-stage-unsettled',failureOutput(result),null,packet.operationId);
    const planInput=verifyStageReceipt(result,packet);verifyCapacity(result.preStageCapacity,{staged:false});
    const output={kind:'nova-delivery-frontend-capacity',operationId:packet.operationId,capacityQualified:true,packetInput:context.intent.input,runId:packet.runId,stageReceipt:result,
      frontendStage:{kind:'nova-protected-frontend-stage',planInput}};
    return outcome('completed','frontend-protected-inputs-and-capacity-produced',output,record(storeReceipt,context,'frontend-capacity-result.json',output),packet.operationId);
  };
  return {input:async c=>expected(c),validate,execute:advance,observe:advance,verify:async(value,context)=>{
    if(value.state!=='completed'){if(value.output?.privateDiagnostic)readEvidenceFile(value.output.privateDiagnostic);return;}
    need(value.externalId===context.descriptor.operation.id&&isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output)&&isDeepStrictEqual(value.output.packetInput,context.intent.input)&&value.output.runId===context.intent.key,'frontend-capacity-result-changed');
    const packet=frontendStagePacket(context.intent.input,context.intent.key);verifyStageReceipt(value.output.stageReceipt,packet);
    const current=await invoke(transport,{mode:'capacity',packet},run,context,storeReceipt);need(current?.kind==='frontend-stage-capacity-reverified'&&current.operationId===packet.operationId&&current.runId===packet.runId&&current.readOnly===true,'frontend-fresh-capacity-unavailable');verifyCapacity(current.capacity,{staged:true});
  }};
}
export function createFrontendBoundRecoveryAdapter({transport,storeReceipt,run=runInstallTransport}){
  const expected=({descriptor,prior})=>{
    const c=prior.capacity;need(prior.route?.route==='frontend'&&c?.kind==='nova-delivery-frontend-capacity'&&c.capacityQualified===true&&c.operationId===descriptor.operation.id,'frontend-binding-capacity-required');
    const packet=frontendStagePacket(c.packetInput,c.runId),input=verifyStageReceipt(c.stageReceipt,packet);
    return {transport,packetInput:c.packetInput,runId:c.runId,input,capacityOutputSha256:sha256(JSON.stringify(c)),implementationSha256:frontendStageIdentity()};
  };
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'frontend-binding-input-changed');
  const advance=async context=>{
    const v=context.intent.input,packet=frontendStagePacket(v.packetInput,v.runId);let recovery=original(context,'frontend-original-plan.json');
    if(!recovery){let diagnostic=null;const observedRun=async(target,program)=>{const raw=await run(target,program,{captureDiagnostics:true});let parseFailure=false;try{JSON.parse(raw.stdout);}catch{parseFailure=true;}if(raw.uncertain||raw.exitCode!==0||parseFailure)diagnostic=saveDiagnostic(context,storeReceipt,'native-plan',raw,parseFailure);return raw;};
      const result=await requestFrontendPlan({transport,input:v.input},{run:observedRun});if(result.state!=='completed')return {...result,output:diagnostic?{privateDiagnostic:diagnostic}:null};recovery=result.output;record(storeReceipt,context,'frontend-original-plan.json',recovery);}
    verifyFrontendPlanResult(recovery,v.input);
    const intent={format:1,operationId:packet.operationId,planSha256:recovery.planSha256,operationSha256:v.input.operation.sha256};
    const request=frontendExecutionRequest({operationId:packet.operationId,runId:packet.runId,planInput:v.input,planSha256:recovery.planSha256,intentSha256:sha256(encoded(intent))}),requestBytes=Buffer.from(JSON.stringify(request)+'\n'),requestBase64=requestBytes.toString('base64');
    const dispatched=original(context,'frontend-bind-dispatch.json');let binding;
    if(dispatched){need(dispatched.requestSha256===sha256(requestBytes),'frontend-bind-original-request-changed');binding=await invoke(transport,{mode:'bind-observe',packet,requestBase64},run,context,storeReceipt);}
    else {
      need(typeof context.beforeNewEffect==='function','frontend-bind-prerequisite-check-required');await context.beforeNewEffect();
      record(storeReceipt,context,'frontend-bind-dispatch.json',{format:1,operationId:packet.operationId,runId:packet.runId,requestSha256:sha256(requestBytes),planSha256:recovery.planSha256});
      binding=await invoke(transport,{mode:'bind',packet,recovery,requestBase64},run,context,storeReceipt);
    }
    if(!binding||binding.state==='uncertain')return outcome('uncertain','frontend-original-binding-unsettled',failureOutput(binding),null,packet.operationId);
    need(binding.kind==='protected-frontend-execution-binding'&&binding.complete===true&&binding.operationId===packet.operationId&&binding.runId===packet.runId&&binding.requestSha256===sha256(requestBytes)&&binding.planSha256===recovery.planSha256,'frontend-bound-result-changed');verifyCapacity(binding.capacity,{staged:true});
    const output={...recovery,binding,stagedExecution:{kind:'nova-protected-frontend-execution-input',complete:true,request,requestSha256:sha256(requestBytes)}};
    return outcome('completed','frontend-original-plan-intent-bound',output,record(storeReceipt,context,'frontend-bound-recovery.json',output),packet.operationId);
  };
  return {input:async c=>expected(c),validate,execute:advance,observe:advance,verify:async(value,context)=>{
    if(value.state!=='completed'){if(value.output?.privateDiagnostic)readEvidenceFile(value.output.privateDiagnostic);return;}
    need(isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output),'frontend-bound-recovery-receipt-changed');verifyFrontendPlanResult(value.output,context.intent.input.input);
    const request=frontendExecutionRequestSchema.parse(value.output.stagedExecution.request),packet=frontendStagePacket(context.intent.input.packetInput,context.intent.input.runId),requestBytes=Buffer.from(JSON.stringify(request)+'\n');
    need(value.output.stagedExecution.complete===true&&value.output.stagedExecution.requestSha256===sha256(requestBytes),'frontend-bound-execution-request-changed');
    const current=await invoke(transport,{mode:'bind-observe',packet,requestBase64:requestBytes.toString('base64')},run,context,storeReceipt);need(isDeepStrictEqual(current,value.output.binding),'frontend-original-binding-unavailable');
  }};
}
