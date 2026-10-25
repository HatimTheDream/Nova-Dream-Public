import {claimFeedHistoryOwner,feedHistoryOwnerBlockers,type HistoryOwnerPort,type HistoryOwnerToken} from './feed-history-owner-observer.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';
import type {Store} from './store.js';
import type {NewsFeed} from './news-feed.js';
import type {AssistantTransport} from './gateway.js';
import type {ChatGptAccount} from './chatgpt-account.js';
import {FeedSemanticWorker} from './feed-semantic-worker.js';
import {resolveFeedReview} from './feed-semantic-reviews.js';
import {projectFeedCurrentContext,selectFeedCurrentStory} from './feed-semantic-projections.js';
import {workerInputHash,workerNativeIdentity} from './worker-plugin/identity.js';
import {commandSchema,ownerStopCommandSchema,feedWorkerPrefix,feedWorkerIntent,feedWorkerReceipt,
 validateFeedWorkerRecord,summary,same,terminal,type Command,type Route,type FeedWorkerSaved,type FeedWorkerSummary}
 from '../../packages/domain/news-feed-worker.js';

export type FeedAuthenticatedOwner={readonly deviceId:string;readonly epoch:string;authorize():void};
export type FeedReadyTicket={readonly kind:'feed-ready-ticket'};
export type FeedAuthorityPorts={
 /** NEW mandatory local observations. Production lifecycle wiring remains a gate. */
 routingPolicy():{revision:string;busy:boolean};
 qualification():{id:string;available:boolean};
};
export const feedAuthorityLimits={preparationMs:30000,ticketMs:30000,closeMs:30000,callbacks:16,rawCalls:8} as const;
const identity=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),uuid=z.string().uuid();
const policySchema=z.object({revision:identity,busy:z.boolean()}).strict();
const qualificationSchema=z.object({id:identity,available:z.boolean()}).strict();
const modelSchema=z.object({id:z.string().min(1).max(200),provider:z.string().min(1).max(200),available:z.boolean(),isDefault:z.boolean()}).passthrough();
type Owner={deviceId:string;epoch:string;authorize:()=>void;callback:FeedAuthenticatedOwner['authorize']};
type Policy={accountKey:string;generation:string;routingRevision:string;busy:boolean};
type Ready={owner:Owner;command:Command;policy:Policy;route:Route;briefSha256:string;createdAt:number;expiresAt:number;monotonicExpiry:number;ticket:FeedReadyTicket};
type Lease={owner:Owner;command:Command;policy:Policy;route:Route;ready?:Ready};

/** Outside-app source proposal. No HTTP/startup wiring or native admission.
 * Required caller ports and qualification may never be defaulted to success. */
