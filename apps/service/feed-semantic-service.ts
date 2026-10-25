import type {ManagedRuntime} from './runtime.js';
import {Fault,type Store} from './store.js';
import type {NewsFeed} from './news-feed.js';
import type {AssistantTransport} from './gateway.js';
import type {ChatGptAccount} from './chatgpt-account.js';
import type {PhoneAccess} from './phone-access.js';
import {FeedAdaptiveAuthority,type FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import {FeedAdaptiveCurrentSource} from './feed-adaptive-current-source.js';
import {FeedAdaptiveController} from './feed-adaptive-controller.js';
import {FeedSemanticHttp,type FeedHttpPolicy} from './feed-semantic-http.js';
import {FeedAdaptiveView} from './feed-adaptive-view.js';
import {FeedAdaptiveReading} from './feed-adaptive-reading.js';
import {FeedAutomaticLocal} from './feed-automatic-local.js';

/** Service-owned composition only. All components retain the same actual Store.
 * No caller can supply qualification, an authority, a ledger, or owner claims.
 * Saved local work remains usable while actual native qualification is absent. */
export function createFeedSemanticService(store:Store,news:NewsFeed,gateway:AssistantTransport,
 account:ChatGptAccount|undefined,phone:PhoneAccess,policy:()=>FeedHttpPolicy,runtime?:Pick<ManagedRuntime,'feedQualification'>){
 const permissions=(owner:FeedAdaptiveOwner)=>{
  const authorization:unknown=owner.authorize();
  if(authorization!==undefined){void Promise.resolve(authorization).catch(()=>{});throw Error('Original authorization must be synchronous');}
  const current=policy();
  return {read:current.enabled,write:current.enabled&&!current.closing&&!store.recoveryHeld&&!store.recoveryEffectsPaused&&!store.updateMaintenanceHeld};
 };
 const source=new FeedAdaptiveCurrentSource(store,news,permissions);
 const native=new FeedAdaptiveAuthority(store,gateway,account,{
  routingPolicy:()=>{
   if(!account)throw new Fault(409,'feed_native_unavailable','The managed Feed account route is unavailable. Saved originals remain available.');
   return account.internalRoutingPolicy();
  },
  // ManagedRuntime owns the spawn-bound Feed identity. Connection readiness
  // or an account listing alone never supplies native authority.
  qualification:()=>runtime?.feedQualification()??{id:'feed-native-unavailable',available:false},
  permissions:owner=>source.permissions(owner),source:owner=>source.source(owner),
  story:(owner,id)=>source.story(owner,id)?.story,
 },()=>store.internalFeedLedger());
 const controller=new FeedAdaptiveController(store,native,source);
 const automatic=new FeedAutomaticLocal(store,news,controller,source,native);
 const view=new FeedAdaptiveView(store,news,owner=>{const value=permissions(owner);return {...value,read:value.read&&!policy().closing};});
 const readings=new FeedAdaptiveReading(store,news,view,owner=>{const value=permissions(owner);return {...value,read:value.read&&!policy().closing};});
 return {controller,view,readings,automatic,http:new FeedSemanticHttp(store,phone,controller,policy,{view,readings,automatic})};
}
