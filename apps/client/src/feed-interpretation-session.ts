import {canonical} from '../../../packages/domain/contracts';
import {feedStartV3Schema,type FeedStartPreparation,type FeedStartV3} from '../../../packages/domain/news-feed-semantic-protocol';
import {adaptiveReviewCommandSchema,type AdaptiveProtocolRequest,type AdaptiveReviewCommand} from '../../../packages/domain/news-feed-adaptive-commands';
import type {AdaptiveWrittenApproval} from '../../../packages/domain/news-feed-adaptive';
import {FeedAdaptiveRequestActions,type FeedAdaptiveRequestPort,type FeedAdaptiveActionResult} from './feed-adaptive-request-actions';
import type {FeedInterpretationAttempt,FeedCurrentWriting,FeedAcceptanceState,FeedPanelAction,FeedReviewTarget,FeedOriginalTarget} from './NewsFeedInterpretationPanel';

export type FeedInterpretationView={attempt:FeedInterpretationAttempt;currentWriting:FeedCurrentWriting|null};
export type FeedAcceptanceView={state:'unknown';command:AdaptiveReviewCommand}|{state:'accepted';command:AdaptiveReviewCommand;approval:AdaptiveWrittenApproval};
export type FeedInterpretationCapabilities={read:boolean;prepare:boolean;observe:boolean;stop:boolean;accept:boolean;close:boolean};
export type FeedInterpretationPort=FeedAdaptiveRequestPort&{
 prepare(descriptor:FeedStartPreparation):Promise<unknown>;
 interpretation(id:string):Promise<FeedInterpretationView>;
 observe(target:FeedOriginalTarget):Promise<unknown>;
 acceptance(command:AdaptiveReviewCommand):Promise<FeedAcceptanceView>;
};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const allowed=(test:()=>unknown)=>{try{const value=test();if(value===true)return true;
 if(value&&typeof (value as PromiseLike<unknown>).then==='function')void Promise.resolve(value).catch(()=>{});
 }catch{/* Current owner is unavailable. */}return false;};
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const failed=(message:string):FeedAdaptiveActionResult=>({ok:false,message});

/** One mounted workspace owner. No constructor network, timer, auto retry or
 * dispatch on reload. The authenticated service validates graph/provenance;
 * this session binds presentation, live selection and exact browser custody. */
