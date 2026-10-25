import {useEffect,useRef,useState} from 'react';
import {request} from './api';
import {draftBrowserStorage} from './draft-browser-storage';
import {ContentRecoveryPanel} from './ContentRecoveryPanel';
import {NewsFeedInterpretationPanel} from './NewsFeedInterpretationPanel';
import {FeedInterpretationBrowser,feedInterpretationHttpPort,type FeedSemanticRequest} from './feed-interpretation-browser';
import type {AdaptiveProtocolRequest} from '../../../packages/domain/news-feed-adaptive-commands';

const labels:Record<AdaptiveProtocolRequest['kind'],string>={start:'Interpretation Or Learning',stop:'Stop Request',accept:'Written Acceptance','apply-learning':'Learning Application',close:'Local Close'};
const stateLabels:Record<string,string>={prepared:'Prepared',dispatching:'Starting',running:'In Progress',completed:'Completed',failed:'Failed',unknown:'Unconfirmed',stopped:'Stopped',admitted:'Request Saved','unadmitted-close':'Closed Locally'};
const send:FeedSemanticRequest=(path,data)=>request(path,data);
export type NewsFeedInterpretationsProps={scope:{deviceId:string;epoch:string};authorized:boolean;close():void;fallbackFocus():HTMLElement|null;
 /** Optional authenticated transport/storage seams also support local UI fixtures. */
 send?:FeedSemanticRequest;storage?:Pick<Storage,'getItem'|'setItem'>};

export function NewsFeedInterpretations(p:NewsFeedInterpretationsProps){
 const live=useRef(p);live.current=p;
 const current=useRef<FeedInterpretationBrowser|null>(null),[,render]=useState(0),[published,setPublished]=useState<FeedInterpretationBrowser|null>(null);
 useEffect(()=>{
  let mounted=true;const scope={deviceId:p.scope.deviceId,epoch:p.scope.epoch};
  const owns=()=>mounted&&live.current.authorized&&live.current.scope.deviceId===scope.deviceId&&live.current.scope.epoch===scope.epoch;
  const notify=()=>{if(mounted)render(value=>value+1);};
  const port=feedInterpretationHttpPort(p.send??send,notify),model=new FeedInterpretationBrowser(p.storage??draftBrowserStorage,scope,owns,port,notify);
  current.current=model;setPublished(model);void model.session.actions.journal.ready.then(notify);void model.refresh();
  return()=>{mounted=false;if(current.current===model)current.current=null;model.dispose();void model.settled();};
 },[p.scope.deviceId,p.scope.epoch,p.send,p.storage]);
 const model=published&&current.current===published&&published.scope.deviceId===p.scope.deviceId&&published.scope.epoch===p.scope.epoch?published:null;
 return <NewsFeedInterpretationsView key={p.scope.deviceId+':'+p.scope.epoch} model={model} authorized={p.authorized} close={p.close} fallbackFocus={p.fallbackFocus} changed={()=>render(value=>value+1)}/>;
}

