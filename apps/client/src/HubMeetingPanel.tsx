import { Suspense, useEffect, useState } from 'react';
import { lazy } from './preload-lazy';
import type { HubMember } from '../../../packages/domain/agent-hub';
import type { HubMeeting, HubMeetingState } from '../../../packages/domain/hub-meetings';
import type { HubLayout } from '../../../packages/domain/hub-layout';
import { readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';
import { useHubMeetingControls, type HubMeetingControls } from './nova/hub/useHubMeetingControls';
const MeetingMarkdown=lazy(()=>import('./dreamclaw/components/Chat/ReplyMarkdown').then(m=>({default:m.ReplyMarkdown})));

export function HubMeetingPanel({state,roster,layout,epoch,draftKey,refresh,close,unavailable,controls,initialMeetingId,onSelection}:{unavailable?:string;state?:HubMeetingState;roster:HubMember[];layout:HubLayout;epoch:string;draftKey:string;refresh:()=>void;close:()=>void;controls?:HubMeetingControls;initialMeetingId?:string;onSelection?:(id?:string)=>void}){
  const [draft,setDraft]=useState(()=>readLocal<{title:string;agenda:string;ids:string[]}>(draftKey)??{title:'Team discussion',agenda:'',ids:roster.slice(0,12).map(a=>a.id)});
  useEffect(()=>{setDraft(d=>{const ids=d.ids.filter(id=>roster.some(a=>a.id===id));return ids.length===d.ids.length?d:{...d,ids};});},[roster.map(a=>a.id).join(',')]);
  const ownControls=useHubMeetingControls(epoch,draftKey,refresh),{busy,error,pending,command}=controls??ownControls;
  const [history,setHistory]=useState<HubMeeting|null>(null),[historyError,setHistoryError]=useState('');
  useEffect(()=>{if(!initialMeetingId||initialMeetingId===state?.current?.id)return;const saved=state?.history.find(m=>m.id===initialMeetingId);if(saved){setHistory(saved);setHistoryError('');return;}let live=true;void request<HubMeeting>('agents/meetings?meetingId='+encodeURIComponent(initialMeetingId)).then(value=>{if(live){setHistory(value);setHistoryError('');}}).catch(reason=>{if(live)setHistoryError(reason instanceof Error?reason.message:'The original discussion could not load.');});return()=>{live=false;};},[initialMeetingId,state]);
  useEffect(()=>{saveLocal(draftKey,draft);},[draft,draftKey]);
  const chooseHistory=(meeting:HubMeeting|null)=>{setHistory(meeting);setHistoryError('');onSelection?.(meeting?.id);};
  const selectingHistory=!!initialMeetingId&&initialMeetingId!==state?.current?.id;
  const selectedHistory=history&&(!initialMeetingId||history.id===initialMeetingId)?(state?.history.find(m=>m.id===history.id)??history):undefined;
  const current=selectedHistory??(selectingHistory?undefined:state?.current),boardroom=layout.rooms.find(r=>r.template==='boardroom');
  return <Dialog title={current?current.title:'Meet In The Boardroom'} close={close}>
    <div className="hub-meeting-panel">
      {unavailable&&<p className="field-error" role="status">{unavailable}</p>}
      {error&&<p className="field-error" role="alert">{error}</p>}
      {historyError&&<p className="field-error" role="alert">{historyError}</p>}
      {pending&&<div className="notice">A meeting change needs reconciliation.<button disabled={busy} onClick={()=>void command(pending)}>Check Original Change</button></div>}
      {selectingHistory&&!selectedHistory?<p role="status">{historyError?'The original discussion is unavailable. Its reference is kept.':'Opening the original discussion…'}</p>:current?<>
        <p className="metadata" role="status">{current.message}</p><p className="hub-meeting-agenda">{current.agenda}</p>
        <div className="hub-attendees">{current.attendees.map(a=><span key={a.id}>{a.name}{current.state==='running'&&current.turns[current.next]?.agentId===a.id?' · current turn':''}</span>)}</div>
        {!history&&<div className="button-row">
          {['gathered','paused'].includes(current.state)&&current.next<current.turns.length&&<button className="primary" disabled={busy||!!pending||!!unavailable} onClick={()=>void command({type:'start',meetingId:current.id,expectedRevision:current.revision})}>{current.state==='paused'?'Continue Discussion':'Start Discussion'}</button>}
          {current.state==='running'&&<button disabled={busy||!!pending||!!unavailable} onClick={()=>void command({type:'pause',meetingId:current.id,expectedRevision:current.revision})}>Pause Discussion</button>}
          <button disabled={busy||!!pending||!!unavailable} onClick={()=>void command({type:'end',meetingId:current.id,expectedRevision:current.revision})}>{current.state==='complete'?'Finish Meeting':'End Gathering'}</button>
          <button onClick={close}>Watch In Hub</button>
        </div>}
        {!history&&current.state==='gathered'&&<p className="metadata">Starting uses the connected AI worker. Each person contributes in turn; the first participant brings the discussion together in a final summary. Discussion can read context. Assign follow-up actions separately.</p>}
        <div className="hub-meeting-turns">{current.turns.filter(t=>t.attemptId).map((t,i)=><article key={t.planId}>
          <header><strong>{t.agentName}{t.kind==='summary'?' · Summary':''}</strong><span className="metadata">{t.result?'Returned':t.state==='cancelled'?'Stopped':i===current.next&&current.state==='running'?'In progress':t.state}</span></header>
          {t.result?<><div className="hub-meeting-response"><Suspense fallback={t.result.text}><MeetingMarkdown text={t.result.text}/></Suspense></div><a href={`/api/attachments/${t.result.fileId}`} download>Download Contribution</a></>:<p className="metadata">{t.message??'Waiting for the original response.'}</p>}
        </article>)}</div>
        {history&&<button onClick={()=>chooseHistory(null)}>Back To Current Gathering</button>}
      </>:<form onSubmit={e=>{e.preventDefault();if(boardroom)void command({type:'gather',roomId:boardroom.id,title:draft.title,agenda:draft.agenda,agentIds:draft.ids});}}>
        <label>Meeting Title<input maxLength={160} required value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <label>What should the team discuss?<textarea rows={4} maxLength={4000} required value={draft.agenda} placeholder="A decision, question, or piece of work to discuss together…" onChange={e=>setDraft({...draft,agenda:e.target.value})}/></label>
        <fieldset><legend>Invite The Team · Choose 2–12</legend><div className="hub-meeting-invites">{roster.map(a=><label key={a.id}><input type="checkbox" checked={draft.ids.includes(a.id)} disabled={a.status==='working'||!draft.ids.includes(a.id)&&draft.ids.length>=12} onChange={e=>setDraft({...draft,ids:e.target.checked?[...draft.ids,a.id]:draft.ids.filter(id=>id!==a.id)})}/><span>{a.name}<small>{a.position}</small></span></label>)}</div></fieldset>
        <div className="button-row"><button className="primary" disabled={busy||!!pending||!!unavailable||!boardroom||draft.ids.length<2||!draft.title.trim()||!draft.agenda.trim()}>{busy?'Gathering…':'Gather At The Table'}</button><button type="button" onClick={close}>Close</button></div>
        <p className="metadata">Gathering moves the team to their chairs. You start the AI discussion separately.</p>
      </form>}
      {!history&&!!state?.history.length&&<details><summary>Past Discussions</summary>{state.history.map(m=><button className="hub-work-link" key={m.id} onClick={()=>chooseHistory(m)}>{m.title}<small>{new Date(m.createdAt).toLocaleDateString()}</small></button>)}</details>}
    </div>
  </Dialog>;
}
