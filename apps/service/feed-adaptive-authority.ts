import {claimFeedHistoryOwner,feedHistoryOwnerBlockers,type HistoryOwnerPort,type HistoryOwnerToken} from './feed-history-owner-observer.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';
import {Fault,type Store} from './store.js';
import type {AssistantTransport} from './gateway.js';
import type {ChatGptAccount} from './chatgpt-account.js';
import {FeedAdaptiveWorker} from './feed-adaptive-worker.js';
import {FeedAdaptiveLocalProtocol,type FeedLedgerReader,type FeedLocalCaller} from './feed-adaptive-local-protocol.js';
import {workerInputHash as hash,workerNativeIdentity} from './worker-plugin/identity.js';
import {verifyFeedLocalGraph,knownStartRefusal} from '../../packages/domain/news-feed-successor-journal.js';
import {captureAdaptiveOriginal,type AdaptiveAuthority,type AdaptiveNativePolicy} from '../../packages/domain/news-feed-adaptive-capture.js';
import {adaptiveHash} from '../../packages/domain/news-feed-adaptive.js';
import {feedStartPreparationSchema,feedStartV3Schema,type FeedStartPreparation,type FeedStartV3} from '../../packages/domain/news-feed-semantic-protocol.js';
import {ownerStopCommandSchema,summary,same,promptFor,terminal,type FeedWorkerSaved,type FeedWorkerSummary} from '../../packages/domain/news-feed-adaptive-worker.js';
import type {FeedStory} from '../../packages/domain/news-feed.js';

export type FeedAdaptiveOwner={readonly deviceId:string;readonly epoch:string;authorize():void};
export type FeedAdaptiveAuthorityPorts={
 routingPolicy():{revision:string;busy:boolean};
 qualification():{id:string;available:boolean};
 /** Trusted synchronous current permissions; never request-body assertions. */
 permissions(owner:FeedAdaptiveOwner):{read:boolean;write:boolean};
 /** Called in one Store snapshot. Full collection failure is source:null;
  * it must not remove independently available writing or original read access. */
 source(owner:FeedAdaptiveOwner):Pick<AdaptiveAuthority,'writing'|'source'>;
 story(owner:FeedAdaptiveOwner,id:string):FeedStory|undefined;
};
export const feedAdaptiveAuthorityLimits={preparationMs:30000,ticketMs:30000,closeMs:30000,callbacks:16,rawCalls:8} as const;
const identity=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),uuid=z.string().uuid();
const routingSchema=z.object({revision:identity,busy:z.boolean()}).strict();
const qualificationSchema=z.object({id:identity,available:z.boolean()}).strict();
const permissionSchema=z.object({read:z.boolean(),write:z.boolean()}).strict();
const modelSchema=z.object({id:z.string().min(1).max(200),provider:z.string().min(1).max(200),available:z.boolean(),isDefault:z.boolean()}).passthrough();
type Owner={readonly deviceId:string;readonly epoch:string;authorize():void};
type Policy={accountKey:string;generation:string;qualificationId:string;configurationRevision:string;routingRevision:string;busy:boolean};
type Ready={captureSha256:string;capturedAt:number;createdAt:number;expiresAt:number;monotonicExpiry:number;admissionUsed:boolean};
type Lease={owner:Owner;descriptor:FeedStartPreparation;command?:FeedStartV3;policy:Policy;route:AdaptiveNativePolicy['route'];ready?:Ready};
const descriptorOf=(command:FeedStartV3):FeedStartPreparation=>{
 const {expectation:_expectation,expectedRevision:_revision,...descriptor}=command;return feedStartPreparationSchema.parse(descriptor);
};

/** Outside-app adaptive successor. HTTP/controller, protected Store, current
 * source and actual native qualification remain mandatory composition gates.
 * Preparation returns a command only. A later explicit start rechecks readiness
 * under its own original authenticated request; no serialized ticket is authority. */
