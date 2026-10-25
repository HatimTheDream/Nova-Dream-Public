import {randomUUID} from 'node:crypto';
import type {FeedRefreshCommand,FeedRefreshReceipt,FeedSavedState,FeedScheduleStatus} from '../../packages/domain/news-feed.js';
import type {Store} from './store.js';

export const feedScheduleKey='home:news:schedule';
const intentPrefix='home:news:schedule-intent:';
type Schedule={format:1;epoch:string;deviceId:string;consentRequestId:string;hours:6|12|24;
 sources:{id:string;nextAt:string}[];pending:FeedRefreshCommand|null;attention:string|null};
type Ports={saved():FeedSavedState;refresh(device:string,command:FeedRefreshCommand):Promise<FeedRefreshReceipt>;
 receipt(device:string,command:FeedRefreshCommand):FeedRefreshReceipt|{state:'unknown';command:FeedRefreshCommand};count():number};
/** A cursor is saved before the first fetch. Restart observes that exact request;
 * it never dispatches a recorded cursor again or catches up missed intervals. */
export class FeedSchedule {
 private busy=false;private closed=false;
 constructor(private store:Store,private ports:Ports,private now=Date.now){}
 configure(deviceId:string,consentRequestId:string,saved:FeedSavedState){
  const hours=saved.profile.settings.autoRefreshHours;
  if(!hours){this.store.internalWrite(feedScheduleKey,null);return;}
  const nextAt=new Date(this.now()+hours*3600000).toISOString();
  const value:Schedule={format:1,epoch:this.store.epoch,deviceId,consentRequestId,hours,
   sources:saved.profile.settings.sources.filter(source=>source.enabled).map(source=>({id:source.id,nextAt})),pending:null,attention:null};
  this.store.internalWrite(feedScheduleKey,value);
 }
 private held(){return this.closed||this.store.recoveryEffectsPaused||this.store.updateMaintenanceHeld;}
 private read(){return this.store.internalRead<Schedule|null>(feedScheduleKey);}
 status():FeedScheduleStatus{
  const schedule=this.read(),retainedCount=this.ports.count(),base={retainedCount,limit:512 as const,nextAt:null};
  if(!this.ports.saved().profile.settings.autoRefreshHours)return {...base,status:'off',message:'Automatic Source Checks Are Off'};
  if(this.held())return {...base,status:'paused',message:'Source checks are paused during recovery or maintenance.'};
  if(!schedule||schedule.epoch!==this.store.epoch)return {...base,status:'attention',message:'Review and save Feed settings in this workspace before automatic checks resume.'};
  if(schedule.attention)return {...base,status:'attention',message:schedule.attention};
  if(retainedCount>=512||this.store.internalList(intentPrefix).length>=512)return {...base,status:'full',message:'Source-check history is full. Checks are paused; existing stories and original results are kept.'};
  if(schedule.pending)return {...base,status:'checking',message:'Observing The Original Source Check'};
  if(!schedule.sources.length)return {...base,status:'paused',message:'Enable a source in Feed settings to schedule checks.'};
  return {...base,status:'scheduled',message:`Enabled sources are checked every ${schedule.hours} hours while Dream is running.`,
   nextAt:schedule.sources.map(source=>source.nextAt).sort()[0]};
 }
 private update(original:Schedule,change:Partial<Schedule>){
  if(this.held()||original.epoch!==this.store.epoch)return;
  const current=this.read();
  if(current?.consentRequestId!==original.consentRequestId||current.pending?.requestId!==original.pending?.requestId)return;
  this.store.internalWrite(feedScheduleKey,{...current,...change});
 }
 private observe(schedule:Schedule){
  try{
   const result=this.ports.receipt(schedule.deviceId,schedule.pending!);
   if(result.state==='running')return;
   if(result.state==='unknown'||result.state==='expired'){
    this.update(schedule,{attention:'An earlier source check is unconfirmed. Its original request is kept and will not be repeated. Review and save Feed settings to schedule future checks.'});return;
   }
   this.update(schedule,{pending:null});
  }catch{this.update(schedule,{attention:'The original check could not be read. It has not been repeated. Existing stories are kept.'});}
 }
 async tick(){
  if(this.busy||this.held())return;
  const schedule=this.read(),saved=this.ports.saved();
  if(!schedule||schedule.epoch!==this.store.epoch||!saved.profile.settings.autoRefreshHours||schedule.hours!==saved.profile.settings.autoRefreshHours||schedule.attention)return;
  if(schedule.pending){this.observe(schedule);return;}
  if(this.ports.count()>=512||this.store.internalList(intentPrefix).length>=512)return;
  const due=schedule.sources.filter(row=>Date.parse(row.nextAt)<=this.now()&&saved.profile.settings.sources.some(source=>source.id===row.id&&source.enabled))
   .sort((a,b)=>a.nextAt.localeCompare(b.nextAt)||a.id.localeCompare(b.id))[0];
  if(!due)return;
  const command:FeedRefreshCommand={requestId:randomUUID(),epoch:schedule.epoch,sourceId:due.id,profileRevision:saved.profile.revision};
  const pending:Schedule={...schedule,pending:command,sources:schedule.sources.map(row=>row.id===due.id?{...row,nextAt:new Date(this.now()+schedule.hours*3600000).toISOString()}:row)};
  this.store.internalAtomic(()=>{
   this.store.internalWrite(intentPrefix+command.requestId,{format:1,deviceId:schedule.deviceId,consentRequestId:schedule.consentRequestId,command,recordedAt:new Date(this.now()).toISOString()});
   this.store.internalWrite(feedScheduleKey,pending);
  });
  this.busy=true;
  try{await this.ports.refresh(schedule.deviceId,command);this.observe(pending);}
  catch{this.update(pending,{attention:'This scheduled check did not confirm a result. Its original request is kept; no automatic retry will run.'});}
  finally{this.busy=false;}
 }
 close(){this.closed=true;}
}
