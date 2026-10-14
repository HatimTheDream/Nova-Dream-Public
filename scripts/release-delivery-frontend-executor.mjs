/** Finite installed-worker transport. Fixed staged helper only; no new installer.
 * Production registration still requires actual staging/capacity/acceptance. */
import { readFileSync,existsSync } from 'node:fs';
import {join} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { sha256,readEvidenceFile,readReleaseInputFile } from './release-plan.mjs';
import { releaseTransportSchema,runInstallTransport } from './release-adapters.mjs';
import { frontendPlanInputSchema,verifyFrontendPlanResult } from './release-delivery-frontend-plan.mjs';
import {buildFrontendFreshExecution,frontendRefreshProof,frontendRefreshSourceSha256} from './release-delivery-frontend-refresh.mjs';
const need=(v,reason)=>{if(!v)throw Error(reason);};
const ref=z.object({path:z.string().min(1).max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const frontendExecutionRequestSchema=z.object({format:z.literal(1),operationId:z.uuid(),runId:z.uuid(),planInput:frontendPlanInputSchema,
  workerPlan:ref,workerIntent:ref,planHelper:ref,executor:ref}).strict();
export const frontendExecutorIdentity=()=>sha256(readFileSync(new URL('release-frontend-executor.py',import.meta.url)));
export function frontendExecutionRequest({operationId,runId,planInput,planSha256,intentSha256}) {
  const root=`/var/lib/nova-update/frontend/operator-inputs/${operationId}`;
  return frontendExecutionRequestSchema.parse({format:1,operationId,runId,planInput,workerPlan:{path:`${root}/plan.json`,sha256:planSha256},workerIntent:{path:`${root}/intent.json`,sha256:intentSha256},
    planHelper:{path:`${root}/frontend-plan.py`,sha256:sha256(readFileSync(new URL('release-frontend-plan.py',import.meta.url)))},executor:{path:`${root}/frontend-executor.py`,sha256:frontendExecutorIdentity()}});
}
export function buildFrontendExecutionProgram(raw,mode) {
  const value=frontendExecutionRequestSchema.parse(raw),root=`/var/lib/nova-update/frontend/operator-inputs/${value.operationId}`;
  need(['execute','observe','resume'].includes(mode)&&value.planInput.operationId===value.operationId
    &&value.executor.path===`${root}/frontend-executor.py`&&value.executor.sha256===frontendExecutorIdentity()
    &&value.planHelper.path===`${root}/frontend-plan.py`&&value.planHelper.sha256===sha256(readFileSync(new URL('release-frontend-plan.py',import.meta.url))), 'frontend-execution-source-or-mode-changed');
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),payload=Buffer.from(JSON.stringify({path:`${root}/delivery-request.json`,sha256:sha256(bytes),requestBase64:bytes.toString('base64'),executor:value.executor,mode})).toString('base64');
  // No host writes: exact helper/request must already exist from the protected
  // stage producer. The helper owns the single durable dispatch before launch.
  return `import base64,hashlib,json,os,pathlib,stat\nv=json.loads(base64.b64decode('${payload}',validate=True))\ndef read(p):\n p=pathlib.Path(p)\n assert p.is_absolute() and p.resolve(strict=True)==p\n for x in (p,*p.parents):\n  s=x.lstat();assert not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022\n s=p.lstat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=262144 and not s.st_mode&0o077\n fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)\n try:\n  with os.fdopen(fd,'rb',closefd=False) as f:b=f.read(262145)\n  assert len(b)==s.st_size\n  return b\n finally:os.close(fd)\nassert read(v['path'])==base64.b64decode(v['requestBase64'],validate=True)\nassert hashlib.sha256(read(v['executor']['path'])).hexdigest()==v['executor']['sha256']\nos.execv('/usr/bin/python3',['/usr/bin/python3','-B',v['executor']['path'],v['mode'],'--request',v['path'],'--request-sha256',v['sha256']])\n`;
}
export function classifyFrontendExecution(value,request) {
  // SQLite preserves values with canonical key order; restore this fixed wire
  // schema before hashing the original staged request bytes.
  request=frontendExecutionRequestSchema.parse(request);
  const uncertain=reason=>({state:'uncertain',reason,externalId:request.operationId,receipt:null,output:null});
  const raw=Buffer.from(JSON.stringify(request)+'\n'),digest=sha256(raw);
  if(value?.operationId!==request.operationId||value?.runId!==request.runId||value?.requestSha256!==digest)return uncertain('frontend-execution-response-identity-mismatch');
  if(!['running','uncertain','failed','completed'].includes(value.state))return uncertain('frontend-original-worker-unsettled');
  if(value.state==='completed') {
    const j=value.journal,d=value.dispatch,s=value.started,p=request.planInput;
    const native=Buffer.from(value.journalRawBase64??'','base64');
    need(native.length<=128*1024&&native.toString('base64')===value.journalRawBase64&&sha256(native)===value.journalSha256&&isDeepStrictEqual(JSON.parse(native),j),'frontend-original-journal-bytes-changed');
    need(j?.phase==='completed'&&j.outcome==='selected'&&j.operationId===request.operationId&&j.operationSha256===p.operation.sha256
      &&j.configSha256===p.config.sha256&&j.manifestSha256===p.assets.manifest.sha256&&j.planSha256===request.workerPlan.sha256&&j.frontendId===p.frontendId
      &&j.health.processIdentity===p.processIdentity&&j.health.epoch===p.workspaceEpoch&&j.health.candidateId===p.baseCandidateId&&j.health.serviceInputsSha256===p.serviceInputsSha256,'frontend-execution-completed-journal-changed');
    need(d?.runId===request.runId&&d.operationId===request.operationId&&d.requestSha256===digest&&['execute','resume'].includes(d.action)
      &&d.unit===`nova-frontend-${request.runId}-${d.action}.service`&&d.runtimeMaxSeconds===120&&d.timeoutStopSeconds===15
      &&d.deadlineAtMs===d.createdAtMs+135000&&isDeepStrictEqual(s?.binding,d)&&isDeepStrictEqual(value.workerResult?.binding,d)
      &&value.workerResult.returncode===0&&value.workerResult.invocationId===s.invocationId,'frontend-execution-original-worker-changed');
    need(isDeepStrictEqual(s.effectiveProfile,{Type:'exec',Restart:'no',KillMode:'control-group',MemoryMax:String(768*1024**2),MemorySwapMax:'0',NoNewPrivileges:'yes',ProtectSystem:'strict',RuntimeMaxUSec:120000000,TimeoutStopUSec:15000000,CPUQuotaPerSecUSec:500000,ReadWritePaths:['/opt/nova/frontend','/var/lib/nova-update/frontend']})
      &&/^[a-f0-9]{32}$/.test(s.invocationId)&&s.unitProperties?.InvocationID===s.invocationId&&s.unitProperties.MainPID===String(s.pid)
      &&s.unitProperties.ControlGroup===`/system.slice/${d.unit}`,'frontend-execution-resource-profile-changed');
    need(value.unit?.MainPID==='0'&&value.unit.ControlPID==='0'&&['inactive','failed'].includes(value.unit.ActiveState)
      &&(value.unit.LoadState==='not-found'||value.unit.LoadState==='loaded'&&value.unit.Result==='success'&&value.unit.ExecMainStatus==='0'&&value.unit.InvocationID===s.invocationId)
      &&value.savedReplyAccepted===false&&value.browserAccepted===false,'frontend-execution-closure-changed');
  }
  return {state:value.state,reason:/^[a-z][a-z0-9-]{0,99}$/.test(value.reason??'')?value.reason:'frontend-original-worker-observed',externalId:request.operationId,receipt:null,output:value};
}
export async function invokeFrontendExecution({transport,request},mode,{run=runInstallTransport}={}) {
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});
  const result=await run(target,buildFrontendExecutionProgram(request,mode));
  if(result.uncertain)return {state:'uncertain',reason:'frontend-execution-transport-unavailable',externalId:request.operationId,receipt:null,output:null};
  let value;try{value=JSON.parse(result.stdout);}catch{return {state:'uncertain',reason:'frontend-execution-response-unavailable',externalId:request.operationId,receipt:null,output:null};}
  if(result.exitCode!==0)value.state='uncertain';return classifyFrontendExecution(value,request);
}

