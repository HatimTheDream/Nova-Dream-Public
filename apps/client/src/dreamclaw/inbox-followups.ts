import {localEventInterval} from '../../../../packages/domain/calendar-time';
import {createStore} from 'zustand/vanilla';
import {ApiError,readLocal,request,saveLocal} from '../api';
import {mailCalendarKey,type CalendarFollowupCommand,type CalendarFollowupResult} from '../../../../packages/domain/calendar-followups';
export type FollowupRecord={command:CalendarFollowupCommand;result?:CalendarFollowupResult;pending:boolean;error?:string};
type Records=Record<string,FollowupRecord>;
type Options={epoch:string;deviceId:string;windowId:string;previousWindowId?:string};
export function createInboxFollowups(options:Options,send=(command:CalendarFollowupCommand)=>request<CalendarFollowupResult>('calendar/followups',command),disk={read:(key:string)=>readLocal<Records>(key),write:saveLocal}) {
  const keyFor=(window:string)=>`e3:inbox-followups:${options.epoch}:${options.deviceId}:${window}`,key=keyFor(options.windowId);
  const initial=disk.read(key)??(options.previousWindowId?disk.read(keyFor(options.previousWindowId)):undefined)??{};
  const store=createStore<{records:Records;busy:Record<string,boolean>;storageError:boolean}>(()=>({records:initial,busy:{},storageError:false}));
  const jobs=new Map<string,Promise<CalendarFollowupResult>>();
  function keep(source:string,record:FollowupRecord,required=false){const records={...store.getState().records,[source]:record},saved=disk.write(key,records);if(!saved&&required){store.setState({storageError:true});throw new Error('Free browser storage before scheduling this follow-up. Your mail and existing Calendar work are kept.');}store.setState({records,storageError:!saved});}
  function act(source:string,record:FollowupRecord):Promise<CalendarFollowupResult> {
    const running=jobs.get(source);if(running)return running;
    keep(source,record,true);store.setState(state=>({busy:{...state.busy,[source]:true}}));
    const job=(async()=>{
      try {const result=await send(record.command);if(result.epoch!==options.epoch||result.requestId!==record.command.requestId||!result.source||mailCalendarKey(result.source)!==source||!result.event?.id||result.event.revision<1)throw new Error('The saved follow-up could not be verified. Check the original request.');keep(source,{...record,pending:false,error:undefined,result});return result;}
      catch(error){keep(source,{...record,error:error instanceof Error?error.message:'The follow-up save is unconfirmed.',pending:!(error instanceof ApiError&&['validation','calendar_time','calendar_followup_changed','calendar_followup_account','epoch_changed'].includes(error.code))});throw error;}
      finally {jobs.delete(source);store.setState(state=>({busy:{...state.busy,[source]:false}}));}
    })();jobs.set(source,job);return job;
  }
  function schedule(input:Omit<CalendarFollowupCommand,'requestId'|'epoch'>){const source=mailCalendarKey(input.source),old=store.getState().records[source];if(old?.pending)return act(source,old);if(!old&&Object.keys(store.getState().records).length>=100)throw new Error('This window has reached 100 kept follow-ups. Existing follow-ups remain available in Calendar.');return act(source,{command:{...input,epoch:options.epoch,requestId:crypto.randomUUID()},pending:true,result:old?.result});}
  function retry(source:string){const old=store.getState().records[source];if(!old)return Promise.reject(new Error('This follow-up is no longer in this window.'));return act(source,old.pending?old:{...old,command:{...old.command,requestId:crypto.randomUUID(),after:undefined},pending:true,error:undefined});}
  function forget(source:string){const record=store.getState().records[source];if(!record)return;if(record.pending||store.getState().busy[source])throw new Error('Check this follow-up before hiding its saved status.');const records={...store.getState().records};delete records[source];if(!disk.write(key,records)){store.setState({storageError:true});throw new Error('Free browser storage before hiding this saved follow-up.');}store.setState({records,storageError:false});}
  return {store,schedule,retry,forget};
}
export type InboxFollowups=ReturnType<typeof createInboxFollowups>;

export function nextFollowupProposal(record:FollowupRecord,now=Date.now()) {
  const value=record.result?.event.value,interval=value?localEventInterval(value).interval:undefined;
  const previous=interval?.kind==='instant'?Date.parse(interval.start):Date.parse(record.command.startAt);
  const start=Math.ceil(Math.max(now+3600000,previous+86400000)/60000)*60000;
  return {...record.command,title:value?.title??record.command.title,notes:value?.notes??record.command.notes,timezone:value?.timezone??record.command.timezone,reminderMinutes:value?.reminderMinutes??record.command.reminderMinutes,deliveryChannel:value?.deliveryChannel??record.command.deliveryChannel,startAt:new Date(start).toISOString(),endAt:new Date(start+1800000).toISOString()};
}
