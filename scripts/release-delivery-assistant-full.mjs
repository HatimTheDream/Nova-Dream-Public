/** Full installed identity + saved-reply transport. Frontend implementation is
 * reused unchanged; no installation, manual success receipt or browser proof. */
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual as equal} from 'node:util';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {releaseTransportSchema,releaseInstallSpecSchema,runInstallTransport} from './release-adapters.mjs';
import {assistantAcceptanceInput} from './release-delivery-assistant.mjs';
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const source=()=>readFileSync(new URL('release-assistant-transport.py',import.meta.url));
const full=()=>readFileSync(new URL('release-installed-identity.py',import.meta.url));
const REQUESTER='15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06';
const SUPPORT='8146ea044aaec3e06c29f663ddab5aabcab59a3b9e88c15bd7576ef1fc305d0d';
const ref=v=>v&&Object.keys(v).sort().join(',')==='path,sha256'&&typeof v.path==='string'&&/^[a-f0-9]{64}$/.test(v.sha256);
export const fullAssistantTransportIdentity=()=>sha256(Buffer.concat([source(),full(),readFileSync(new URL(import.meta.url))]));
export function validateInstalledIdentityRequest(binding){
 need(binding&&Object.keys(binding).sort().join(',')==='format,jobId,operation,requester,runtime'&&binding.format===1,'full-original-identity-input-required');
 const {idempotencyKey,...spec}=binding.operation;releaseInstallSpecSchema.parse(spec);
 need(/^[a-f0-9-]{36}$/.test(idempotencyKey)&&/^[a-f0-9-]{36}$/.test(binding.jobId),'full-original-key-job-required');
 need(equal(binding.requester,{path:`/opt/nova-release-tools/${REQUESTER}/request_install.py`,sha256:REQUESTER}),'full-maintained-requester-required');
 need(Object.keys(binding.runtime).sort().join(',')==='hostConfig,startupReview'&&ref(binding.runtime.hostConfig)&&binding.runtime.hostConfig.path==='/etc/nova-update/config.json'&&ref(binding.runtime.startupReview)&&/^\/opt\/nova-release-tools\/[a-zA-Z0-9/_-]+\/startup-review\.json$/.test(binding.runtime.startupReview.path),'full-reviewed-runtime-inputs-required');
 return binding;
}
function program(value){
 const s=source(),f=full();need(sha256(s)===SUPPORT,'unchanged-reviewed-assistant-transport-required');
 const payload=Buffer.from(JSON.stringify({support:s.toString('base64'),supportSha:sha256(s),full:f.toString('base64'),fullSha:sha256(f),value})).toString('base64');
 return `import base64,hashlib,json,signal,types\nv=json.loads(base64.b64decode('${payload}',validate=True))\ns=base64.b64decode(v['support'],validate=True);f=base64.b64decode(v['full'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['supportSha'] and hashlib.sha256(f).hexdigest()==v['fullSha']\nn={'__name__':'fixed_assistant_host_transport'}\nexec(compile(s,'fixed-assistant-host-transport','exec'),n)\nm=n['load_module']('full_installed_identity','full-installed-identity',f)\nsupport=types.SimpleNamespace(**n)\nsignal.alarm(90)\nif v['value']['mode']=='identity':\n result=m.observe(v['value']['binding'],support)\n print(json.dumps({'ok':True,'value':result},separators=(',',':')))\nelse:\n def installation(binding):\n  proof,_=m.original(binding['fullRequest'],support)\n  n['need'](proof==binding['fullIdentity']['installationProof'],'assistant-original-full-installation-changed')\n  n['need'](support.process_identity()==binding['fullIdentity']['appProcess'],'assistant-original-full-process-changed')\n  return {'installationSha256':binding['input']['installationSha256'],'fullOriginalInstallation':proof}\n def root_for(binding):\n  return n['P']('/var/lib/nova-update/release-coordinator')/binding['operationId']/('assistant-'+binding['parentKey'])\n n['installation']=installation;n['root_for']=root_for\n print(json.dumps(n['invoke'](v['value']),separators=(',',':')))\n`;
}
export function buildInstalledIdentityProgram(binding){validateInstalledIdentityRequest(binding);return program({mode:'identity',binding});}
export function fullAssistantBinding(context,startupReview,hostConfig){
 const {descriptor,prior,intent,journal}=context,input=assistantAcceptanceInput(context);
 need(input.route==='full'&&equal(input,context.input)&&equal(input,intent.input),'assistant-full-original-input-required');
 const parent=journal.deliveryPhase(descriptor.operation.id,'assistant');
 need(parent?.key===intent.key&&parent.inputSha256===intent.inputSha256&&Number.isSafeInteger(parent.createdAtMs),'assistant-original-parent-required');
 const identity=prior.installation.acceptanceIdentity,request=validateInstalledIdentityRequest(identity.request);
 need(identity.readOnly===true&&identity.savedReplyAccepted===false&&identity.browserUiVerified===false&&equal(identity.health,input.installedHealth),'actual-full-identity-observation-required');
 need(identity.operationId===descriptor.operation.id&&request.operation.operationId===descriptor.operation.id&&identity.candidateId===request.operation.candidateId&&identity.jobId===request.jobId&&identity.jobId===prior.installation.jobId&&identity.idempotencyKey===request.operation.idempotencyKey&&identity.idempotencyKey===prior.installation.idempotencyKey&&prior.installation.coordinatorOperationId===descriptor.operation.id,'original-full-installation-identity-changed');
 need(equal(request.runtime,{startupReview,hostConfig}),'original-full-runtime-evidence-changed');
 return {format:1,operationId:descriptor.operation.id,parentKey:intent.key,inputSha256:intent.inputSha256,input,deadlineAtMs:parent.createdAtMs+300000,fullRequest:request,fullIdentity:identity,runtime:request.runtime,implementationSha256:fullAssistantTransportIdentity()};
}
export function createFullAssistantHostTransport({transport,startupReview,hostConfig,storeReceipt,run=runInstallTransport}){
 const contexts=new Map();
 const validate=async context=>{
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});need(typeof storeReceipt==='function','assistant-private-receipt-store-required');
  const binding=fullAssistantBinding(context,startupReview,hostConfig),key=binding.operationId+':'+binding.parentKey,old=contexts.get(key);need(!old||equal(old.binding,binding),'assistant-original-host-binding-changed');contexts.set(key,{binding,context,target});
 };
 const invoke=async(mode,common)=>{
  const saved=contexts.get(common.operationId+':'+common.parentKey);need(saved,'assistant-host-validation-required');const {binding,context,target}=saved;
  need(['operationId','parentKey','inputSha256','input','deadlineAtMs'].every(k=>equal(common[k],binding[k])),'assistant-original-host-call-changed');
  const raw=await run(target,program({mode,binding,common}),{captureDiagnostics:true});let value;try{value=JSON.parse(raw.stdout);}catch{}
  if(raw.uncertain||raw.exitCode!==0||value?.ok!==true||!Object.hasOwn(value,'value')){
   const diagnostic={format:1,kind:'private-full-assistant-transport-failure',operationId:binding.operationId,parentKey:binding.parentKey,mode,transport:{uncertain:raw.uncertain===true,exitCode:raw.exitCode??null,stdout:String(raw.stdout??'').slice(0,131072),stderr:String(raw.stderr??'').slice(0,131072)}};
   const receipt=storeReceipt(context.journal,context.intent.key,`assistant-full-failure-${sha256(encoded(diagnostic))}.json`,encoded(diagnostic));const e=Error('assistant-original-host-response-unavailable');e.privateDiagnostic=receipt;if(typeof value?.code==='string')e.code=value.code;if(Number.isInteger(value?.status))e.status=value.status;throw e;
  }
  return value.value;
 };
 return {validate,session:c=>invoke('session',c),readReady:c=>invoke('ready',c),postExact:c=>invoke('post',c),readDraft:c=>invoke('draft',c),observeSubmit:c=>invoke('observe',c)};
}
