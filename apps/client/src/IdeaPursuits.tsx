import {useEffect,useMemo,useRef,useState} from 'react';
import {z} from 'zod';
import type {Snapshot} from '../../../packages/domain/contracts';
import {ideaEntrySchema,ideaPursuitSchema,type IdeaEntry,type IdeaPage,type IdeaPursuit,type IdeaRun,type IdeaRunDetail} from '../../../packages/domain/idea-pursuits';
import type {HomeSourceActions} from './HomeLibrary';
import type {HomeResource,HomeReference} from '../../../packages/domain/home-library';
import {exactHomeReference} from '../../../packages/domain/home-library-view';
import {ToolActivity} from './ToolActivity';
import {request} from './api';
import {draftBrowserStorage} from './draft-browser-storage';
import {retainedWindowId} from './useWorkspace';
import {RetainedBook} from './content-library-recovery';
import {IdeaQuestionJournal} from './idea-pursuits-retained';
import {registerHomeDraftNavigation} from './home-draft-navigation';
import type {useIdeaPursuits} from './useIdeaPursuits';
import {Dialog} from './ui';
import './idea-pursuits.css';

type Controller=ReturnType<typeof useIdeaPursuits>;
type Props=HomeSourceActions&{snapshot:Snapshot;controller:Controller;resources?:HomeResource[]};
const viewSchema=z.object({selected:z.string().uuid().nullable()}).strict();
export function IdeaPursuits({snapshot,controller,onAssistantHandoff,openResource,resources}:Props){
 const scope={deviceId:snapshot.deviceId,epoch:snapshot.epoch,windowId:retainedWindowId};
 const view=useMemo(()=>new RetainedBook(draftBrowserStorage,`e3:idea-pursuits-view:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,viewSchema,{selected:null}),[scope.deviceId,scope.epoch]);
 const [,render]=useState(0),[error,setError]=useState('');
 const select=(id:string|null)=>{if(view.keep({selected:id})){render(v=>v+1);setError('');}else setError(view.error);};
 const saved=controller.journal.value.receipt;
 return <section className="idea-pursuits" aria-label="Idea Pursuits"><h2>Pursuits</h2>
  <p className="metadata">Each use of a starter keeps its own brief, questions and original work. Opening one does not send or mark it reviewed.</p>
  {(error||view.error||controller.error||controller.journal.error)&&<p role="alert">{error||view.error||controller.error||controller.journal.error}</p>}
  {controller.journal.pending&&<div className="compact-actions"><button disabled={controller.busy} onClick={()=>void controller.check()}>Check Original Idea Request</button><button disabled={controller.busy} onClick={()=>void controller.retry()}>Retry Original Request</button></div>}
  {controller.journal.invalid&&<details><summary>Original Request Recovery</summary><textarea readOnly aria-label="Original Idea Request" value={controller.journal.copy()}/></details>}
  {saved?.state==='saved'&&<button className="compact-action" onClick={()=>select(saved.pursuit.id)}>Open Last Kept Pursuit</button>}
  {!controller.page?<p role="status">Pursuit history has not loaded. Kept writing is unchanged.</p>:<>
   {controller.page.rows.map(row=><article className="home-idea-draft" key={row.id}><div><h3 className="preserve-case">{row.title}</h3><p>{new Date(row.createdAt).toLocaleString()} · {row.reviewed?'Marked Reviewed':'Not Marked Reviewed'}</p></div><button className="compact-action" onClick={()=>select(row.id)}>Open Pursuit</button></article>)}
   {!controller.page.rows.length&&<p>No pursuits are saved yet. Review a starter to prepare the first one.</p>}
   <div className="compact-actions"><button onClick={()=>void controller.load()}>First Page</button>{controller.page.next&&<button onClick={()=>void controller.load(controller.page!.next!)}>More Pursuits</button>}</div>
  </>}
  {view.value.selected&&<PursuitDetail key={`${scope.epoch}:${scope.deviceId}:${view.value.selected}`} id={view.value.selected} snapshot={snapshot} controller={controller}
   onAssistantHandoff={onAssistantHandoff} openResource={openResource} resources={resources} close={()=>select(null)}/>}
 </section>;
}
function PursuitDetail({id,snapshot,controller,onAssistantHandoff,openResource,resources,close}:Props&{id:string;close:()=>void}){
 const owner=useMemo(()=>({active:true,generation:0,epoch:snapshot.epoch,deviceId:snapshot.deviceId}),[snapshot.epoch,snapshot.deviceId,id]);
 const current=useRef(owner);current.current=owner;const active=()=>owner.active&&current.current===owner;
 const journal=useMemo(()=>new IdeaQuestionJournal(draftBrowserStorage,{...snapshot,windowId:retainedWindowId},id),[owner,id]);
 const [question,setQuestion]=useState(journal.value.text),writing=useRef(question);writing.current=question;
 const [pursuit,setPursuit]=useState<IdeaPursuit>(),[entries,setEntries]=useState<IdeaPage<IdeaEntry>>(),[runs,setRuns]=useState<IdeaPage<IdeaRun>>(),
  [result,setResult]=useState<IdeaRunDetail>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copy,setCopy]=useState(false);
 const retain=()=>{if(journal.invalid)return false;const ok=journal.keep({format:1,text:writing.current});if(!ok)setError(journal.error);return ok;};
 const retention=useRef(retain);retention.current=retain;
 const query=(kind:string,extra='')=>`home/ideas?id=${encodeURIComponent(id)}&kind=${kind}${extra}`;
 const load=async()=>{
  const ticket=++owner.generation;
  try{
   const [detail,briefs,work]=await Promise.all([
    request<{epoch:string;pursuit:IdeaPursuit}>(query('detail')),request<IdeaPage<IdeaEntry>>(query('entries')),request<IdeaPage<IdeaRun>>(query('runs'))]);
   if(detail.epoch!==owner.epoch||detail.pursuit.id!==id||!ideaPursuitSchema.safeParse(detail.pursuit).success
    ||briefs.epoch!==owner.epoch||work.epoch!==owner.epoch||briefs.rows.some(row=>!ideaEntrySchema.safeParse(row).success||row.pursuitId!==id)
    ||work.rows.some(row=>row.pursuitId!==id))throw Error('The original pursuit response could not be verified.');
   if(active()&&ticket===owner.generation){setPursuit(detail.pursuit);setEntries(briefs);setRuns(work);}
  }catch(reason){if(active()&&ticket===owner.generation)setError(reason instanceof Error?reason.message:'The pursuit could not load.');}
 };
 useEffect(()=>{owner.active=true;void load();const unregister=registerHomeDraftNavigation(()=>retention.current());return()=>{owner.active=false;owner.generation++;unregister();};},[owner]);
 const handoff=async(entryId:string)=>{
  if(!active()||busy||!onAssistantHandoff||!retain())return;
  setBusy(true);setError('');
  try{
   const value=await request<{epoch:string;entry:IdeaEntry}>(`home/ideas?kind=entry&id=${encodeURIComponent(entryId)}`);
   if(value.epoch!==owner.epoch||value.entry.id!==entryId||value.entry.pursuitId!==id||!ideaEntrySchema.safeParse(value.entry).success)throw Error('The exact original brief is unavailable.');
   if(active())await onAssistantHandoff({...value.entry.handoff,handoffId:entryId,idea:{pursuitId:id,entryId}});
  }catch(reason){if(active())setError(reason instanceof Error?reason.message:'The original brief remains kept.');}
  finally{if(active())setBusy(false);}
 };
 const prepare=async()=>{
  if(!pursuit||!active()||busy||controller.busy||controller.journal.pending||controller.journal.invalid||!retain()||!question.trim())return;
  const submitted=question;setBusy(true);setError('');
  try{
   const receipt=await controller.run({requestId:crypto.randomUUID(),epoch:owner.epoch,type:'question',id,entryId:crypto.randomUUID(),expectedRevision:pursuit.revision,text:submitted});
   if(active()&&receipt?.state==='saved'){
    // Keep question writing even after acknowledgement. Preparing is separate from opening or sending.
    await load();
   }
  }finally{if(active())setBusy(false);}
 };
 const more=async(kind:'entries'|'runs')=>{
  const page=kind==='entries'?entries:runs;if(!page?.next||busy||!active())return;
  setBusy(true);const ticket=owner.generation;
  try{
   const next=await request<IdeaPage<IdeaEntry|IdeaRun>>(query(kind,'&after='+encodeURIComponent(page.next)));
   if(next.epoch!==owner.epoch||!Array.isArray(next.rows)||next.rows.length>50||next.rows.some(row=>row.pursuitId!==id))throw Error('The original history page changed.');
   if(active()&&ticket===owner.generation){if(kind==='entries')setEntries(next as IdeaPage<IdeaEntry>);else setRuns(next as IdeaPage<IdeaRun>);}
  }catch(reason){if(active())setError(reason instanceof Error?reason.message:'The next history page could not load.');}
  finally{if(active())setBusy(false);}
 };
 const openRun=async(link:IdeaRun)=>{
  if(!active()||busy||!retain())return;setBusy(true);setError('');const ticket=owner.generation;
  try{
   const value=await request<IdeaRunDetail>(query('run','&operation='+encodeURIComponent(link.operationId)));
   if(value.epoch!==owner.epoch||value.link.pursuitId!==id||value.link.operationId!==link.operationId||value.link.entryId!==link.entryId
    ||value.operation&&(value.operation.id!==link.operationId||value.operation.conversationId!==link.conversationId||value.operation.context.idea?.pursuitId!==id||value.operation.context.idea.entryId!==link.entryId))
    throw Error('The result does not match this original attempt.');
   if(active()&&ticket===owner.generation)setResult(value);
  }catch(reason){if(active())setError(reason instanceof Error?reason.message:'The exact result could not be read.');}
  finally{if(active())setBusy(false);}
 };
 const blocked=busy||controller.busy||!!controller.journal.pending||controller.journal.invalid;
 const sourceStatus=(ref:HomeReference)=>{
  if(!resources)return 'Current Availability Not Checked';
  const source=resources.find(row=>row.reference.kind===ref.kind&&row.reference.id===ref.id);
  return !source?'Current Source Unavailable; Captured Version Kept':exactHomeReference(source.reference,ref)?'Same Saved Version':'Source Changed; Captured Version Kept';
 };
 return <Dialog title={pursuit?.title??'Original Pursuit'} close={()=>{if(!busy&&retain())close();}}><div className="idea-pursuit-detail">
  {(error||journal.error)&&<p role="alert">{error||journal.error}</p>}
  <div className="compact-actions"><button disabled={busy} onClick={()=>void load()}>Refresh Original History</button><button onClick={()=>setCopy(!copy)}>Copy Kept Question</button></div>
  {copy&&<textarea readOnly aria-label="Complete Kept Question" value={question}/>}
  {journal.invalid&&<details><summary>Original Question Recovery</summary><textarea readOnly value={journal.copy()} aria-label="Original Question Recovery"/></details>}
  {pursuit&&<><p className="metadata">{pursuit.reviewed?'Marked Reviewed':'Not Marked Reviewed'} · Personal Review Only</p><button disabled={blocked} onClick={async()=>{
   const receipt=await controller.run({requestId:crypto.randomUUID(),epoch:owner.epoch,type:'review',id,expectedRevision:pursuit.revision,reviewed:!pursuit.reviewed});
   if(active()&&receipt?.state==='saved')await load();
  }}>{pursuit.reviewed?'Mark Not Reviewed':'Mark Reviewed'}</button></>}
  <section><h3>Briefs And Questions</h3>{entries?.rows.map(entry=><article key={entry.id}><p className="metadata">{entry.question?'Follow-Up Question':'Original Brief'} · {new Date(entry.createdAt).toLocaleString()}</p>
   <details><summary>Read Complete Brief</summary><pre>{entry.handoff.text}</pre><p className="metadata">Source Capture {entry.handoff.sourceCaptureId}. These are the versions selected at preparation time.</p>
    {entry.handoff.sourceRefs.map(ref=><p key={`${ref.kind}:${ref.id}`}>{ref.kind} · {ref.id} · Version {ref.revision} · {sourceStatus(ref)}</p>)}</details>
   <button disabled={blocked||!onAssistantHandoff} onClick={()=>void handoff(entry.id)}>Review In Assistant</button></article>)}
   {entries?.next&&<button disabled={busy} onClick={()=>void more('entries')}>More Briefs And Questions</button>}
  </section>
  <section><h3>Ask A Follow-Up</h3><p className="metadata">Keeps a separate brief with the original source context. Review it in Assistant before sending. Earlier results stay below.</p>
   <label>Question<textarea value={question} maxLength={50000} disabled={journal.invalid} onChange={event=>{writing.current=event.target.value;setQuestion(event.target.value);retain();}}/></label>
   <button disabled={blocked||journal.invalid||!question.trim()||!pursuit} onClick={()=>void prepare()}>Keep Question For Review</button>
  </section>
  <section><h3>Original Work</h3>{!runs?.rows.length&&<p>No Assistant submission has been linked to this pursuit. Preparing a brief does not start work.</p>}
   {runs?.rows.map(link=><article key={link.operationId}><p className="metadata">Submitted {new Date(link.createdAt).toLocaleString()}</p><button disabled={busy} onClick={()=>void openRun(link)}>Open Exact Attempt</button></article>)}
   {runs?.next&&<button disabled={busy} onClick={()=>void more('runs')}>More Original Attempts</button>}
  </section>
  {result&&<section aria-label="Exact Attempt"><h3>Exact Attempt</h3><p className="metadata">{result.link.operationId}</p>{!result.operation?<p>The original work is unavailable. Its pursuit link is preserved.</p>:<>
   <p>{result.operation.state} · {result.operation.state==='completed'?'Reply Recorded':'Original Outcome; Opening Does Not Retry'}</p>
   {result.operation.error&&<p role="status">{result.operation.error}</p>}
   <details><summary>Exact Submitted Writing</summary><pre>{result.operation.input}</pre></details>
   <pre className="idea-pursuit-result">{result.operation.text||'No returned text is recorded for this attempt.'}</pre>
   <ToolActivity operation={result.operation}/>
   {result.capture&&<details><summary>Captured Source Evidence</summary>{result.capture.sources.map((source,index)=><article key={index}><h4 className="preserve-case">{source.title}</h4><p>{source.reference.kind} · {source.reference.id} · Version {source.reference.revision}</p><pre>{source.text}</pre>{source.url&&<a href={source.url} target="_blank" rel="noreferrer">Original Source</a>}</article>)}</details>}
   {result.outputs.map(output=><article key={`${output.id}:${output.version}`}><h4 className="preserve-case">{output.name}</h4><pre>{output.text}</pre>{output.file&&openResource&&<button onClick={()=>{if(retain())openResource({kind:'output',id:output.id,revision:output.version,sha256:output.file!.sha256});}}>Open Saved Output</button>}</article>)}
  </>}</section>}
 </div></Dialog>;
}