export class FeedAdaptiveAuthority{
 private readonly historyOwner:HistoryOwnerPort;
 private readonly context=new AsyncLocalStorage<Lease>();
 private readonly worker:FeedAdaptiveWorker;
 private preparing=false;
 private closing=false;
 private readonly jobs=new Set<Promise<unknown>>();
 private readonly raw=new Set<Promise<unknown>>();
 private readonly producers=new Set<Promise<unknown>>();
 private producerReserved=false;
 constructor(private store:Store,private gateway:AssistantTransport,private account:Pick<ChatGptAccount,'route'>|undefined,
  private ports:FeedAdaptiveAuthorityPorts,private ledger:FeedLedgerReader,private now=Date.now,
  private limits:{preparationMs:number;ticketMs:number;rpcMs:number}={...feedAdaptiveAuthorityLimits,rpcMs:90000}){
  for(const [value,max] of [[limits.preparationMs,90000],[limits.ticketMs,30000],[limits.rpcMs,90000]])
   if(!Number.isInteger(value)||value<1||value>max)throw new Error('Invalid finite adaptive authority bound');
  for(const key of ['routingPolicy','qualification','permissions','source','story'] as const)
   if(typeof ports?.[key]!=='function')throw new Error('Adaptive authority observations are required');
  if(typeof ledger!=='function')throw new Error('Complete Store ledger reader required');
  this.limits=Object.freeze({...limits});
  this.historyOwner=claimFeedHistoryOwner(store,'adaptive-authority');
  const transport:AssistantTransport={status:()=>gateway.status(),models:()=>{throw new Error('Explicit guarded preparation required');},
   attachmentPolicy:()=>gateway.attachmentPolicy(),subscribe:listener=>gateway.subscribe(listener),
   request:<T>(method:string,params:unknown)=>this.workerRequest<T>(method,params)};
  try{this.worker=new FeedAdaptiveWorker(store,transport,{current:deviceId=>this.current(deviceId),story:id=>this.story(id)},ledger,now,limits.rpcMs);}catch(error){this.historyOwner.taint(error);throw error;}
 }
 private owner(input:FeedAdaptiveOwner):Owner{
  if(typeof input?.authorize!=='function')throw new Error('Authenticated original request required');
  const callback=input.authorize.bind(input),owner=Object.freeze({deviceId:identity.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:callback});
  this.authorize(owner);return owner;
 }
 private authorize(owner:Owner,write=false){
  const result:unknown=owner.authorize();
  if(result!==undefined){void Promise.resolve(result).catch(()=>undefined);throw new Error('Original authorization must be synchronous');}
  if(owner.epoch!==this.store.epoch)throw new Error('Original workspace changed');
  const permissions=permissionSchema.parse(this.ports.permissions(owner));
  if(!permissions.read||write&&!permissions.write)throw new Error('Original Feed permission changed');
  return permissions;
 }
 /** Capability presentation follows the same actual identity used by native
  * requests. Local read/write permissions remain independently authorized. */
 nativeCapabilities(input:FeedAdaptiveOwner):{prepare:boolean;observe:boolean;reason:'available'|'held'|'unavailable'}{
  const owner=this.owner(input),permissions=this.authorize(owner);
  try{
   if(this.closing)return {prepare:false,observe:false,reason:'held'};
   const policy=this.policy(owner);
   const connection=this.gateway.status();
   return {prepare:permissions.write&&!!this.account&&!policy.busy&&connection.modelAuthReady&&connection.grantedScopes.includes('operator.write'),observe:true,reason:'available'};
  }catch{return {prepare:false,observe:false,reason:'unavailable'};}
  finally{this.authorize(owner);}
 }
 private policy(owner:Owner):Policy{
  this.authorize(owner);
  const connection=this.gateway.status(),routing=routingSchema.parse(this.ports.routingPolicy()),qualification=qualificationSchema.parse(this.ports.qualification());
  const revision=this.store.internalGatewayConfigurationRevision();
  if(this.store.recoveryEffectsPaused||connection.state!=='ready'||!connection.generation||typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1||!qualification.available||!connection.grantedScopes.includes('operator.read'))
   throw new Fault(409,'feed_native_unavailable','Original native authority unavailable. Saved requests remain available to check.');
  const configurationRevision=String(revision);
  const accountKey=hash(JSON.stringify({format:1,policy:'native-main-local',epoch:owner.epoch,deviceId:owner.deviceId,
   configurationRevision,generation:connection.generation,qualification:qualification.id}));
  return {accountKey,generation:connection.generation,qualificationId:qualification.id,configurationRevision,routingRevision:routing.revision,busy:routing.busy};
 }
 private check(lease:Lease,write=false){
  this.authorize(lease.owner,write);const policy=this.policy(lease.owner);
  if(policy.accountKey!==lease.policy.accountKey||policy.generation!==lease.policy.generation||write&&!this.gateway.status().grantedScopes.includes('operator.write'))
   throw new Error('Original native policy or scope changed');
  return policy;
 }
 private nativePolicy(lease:Lease):AdaptiveNativePolicy{return {route:structuredClone(lease.route),generation:lease.policy.generation,
  qualificationId:lease.policy.qualificationId,configurationRevision:lease.policy.configurationRevision};}
 private capture(lease:Lease,at:number){return this.store.internalReadSnapshot(()=>{
  this.authorize(lease.owner,true);const data=this.ports.source(lease.owner),graph=verifyFeedLocalGraph(this.ledger(),hash,workerNativeIdentity);
  const descriptor=lease.descriptor,source=descriptor.kind==='interpret'?data.writing:data.source;
  if(!source)throw new Error('Current adaptive source unavailable');
  const basis=descriptor.kind==='interpret'?null:descriptor.basis.kind==='empty-written'?{kind:'empty' as const}:graph.adaptiveReviews.get(descriptor.basis.reviewId)?.source??null;
  const story=descriptor.kind==='classify'?this.ports.story(lease.owner,descriptor.story.id):undefined;
  const captured=captureAdaptiveOriginal(lease.command??descriptor,source,basis,story,at,hash);
  this.authorize(lease.owner,true);return structuredClone(captured);
 });}
 private ready(lease:Lease){
  const ready=lease.ready;if(!ready||this.closing||this.now()<ready.createdAt||this.now()>=ready.expiresAt||performance.now()>=ready.monotonicExpiry)return false;
  const policy=this.check(lease,true);if(policy.busy||policy.routingRevision!==lease.policy.routingRevision)return false;
  const at=lease.command?.expectation.preparedAt??ready.capturedAt;
  return adaptiveHash(this.capture(lease,at),hash)===ready.captureSha256;
 }
 private current(deviceId:string):AdaptiveAuthority{
  const lease=this.context.getStore();if(!lease||lease.owner.deviceId!==deviceId)throw new Error('Exact authenticated original lease required');
  this.check(lease);return this.store.internalReadSnapshot(()=>{
   const data=structuredClone(this.ports.source(lease.owner)),permissions=this.authorize(lease.owner);
   const value={...data,deviceId:lease.owner.deviceId,epoch:lease.owner.epoch,authorized:true,writeAuthorized:permissions.write,
    policy:this.nativePolicy(lease),newStartReady:this.ready(lease)};this.authorize(lease.owner);return value;
  });
 }
 private story(id:string){
  const lease=this.context.getStore();if(!lease||lease.descriptor.kind!=='classify'||lease.descriptor.story.id!==id)throw new Error('Exact original story required');
  this.check(lease);return this.store.internalReadSnapshot(()=>{const value=this.ports.story(lease.owner,id);this.authorize(lease.owner);return structuredClone(value);});
 }
 private caller(owner:Owner):FeedLocalCaller{return {deviceId:owner.deviceId,epoch:owner.epoch,current:()=>{
  const value=this.authorize(owner);return {deviceId:owner.deviceId,epoch:owner.epoch,read:value.read,write:value.write};
 }};}
 private local(){return new FeedAdaptiveLocalProtocol(this.store,this.ledger,hash,workerNativeIdentity,this.now);}
 private owned<T>(produce:()=>Promise<T>,set=this.jobs,kind:'callback'|'preparation'|'read'|'run'|'abort'='callback'){return this.historyOwner.run(kind,()=>{const work=produce();set.add(work);return work;},work=>{set.delete(work);});}
 private rawCall<T>(lease:Lease,call:()=>Promise<T>,write=false,kind:'read'|'run'|'abort'=write?'run':'read'){
  this.store.assertFeedExternalEffectAllowed();
  this.check(lease,write);if(this.closing||this.raw.size>=feedAdaptiveAuthorityLimits.rawCalls)throw new Error('Adaptive raw requests are held');
  // The original promise remains owned through both success/error authorization.
  return this.owned(()=>Promise.resolve().then(()=>{this.check(lease,write);return call();}).finally(()=>this.check(lease,write)),this.raw,kind);
 }
 private workerRequest<T>(method:string,params:unknown):Promise<T>{
  const lease=this.context.getStore();if(!lease)return Promise.reject(new Error('Exact authenticated original lease required'));
  const reads=['e3.assignments.capabilities','e3.assignments.status','chat.history'],writes=['e3.assignments.run','e3.assignments.stop','chat.abort'];
  if(!reads.includes(method)&&!writes.includes(method)||!this.gateway.status().methods.includes(method))return Promise.reject(new Error('Original native method unavailable'));
  return this.rawCall(lease,()=>{
   if(method==='e3.assignments.run'&&(!lease.ready?.admissionUsed||!this.ready(lease)||!this.gateway.status().modelAuthReady))throw new Error('Original dispatch readiness changed');
   return this.gateway.request<T>(method,params);
  },writes.includes(method),method==='e3.assignments.run'?'run':writes.includes(method)?'abort':'read');
 }
 private async finite<T>(work:Promise<T>,deadline:number){
  const remaining=deadline-this.now();if(remaining<=0)throw new Error('Original preparation deadline elapsed');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Original preparation outcome unconfirmed')),remaining);})]);}
  finally{if(timer)clearTimeout(timer);}
 }
 private preparationCurrent(lease:Lease,captureSha256:string,at:number,start:number,deadline:number,monotonicExpiry:number){
  const policy=this.check(lease,true);
  if(this.closing||this.now()<start||this.now()>=deadline||performance.now()>=monotonicExpiry||policy.busy||policy.routingRevision!==lease.policy.routingRevision)
   throw new Error('Original preparation no longer current');
  if(adaptiveHash(this.capture(lease,at),hash)!==captureSha256)throw new Error('Current adaptive capture changed during preparation');
 }
 private withReady<T>(owner:Owner,descriptor:FeedStartPreparation,command:FeedStartV3|undefined,complete:(lease:Lease)=>T):Promise<T>{
  this.store.assertFeedExternalEffectAllowed();
  if(this.closing||this.preparing||this.raw.size||this.jobs.size||Object.values(this.worker.maintenanceBlockers()).some(Boolean))throw new Error('Original work holds preparation');
  this.authorize(owner,true);this.store.assertUpdateAdmission();
  const account=this.account;if(!account)throw new Fault(409,'feed_native_unavailable','Original managed account route unavailable. Saved requests remain available to check.');
  const policy=this.policy(owner);if(policy.busy)throw new Error('Account routing is changing');
  const start=this.now(),deadline=Math.min(start+this.limits.preparationMs,command?.expectation.deadlineAt??Number.MAX_SAFE_INTEGER);
  if(deadline<=start)throw new Error('Original preparation deadline elapsed');
  const monotonicExpiry=performance.now()+(deadline-start),at=command?.expectation.preparedAt??start;
  const lease:Lease={owner,descriptor,command,policy,route:{accountKey:policy.accountKey,provider:'pending',model:'pending'}};
  const captured=this.capture(lease,at),captureSha256=adaptiveHash(captured,hash);
  if(command&&(command.expectedRevision!==captured.source.context.profile.revision||command.expectation.captureSha256!==captureSha256||command.expectation.modelInputSha256!==hash(promptFor(captured,hash))))
   throw new Error('Original prepared capture changed');
  return this.owned(()=>{this.preparing=true;return this.context.run(lease,async()=>{
   let readyOwner:HistoryOwnerToken|undefined;
   const guard=()=>this.preparationCurrent(lease,captureSha256,at,start,deadline,monotonicExpiry);
   try{
    guard();if(!this.gateway.status().methods.includes('models.list')||typeof this.gateway.modelsWithAuthority!=='function')throw new Error('Guarded model catalog unavailable');
    const catalog=await this.finite(this.rawCall(lease,()=>{guard();return this.gateway.modelsWithAuthority!(guard);}),deadline);guard();
    const models=z.array(modelSchema).max(1000).parse(catalog).filter(model=>model.isDefault);
    if(models.length!==1||!models[0].available)throw new Error('One explicit available default model required');
    const selected=models[0],prefix=selected.provider+'/';
    if(selected.provider!=='openai'||!selected.id.startsWith(prefix)||selected.id.length===prefix.length)throw new Error('Supported managed default unavailable');
    if(!this.gateway.status().methods.includes('e3.accounts.snapshot'))throw new Error('Account routing observation unavailable');
    const candidate=await this.finite(this.rawCall(lease,()=>{guard();return account.route({model:selected.id});}),deadline);guard();
    if(!candidate||typeof candidate.profileId!=='string'||!candidate.profileId||!Number.isFinite(candidate.checkedAt)||candidate.checkedAt<start||candidate.checkedAt>this.now())
     throw new Error('Current eligible account candidate unconfirmed');
    lease.route={accountKey:policy.accountKey,provider:selected.provider,model:selected.id.slice(prefix.length)};
    if(command&&command.expectation.nativePolicySha256!==adaptiveHash(this.nativePolicy(lease),hash))throw new Error('Original prepared native policy changed');
    const createdAt=this.now(),expiresAt=Math.min(createdAt+this.limits.ticketMs,command?.expectation.deadlineAt??Number.MAX_SAFE_INTEGER);
    readyOwner=this.historyOwner.enter('ticket');lease.ready={captureSha256,capturedAt:at,createdAt,expiresAt,monotonicExpiry:performance.now()+(expiresAt-createdAt),admissionUsed:false};
    const result=complete(lease);this.check(lease,true);return result;
   }finally{this.preparing=false;try{this.authorize(owner,true);}finally{readyOwner?.finish();}}
  });},this.jobs,'preparation');
 }
 readOriginal(input:FeedAdaptiveOwner,request:unknown){const owner=this.owner(input);try{return this.local().readOriginal(this.caller(owner),request);}finally{this.authorize(owner);}}
 history(input:FeedAdaptiveOwner,request:unknown={}){const owner=this.owner(input);try{return this.local().history(this.caller(owner),request);}finally{this.authorize(owner);}}
 closeOriginal(input:FeedAdaptiveOwner,command:unknown){const owner=this.owner(input);if(this.closing)throw new Error('Adaptive authority is closing');
  try{return this.local().closeOriginal(this.caller(owner),command);}finally{this.authorize(owner,true);}}
 private retained(owner:Owner,id:string){uuid.parse(id);this.authorize(owner);return this.store.internalReadSnapshot(()=>{
  const graph=verifyFeedLocalGraph(this.ledger(),hash,workerNativeIdentity),value=graph.adaptiveWorkers.get(id);
  if(!value||value.deviceId!==owner.deviceId)throw new Fault(404,'feed_original_unavailable','Original adaptive request unavailable. Check the exact saved request receipt.');this.authorize(owner);return structuredClone(value);
 });}
 readRetained(input:FeedAdaptiveOwner,id:string){const owner=this.owner(input);uuid.parse(id);
  try{return this.store.internalWithFeedReadGraph(graph=>{const value=graph.adaptiveWorkers.get(id);
   if(!value||value.deviceId!==owner.deviceId)throw new Fault(404,'feed_original_unavailable','Original adaptive request unavailable. Check the exact saved request receipt.');
   this.authorize(owner);return summary(value);});}finally{this.authorize(owner);}
 }
 prepare(input:FeedAdaptiveOwner,raw:unknown){return this.historyOwner.run('callback',()=>this.prepareOwned(input,raw));}
 private prepareOwned(input:FeedAdaptiveOwner,raw:unknown):Promise<FeedStartV3>{
  const owner=this.owner(input),descriptor=feedStartPreparationSchema.parse(raw);if(descriptor.epoch!==owner.epoch)throw new Error('Original workspace changed');
  return this.withReady(owner,descriptor,undefined,lease=>{
   const command=this.local().prepareStart(this.caller(owner),descriptor,(_descriptor,at)=>{
    if(!this.ready(lease)||!this.gateway.status().modelAuthReady)throw new Error('Original preparation readiness changed');
    const captured=this.capture(lease,at);
    return {expectedRevision:captured.source.context.profile.revision,captureSha256:adaptiveHash(captured,hash),modelInputSha256:hash(promptFor(captured,hash)),
     nativePolicySha256:adaptiveHash(this.nativePolicy(lease),hash),newStartReady:true};
   });lease.command=command;
   // No in-memory readiness survives this passive response. A separate explicit
   // start obtains its own lease while retaining these exact command bytes.
   lease.ready=undefined;return command;
  });
 }
 start(input:FeedAdaptiveOwner,raw:unknown){return this.historyOwner.run('callback',()=>this.startOwned(input,raw));}
 private startOwned(input:FeedAdaptiveOwner,raw:unknown){
  const owner=this.owner(input),command=feedStartV3Schema.parse(raw),request={kind:'start' as const,command};
  const previous=this.readOriginal(owner,request);if(previous.state==='confirmed')return Promise.resolve(previous).finally(()=>this.authorize(owner));
  if(this.closing)throw new Error('Adaptive authority is closing');
  if(command.epoch!==owner.epoch)throw new Error('Historical original is read-only');
  if(knownStartRefusal(command,this.now())){
   const result=this.local().refuseKnownStart(this.caller(owner),request,()=>{throw new Error('Invalid command must not prepare native work');});
   return Promise.resolve(result).finally(()=>this.authorize(owner));
  }
  this.store.assertFeedExternalEffectAllowed();
  return this.withReady(owner,descriptorOf(command),command,lease=>{
   if(!lease.ready||lease.ready.admissionUsed||!this.ready(lease))throw new Error('Exact private readiness required');
   lease.ready.admissionUsed=true;return this.worker.start(owner.deviceId,command);
  });
 }
 private original(owner:Owner,value:FeedWorkerSaved):Lease{
  if(value.command.epoch!==owner.epoch)throw new Error('Historical original is read-only');
  const policy=this.policy(owner);
  if(policy.accountKey!==value.route.accountKey||policy.generation!==value.policy.generation||policy.qualificationId!==value.policy.qualificationId||policy.configurationRevision!==value.policy.configurationRevision)
   throw new Error('Original native policy changed');
  return {owner,descriptor:descriptorOf(value.command),command:value.command,policy,route:structuredClone(value.route)};
 }
 observe(input:FeedAdaptiveOwner,id:string){return this.historyOwner.run('callback',()=>this.observeOwned(input,id));}
 private observeOwned(input:FeedAdaptiveOwner,id:string){
  const owner=this.owner(input),value=this.retained(owner,id);
  if(terminal(value))return Promise.resolve(summary(value)).finally(()=>this.authorize(owner));
  if(this.closing||this.jobs.size>=feedAdaptiveAuthorityLimits.callbacks)throw new Error('Observation capacity held');
  this.store.assertFeedExternalEffectAllowed();
  const lease=this.original(owner,value);
  return this.owned(()=>this.context.run(lease,async()=>{try{this.check(lease);return await this.worker.check(owner.deviceId,id);}finally{this.check(lease);}}));
 }
 stop(input:FeedAdaptiveOwner,raw:unknown){return this.historyOwner.run<FeedWorkerSummary|ReturnType<FeedAdaptiveLocalProtocol['terminalStop']>>('callback',()=>this.stopOwned(input,raw));}
 private stopOwned(input:FeedAdaptiveOwner,raw:unknown){
  const owner=this.owner(input),command=ownerStopCommandSchema.parse(raw),value=this.retained(owner,command.id);
  if(this.closing)throw new Error('Adaptive authority is closing');
  if(command.epoch!==owner.epoch)throw new Error('Original Stop workspace changed');
  if(terminal(value)){try{return Promise.resolve(this.local().terminalStop(this.caller(owner),command)).finally(()=>this.authorize(owner,true));}finally{this.authorize(owner,true);}}
  if(this.closing||this.jobs.size>=feedAdaptiveAuthorityLimits.callbacks)throw new Error('Observation capacity held');
  this.store.assertFeedExternalEffectAllowed();
  const lease=this.original(owner,value);
  return this.owned(()=>this.context.run(lease,async()=>{try{this.check(lease,true);return await this.worker.stop(owner.deviceId,command);}finally{this.check(lease,true);}}));
 }
 /** Internal lifetime only: the caller still needs current authorization for
  * every effect. This bucket deliberately stays outside native readiness jobs,
  * so a step can prepare its own request and retain ownership through its save.
  * Nested controller calls must use the supplied captured owner. */
 internalOwnProducerStep<T>(input:FeedAdaptiveOwner,produce:(owner:FeedAdaptiveOwner)=>Promise<T>):Promise<T>{
  if(this.closing||this.producerReserved)throw new Error('Automatic producer ownership held');
  this.producerReserved=true;
  try{
   // Register a native Promise before any caller getter, authorization or body
   // runs. Reentry cannot acquire another slot; thenables stay owned until their
   // actual settlement, including the final authorization check.
   const work=this.owned<T>(()=>Promise.resolve().then(async()=>{
    if(this.closing)throw new Error('Adaptive authority is closing');
    const authority=this;let stepOpen=true,invalidAuthorization:Promise<void>|undefined;
    try{
     const callback=input?.authorize;
     if(typeof callback!=='function')throw new Error('Authenticated original request required');
     const owner=this.owner({get deviceId(){return input.deviceId;},get epoch(){return input.epoch;},authorize(){
      // Worker dispatch can legitimately continue after admission returned.
      // Late authorization enters before the callback and transfers that exact
      // token if the callback unexpectedly returns asynchronous work.
      const token=stepOpen?undefined:authority.historyOwner.enter('callback');let transferred=false;
      try{
       if(invalidAuthorization)throw new Error('Original authorization must be synchronous');
       const result:unknown=Reflect.apply(callback,input,[]);
       if(result!==undefined){
        try{
         invalidAuthorization=Promise.resolve().then(()=>result).then(()=>undefined,()=>undefined);
         if(token){
          transferred=true;const original=invalidAuthorization;authority.raw.add(original);
          void original.then(()=>{try{authority.raw.delete(original);token.finish();}catch(error){authority.historyOwner.taint(error);}});
         }
        }catch(error){if(token)transferred=true;authority.historyOwner.taint(error);throw error;}
        throw new Error('Original authorization must be synchronous');
       }
      }finally{if(token&&!transferred)token.finish();}
     }});
     this.authorize(owner,true);
     try{return await produce(owner);}finally{this.authorize(owner,true);}
    }finally{try{if(invalidAuthorization)await invalidAuthorization;}finally{stepOpen=false;}}
   }),this.producers);
   void work.then(()=>{this.producerReserved=false;},()=>{this.producerReserved=false;});
   return work;
  }catch(error){this.producerReserved=false;throw error;}
 }
 maintenanceBlockers(){return {...this.worker.maintenanceBlockers(),...feedHistoryOwnerBlockers(this.store),'feed-authority-preparation':Number(this.preparing),'feed-authority-callbacks':this.jobs.size,'feed-authority-raw':this.raw.size,'feed-authority-producer':Number(this.producerReserved)};}
 async close(waitMs:number=feedAdaptiveAuthorityLimits.closeMs){
  if(!Number.isInteger(waitMs)||waitMs<1||waitMs>90000)throw new Error('Invalid finite close bound');
  this.closing=true;let timer:ReturnType<typeof setTimeout>|undefined,workerClosed=false;
  const closing=this.worker.close(waitMs).then(value=>{workerClosed=value.localSettled;});
  try{await Promise.race([Promise.allSettled([closing,...this.jobs,...this.raw,...this.producers]),new Promise<void>(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
  finally{if(timer)clearTimeout(timer);}
  const blockers=this.maintenanceBlockers();return {localSettled:workerClosed&&!this.preparing&&!this.jobs.size&&!this.raw.size&&!this.producerReserved&&!this.producers.size&&!blockers['feed-semantic-rpc']&&!blockers['feed-history-owned']&&!blockers['feed-history-uncertain'],blockers};
 }
}