/** Visible controls use the same retained session as effects and receipts. */
export function NewsFeedInterpretationsView({model,authorized,close,fallbackFocus,changed}:{model:FeedInterpretationBrowser|null;authorized:boolean;close():void;fallbackFocus():HTMLElement|null;changed():void}){
 const [actionBusy,setActionBusy]=useState(0),[notice,setNotice]=useState('');
 const alive=useRef(true),historyFocus=useRef<HTMLHeadingElement>(null),noticeGeneration=useRef(0),latest=useRef(model);latest.current=model;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const work=(run:()=>Promise<unknown>)=>{if(!model||!authorized||!model.current())return;const original=model,generation=++noticeGeneration.current;setActionBusy(value=>value+1);setNotice('');
  const task=Promise.resolve().then(run);void task.then(result=>{
   if(alive.current&&latest.current===original&&generation===noticeGeneration.current&&original.current()&&result&&typeof result==='object'&&'ok' in result&&result.ok===false&&'message' in result)setNotice(String(result.message));
  },error=>{if(alive.current&&latest.current===original&&generation===noticeGeneration.current&&original.current())setNotice(error instanceof Error?error.message:'The original request is kept.');})
   .finally(()=>{if(alive.current&&latest.current===original){setActionBusy(value=>Math.max(0,value-1));changed();}});
 };
 const s=model?.session,book=s?.actions.journal,view=s?.observation,cap=model?.capabilities;
 const canRead=!!(authorized&&model?.current()),busy=actionBusy>0||!!s?.busy;
 const acceptance=s?.acceptance??{state:'idle' as const};
 if(s&&s.selectedId)return <>
  {canRead&&(notice||s.error)&&<p role="alert" className="preserve-case">{notice||s.error}</p>}
  <NewsFeedInterpretationPanel attempt={view?.attempt??null} currentWriting={view?.currentWriting??null} acceptance={acceptance}
   authorized={canRead} canCheck={canRead} canCheckAcceptance={canRead} canStop={!!cap?.stop} canAccept={!!cap?.accept} busy={busy}
   currentAction={action=>s.currentAction(action)} check={target=>work(()=>s.check(target))} stop={target=>work(()=>s.stop(target))}
   accept={target=>work(()=>s.accept(target))} checkAcceptance={command=>work(()=>s.checkAcceptance(command))}
   close={()=>{noticeGeneration.current++;s.clearSelection();setNotice('');changed();}} fallbackFocus={()=>historyFocus.current??fallbackFocus()}/></>;
 const pending=[book?.pending,book?.pendingStop,book?.pendingClose].filter(Boolean) as AdaptiveProtocolRequest[];
 const page=model?.history??{entries:[]},proof=model?.receipt;
 return <ContentRecoveryPanel title="Feed Interpretations" close={close} fallbackFocus={fallbackFocus} breakpoint={800} backLabel="Back To Feed">
  {!canRead?<p role="alert">Access is unavailable. Reconnect to this workspace to read its saved interpretations.</p>:<>
   <p>Review how your saved preferences are understood. A completed interpretation is kept for your review before acceptance.</p>
   <div className="button-row"><button disabled={busy||!cap?.prepare||!!pending.length||!!book?.invalid} onClick={()=>work(()=>s!.start())}>Interpret Saved Writing</button>
    <button disabled={!!model?.loading} onClick={()=>void model?.refresh()}>Reload Saved History</button></div>
   {!cap?.prepare&&<p role="status">New interpretations are unavailable. You can still read saved history and check original requests.</p>}
   {(notice||model?.error||s?.error||book?.error)&&<p role="alert" className="preserve-case">{notice||model?.error||s?.error||book?.error}</p>}
   {!!pending.length&&<section aria-label="Kept Original Requests"><h3>Kept Original Requests</h3><p>These requests are unconfirmed. Check the originals; reopening this view does not resend them.</p>
    {pending.map(original=><div key={original.command.requestId}><p>{labels[original.kind]}</p><code>{original.command.requestId}</code>
     <button onClick={()=>work(()=>original.kind==='accept'&&'format' in original.command&&original.command.format===3?s!.checkAcceptance(original.command):s!.checkKept(original))}>Check Original Request</button>
     {original.kind==='start'&&<button disabled={busy||!cap?.close||!!book?.pendingClose||!!book?.pendingStop} onClick={()=>work(()=>s!.closeUnsent())}>Close This Original Locally</button>}
     {original.kind==='close'&&<button disabled={busy||!cap?.close} onClick={()=>work(()=>s!.continueClose())}>Continue Original Local Close</button>}
    </div>)}</section>}
   {book?.value.request?.kind==='accept'&&acceptance.state==='unknown'&&!book.pending&&<section><p>Acceptance admission is saved. Check the original acceptance to confirm the saved approval.</p>
    <button onClick={()=>work(()=>s!.checkAcceptance(acceptance.command))}>Check Original Acceptance</button></section>}
   {acceptance.state==='accepted'&&<section aria-label="Confirmed Original Acceptance"><p role="status">Original Acceptance Confirmed. This interpretation is saved as accepted.</p><button onClick={()=>work(()=>s!.select(acceptance.command.operationId))}>Review Accepted Interpretation</button></section>}
   {book&&<details><summary>Copy Kept Request Records</summary><textarea readOnly aria-label="Kept Feed Request Records" value={book.copy()}/></details>}
   <section aria-label="Saved Feed Requests"><h3 ref={historyFocus} tabIndex={-1}>Saved Requests</h3>
    {model?.loading&&<p role="status">Reading Saved Requests…</p>}
    {!model?.loading&&!page.entries.length&&<p>No saved requests are available on this page.</p>}
    <ul>{page.entries.map(entry=>{const original=entry.request,command=original.command;
     const interpretation=original.kind==='start'&&'format' in command&&command.format===3&&'kind' in command&&command.kind==='interpret'&&!entry.historical&&command.epoch===model!.scope.epoch;
     return <li key={command.requestId}><p>{original.kind==='start'&&'kind' in command&&command.kind==='interpret'?'Written Interpretation':labels[original.kind]} · <span className="preserve-case">{stateLabels[entry.state]??'Saved Request'}</span></p>
      <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time>{entry.historical&&<p>Earlier Workspace · Read Only</p>}
      <div className="button-row">{interpretation&&<button onClick={()=>work(()=>s!.select(command.requestId))}>Review Interpretation</button>}
       <button onClick={()=>work(()=>model!.checkHistory(original))}>Check Saved Receipt</button></div>
      <details><summary>Original Request</summary><code>{command.requestId}</code></details></li>;
    })}</ul>
    <div className="button-row"><button disabled={!!model?.loading} onClick={()=>void model?.loadHistory()}>First Page</button>
     {page.next&&<button disabled={!!model?.loading} onClick={()=>void model?.loadHistory(page.next)}>More History</button>}</div>
   </section>
   {proof&&<p role="status">Original Request <code>{proof.request.command.requestId}</code>: {proof.receipt.state==='confirmed'?'Saved Admission Confirmed':'Still Unconfirmed'}. A saved admission alone does not confirm completion or approval.</p>}
  </>}
 </ContentRecoveryPanel>;
}
