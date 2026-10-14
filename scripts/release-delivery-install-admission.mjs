/** Fresh read-only full-install admission, before a new delivery reservation.
 * Completed publication is immutable. Unknown original requests are observed;
 * fresh capacity never renews or replaces their captured input or identity. */
import { isDeepStrictEqual as same } from 'node:util';
import { normalizeCoordinatorDescriptor } from './release-coordinate.mjs';
import { describeInstallAdapter } from './release-adapters.mjs';
import { readEvidenceFile, sha256, planRelease, validateOperationContinuation } from './release-plan.mjs';
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const bytes=v=>Buffer.from(canonical(v)+'\n');
const stable=input=>({...input,timeline:null,evidence:{...input.evidence,capacity:null,
  recovery:{...input.evidence.recovery,observation:null}}});
const phases=['private-ci','public-ci','package','capacity','recovery','publication'];

function publication(context) {
  const id=context.descriptor.operation.id,row=context.journal.deliveryPhase(id,'publication');
  need(row?.state==='completed'&&row.validation?.state!=='failed'&&same(row.current.output,context.prior.publication),'full-install-original-publication-required');
  const descriptor=normalizeCoordinatorDescriptor(row.current.output.coordinatorDescriptor);
  validateOperationContinuation(descriptor.input.operation,context.descriptor.operation);
  need(descriptor.input.operation.id===id,'full-install-admission-operation-changed');
  return {row,descriptor,binding:{key:row.key,outputSha256:sha256(canonical(row.current.output)),descriptorSha256:sha256(canonical(descriptor))}};
}
function equivalent(actual,published) {
  need(same(actual.adapter,published.adapter)&&same(stable(actual.input),stable(published.input)),'full-install-admission-publication-changed');
}
function ready(input,now,previousReport) {
  const report=planRelease(input,{nowMs:now,...(previousReport?{previousReport}:{})});
  need(phases.every(name=>report.phases.find(p=>p.id===name)?.state==='passed'),'full-install-fresh-prerequisites-unverified');
  need(report.eta.dueReviews.length===0&&report.eta.suspendNewAttemptsFor.length===0,'full-install-admission-overrun-review-required');
  return report;
}
export function createFullInstallationAdmission({collectCapacity,storeReceipt,describe=describeInstallAdapter,clock=Date.now}) {
  const read=context=>{
    const p=publication(context),ref=context.input?.admission??context.intent?.input.admission;
    need(ref,'full-install-admission-required');
    const record=JSON.parse(readEvidenceFile(ref)),actual=normalizeCoordinatorDescriptor(context.input?.coordinatorDescriptor??context.intent.input.coordinatorDescriptor);
    need(record.format===1&&record.kind==='full-install-readonly-admission'&&record.operationId===context.descriptor.operation.id
      &&same(record.publication,p.binding)&&same(record.coordinatorDescriptor,actual)
      &&['fresh-prerequisite-checkpoint','original-request-observation'].includes(record.mode),'full-install-admission-binding-changed');
    equivalent(actual,p.descriptor);return {p,record,actual};
  };
  return {
    prepare:async context=>{
      const p=publication(context),id=context.descriptor.operation.id;
      need(!context.journal.deliveryPhase(id,'installation'),'full-install-admission-existing-parent');
      const original=context.journal.intent(id);let actual,mode,originalRequest=null;
      if(original){
        const current=context.journal.load(id,original.checkpointId);
        actual=normalizeCoordinatorDescriptor({format:1,input:current.input,adapter:p.descriptor.adapter});equivalent(actual,p.descriptor);
        need(same(current.adapter.transport,actual.adapter.transport)&&same(current.adapter.installSpec,actual.adapter.installSpec),'full-install-original-adapter-changed');
        mode='original-request-observation';originalRequest={key:original.idempotencyKey,checkpointId:original.checkpointId,inputSha256:original.inputSha256};
      }else{
        need(typeof collectCapacity==='function','full-install-fresh-capacity-producer-required');
        const measured=await collectCapacity({...context,intent:p.row});
        need(measured?.state==='completed'&&measured.evidence?.observation,'full-install-fresh-capacity-unavailable');
        readEvidenceFile(measured.evidence.observation);
        const recovery=measured.recoveryEvidence??p.descriptor.input.evidence.recovery;
        need(same(recovery.review,p.descriptor.input.evidence.recovery.review)&&same(recovery.proof,p.descriptor.input.evidence.recovery.proof),
          'full-install-original-rehearsal-proof-changed');
        for(const reference of Object.values(recovery))readEvidenceFile(reference);
        const now=clock(),timeline=context.journal.deliveryTimeline(id,now).timeline;
        actual=normalizeCoordinatorDescriptor({...p.descriptor,input:{...p.descriptor.input,timeline,
          evidence:{...p.descriptor.input.evidence,capacity:measured.evidence,recovery}}});
        equivalent(actual,p.descriptor);ready(actual.input,now);
        mode='fresh-prerequisite-checkpoint';
      }
      const described=await describe({...actual.adapter,operation:actual.input.operation,input:actual.input});
      need(described.scopeIdentity===context.descriptor.targetIdentity,'full-install-admission-target-changed');
      // Hash-named immutable local evidence is a preparation record, not a claim
      // that an installation intent or coordinator checkpoint was already written.
      const record={format:1,kind:'full-install-readonly-admission',mode,operationId:id,publication:p.binding,
        preparedAtMs:clock(),coordinatorDescriptor:actual,originalRequest,hostEffects:false,coordinatorIntentCreated:false};
      const raw=bytes(record),admission=storeReceipt(context.journal,p.row.key,'full-install-admission-'+sha256(raw)+'.json',raw);
      return {coordinatorDescriptor:actual,admission};
    },
    validate:context=>{read(context);},
    apply:async context=>{
      const {record,actual}=read(context),id=context.descriptor.operation.id,original=context.journal.intent(id);
      const parent=context.journal.deliveryPhase(id,'installation');
      need(parent&&parent.key===context.intent?.key&&same(parent.input,context.intent.input),'full-install-admission-parent-changed');
      // A concurrent/previous original request wins. There is no checkpoint
      // refresh after its immutable reservation, even when its response is lost.
      if(original){
        const current=context.journal.load(id,original.checkpointId);
        equivalent({format:1,input:current.input,adapter:{transport:current.adapter.transport,installSpec:current.adapter.installSpec}},actual);
        if(record.originalRequest)need(record.originalRequest.key===original.idempotencyKey&&record.originalRequest.inputSha256===original.inputSha256
          &&record.originalRequest.checkpointId===original.checkpointId,'full-install-original-request-changed');
        return {observeOnly:true};
      }
      need(record.mode==='fresh-prerequisite-checkpoint'&&record.originalRequest===null,'full-install-original-request-missing');
      const now=clock(),described=await describe({...actual.adapter,operation:actual.input.operation,input:actual.input});
      need(described.scopeIdentity===context.descriptor.targetIdentity,'full-install-admission-target-changed');
      need(same(actual.input.timeline,context.journal.deliveryTimeline(id,now).timeline),'full-install-admission-timeline-changed');
      const exists=context.journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id);
      if(exists){
        const current=context.journal.load(id);equivalent({format:1,input:current.input,adapter:{transport:current.adapter.transport,installSpec:current.adapter.installSpec}},actual);
        need(current.adapter.identity===described.identity&&current.adapter.scopeIdentity===described.scopeIdentity,'full-install-original-adapter-changed');
        ready(actual.input,now,current.report);context.journal.checkpoint(id,actual.input,{nowMs:now});
      }else{
        ready(actual.input,now);context.journal.attachDeliveryCoordinator(id,actual,described,now);
      }
      return {observeOnly:false};
    },
  };
}
