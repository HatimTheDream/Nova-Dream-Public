/** Fixed SSH/loopback producer. Credentials and exact response records stay on
 * the protected host; no arbitrary route, command, session or evidence input. */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile,sha256 } from './release-plan.mjs';
import { releaseTransportSchema,runInstallTransport } from './release-adapters.mjs';
import { assistantAcceptanceInput } from './release-delivery-assistant.mjs';
import { frontendExecutionRequestSchema,buildFrontendExecutionProgram } from './release-delivery-frontend-executor.mjs';
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const reference=z.object({path:z.string().min(1).max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const source=()=>readFileSync(new URL('release-assistant-transport.py',import.meta.url));
export const assistantHostTransportIdentity=()=>sha256(source());
export function buildAssistantHostProgram(value){
  need(['session','ready','post','draft','observe'].includes(value.mode),'assistant-fixed-mode-required');
  const helper=source(),payload=Buffer.from(JSON.stringify({sourceBase64:helper.toString('base64'),sourceSha256:sha256(helper),value})).toString('base64');
  return `import base64,hashlib,json\nv=json.loads(base64.b64decode('${payload}',validate=True))\ns=base64.b64decode(v['sourceBase64'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sourceSha256']\nn={'__name__':'fixed_assistant_host_transport'}\nexec(compile(s,'fixed-assistant-host-transport','exec'),n)\nprint(json.dumps(n['invoke'](v['value']),separators=(',',':')))\n`;
}
export function assistantHostBinding(context,startupReview,hostConfig){
  const {descriptor,prior,intent,journal}=context,input=assistantAcceptanceInput(context);
  need(input.route==='frontend','assistant-full-installation-identity-producer-required');
  need(isDeepStrictEqual(input,context.input)&&isDeepStrictEqual(input,intent.input),'assistant-transport-input-changed');
  const parent=journal.deliveryPhase(descriptor.operation.id,'assistant');
  need(parent?.key===intent.key&&parent.inputSha256===intent.inputSha256&&Number.isSafeInteger(parent.createdAtMs),'assistant-original-parent-required');
  const request=frontendExecutionRequestSchema.parse(prior.recovery?.stagedExecution?.request);
  // Reuse the maintained exact helper/path/pin admission without dispatching it.
  buildFrontendExecutionProgram(request,'observe');
  const p=request.planInput;
  need(request.operationId===descriptor.operation.id&&p.baseCandidateId===input.installedHealth.candidateId
    &&p.workspaceEpoch===input.installedHealth.epoch&&p.processIdentity===input.installedHealth.processIdentity
    &&p.frontendId===input.installedHealth.frontend.id&&p.serviceInputsSha256===input.installedHealth.serviceInputsSha256
    &&p.config.path==='/etc/nova-update/frontend.json'&&/^[a-f0-9]{64}$/.test(prior.installation.journalSha256),'assistant-original-installation-binding-changed');
  const proof=reference.parse(startupReview);
  need(/^\/opt\/nova-release-tools\/[a-zA-Z0-9/_-]+\/startup-review\.json$/.test(proof.path),'assistant-maintained-runtime-reference-required');
  const config=reference.parse(hostConfig);need(config.path==='/etc/nova-update/config.json','assistant-fixed-runtime-configuration-required');
  return {format:1,operationId:descriptor.operation.id,parentKey:intent.key,inputSha256:intent.inputSha256,input,
    deadlineAtMs:parent.createdAtMs+300000,frontendRequest:request,journalSha256:prior.installation.journalSha256,
    runtime:{startupReview:proof,hostConfig:config},implementationSha256:assistantHostTransportIdentity()};
}
export function createAssistantHostTransport({transport,startupReview,hostConfig,storeReceipt,run=runInstallTransport}){
  const contexts=new Map();
  const validate=async context=>{
    const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});
    need(typeof storeReceipt==='function','assistant-private-receipt-store-required');
    const binding=assistantHostBinding(context,startupReview,hostConfig),key=binding.operationId+':'+binding.parentKey,old=contexts.get(key);
    need(!old||isDeepStrictEqual(old.binding,binding),'assistant-original-host-binding-changed');contexts.set(key,{binding,context,target});
  };
  const invoke=async(mode,common)=>{
    const saved=contexts.get(common.operationId+':'+common.parentKey);need(saved,'assistant-host-validation-required');
    const {binding,context,target}=saved;
    need(['operationId','parentKey','inputSha256','input','deadlineAtMs'].every(k=>isDeepStrictEqual(common[k],binding[k])),'assistant-original-host-call-changed');
    const raw=await run(target,buildAssistantHostProgram({mode,binding,common}),{captureDiagnostics:true});
    let value,parseFailure=false;try{value=JSON.parse(raw.stdout);}catch{parseFailure=true;}
    if(raw.uncertain||raw.exitCode!==0||parseFailure||value?.ok!==true||!Object.hasOwn(value,'value')){
      const bounded=x=>typeof x==='string'?x.slice(0,131072):null;
      const diagnostic={format:1,kind:'private-assistant-transport-failure',operationId:binding.operationId,parentKey:binding.parentKey,mode,parseFailure,
        transport:{uncertain:raw.uncertain===true,exitCode:raw.exitCode??null,reasonCode:raw.reasonCode??null,stdout:bounded(raw.stdout),stderr:bounded(raw.stderr),diagnosticsTruncated:raw.diagnosticsTruncated===true}};
      const receipt=storeReceipt(context.journal,context.intent.key,`assistant-private-failure-${sha256(encoded(diagnostic))}.json`,encoded(diagnostic));
      const error=Error('assistant-original-host-response-unavailable');error.privateDiagnostic=receipt;
      if(typeof value?.code==='string')error.code=value.code;
      if(Number.isInteger(value?.status))error.status=value.status;
      throw error;
    }
    need(Object.hasOwn(value,'value'),'assistant-host-response-shape-invalid');return value.value;
  };
  return {validate,session:c=>invoke('session',c),readReady:c=>invoke('ready',c),postExact:c=>invoke('post',c),
    readDraft:c=>invoke('draft',c),observeSubmit:c=>invoke('observe',c)};
}
