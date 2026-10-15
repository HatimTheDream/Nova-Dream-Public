import { useRef, useState } from 'react';
import type { HubMeeting } from '../../../../../packages/domain/hub-meetings';
import { readLocal, request, saveLocal } from '../../api';

export type HubMeetingControls = {
  busy: boolean; error: string; pending: Record<string, unknown> | null;
  command: (action: Record<string, unknown>) => Promise<boolean>;
};
/** The dock and full discussion share one pending command and receipt identity. */
export function useHubMeetingControls(epoch: string, key: string, refresh: () => void): HubMeetingControls {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const flight=useRef(false);
  const [pending,setPending]=useState<Record<string,unknown>|null>(()=>readLocal(key+':pending')??null);
  const command=async(action:Record<string,unknown>)=>{
    if(flight.current)return false;
    const input=pending??{...action,epoch,requestId:crypto.randomUUID()};
    if(!saveLocal(key+':pending',input)){setError('Browser storage is unavailable. Your saved discussion is kept.');return false;}
    flight.current=true;setPending(input);setBusy(true);setError('');
    try{await request<HubMeeting>('agents/meetings',input);saveLocal(key+':pending',null);setPending(null);refresh();return true;}
    catch(reason){setError(reason instanceof Error?reason.message:'The discussion change is unconfirmed.');if((reason as {status?:number}).status&&Number((reason as {status?:number}).status)<500){saveLocal(key+':pending',null);setPending(null);refresh();}return false;}
    finally{flight.current=false;setBusy(false);}
  };
  return {busy,error,pending,command};
}