export class FeedSemanticAuthority{
 private readonly historyOwner:HistoryOwnerPort;
 private readonly context=new AsyncLocalStorage<Lease>();
 private readonly worker:FeedSemanticWorker;
 private readonly tickets=new WeakMap<FeedReadyTicket,Ready>();
 private activeTicket?:Ready;
 private activeTicketOwner?:HistoryOwnerToken;
 private revokeTicket(){if(this.activeTicket)this.tickets.delete(this.activeTicket.ticket);this.activeTicket=undefined;const token=this.activeTicketOwner;this.activeTicketOwner=undefined;token?.finish();}
 private preparing=false;
 private closing=false;
 private readonly jobs=new Set<Promise<unknown>>();
 private readonly raw=new Set<Promise<unknown>>();
 constructor(private store:Store,private news:NewsFeed,private gateway:AssistantTransport,
  private account:Pick<ChatGptAccount,'route'>,private ports:FeedAuthorityPorts,private now=Date.now,
  private limits:{preparationMs:number;ticketMs:number;rpcMs:number}={...feedAuthorityLimits,rpcMs:90000}){
  for(const [value,max] of [[limits.preparationMs,90000],[limits.ticketMs,30000],[limits.rpcMs,90000]])
   if(!Number.isInteger(value)||value<1||value>max)throw new Error('Invalid finite Feed authority bound');
  this.limits=Object.freeze({...limits});
  if(typeof ports?.routingPolicy!=='function'||typeof ports?.qualification!=='function')throw new Error('Feed authority observations are required');
  this.historyOwner=claimFeedHistoryOwner(store,'legacy-authority');
  const transport:AssistantTransport={status:()=>gateway.status(),models:()=>{throw new Error('Worker readiness must use explicit preparation');},
   attachmentPolicy:()=>gateway.attachmentPolicy(),subscribe:listener=>gateway.subscribe(listener),
   request:<T>(method:string,params:unknown)=>this.workerRequest<T>(method,params)};
  try{this.worker=new FeedSemanticWorker(store,transport,{current:deviceId=>this.current(deviceId),story:id=>this.story(id)},now,limits.rpcMs);}catch(error){this.historyOwner.taint(error);throw error;}
 }
 private owner(input:FeedAuthenticatedOwner):Owner{
  if(typeof input?.authorize!=='function')throw new Error('Authenticated request callback required');
  const owner={deviceId:identity.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:input.authorize.bind(input),callback:input.authorize};
  this.authorize(owner);return owner;
 }
 private authorize(owner:Owner){
  const result:unknown=owner.authorize();
  if(result!==undefined){
   // Refuse invalid async ports without leaving their rejection unobserved.
   void Promise.resolve(result).catch(()=>undefined);
   throw new Error('Feed authorization must be synchronous and return no assertion');
  }
  if(owner.epoch!==this.store.epoch)throw new Error('Original Feed workspace changed');
 }
 private policy(owner:Owner):Policy{
  this.authorize(owner);
  const connection=this.gateway.status(),routing=policySchema.parse(this.ports.routingPolicy()),qualified=qualificationSchema.parse(this.ports.qualification());
  const revision=this.store.internalGatewayConfigurationRevision();
  if(this.store.recoveryEffectsPaused||connection.state!=='ready'||!connection.generation||!revision||!qualified.available||!connection.grantedScopes.includes('operator.read'))
   throw new Error('Original Feed authority unavailable');
  return {accountKey:workerInputHash(JSON.stringify({format:1,policy:'native-main-local',epoch:owner.epoch,deviceId:owner.deviceId,
   configurationRevision:revision,generation:connection.generation,qualification:qualified.id})),
   generation:connection.generation,routingRevision:routing.revision,busy:routing.busy};
 }
 private check(lease:Lease,write=false){
  const policy=this.policy(lease.owner),connection=this.gateway.status();
  if(policy.accountKey!==lease.policy.accountKey||policy.generation!==lease.policy.generation||
   write&&!connection.grantedScopes.includes('operator.write'))throw new Error('Original Feed policy or scope changed');
  return policy;
 }
 private snapshot(owner:Owner){this.authorize(owner);return this.news.internalSemanticSnapshot(owner.deviceId);}
 private ready(lease:Lease){
  const ticket=lease.ready;if(!ticket||this.closing||this.now()<ticket.createdAt||this.now()>=ticket.expiresAt||performance.now()>=ticket.monotonicExpiry)return false;
  const policy=this.policy(lease.owner);if(policy.busy||policy.routingRevision!==ticket.policy.routingRevision)return false;
  const context=projectFeedCurrentContext(this.snapshot(lease.owner),ticket.command.requestId,workerInputHash);
  return context.usable&&context.brief.briefSha256===ticket.briefSha256;
 }
 private current(deviceId:string){
  const lease=this.context.getStore();if(!lease||lease.owner.deviceId!==deviceId)throw new Error('Exact original authenticated lease required');
  this.check(lease);return {authorized:true,newStartReady:this.ready(lease),context:this.snapshot(lease.owner).context,route:structuredClone(lease.route)};
 }
 private story(id:string){
  const lease=this.context.getStore();if(!lease||lease.command.kind!=='classify'||lease.command.storyId!==id)throw new Error('Exact original story required');
  this.check(lease);const snapshot=this.snapshot(lease.owner),current=snapshot.stories.find(row=>row.id===id);
  if(!current)return undefined;
  const original=this.store.internalRead<FeedWorkerSaved>(feedWorkerPrefix+lease.command.requestId);
  const sourceId=original?.capture.kind==='classify'?original.capture.preview.story.sourceId:current.sourceId;
  const selected=selectFeedCurrentStory(snapshot,{id,revision:lease.command.storyRevision,sourceId,sourceDigest:lease.command.sourceDigest});
  return selected.available?selected.story:undefined;
 }
 private owned<T>(produce:()=>Promise<T>,set=this.jobs,kind:'callback'|'preparation'|'read'|'run'|'abort'='callback'){return this.historyOwner.run(kind,()=>{const work=produce();set.add(work);return work;},work=>{set.delete(work);});}
 private rawCall<T>(lease:Lease,call:()=>Promise<T>,write=false,kind:'read'|'run'|'abort'=write?'run':'read'){
  this.store.assertFeedExternalEffectAllowed();
  this.check(lease,write);if(this.closing||this.raw.size>=feedAuthorityLimits.rawCalls)throw new Error('Feed raw calls are held');
  // Track through the post-await access check, not only the underlying transport.
  return this.owned(()=>Promise.resolve(call()).then(value=>{this.check(lease,write);return value;}),this.raw,kind);
 }
 private workerRequest<T>(method:string,params:unknown):Promise<T>{
  const lease=this.context.getStore();if(!lease)return Promise.reject(new Error('Original authenticated lease required'));
  const read=['e3.assignments.capabilities','e3.assignments.status','chat.history'],write=['e3.assignments.run','e3.assignments.stop','chat.abort'];
  if(!read.includes(method)&&!write.includes(method))return Promise.reject(new Error('Unqualified Feed method'));
  if(!this.gateway.status().methods.includes(method))return Promise.reject(new Error('Original Feed method unavailable'));
  return this.rawCall(lease,()=>{
   if(method==='e3.assignments.run'&&(!this.ready(lease)||!this.gateway.status().modelAuthReady||
    lease.command.kind==='classify'&&!this.story(lease.command.storyId)))throw new Error('Original Feed dispatch readiness changed');
   return this.gateway.request<T>(method,params);
  },write.includes(method),method==='e3.assignments.run'?'run':write.includes(method)?'abort':'read');
 }
 private async finite<T>(work:Promise<T>,deadline:number){
  const remaining=deadline-this.now();if(remaining<=0)throw new Error('Feed preparation deadline elapsed');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Feed preparation outcome unconfirmed')),remaining);})]);}
  finally{if(timer)clearTimeout(timer);}
 }
 private read(owner:Owner,id:string){
  this.authorize(owner);uuid.parse(id);const result=this.store.internalReadSnapshot(()=>{
  const raw=this.store.internalRead<FeedWorkerSaved>(feedWorkerPrefix+id);if(!raw)return undefined;
  const value=validateFeedWorkerRecord(raw,workerInputHash,workerNativeIdentity);
  if(value.id!==id||value.deviceId!==owner.deviceId||value.command.epoch!==owner.epoch||
   !same(this.store.replayAdmission(owner.deviceId,value.command,feedWorkerIntent(value.command)),feedWorkerReceipt(value,workerInputHash)))
   throw new Error('Original Feed owner or admission receipt changed');
  if(value.capture.kind==='classify'&&value.command.kind==='classify'){
   const reviewed=resolveFeedReview(this.store,value.command.reviewId,workerInputHash,workerNativeIdentity);
   if(!reviewed||!same(reviewed,{brief:value.capture.brief,plan:value.capture.plan,review:value.capture.review}))throw new Error('Original accepted Feed review changed');
  }
  return value;
  });this.authorize(owner);return result;
 }
 private original(owner:Owner,id:string):Lease{
  const value=this.read(owner,id);if(!value)throw new Error('Original Feed request unavailable');
  const policy=this.policy(owner);if(policy.accountKey!==value.route.accountKey||policy.generation!==value.generation)throw new Error('Original Feed policy changed');
  return {owner,command:value.command,policy,route:value.route};
 }
 private preparationCurrent(lease:Lease,briefSha256:string,deadline:number){
  const policy=this.check(lease,true);
  if(this.closing||this.now()<deadline-this.limits.preparationMs||this.now()>=deadline||policy.busy||policy.routingRevision!==lease.policy.routingRevision)
   throw new Error('Feed preparation no longer current');
  const current=projectFeedCurrentContext(this.snapshot(lease.owner),lease.command.requestId,workerInputHash);
  if(!current.usable||current.brief.briefSha256!==briefSha256)throw new Error('Feed writing changed during preparation');
 }
 readRetained(input:FeedAuthenticatedOwner,id:string):FeedWorkerSummary{
  const owner=this.owner(input);uuid.parse(id);
  try{return this.store.internalWithFeedReadGraph(graph=>{const value=graph.workers.get(id);
   if(!value||value.format!==2||value.deviceId!==owner.deviceId||value.command.epoch!==owner.epoch)throw new Error('Original Feed request unavailable');
   this.authorize(owner);return summary(value);});}finally{this.authorize(owner);}
 }
 prepare(input:FeedAuthenticatedOwner,raw:unknown){return this.historyOwner.run('callback',()=>this.prepareOwned(input,raw));}
 private prepareOwned(input:FeedAuthenticatedOwner,raw:unknown):Promise<{kind:'original';value:FeedWorkerSummary}|{kind:'ready';ticket:FeedReadyTicket}>{
  if(this.closing||this.jobs.size>=feedAuthorityLimits.callbacks)throw new Error('Feed preparation is held');
  const owner=this.owner(input),command=commandSchema.parse(raw),original=this.read(owner,command.requestId);
  if(command.epoch!==owner.epoch)throw new Error('Original command workspace changed');
  if(original){if(!same(original.command,command))throw new Error('Original Feed command changed');
   return this.owned(()=>Promise.resolve().then(()=>{this.authorize(owner);return {kind:'original' as const,value:summary(original)};}));}
  this.store.assertFeedExternalEffectAllowed();
  if(this.activeTicket&&(this.now()<this.activeTicket.createdAt||this.now()>=this.activeTicket.expiresAt||performance.now()>=this.activeTicket.monotonicExpiry)){
   this.revokeTicket();}
  if(this.closing||this.preparing||this.activeTicket||this.raw.size||this.jobs.size||Object.values(this.worker.maintenanceBlockers()).some(Boolean))
   throw new Error('Feed preparation is held by existing work');
  this.store.assertUpdateAdmission();const policy=this.policy(owner);if(policy.busy)throw new Error('Account routing is changing');
  const snapshot=this.snapshot(owner),captured=projectFeedCurrentContext(snapshot,command.requestId,workerInputHash);
  if(!captured.usable||snapshot.context.profile.revision!==command.expectedRevision)throw new Error('Current Feed capture unavailable');
  const deadline=this.now()+this.limits.preparationMs;
  const lease:Lease={owner,command,policy,route:{accountKey:policy.accountKey,provider:'pending',model:'pending'}};
  return this.owned(()=>{this.preparing=true;return this.context.run(lease,async()=>{
   try{
    this.check(lease,true);if(!this.gateway.status().methods.includes('models.list')||typeof this.gateway.modelsWithAuthority!=='function')throw new Error('Owned model catalog unavailable');
    const catalog=await this.finite(this.rawCall(lease,()=>{
     const guard=()=>this.preparationCurrent(lease,captured.brief.briefSha256,deadline);guard();
     return this.gateway.modelsWithAuthority!(guard);
    }),deadline);
    this.preparationCurrent(lease,captured.brief.briefSha256,deadline);
    const defaults=z.array(modelSchema).max(1000).parse(catalog).filter(model=>model.isDefault);
    if(defaults.length!==1||!defaults[0].available)throw new Error('One available explicit default model is required');
    const selected=defaults[0],prefix=selected.provider+'/';
    if(selected.provider!=='openai'||!selected.id.startsWith(prefix)||selected.id.length===prefix.length)throw new Error('Supported managed default model unavailable');
    if(!this.gateway.status().methods.includes('e3.accounts.snapshot'))throw new Error('Account routing observation unavailable');
    const candidate=await this.finite(this.rawCall(lease,()=>{this.preparationCurrent(lease,captured.brief.briefSha256,deadline);return this.account.route({model:selected.id});}),deadline);
    this.preparationCurrent(lease,captured.brief.briefSha256,deadline);
    if(!candidate||typeof candidate.profileId!=='string'||!candidate.profileId||!Number.isFinite(candidate.checkedAt)||candidate.checkedAt>this.now()||candidate.checkedAt<deadline-this.limits.preparationMs)
     throw new Error('An eligible current account candidate was not confirmed');
    if(this.now()>=deadline||this.closing||this.policy(owner).busy)throw new Error('Feed preparation no longer current');
    const current=projectFeedCurrentContext(this.snapshot(owner),command.requestId,workerInputHash);
    if(!current.usable||current.brief.briefSha256!==captured.brief.briefSha256)throw new Error('Feed writing changed during preparation');
    const route={accountKey:policy.accountKey,provider:selected.provider,model:selected.id.slice(prefix.length)};
    const ticket=Object.freeze({kind:'feed-ready-ticket' as const});
    const ready:Ready={owner,command:structuredClone(command),policy,route,briefSha256:captured.brief.briefSha256,
     createdAt:this.now(),expiresAt:this.now()+this.limits.ticketMs,monotonicExpiry:performance.now()+this.limits.ticketMs,ticket};
    this.activeTicketOwner=this.historyOwner.enter('ticket');this.tickets.set(ticket,ready);this.activeTicket=ready;this.authorize(owner);return {kind:'ready' as const,ticket};
   }finally{this.preparing=false;}
  });},this.jobs,'preparation');
 }
 start(input:FeedAuthenticatedOwner,raw:unknown,ticket?:FeedReadyTicket):FeedWorkerSummary{return this.historyOwner.sync('callback',()=>this.startOwned(input,raw,ticket));}
 private startOwned(input:FeedAuthenticatedOwner,raw:unknown,ticket?:FeedReadyTicket):FeedWorkerSummary{
  if(this.closing)throw new Error('Feed readiness expired or changed while closing');
  const owner=this.owner(input),command=commandSchema.parse(raw),existing=this.read(owner,command.requestId);
  if(command.epoch!==owner.epoch)throw new Error('Original command workspace changed');
  if(existing){if(!same(existing.command,command))throw new Error('Original Feed command changed');return summary(existing);}
  this.store.assertFeedExternalEffectAllowed();
  const ready=ticket&&this.tickets.get(ticket);
  if(!ready||this.activeTicket!==ready||!same(command,ready.command)||owner.deviceId!==ready.owner.deviceId||owner.epoch!==ready.owner.epoch||owner.callback!==ready.owner.callback)
   throw new Error('Exact in-memory Feed readiness ticket required');
  const lease={owner:ready.owner,command:ready.command,policy:ready.policy,route:ready.route,ready};
  this.check(lease,true);if(!this.ready(lease)||this.raw.size||this.preparing||this.closing)throw new Error('Feed readiness expired or changed');
  this.revokeTicket();
  return this.context.run(lease,()=>{const result=this.worker.start(owner.deviceId,command);this.check(lease,true);return result;});
 }
 observe(input:FeedAuthenticatedOwner,id:string){return this.historyOwner.run('callback',()=>this.observeOwned(input,id));}
 private observeOwned(input:FeedAuthenticatedOwner,id:string):Promise<FeedWorkerSummary>{
  if(this.closing||this.jobs.size>=feedAuthorityLimits.callbacks)throw new Error('Feed observation capacity is held');
  const lease=this.original(this.owner(input),id);
  if(!terminal(this.read(lease.owner,id)!))this.store.assertFeedExternalEffectAllowed();
  return this.owned(()=>this.context.run(lease,async()=>{this.check(lease);const result=await this.worker.check(lease.owner.deviceId,id);this.check(lease);return result;}));
 }
 stop(input:FeedAuthenticatedOwner,raw:unknown){return this.historyOwner.run('callback',()=>this.stopOwned(input,raw));}
 private stopOwned(input:FeedAuthenticatedOwner,raw:unknown):Promise<FeedWorkerSummary>{
  if(this.closing||this.jobs.size>=feedAuthorityLimits.callbacks)throw new Error('Feed observation capacity is held');
  const owner=this.owner(input),command=ownerStopCommandSchema.parse(raw),lease=this.original(owner,command.id);
  if(command.epoch!==owner.epoch)throw new Error('Original stop workspace changed');
  if(!terminal(this.read(owner,command.id)!))this.store.assertFeedExternalEffectAllowed();
  return this.owned(()=>this.context.run(lease,async()=>{this.check(lease,true);const result=await this.worker.stop(owner.deviceId,command);this.check(lease,true);return result;}));
 }
 maintenanceBlockers(){return {...this.worker.maintenanceBlockers(),...feedHistoryOwnerBlockers(this.store),'feed-authority-preparation':Number(this.preparing),
  'feed-authority-callbacks':this.jobs.size,'feed-authority-raw':this.raw.size};}
 async close(waitMs:number=feedAuthorityLimits.closeMs){
  if(!Number.isInteger(waitMs)||waitMs<1||waitMs>90000)throw new Error('Invalid Feed authority close bound');
  this.closing=true;this.revokeTicket();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let workerClosed=false;
  const closing=this.worker.close(waitMs).then(value=>{workerClosed=value.localSettled;});
  try{await Promise.race([Promise.allSettled([closing,...this.jobs,...this.raw]),new Promise<void>(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
  finally{if(timer)clearTimeout(timer);}
  const blockers=this.maintenanceBlockers();
  return {localSettled:workerClosed&&!this.preparing&&this.jobs.size===0&&this.raw.size===0&&blockers['feed-semantic-rpc']===0&&!blockers['feed-history-owned']&&!blockers['feed-history-uncertain'],blockers};
 }
}