/** Requires a real protected binder producer in the recovery phase. That
 * upstream integration is intentionally still absent from the registry. */
export function createFrontendExecutionAdapter({transport,storeReceipt,run=runInstallTransport}) {
  const refreshRecord=(context,name,value)=>storeReceipt(context.journal,context.intent.key,name,Buffer.from(JSON.stringify(value)+'\n'));
  const refreshInput=context=>{
    const request=frontendExecutionRequestSchema.parse(context.intent.input.request),program=buildFrontendFreshExecution(buildFrontendExecutionProgram(request,'execute'),request);
    return{request,program,intent:{format:1,kind:'frontend-original-app-refresh-dispatch',operationId:request.operationId,runId:request.runId,phaseKey:context.intent.key,
      requestSha256:sha256(Buffer.from(JSON.stringify(request)+'\n')),transportSha256:context.intent.input.transport.sha256,refreshSourceSha256:frontendRefreshSourceSha256,programSha256:sha256(program),automaticReplayPermitted:false}};
  };
  const originalRefresh=context=>{const path=join(context.journal.directory,'delivery-evidence',context.intent.key+'-frontend-app-refresh-dispatch.json');if(!existsSync(path))return null;
    const value=JSON.parse(readReleaseInputFile(path));need(isDeepStrictEqual(value,refreshInput(context).intent),'frontend-original-refresh-dispatch-changed');return value;};
  const expected=({descriptor,prior})=>{
    const staged=prior.recovery?.stagedExecution;
    need(prior.route?.route==='frontend'&&staged?.kind==='nova-protected-frontend-execution-input'&&staged.complete===true,'frontend-execution-stager-required');
    const request=frontendExecutionRequestSchema.parse(staged.request);
    need(request.operationId===descriptor.operation.id&&request.planInput.baseCandidateId===descriptor.operation.priorCandidateId
      &&request.planInput.sourceRevision===descriptor.sources.private.commit&&request.planInput.version===descriptor.operation.version
      &&request.planInput.buildVersion===descriptor.operation.buildVersion&&request.planInput.frontendId===prior.publication?.frontendId
      &&request.planInput.serviceInputsSha256===prior.route.serviceInputsSha256&&request.workerPlan.sha256===prior.recovery.planSha256,'frontend-execution-delivery-input-changed');
    verifyFrontendPlanResult(prior.recovery,request.planInput);buildFrontendExecutionProgram(request,'observe');
    need(staged.requestSha256===sha256(Buffer.from(JSON.stringify(request)+'\n')),'frontend-staged-request-changed');
    return {transport,request,stagingOutputSha256:sha256(JSON.stringify(staged))};
  };
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'frontend-execution-input-changed');
  const retain=(value,context)=>{
    if(!value.output)return value;
    const bytes=Buffer.from(JSON.stringify(value.output)+'\n');return {...value,receipt:storeReceipt(context.journal,context.intent.key,`frontend-execution-${sha256(bytes)}.json`,bytes)};
  };
  const observe=async context=>{
    originalRefresh(context);
    let result=await invokeFrontendExecution(context.intent.input,'observe',{run});
    if(result.state==='uncertain'&&result.output?.resumeEligible===true) {
      need(typeof context.beforeNewEffect==='function','frontend-resume-prerequisite-check-required');await context.beforeNewEffect();
      // The helper independently repeats closure, original source/profile and
      // native-journal checks before its one-use resume dispatch.
      result=await invokeFrontendExecution(context.intent.input,'resume',{run});
    }
    return retain(result,context);
  };
  return {input:async context=>expected(context),validate,execute:async context=>{
    if(originalRefresh(context))return observe(context);
    need(typeof context.beforeNewEffect==='function','frontend-execution-prerequisite-check-required');await context.beforeNewEffect();
    if(originalRefresh(context))return observe(context);
    const fresh=refreshInput(context);
    // Exclusive, fsynced receipt precedes the one combined app-check/execute transport.
    // A lost response leaves this original witness; future calls only observe it.
    refreshRecord(context,'frontend-app-refresh-dispatch.json',fresh.intent);
    const refreshedRun=async(target,program)=>{
      need(program===buildFrontendExecutionProgram(fresh.request,'execute'),'frontend-original-execute-program-changed');
      let raw;try{raw=await run(target,fresh.program,{captureDiagnostics:true});}catch(error){refreshRecord(context,'frontend-app-refresh-transport-unavailable.json',{format:1,operationId:fresh.request.operationId,runId:fresh.request.runId,requestSha256:fresh.intent.requestSha256,transportUnavailable:true});throw error;}
      // Keep an uncertain/missing proof honest; native observation may still settle
      // the original request, but it cannot invent an acknowledged app-check result.
      const record={format:1,operationId:fresh.request.operationId,runId:fresh.request.runId,requestSha256:fresh.intent.requestSha256,
        transportUncertain:raw.uncertain===true,exitCode:Number.isInteger(raw.exitCode)?raw.exitCode:null,stdout:String(raw.stdout??'').slice(0,131072),stderr:String(raw.stderr??'').slice(0,131072),diagnosticsTruncated:raw.diagnosticsTruncated===true||String(raw.stdout??'').length>131072||String(raw.stderr??'').length>131072};
      refreshRecord(context,'frontend-app-refresh-response.json',record);
      const proof=frontendRefreshProof(raw,fresh.request);if(proof)refreshRecord(context,'frontend-app-refresh-proof.json',{...proof,operationId:fresh.request.operationId,runId:fresh.request.runId,requestSha256:fresh.intent.requestSha256});
      return raw;
    };
    return retain(await invokeFrontendExecution(context.intent.input,'execute',{run:refreshedRun}),context);
  },observe,verify:async(value,context)=>{
    if(value.externalId)need(value.externalId===context.descriptor.operation.id,'frontend-original-operation-changed');
    if(value.output){need(isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output),'frontend-execution-receipt-changed');classifyFrontendExecution(value.output,context.intent.input.request);}
    if(value.state==='completed')need(classifyFrontendExecution(value.output,context.intent.input.request).state==='completed','frontend-completed-result-changed');
  }};
}