export class FeedInterpretationSession{
 readonly actions:FeedAdaptiveRequestActions;
 readonly scope:Readonly<{deviceId:string;epoch:string}>;
 private disposed=false;
 private preparing=false;
 private selected:string|null=null;
 private selection=0;
 private view:FeedInterpretationView|null=null;
 private proof:FeedAcceptanceView|null=null;
 private prepared:FeedStartV3|null=null;
 private tasks=new Set<Promise<unknown>>();
 private observations=new Map<string,Promise<void>>();
 private ports:Readonly<FeedInterpretationPort>;
 error='';
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,scope:{deviceId:string;epoch:string},
  private isOwner:()=>boolean,private capabilities:()=>FeedInterpretationCapabilities,port:FeedInterpretationPort,private changed:()=>void=()=>{}){
  this.scope=Object.freeze({...scope});
  this.ports=Object.freeze({submitNew:port.submitNew.bind(port),readOriginal:port.readOriginal.bind(port),continueClose:port.continueClose.bind(port),
   prepare:port.prepare.bind(port),interpretation:port.interpretation.bind(port),observe:port.observe.bind(port),acceptance:port.acceptance.bind(port)});
  this.actions=new FeedAdaptiveRequestActions(storage,this.scope,()=>this.current(),request=>this.canSubmit(request),this.ports);
 }
 private current(){return !this.disposed&&allowed(this.isOwner)&&allowed(()=>this.capabilities().read);}
 private can(kind:keyof FeedInterpretationCapabilities){return this.current()&&allowed(()=>this.capabilities()[kind]);}
 private notify(){if(!this.disposed)this.changed();}
 private own<T>(work:()=>Promise<T>):Promise<T>{const task=Promise.resolve().then(work);this.tasks.add(task);
  void task.then(()=>{this.tasks.delete(task);this.notify();},()=>{this.tasks.delete(task);this.notify();});return task;}
 private async visible(work:()=>Promise<void>,relevant:()=>boolean=()=>this.current()){try{await work();if(relevant())this.error='';}
  catch(error){if(relevant())this.error=error instanceof Error?error.message:'The original Feed request is kept.';}finally{this.notify();}}
 private selectedNow(id:string,generation:number){return this.current()&&this.selected===id&&this.selection===generation;}
 get busy(){return this.preparing||this.actions.busy;}
 get selectedId(){return this.current()?this.selected:null;}
 get observation(){return this.current()&&this.view?structuredClone(this.view):null;}
 get acceptance():FeedAcceptanceState{
  if(!this.current())return {state:'idle'};
  const request=this.actions.journal.value.request;
  if(request?.kind!=='accept'||!('format' in request.command)||request.command.format!==3)return {state:'idle'};
  const command=structuredClone(request.command) as AdaptiveReviewCommand;
  if(this.proof?.state==='accepted'&&same(this.proof.command,command)&&this.actions.journal.value.receipt?.state==='confirmed')
   return {state:'accepted',command,approval:structuredClone(this.proof.approval)};
  return {state:this.actions.busy?'pending':'unknown',command};
 }
 private original():FeedOriginalTarget|null{const a=this.view?.attempt;return a&&this.selected===a.id&&a.capture.requestId===a.id&&
  a.capture.epoch===this.scope.epoch&&a.capture.deviceId===this.scope.deviceId?{format:3,id:a.id,epoch:a.capture.epoch}:null;}
 private review():FeedReviewTarget|null{
  const a=this.view?.attempt,c=this.view?.currentWriting,r=a?.result,o=this.original();
  if(!a||!c||!r||!o||a.state!=='completed'||a.resultError||!a.terminalSha256||c.epoch!==o.epoch||c.deviceId!==this.scope.deviceId||
   c.profileRevision<a.capture.profileRevision||!same(c.writing,a.capture.writing)||c.writingSha256!==a.capture.writingSha256||
   r.plan.requestId!==a.id||r.plan.briefSha256!==a.capture.briefSha256||!['reviewable','constraints-only'].includes(r.status)||r.plan.unsupported.length)return null;
  return {format:3,epoch:o.epoch,operationId:a.id,expectedRevision:c.profileRevision,briefSha256:a.capture.briefSha256,planSha256:r.planSha256,terminalSha256:a.terminalSha256};
 }
 currentAction(action:FeedPanelAction){if(!this.current())return false;
  if(action.kind==='check-acceptance'){const kept=this.actions.journal.value.request;return kept?.kind==='accept'&&same(kept.command,action.command);}
  if(action.kind==='check')return same(this.original(),action.target);
  if(action.kind==='stop')return !this.busy&&this.can('stop')&&same(this.original(),action.target)&&!!this.view&&
   ['prepared','dispatching','running','unknown'].includes(this.view.attempt.state)&&!this.view.attempt.stop;
  return !this.busy&&this.can('accept')&&same(this.review(),action.target)&&!this.actions.journal.pending&&!this.actions.journal.pendingStop&&!this.actions.journal.pendingClose;
 }
 private canSubmit(request:AdaptiveProtocolRequest){if(!this.current()||!('format' in request.command)||request.command.format!==3)return false;
  if(request.kind==='start')return this.can('prepare')&&!!this.prepared&&same(this.prepared,request.command);
  if(request.kind==='accept'){const {requestId:_,...target}=request.command;return this.can('accept')&&same(this.review(),target);}
  if(request.kind==='stop'){const {requestId:_,...target}=request.command;return this.can('stop')&&same(this.original(),target);}
  if(request.kind==='close')return this.can('close')&&this.actions.journal.value.request?.kind==='start'&&same(this.actions.journal.value.request.command,request.command.original);
  return false;
 }
 async select(id:string){if(!uuid(id)||!this.current())return;this.selected=id;const generation=++this.selection;this.view=null;this.error='';this.notify();
  return this.own(()=>this.visible(async()=>{const view=await this.ports.interpretation(id);
   if(!this.selectedNow(id,generation))return;
   if(view.attempt.id!==id||view.attempt.capture.requestId!==id||view.attempt.capture.deviceId!==this.scope.deviceId||view.attempt.capture.epoch!==this.scope.epoch)
    throw Error('This interpretation does not belong to the selected original.');
   this.view=structuredClone(view);
  },()=>this.selectedNow(id,generation)));
 }
 clearSelection(){this.selection++;this.selected=null;this.view=null;this.error='';this.notify();}
 start(){if(this.busy||!this.can('prepare'))return Promise.resolve(failed('New interpretation is unavailable.'));
  const generation=this.selection;
  this.preparing=true;this.notify();return this.own(async()=>{try{
   if(!await this.actions.journal.ready||!this.can('prepare')||this.actions.journal.invalid||this.actions.journal.pending||this.actions.journal.pendingStop||this.actions.journal.pendingClose)
    return failed('Check the original kept request before another interpretation.');
   const descriptor={format:3 as const,requestId:crypto.randomUUID(),epoch:this.scope.epoch,kind:'interpret' as const};
   const command=feedStartV3Schema.parse(await this.ports.prepare(descriptor));
   if(!this.can('prepare')||command.kind!=='interpret'||command.requestId!==descriptor.requestId||command.epoch!==descriptor.epoch)return failed('Prepared interpretation changed or access is unavailable.');
   this.prepared=command;this.preparing=false;const result=await this.actions.submitNew({kind:'start',command});
   if(this.current()&&this.selection===generation){if(!result.ok)this.error=result.message;else await this.select(command.requestId);}return result;
  }catch(error){const message=error instanceof Error?error.message:'Preparation failed; no new interpretation was sent.';
   if(this.current()&&this.selection===generation)this.error=message;return failed(message);}
  finally{this.prepared=null;this.preparing=false;this.notify();}});
 }
 check(target:FeedOriginalTarget){if(!this.currentAction({kind:'check',target}))return Promise.resolve();
  const exact=structuredClone(target),key=canonical(exact),prior=this.observations.get(key);if(prior)return prior;
  const generation=this.selection;const task=this.own(()=>this.visible(async()=>{
   if(!this.currentAction({kind:'check',target:exact}))return;
   // Native observation is optional; an offline account must not make the
   // original locally saved result or writing inaccessible.
   if(this.can('observe'))await this.ports.observe(exact);
   if(this.selectedNow(exact.id,generation))await this.select(exact.id);
  },()=>this.selectedNow(exact.id,generation)));this.observations.set(key,task);void task.then(()=>this.observations.delete(key),()=>this.observations.delete(key));return task;
 }
 stop(target:FeedOriginalTarget){if(!this.currentAction({kind:'stop',target}))return Promise.resolve(failed('The original Stop target changed.'));
  return this.own(async()=>{const result=await this.actions.submitNew({kind:'stop',command:{...structuredClone(target),requestId:crypto.randomUUID()}});
   if(this.current()&&!result.ok)this.error=result.message;return result;});}
 accept(target:FeedReviewTarget){if(!this.currentAction({kind:'accept',target}))return Promise.resolve(failed('The selected written interpretation changed.'));
  const command=adaptiveReviewCommandSchema.parse({...structuredClone(target),requestId:crypto.randomUUID()});
  return this.own(async()=>{const result=await this.actions.submitNew({kind:'accept',command});
   if(this.current()){if(result.ok){try{await this.readAcceptance(command);}catch(error){if(this.current())this.error=error instanceof Error?error.message:'The saved acceptance proof could not be read.';}}
    else this.error=result.message;}return result;});}
 private async readAcceptance(command:AdaptiveReviewCommand){const proof=await this.ports.acceptance(structuredClone(command)),kept=this.actions.journal.value.request;
  if(!this.current()||kept?.kind!=='accept'||!same(kept.command,command))return;
  if(!same(proof.command,command))throw Error('Acceptance readback changed the original request.');
  if(proof.state==='accepted'){const a=proof.approval;
   if(a.format!==2||a.kind!=='approved-written'||a.reviewRequestId!==command.requestId||a.originalRequestId!==command.operationId||a.deviceId!==this.scope.deviceId||
    a.epoch!==command.epoch||a.briefSha256!==command.briefSha256||a.planSha256!==command.planSha256||a.profileRevisionAtAcceptance!==command.expectedRevision)
    throw Error('Acceptance readback does not confirm the exact reviewed writing.');
  }else if(proof.state!=='unknown')throw Error('Unknown acceptance response.');
  this.proof=structuredClone(proof);
 }
 checkAcceptance(command:AdaptiveReviewCommand){if(!this.currentAction({kind:'check-acceptance',command}))return Promise.resolve();
  const exact=structuredClone(command);return this.own(()=>this.visible(async()=>{
   const result=await this.actions.checkOriginal({kind:'accept',command:exact});
   if(!result.ok)throw Error(result.message);
   if(this.currentAction({kind:'check-acceptance',command:exact})&&result.receipt.state==='confirmed')await this.readAcceptance(exact);
  }));}
 checkKept(request:AdaptiveProtocolRequest){return this.own(async()=>{const result=await this.actions.checkOriginal(structuredClone(request));
  if(this.current()&&!result.ok)this.error=result.message;return result;});}
 closeUnsent(){const original=this.actions.journal.pending;
  if(!original||original.kind!=='start'||this.busy||!this.can('close'))return Promise.resolve(failed('No original unsent request is available to close.'));
  return this.own(()=>this.actions.submitNew({kind:'close',command:{format:3,requestId:crypto.randomUUID(),epoch:this.scope.epoch,original:structuredClone(original.command)}}));
 }
 continueClose(){const request=this.actions.journal.pendingClose;return request?this.own(()=>this.actions.continueClose(request)):Promise.resolve(failed('No original local close is pending.'));}
 dispose(){this.disposed=true;this.selection++;this.view=null;this.proof=null;this.actions.dispose();}
 async settled(){while(this.tasks.size)await Promise.allSettled([...this.tasks]);await this.actions.settled();}
}
