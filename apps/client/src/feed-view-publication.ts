import type {FeedState} from '../../../packages/domain/news-feed';
import {boundedFeedViewJson,checkedFeedView,feedViewSchema,type FeedViewReady,type FeedViewState} from '../../../packages/domain/news-feed-view';
import {canonical} from '../../../packages/domain/contracts';
import {checkedFeedState,type FeedPending} from './news-feed-retained';

export type FeedSettingsSnapshot={value:Pick<FeedViewReady['value'],'revision'|'profile'|'control'>;
 activity:Pick<FeedViewReady['activity'],'status'|'message'|'supported'>;schedule?:FeedViewReady['schedule']};
type Ticket={owner:FeedViewPublication;generation:number;following:boolean};
const readyShape=feedViewSchema.options[0];
const preferencesSchema=readyShape.pick({value:true,activity:true,schedule:true}).extend({
 value:readyShape.shape.value.pick({revision:true,profile:true,control:true}),
 activity:readyShape.shape.activity.pick({status:true,message:true,supported:true}),
});
export const feedAccessDenied=(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&[401,403].includes((error as {status?:number}).status??0);
export const feedPendingRoute=(pending:FeedPending)=>pending.kind==='refresh'?'home/news/refresh':pending.command.type==='reading'?'home/news/semantic/reading':'home/news';
function settingsOnly(state:FeedViewReady|FeedState):FeedSettingsSnapshot{
 // No story, interest, activity quote or semantic proof survives here.
 const {revision,profile,control}=state.value,{status,message,supported}=state.activity;
 const selected={value:{revision,profile,control},activity:{status,message,...(supported?{supported}:{})},...(state.schedule?{schedule:state.schedule}:{})};
 if(boundedFeedViewJson(selected)===undefined)throw Error('Current preferences exceed their supported bounds.');
 const checked=preferencesSchema.parse(selected);if(canonical(checked)!==canonical(selected))throw Error('Current preference normalization refused.');
 return checked;
}
/** Publication ownership only, never server eligibility or command authority.
 * Preferences fallback remains independently labeled. Snapshots never merge. */
export class FeedViewPublication{
 private generation=0;private active=true;private following=false;
 current?:FeedViewState;settings?:FeedSettingsSnapshot;settingsStale=false;settingsSeparate=false;authorized=false;
 constructor(readonly scope:{deviceId:string;epoch:string}){}
 activate(){this.active=true;}
 dispose(){this.active=false;this.generation++;this.clear();}
 begin(following:boolean):Ticket{this.following=following;return {owner:this,generation:++this.generation,following};}
 select(following:boolean){if(following!==this.following){this.following=following;this.generation++;this.current=undefined;}}
 owns(ticket:Ticket){return this.active&&ticket.owner===this&&ticket.generation===this.generation&&ticket.following===this.following;}
 private clear(){this.current=undefined;this.settings=undefined;this.settingsStale=false;this.settingsSeparate=false;this.authorized=false;}
 deny(){this.generation++;this.clear();}
 publish(ticket:Ticket,raw:unknown){
  if(!this.owns(ticket))return false;
  if(boundedFeedViewJson(raw)===undefined)throw Error('The Feed response exceeds its supported bounds.');
  const value=checkedFeedView(raw),cp=value.checkpoint;
  if(cp.deviceId!==this.scope.deviceId||cp.epoch!==this.scope.epoch||cp.following!==ticket.following)throw Error('The Feed response belongs to another reading view.');
  const preferences=value.state==='ready'?settingsOnly(value):undefined;
  this.current=value;this.authorized=true;
  if(preferences){this.settings=preferences;this.settingsStale=false;this.settingsSeparate=false;}
  else{this.settingsStale=!!this.settings;this.settingsSeparate=true;}
  return true;
 }
 publishSettings(ticket:Ticket,raw:unknown){
  if(!this.owns(ticket)||this.current?.state!=='unavailable')return false;
  const value=checkedFeedState(raw as FeedState,this.scope.epoch);
  this.settings=settingsOnly(value);this.settingsStale=false;this.settingsSeparate=true;return true;
 }
 fail(ticket:Ticket,error:unknown){
  if(!this.active||ticket.owner!==this)return false;
  // A denial invalidates this owner's other outstanding generations as well.
  if(feedAccessDenied(error)){this.deny();return true;}
  if(!this.owns(ticket))return false;
  this.current=undefined;this.authorized=false;this.settingsStale=!!this.settings;return true;
 }
 settingsFailed(ticket:Ticket,error:unknown){
  if(feedAccessDenied(error))return this.fail(ticket,error);
  if(!this.owns(ticket))return false;this.settingsStale=!!this.settings;return true;
 }
}
