import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import type {SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import {claimFeedHistoryOwner,type HistoryOwnerPort} from './feed-history-owner-observer.js';
import {z} from 'zod';
import {adaptiveHash,type AdaptiveWrittenBasis} from '../../packages/domain/news-feed-adaptive.js';
import {captureAdaptiveOriginal,adaptiveWorkerBounds,type AdaptiveAuthority} from '../../packages/domain/news-feed-adaptive-capture.js';
import {FeedAdaptiveLocalProtocol,type FeedLocalCaller,type FeedLedgerReader} from './feed-adaptive-local-protocol.js';
import {knownStartRefusal} from '../../packages/domain/news-feed-successor-journal.js';
import {adaptiveWorkerReceipts,requireCurrentAdaptiveSource} from '../../packages/domain/news-feed-adaptive-graph.js';
import type {FeedStartPreparation} from '../../packages/domain/news-feed-semantic-protocol.js';
import {workerCapabilitiesSchema,workerReceiptSchema,workerStatusSchema,isSettledWorkerObservation,type WorkerIdentity,type WorkerReceipt} from '../../packages/domain/worker.js';
import {workerInputHash,workerNativeIdentity} from './worker-plugin/identity.js';
import {Fault,type Store,type FeedMutationReadView} from './store.js';
import type {AssistantTransport} from './gateway.js';
import {captureCurrentEvidence,captureObservedBasis,deriveFeedTerminal,type TerminalBasis,type Output} from '../../packages/domain/news-feed-adaptive-worker-evidence.js';
import {feedWorkerPrefix,feedWorkerLimits,commandSchema,routeSchema,terminal,json,size,same,summary,unwrap,promptFor,validateFeedWorkerRecord,
 feedWorkerIntent,feedStopIntent,feedWorkerReceipt,feedStopReceipt,ownerStopCommandSchema,
 type FeedWorkerSources,type FeedWorkerSaved,type FeedWorkerSummary,type Capture,type State,type Stop} from '../../packages/domain/news-feed-adaptive-worker.js';
export type {FeedWorkerSources,FeedWorkerSaved,FeedWorkerSummary} from '../../packages/domain/news-feed-adaptive-worker.js';
const uuid=z.string().uuid();

/** SOURCE-ONLY PROPOSAL. No constructor effects or automatic dispatch replay.
 * Uses the maintained Store transaction and worker contracts in isolated tests.
 * Namespace startup/import verification, HTTP, polling and maintenance wiring
 * are still integration work; this class must not be instantiated by the app yet. */
export class FeedAdaptiveWorker{
 private readonly historyOwner:HistoryOwnerPort;
 private draft?:{graph:FeedMutationReadView;writes:SemanticRow[];latest:Map<string,FeedWorkerSaved>};
 private closing=false;
 private jobs=new Set<Promise<unknown>>();
 private rawRequests=new Set<Promise<unknown>>();
 private rawByOriginalMethod=new Map<string,{params:string;promise:Promise<unknown>}>();
 private checks=new Map<string,Promise<FeedWorkerSummary>>();
 private dispatches=new Set<string>();
 private enteringChecks=new Set<string>();
 private enteringRaw=new Map<string,string>();
 constructor(private store:Store,private gateway:AssistantTransport,private sources:FeedWorkerSources,
  private ledger:FeedLedgerReader,private now=Date.now,private rpcMs:number=feedWorkerLimits.rpcMs){
  if(!Number.isInteger(rpcMs)||rpcMs<1||rpcMs>feedWorkerLimits.rpcMs)throw new Error('Invalid finite RPC bound');
  this.historyOwner=claimFeedHistoryOwner(store,'adaptive-worker');
 }
 private track<T>(produce:()=>Promise<T>){return this.historyOwner.run('job',()=>{const work=produce();this.jobs.add(work);return work;},work=>{this.jobs.delete(work);});}
 private withGraph<T>(read:(graph:FeedReadGraph)=>T):T{return this.draft?read(this.draft.graph):this.store.internalWithFeedReadGraph(read);}
 private withDraft<T>(graph:FeedMutationReadView,work:()=>T):{writes:SemanticRow[];value:T}{
  if(this.draft)throw Error('Nested worker draft refused');const draft={graph,writes:[] as SemanticRow[],latest:new Map<string,FeedWorkerSaved>()};this.draft=draft;
  try{return {writes:draft.writes,value:work()};}finally{this.draft=undefined;}
 }
 private admit<T>(device:string,input:{requestId:string;epoch:string},intent:unknown,work:()=>T){return this.store.internalAdmitFeed(device,input,intent,graph=>{
  const draft=this.withDraft(graph,work);return {writes:draft.writes,receiptValue:draft.value};
 });}
 private all(){return this.withGraph(graph=>[...graph.adaptiveWorkers.values()]);}
 private caller(deviceId:string):FeedLocalCaller{return {deviceId,epoch:this.store.epoch,current:()=>{const value=this.sources.current(deviceId);return {deviceId:value.deviceId,epoch:value.epoch,read:value.authorized,write:value.authorized&&value.writeAuthorized};}};}
 private local(){return new FeedAdaptiveLocalProtocol(this.store,this.ledger,workerInputHash,workerNativeIdentity,this.now);}
 readOriginal(deviceId:string,request:unknown){return this.local().readOriginal(this.caller(deviceId),request);}
 history(deviceId:string,input:unknown={}){return this.local().history(this.caller(deviceId),input);}
 closeOriginal(deviceId:string,command:unknown){return this.local().closeOriginal(this.caller(deviceId),command);}
 private validate(raw:FeedWorkerSaved){return validateFeedWorkerRecord(raw,workerInputHash,workerNativeIdentity);}
 private read(id:string){const value=this.draft?.latest.get(id)??this.withGraph(graph=>graph.adaptiveWorkers.get(id)) as FeedWorkerSaved|undefined;if(!value)throw new Fault(404,'feed_worker_missing','This original Feed request is unavailable.');
  const checked=this.validate(value);if(checked.id!==id)throw new Error('Original Feed record key changed');return checked;}
 private save(value:FeedWorkerSaved,admitting?:string):FeedWorkerSaved{
  if(!this.draft){if(admitting)throw Error('Worker original needs its exact draft admission');return this.store.internalObserveFeed(graph=>this.withDraft(graph,()=>this.save(value)));}
  const active=this.draft.graph.activeRow(feedWorkerPrefix+value.id),previous=this.draft.latest.get(value.id)??active?.value as FeedWorkerSaved|undefined;
  if(!previous&&this.draft.graph.workers.has(value.id))throw Error('Archived worker cannot be recreated');
  if(this.draft.writes.length>=2)throw Error('Worker draft sequence bound');
  value={...value,revision:(previous?.revision??0)+1};this.validate(value);
  if(previous){for(const key of ['id','deviceId','command','capture','policy','route','generation','createdAt','deadlineAt','prompt','inputHash'] as const)
   if(!same(previous[key],value[key]))throw new Error('Original Feed intent cannot change');
   if(terminal(previous)&&!same(previous,value))throw new Error('Original terminal result cannot change');
   if(previous.originalReceipt&&!same(previous.originalReceipt,value.originalReceipt))throw new Error('Original worker receipt cannot change');
   if(!same(value.ownerStops.slice(0,previous.ownerStops.length),previous.ownerStops))throw new Error('Original owner stop admissions cannot change');
   if(!same(value.events.slice(0,previous.events.length),previous.events))throw new Error('Original Feed events cannot change');}
  if(admitting&&!adaptiveWorkerReceipts(value,workerInputHash).some(receipt=>receipt.requestId===admitting))throw Error('Exact adaptive admission receipt missing');
  this.draft.writes.push({id:feedWorkerPrefix+value.id,revision:value.revision,value});this.draft.latest.set(value.id,value);return value;
 }
 private change(id:string,patch:Partial<FeedWorkerSaved>,event?:string,admitting?:string){const old=this.read(id);if(terminal(old))return old;
  return this.save({...old,...patch,events:event?[...old.events,{kind:event,at:this.now()}]:old.events},admitting);}
 private finished(id:string,basis:TerminalBasis,output?:Output){const derived=deriveFeedTerminal(this.read(id),basis,output,workerInputHash);
  return this.change(id,{...derived,...(output?{output}:{})},'terminal:'+derived.state);}
 private reviewed(id:string){return this.withGraph(graph=>graph.adaptiveReviews.get(id)?.source);}
 private sourceCurrent(current:AdaptiveAuthority){return this.withGraph(graph=>{if(!current.source)throw new Error('Current adaptive source unavailable');
 return requireCurrentAdaptiveSource(graph,current.source,current.deviceId,current.epoch,this.now(),workerInputHash);});
 }
 private captured(command:FeedStartPreparation|FeedWorkerSaved['command'],current:AdaptiveAuthority,at:number){
  const source=command.kind==='interpret'?current.writing:this.sourceCurrent(current),basis:AdaptiveWrittenBasis|null=command.kind==='interpret'?null:command.basis.kind==='empty-written'?{kind:'empty'}:this.reviewed(command.basis.reviewId)??null;
  return captureAdaptiveOriginal(command,source,basis,command.kind==='classify'?this.sources.story(command.story.id):undefined,at,workerInputHash);
 }
 prepare(deviceId:string,descriptor:unknown){return this.local().prepareStart(this.caller(deviceId),descriptor,(command,at)=>{const current=this.sources.current(deviceId),capture=this.captured(command,current,at);
  return {expectedRevision:capture.source.context.profile.revision,captureSha256:adaptiveHash(capture,workerInputHash),modelInputSha256:workerInputHash(promptFor(capture,workerInputHash)),nativePolicySha256:adaptiveHash(current.policy,workerInputHash),newStartReady:current.newStartReady};});}
 private currentEvidence(value:FeedWorkerSaved){const authority=this.authority(value);
  return captureCurrentEvidence(authority,this.gateway.status().generation!,value.command.kind,
   value.command.kind==='classify'?this.sources.story(value.command.story.id):undefined,workerInputHash);}
 private identity(value:FeedWorkerSaved):WorkerIdentity{if(!value.hostId)throw new Error('Original host not captured');
  return {epoch:value.command.epoch,hostId:value.hostId,attemptId:value.id,inputHash:value.inputHash};}
 private authority(value:FeedWorkerSaved,scope:'operator.read'|'operator.write'='operator.read'){
  if(this.store.recoveryEffectsPaused)throw new Error('Recovery effects are held');
  const authority=this.sources.current(value.deviceId),connection=this.gateway.status();routeSchema.parse(authority.policy.route);
  if(!authority.authorized||scope==='operator.write'&&!authority.writeAuthorized||authority.deviceId!==value.deviceId||authority.epoch!==value.command.epoch||this.store.epoch!==value.command.epoch||
   authority.policy.route.accountKey!==value.route.accountKey||authority.policy.qualificationId!==value.policy.qualificationId||authority.policy.configurationRevision!==value.policy.configurationRevision||
   connection.state!=='ready'||connection.generation!==value.generation||!connection.grantedScopes.includes(scope))
   throw new Error('Original Feed authority unavailable');
  if(this.store.internalRead(feedWorkerPrefix+value.id)&&!same(this.store.replayAdmission(value.deviceId,value.command,feedWorkerIntent(value.command)),feedWorkerReceipt(value,workerInputHash)))
   throw new Error('Original Feed admission receipt unavailable');
  return authority;
 }
 private fresh(value:FeedWorkerSaved){const authority=this.authority(value);
  try{return adaptiveHash(this.captured(value.command,authority,value.command.expectation.preparedAt),workerInputHash)===value.command.expectation.captureSha256&&adaptiveHash(authority.policy,workerInputHash)===value.command.expectation.nativePolicySha256;}catch{return false;}
 }
 private newWork(value:FeedWorkerSaved){this.store.assertFeedExternalEffectAllowed();this.store.assertUpdateAdmission();if(this.closing||!this.fresh(value))throw new Error('Current Feed writing or permissions changed');
  const current=this.authority(value,'operator.write');
  if(!current.newStartReady||!this.gateway.status().modelAuthReady||!same(current.policy.route,value.route))throw new Error('New Feed interpretation is unavailable');
  if(this.now()>=value.deadlineAt)throw new Error('Original Feed deadline elapsed');
 }
 private async rpc(value:FeedWorkerSaved,method:string,params:unknown){
  const scope=['e3.assignments.run','e3.assignments.stop','chat.abort'].includes(method)?'operator.write':'operator.read';
  this.authority(value,scope);if(!this.gateway.status().methods.includes(method))throw new Error('Original worker method unavailable');
  const key=value.id+':'+method,encoded=json(params),held=this.rawByOriginalMethod.get(key);
  if(held&&held.params!==encoded)throw new Error('Original pending RPC arguments changed');
  let raw=held?.promise;
  if(!raw){
   if(this.enteringRaw.has(key))throw Error('Original raw entry is already in progress');
   this.enteringRaw.set(key,encoded);
   try{
   const kind=method==='e3.assignments.run'?'run':['e3.assignments.stop','chat.abort'].includes(method)?'abort':'read';
   raw=this.historyOwner.run(kind,()=>this.store.trackUpdateEffect('feed-semantic-rpc',()=>this.gateway.request(method,params),method!=='e3.assignments.run'),original=>{
    this.rawRequests.delete(original);if(this.rawByOriginalMethod.get(key)?.promise===original)this.rawByOriginalMethod.delete(key);
   });
   const owned={params:encoded,promise:raw};this.rawByOriginalMethod.set(key,owned);this.rawRequests.add(raw);
   }finally{this.enteringRaw.delete(key);}
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{const result=await Promise.race([raw,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Original RPC outcome unconfirmed')),this.rpcMs);})]);
   this.authority(this.read(value.id),scope);return result;
  }finally{if(timer)clearTimeout(timer);}
 }
 private async capabilities(value:FeedWorkerSaved){
  const caps=workerCapabilitiesSchema.parse(await this.rpc(value,'e3.assignments.capabilities',{epoch:value.command.epoch}));
  if(caps.epoch!==value.command.epoch||value.hostId&&caps.hostId!==value.hostId||value.runtimeVersion&&caps.runtimeVersion!==value.runtimeVersion)
   throw new Error('Original worker host/runtime changed');return caps;
 }
 private receipt(value:FeedWorkerSaved,raw:unknown,allowBarrier=false):WorkerReceipt{
  const receipt=workerReceiptSchema.parse(raw),identity=this.identity(value);
  if(size(receipt)>feedWorkerLimits.receiptBytes||receipt.epoch!==identity.epoch||receipt.hostId!==identity.hostId||receipt.attemptId!==identity.attemptId||receipt.inputHash!==identity.inputHash||
   receipt.runId!==value.runId||receipt.sessionKey!==value.sessionKey||receipt.toolMode!==undefined||receipt.nativeTools!==undefined||
   receipt.deadlineAt!==value.deadlineAt&&!(allowBarrier&&value.stop?.attemptedAt&&receipt.state==='cancelled'&&receipt.stopRequested&&receipt.deadlineAt===undefined))
   throw new Error('Original worker receipt mismatch');
  const current=this.read(value.id);this.change(value.id,{originalReceipt:current.originalReceipt??receipt,latestReceipt:receipt});return receipt;
 }
 start(deviceId:string,raw:unknown){return this.historyOwner.sync('callback',()=>this.startOwned(deviceId,raw));}
 private startOwned(deviceId:string,raw:unknown){
  const command=commandSchema.parse(raw),request={kind:'start' as const,command},intent=feedWorkerIntent(command);
  const previous=this.readOriginal(deviceId,request);if(previous.state==='confirmed')return previous;
  this.store.assertUpdateAdmission();if(this.closing)throw new Error('Feed worker closing');if(this.rawRequests.size)throw new Error('An original Feed raw request remains unresolved');
  const observe=()=>{const current=this.sources.current(deviceId),capture=this.captured(command,current,command.expectation.preparedAt);return {expectedRevision:capture.source.context.profile.revision,captureSha256:adaptiveHash(capture,workerInputHash),modelInputSha256:workerInputHash(promptFor(capture,workerInputHash)),nativePolicySha256:adaptiveHash(current.policy,workerInputHash),newStartReady:current.newStartReady};};
  const disposition=this.local().refuseKnownStart(this.caller(deviceId),request,observe);if(disposition.state!=='eligible-unadmitted')return disposition;
  this.store.assertFeedExternalEffectAllowed();
  const admitted=this.admit(deviceId,command,intent,()=>{
   const graph=this.draft!.graph;if(graph.originalRequests.has(command.requestId)||graph.reservedCloseCommands.has(command.requestId))throw new Error('Original adaptive identity already retained');
   const current=this.sources.current(deviceId),capture=this.captured(command,current,command.expectation.preparedAt),connection=this.gateway.status(),at=this.now(),prompt=promptFor(capture,workerInputHash);
   const refusal=knownStartRefusal(command,at,{expectedRevision:capture.source.context.profile.revision,captureSha256:adaptiveHash(capture,workerInputHash),modelInputSha256:workerInputHash(prompt),nativePolicySha256:adaptiveHash(current.policy,workerInputHash),newStartReady:current.newStartReady});
   if(refusal)throw new Error('Original adaptive admission changed: '+refusal);
   if(!current.authorized||current.deviceId!==deviceId||current.epoch!==command.epoch||current.policy.generation!==connection.generation)throw new Error('Current adaptive authority changed');
   const value:FeedWorkerSaved={format:3,revision:1,ownerStops:[],id:command.requestId,deviceId,command,capture,policy:structuredClone(current.policy),route:structuredClone(current.policy.route),generation:connection.generation!,
    createdAt:at,deadlineAt:command.expectation.deadlineAt,prompt,inputHash:workerInputHash(prompt),state:'prepared',reason:'prepared',events:[{kind:'prepared',at}]};
   this.newWork(value);if([...graph.workers.values()].some(row=>!['completed','failed','cancelled','withdrawn','rejected'].includes(row.state)))throw new Error('An original Feed worker remains unresolved');
   return feedWorkerReceipt(this.save(value,command.requestId),workerInputHash);
  });
  if(admitted.fresh)this.track(()=>{this.dispatches.add(admitted.value.id);return this.dispatch(admitted.value.id).finally(()=>this.dispatches.delete(admitted.value.id));});
  return this.readOriginal(deviceId,request);
 }
 private async dispatch(id:string){
  try{let value=this.read(id);this.newWork(value);const caps=await this.capabilities(value);value=this.read(id);if(terminal(value))return;
   this.newWork(value);if(!caps.newRunsAvailable)throw new Error('Worker result storage is full');
   const identity={epoch:value.command.epoch,hostId:caps.hostId,attemptId:value.id,inputHash:value.inputHash};
   value=this.change(id,{...workerNativeIdentity(identity),hostId:caps.hostId,runtimeVersion:caps.runtimeVersion,
    dispatchAt:this.now(),state:'dispatching',reason:'original-dispatch'},'dispatch');
   const raw=await this.rpc(value,'e3.assignments.run',{...identity,message:value.prompt,deadlineAt:value.deadlineAt});
   value=this.read(id);if(terminal(value))return;const receipt=this.receipt(value,raw,!!value.stop);
   if(receipt.state==='cancelled')this.finished(id,{kind:'barrier',at:this.now(),receipt});
   else{this.change(id,{state:receipt.state==='accepted'?'running':'unknown',reason:this.closing?'closed-original-retained':'original-receipt'});
    if(!this.closing&&!this.fresh(this.read(id)))this.requestStop(this.read(id),'context',id);}
  }catch{const value=this.read(id);if(!terminal(value)){
   if(!value.dispatchAt)this.finished(id,{kind:'not-sent',at:this.now(),reason:'not-dispatched'});
   else this.change(id,{state:'unknown',reason:'original-dispatch-unconfirmed'},'dispatch-unknown');}}
 }
 private requestStop(value:FeedWorkerSaved,reason:Stop['reason'],requestId:string,admitting?:string){
  if(terminal(value)||value.stop)return value;
  const requestedAt=reason==='owner'?value.ownerStops.find(owner=>owner.command.requestId===requestId)!.at:this.now();
  const stop:Stop={reason,requestId,requestedAt,state:'requested'};
  if(!value.dispatchAt){const derived=deriveFeedTerminal({...value,stop},{kind:'not-sent',at:this.now(),reason:'cancelled-before-dispatch'},undefined,workerInputHash);
   return this.change(value.id,{stop,...derived},'terminal:cancelled',admitting);}
  return this.change(value.id,{stop,reason:'original-stop-requested'},'stop-request',admitting);
 }
 stop(deviceId:string,raw:unknown){return this.historyOwner.run<FeedWorkerSummary|ReturnType<FeedAdaptiveLocalProtocol['terminalStop']>>('callback',()=>this.stopOwned(deviceId,raw));}
 private stopOwned(deviceId:string,raw:unknown){const input=ownerStopCommandSchema.parse(raw);
  const value=this.read(input.id);if(value.deviceId!==deviceId)throw new Error('Original owner required');
  if(terminal(value))return Promise.resolve(this.local().terminalStop(this.caller(deviceId),input));
  this.store.assertFeedExternalEffectAllowed();
  this.authority(value,'operator.write');
  this.admit(deviceId,input,feedStopIntent(input),()=>{const original=this.read(input.id);
   if(original.ownerStops.length>=16)throw new Error('Original stop admission bound reached');
   const captured=this.change(input.id,{ownerStops:[...original.ownerStops,{command:input,deviceId,at:this.now()}]},undefined,input.requestId);
   this.requestStop(captured,'owner',input.requestId,input.requestId);return feedStopReceipt(input,captured.ownerStops[captured.ownerStops.length-1].at,workerInputHash);});
  return this.check(deviceId,input.id);
 }
 private async cancelOriginal(id:string){let value=this.read(id);if(!value.stop||!value.dispatchAt||terminal(value))return;
  if(value.stop.state==='requested'){
   value=this.change(id,{stop:{...value.stop,attemptedAt:this.now(),state:'dispatching'}},'stop-dispatch');
   try{const receipt=this.receipt(value,await this.rpc(value,'e3.assignments.stop',this.identity(value)),true);value=this.read(id);
    if(receipt.state==='cancelled'){this.finished(id,{kind:'barrier',at:this.now(),receipt});return;}
    if(!receipt.stopRequested)throw new Error('Original stop not confirmed');this.change(id,{stop:{...value.stop!,state:'acknowledged'}});
   }catch{value=this.read(id);if(!terminal(value))this.change(id,{state:'unknown',stop:{...value.stop!,state:'unknown'},reason:'original-stop-unconfirmed'});}
  }
 }
 private async abortOriginal(value:FeedWorkerSaved){if(!value.stop||value.stop.abort||this.closing)return;
  value=this.change(value.id,{stop:{...value.stop,abort:{attemptedAt:this.now(),state:'dispatching'}}},'abort-dispatch');
  try{const raw=await this.rpc(value,'chat.abort',{sessionKey:value.sessionKey,runId:value.runId,preserveSideRuns:true});
   const result=z.object({aborted:z.boolean(),runIds:z.array(uuid).max(100)}).passthrough().parse(raw);
   if(!result.aborted||!result.runIds.includes(value.runId!))throw new Error('Original abort unconfirmed');
   const current=this.read(value.id);this.change(value.id,{stop:{...current.stop!,abort:{...current.stop!.abort!,state:'acknowledged'}}});
  }catch{const current=this.read(value.id);if(!terminal(current))this.change(value.id,{state:'unknown',reason:'original-abort-unconfirmed',
   stop:{...current.stop!,abort:{...current.stop!.abort!,state:'unknown'}}});}
 }
 check(deviceId:string,id:string):Promise<FeedWorkerSummary>{
  const value=this.read(id);if(value.deviceId!==deviceId)return Promise.reject(new Error('Original owner required'));
  if(!terminal(value))this.store.assertFeedExternalEffectAllowed();
  const existing=this.checks.get(id);if(existing)return existing;
  if(this.enteringChecks.has(id))throw Error('Original check entry is already in progress');
  this.enteringChecks.add(id);
  try{return this.track(()=>{const work=this.reconcile(id).finally(()=>this.checks.delete(id));this.checks.set(id,work);return work;});}
  finally{this.enteringChecks.delete(id);}
 }
 private async reconcile(id:string):Promise<FeedWorkerSummary>{
  let value=this.read(id);this.authority(value);if(this.closing)return summary(value);
  if(terminal(value))return summary(value);
  this.store.assertFeedExternalEffectAllowed();
  if(!value.dispatchAt){if(!this.dispatches.has(id))value=this.finished(id,{kind:'not-sent',at:this.now(),reason:'not-dispatched-after-restart'});return summary(value);}
  try{await this.capabilities(value);value=this.read(id);if(this.closing)return summary(value);
   if(this.now()>=value.deadlineAt)value=this.requestStop(value,'deadline',value.id);
   else if(!this.fresh(value))value=this.requestStop(value,'context',value.id);
   await this.cancelOriginal(id);value=this.read(id);if(terminal(value)||this.closing)return summary(value);
   const result=workerStatusSchema.parse(await this.rpc(value,'e3.assignments.status',this.identity(value)));value=this.read(id);
   if(this.closing)return summary(value);
   if(!result.receipt)return summary(this.change(id,{state:'unknown',reason:'original-receipt-unavailable'}));
   const receipt=this.receipt(value,result.receipt,true);
   if(receipt.state==='cancelled')return summary(this.finished(id,{kind:'barrier',at:this.now(),receipt}));
   const observation=result.observation;
   if(!observation||observation.runId!==value.runId||!isSettledWorkerObservation(observation)){
    if(value.stop&&receipt.stopRequested){if(value.stop.state!=='acknowledged')value=this.change(id,{stop:{...value.stop,state:'acknowledged'}});await this.abortOriginal(value);}
    return summary(this.change(id,{state:value.stop||result.observationUnavailable?'unknown':'running',reason:value.stop?'original-stop-pending':'original-running'}));
   }
   if(observation.status==='error'){const captured=captureObservedBasis(result,this.now(),undefined,undefined,workerInputHash);
    return summary(this.finished(id,captured.basis,captured.output));}
   const terminalReceipt=observation.terminalReceipt!;
   const history=await this.rpc(value,'chat.history',{sessionKey:value.sessionKey,limit:1}) as {sessionId?:string};value=this.read(id);
   if(this.closing)return summary(value);
   if(history.sessionId!==terminalReceipt.sessionId)throw new Error('Original history session changed');
   const captured=captureObservedBasis(result,this.now(),{sessionKey:value.sessionKey!,limit:1,sessionId:history.sessionId},this.currentEvidence(value),workerInputHash);
   return summary(this.finished(id,captured.basis,captured.output));
  }catch{value=this.read(id);return summary(terminal(value)?value:this.change(id,{state:'unknown',reason:'original-observation-unconfirmed'}));}
 }
 maintenanceBlockers(){const values=this.all();return {'feed-semantic':values.filter(value=>!terminal(value)).length,'feed-semantic-rpc':this.rawRequests.size};}
 async settle(){await Promise.allSettled([...this.jobs]);}
 async close(waitMs:number=feedWorkerLimits.rpcMs){
  if(!Number.isInteger(waitMs)||waitMs<1||waitMs>feedWorkerLimits.rpcMs)throw new Error('Invalid close bound');this.closing=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.allSettled([...this.jobs,...this.rawRequests]),new Promise<void>(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
  finally{if(timer)clearTimeout(timer);}
  return {localSettled:this.jobs.size===0&&this.rawRequests.size===0,blockers:this.maintenanceBlockers()};
 }
}
