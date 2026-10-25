import { ProjectOptions } from './ProjectOptions';
import {useEffect,useRef,useState} from 'react';
import {registerRecordDraftNavigation} from './record-draft-navigation';
import type {Entity,Snapshot,Task} from '../../../packages/domain/contracts';
import {blankRecord,contentSchema,contentStages,type Content,type ContentOutputSource,type RecordValue} from '../../../packages/domain/workspace-records';
import {dayInZone} from '../../../packages/domain/tasks';
import {useRetained,retainedWindowId} from './useWorkspace';
import {ContentRecoveryJournal} from './content-recovery';
import {ContentRecoveryPanel,ContentRecoveryDetails,contentRetentionLabel} from './ContentRecoveryPanel';
import {draftBrowserStorage} from './draft-browser-storage';
import {canonical} from '../../../packages/domain/contracts';
import {ContentWriting} from './ContentWriting';
import {ContentFiles,useContentFiles} from './ContentFiles';
import {ContentExport,cleanContentExport} from './ContentExport';
import {ContentTiming} from './ContentTiming';
import {ContentLibrary} from './ContentLibrary';
import {ContentTagsInput} from './ContentTagsInput';
export {ContentTagsInput} from './ContentTagsInput';
import {ContentReviews} from './ContentReviews';
import {ContentAgentWork} from './ContentAgentWork';
import {ContentVersions} from './ContentVersions';
import {RecordConnections} from './RecordConnections';
import {useContentCommand,useContentState,useContentLibrary} from './useContentWorkspace';
import {readLocal,saveLocal} from './api';
import './content-workspace.css';

export default function ContentEditor({id,entity,snapshot,refresh,editTask,close,removeDraft,openSource,openAssistantSettings,requestPublication}:{id:string;entity?:Entity<Content>;snapshot:Snapshot;refresh:()=>Promise<void>;editTask:(t:Entity<Task>)=>void;close:()=>void;removeDraft:()=>void;openSource:(s:ContentOutputSource)=>void;openAssistantSettings?:()=>void;requestPublication?:string}){
 const recoveryRef=useRef<ContentRecoveryJournal|null>(null);
 const recoveryScope={epoch:snapshot.epoch,deviceId:snapshot.deviceId,windowId:retainedWindowId,id};
 if(!recoveryRef.current||canonical(recoveryRef.current.scope)!==canonical(recoveryScope))recoveryRef.current=new ContentRecoveryJournal(draftBrowserStorage,recoveryScope);
 const recovery=recoveryRef.current,[,redrawRecovery]=useState(0),[details,setDetails]=useState(false);
 const writingFocus=useRef<HTMLElement|null>(null);
 const [online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine!==false);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine!==false);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 const [initial]=useState(()=>blankRecord('content',snapshot.layout.value.timezone) as Content),editor=useRetained<Content>('content',id,initial,entity,snapshot,refresh,{autoSave:false,
  onAcknowledged:(original,result)=>{recovery.acknowledge(original,result);redrawRecovery(n=>n+1);}});
 const latest=editor.conflict?.current&&editor.conflict.current.revision>(entity?.revision??0)?editor.conflict.current:entity;
 const canPrepare=!!editor.conflict&&!editor.saving&&editor.epoch===snapshot.epoch&&editor.conflict.code!=='local_editor';
 const prepareCopy=(saved:boolean)=>{
  if(!canPrepare||saved&&!latest)return;
  const original=JSON.stringify({value:editor.value,revision:editor.revision,epoch:editor.epoch,dirty:editor.dirty,pending:editor.pending,conflict:editor.conflict});
  if(!recovery.keepComparison(original,latest)){redrawRecovery(n=>n+1);return;}
  editor.editProposal();editor.change(saved?latest!.value:editor.value);setDetails(false);setError('Original versions are kept in Details. Review this writing, then choose Save Version.');
 };
 const tabKey=`e3:content-tab:${snapshot.deviceId}:${id}`, [tab,setTab]=useState<'write'|'agents'|'review'|'versions'>(()=>readLocal(tabKey)??'write'),[error,setError]=useState(''),[librarySeed,setLibrarySeed]=useState<Content>(),[libraryOpen,setLibraryOpen]=useState<'templates'|'brands'>(),[tool,setTool]=useState<'files'|'export'>();
 const activity=useContentState(id,!!entity,snapshot.epoch),library=useContentLibrary();
 const command=useContentCommand(snapshot,id,async()=>{await refresh();await activity.load();});
 const commandHeld=!!command.pending||command.invalid;
 const uploadsEnabled=!editor.saving&&!editor.pending&&!editor.value.archived&&!command.busy&&!commandHeld;
 const uploads=useContentFiles(id,editor.value,snapshot,update=>editor.change(v=>update(v) as Content),uploadsEnabled);
 const filesPending=uploads.staging||uploads.pending.length>0;
 const panelLeave=useRef<(()=>boolean)|null>(null),libraryLeave=useRef<(()=>boolean)|null>(null),[libraryInstance,setLibraryInstance]=useState(0);
 const openTool=(next:'files'|'export')=>{if(libraryLeave.current&&!libraryLeave.current())return;setDetails(false);setLibrarySeed(undefined);setLibraryOpen(undefined);setTool(next);};
 const openLibrary=(next:'templates'|'brands',seed?:Content)=>{if(libraryLeave.current&&!libraryLeave.current())return;setLibraryInstance(n=>n+1);setDetails(false);setTool(undefined);setLibrarySeed(seed);setLibraryOpen(next);};
 const navigation=useRef({editor,filesPending,busy:command.busy});navigation.current={editor,filesPending,busy:command.busy};
 useEffect(()=>registerRecordDraftNavigation(()=>!navigation.current.filesPending&&!navigation.current.busy&&navigation.current.editor.retainForNavigation()),[]);
 const changed=(patch:Partial<Content>)=>editor.change(v=>({...v,...patch}));
 const isDirty=editor.dirty||!!editor.pending||!!editor.conflict||editor.saving||filesPending;
 const blocked=isDirty||command.busy||!!commandHeld||!!entity?.value.archived;
 const requestSeen=useRef<string|undefined>(undefined);
 useEffect(()=>{saveLocal(tabKey,tab);},[tab,tabKey]);
 useEffect(()=>{if(requestPublication&&requestPublication!==requestSeen.current&&!editor.pending&&!editor.conflict){if(panelLeave.current&&!panelLeave.current())return;requestSeen.current=requestPublication;changed({stage:'published',publication:editor.value.publication??{kind:'manual',date:dayInZone(snapshot.layout.value.timezone),note:''}});setTab('write');}},[requestPublication]);
 const save=async()=>{if(filesPending||command.busy||commandHeld||editor.epoch!==snapshot.epoch)return;if(editor.pending){await editor.flush();return;}const parsed=contentSchema.safeParse(editor.value);if(!parsed.success){setError(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(' '));return;}editor.change(parsed.data);setError('');await editor.flush();};
 const exportState=useRef({entity,value:editor.value,revision:editor.revision,blocked:isDirty||command.busy||!!commandHeld||editor.storageError||editor.epoch!==snapshot.epoch});exportState.current={entity,value:editor.value,revision:editor.revision,blocked:isDirty||command.busy||!!commandHeld||editor.storageError||editor.epoch!==snapshot.epoch};
 const mayExport=()=>{const current=exportState.current;return cleanContentExport(current.entity,current.value,current.revision,current.blocked);};
 const currentReviews=activity.state?.reviews.filter(r=>r.sourceRevision===entity?.revision)??[],approved=currentReviews.length>0&&currentReviews.every(r=>r.state==='approved'&&!r.comments.some(c=>!c.resolved));
 const selectTab=(next:typeof tab)=>{if(next===tab||!panelLeave.current||panelLeave.current())setTab(next);};
 const value=editor.value;
 const archive=async()=>{
  if(!entity||isDirty||command.busy||commandHeld)return;
  if(canonical(entity.value)!==canonical(value)||entity.revision!==editor.revision){setError('Review the exact saved Content version before changing its archive state.');return;}
  if(!value.archived&&!recovery.beginArchive(entity,value)){redrawRecovery(n=>n+1);setDetails(true);return;}
  editor.change(v=>({...v,archived:!v.archived}));await editor.flush();
 };
 const undo=async()=>{
  if(!entity||isDirty||command.busy||commandHeld)return;
  const inverse=recovery.beginUndo(entity);redrawRecovery(n=>n+1);if(!inverse)return;
  editor.change(inverse);await editor.flush();
 };
 const undoAvailable=!!recovery.undoFor(entity);
 const retryRecovery=()=>{
  editor.retainNow();
  if(recovery.invalid){const reread=new ContentRecoveryJournal(draftBrowserStorage,recoveryScope);if(!reread.invalid)recoveryRef.current=reread;}
  else recovery.retain();
  redrawRecovery(n=>n+1);
 };
 return <section className={`card content-studio${details||tool||libraryOpen||librarySeed?' content-recovery-open':''}`} aria-label="Content editor"><div className="content-studio-main" onFocusCapture={event=>{if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement)writingFocus.current=event.target;}}><header className="content-studio-header"><div className="content-studio-identity"><div className="content-retention-status"><span role="status">{contentRetentionLabel(editor)}{approved&&!editor.dirty?' · Approved':''}{!online?' · Offline':editor.networkError?' · Host Connection Unconfirmed':''}</span><button aria-expanded={details} onClick={()=>{if(libraryLeave.current&&!libraryLeave.current())return;setTool(undefined);setLibrarySeed(undefined);setLibraryOpen(undefined);setDetails(!details);}}>Details</button></div>{tab==='write'?<label className="content-title-field"><span className="sr-only">Title</span><input required maxLength={300} placeholder="Untitled draft" value={value.title} disabled={editor.saving||!!editor.pending||value.archived||command.busy||!!commandHeld} onChange={e=>changed({title:e.target.value})}/></label>:<h2>{value.title||'Untitled draft'}</h2>}</div><div className="content-studio-actions compact-actions"><button className="compact-action" onClick={()=>{if(!filesPending&&!command.busy&&(!libraryLeave.current||libraryLeave.current())&&(!panelLeave.current||panelLeave.current())&&editor.retainForNavigation())close();}}>Keep & Close</button>{(editor.dirty||!entity)&&<button className="compact-action" disabled={editor.saving||!!editor.pending||command.busy||filesPending} onClick={()=>{if(!entity&&panelLeave.current&&!panelLeave.current()||!editor.discard())return;setError('');if(!entity)removeDraft();}}>{entity?'Discard Edits':'Discard Draft'}</button>}<button className="compact-action primary" disabled={(!editor.dirty&&!editor.pending)||editor.saving||filesPending||!!editor.conflict||command.busy||!!commandHeld||value.archived&&!editor.pending&&!recovery.canContinueArchive(value,editor.revision)} onClick={()=>void save()}>{editor.pending?'Check Original Save':'Save Version'}</button></div></header>
 <nav className="content-studio-tabs" aria-label="Content workspace">{([['write','Write'],['agents','Agent Work'],['review','Review'],['versions','Versions']] as const).map(([key,label])=><button key={key} aria-current={tab===key?'page':undefined} disabled={!entity&&key!=='write'} onClick={()=>selectTab(key)}>{label}{key==='agents'&&activity.state?.jobs.some(j=>j.attempt?.state==='running')?' · Working':''}{key==='review'&&approved?' · Approved':''}</button>)}</nav>
 {(error||command.error||activity.error||library.error)&&<p role="alert" className="field-error">{error||command.error||activity.error||library.error}</p>}
 {command.pending&&!command.busy&&<div className="notice"><p>A Content change needs confirmation from the host.</p><button disabled={command.busy} onClick={()=>void command.check()}>Check Original Change</button> <button disabled={command.busy||command.invalid} onClick={()=>void command.retry()}>Retry Original Request</button></div>}
 {command.receipt&&<details><summary>Original Change Receipt</summary><p>{command.receipt.message}</p></details>}
 {command.invalid&&<details><summary>Kept Content Request</summary><textarea readOnly aria-label="Copy Original Content Request" value={command.copy()}/></details>}
 {editor.conflict&&!details&&<p className="content-conflict-cue" role="status">Your writing needs review. <button onClick={()=>setDetails(true)}>Compare Versions</button></p>}
 {tab!=='write'&&isDirty&&<p className="notice">Save or discard your edits before acting on a saved version.</p>}
 {tab==='write'?<><fieldset disabled={editor.saving||!!editor.pending||value.archived||command.busy||!!commandHeld}><div className="content-write-layout"><ContentWriting value={value} change={changed}/><aside className="content-inspector" aria-label="Draft Context">
 <details className="content-details content-brief-panel" open><summary>Brief & Planning</summary><label>Brief<textarea rows={3} maxLength={10000} value={value.brief} onChange={e=>changed({brief:e.target.value})} placeholder="Who is this for, and what should it accomplish?"/></label><div className="record-field-grid"><label>Stage<select value={value.stage} onChange={e=>{const stage=e.target.value as Content['stage'];changed({stage,publication:stage==='published'?value.publication??{kind:'manual',date:dayInZone(snapshot.layout.value.timezone),note:''}:value.publication});}}>{contentStages.map(s=><option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}</select></label><label>Platform or content type<input maxLength={100} required value={value.platform} onChange={e=>changed({platform:e.target.value})}/></label><label>Collection<input list={`collections-${id}`} maxLength={100} value={value.collection??''} onChange={e=>changed({collection:e.target.value})}/><datalist id={`collections-${id}`}>{[...new Set((snapshot.records?.content??[]).map(c=>c.value.collection).filter(Boolean))].map(c=><option key={c}>{c}</option>)}</datalist></label><label>Tags<ContentTagsInput value={value.tags??[]} onChange={tags=>changed({tags})}/></label><label>Project<select value={value.projectId??''} onChange={e=>changed({projectId:e.target.value||null})}><option value="">No Project</option><ProjectOptions snapshot={snapshot} selected={value.projectId}/></select></label><label>Brand guidance<select value={value.brandId??''} onChange={e=>changed({brandId:e.target.value||null})}><option value="">No brand</option>{library.items.filter(b=>b.type==='brand'&&(!b.archived||b.id===value.brandId)).map(b=><option key={b.id} value={b.id}>{b.name} · v{b.revision}{b.archived?' · archived':''}</option>)}</select></label><label>Format<select value={value.format} onChange={e=>changed({format:e.target.value as Content['format']})}><option value="markdown">Markdown</option><option value="text">Plain text</option></select></label><label>Planned date<input type="date" value={value.plannedDate} onChange={e=>changed({plannedDate:e.target.value,...(!e.target.value?{plannedTime:'',plannedOverlap:undefined}:{})})}/></label></div><ContentTiming value={value} change={changed} timezone={snapshot.layout.value.timezone}/>{value.stage==='published'&&value.publication&&<section><h3>Manual Publication Record</h3><p className="metadata">Record where you already published this work. Saving does not publish it.</p><label>Published date<input type="date" required value={value.publication.date} onChange={e=>changed({publication:{...value.publication!,date:e.target.value}})}/></label><label>Where it was published<textarea required maxLength={2000} value={value.publication.note} onChange={e=>changed({publication:{...value.publication!,note:e.target.value}})}/></label></section>}</details>
 <button type="button" onClick={()=>openTool('files')}>Files And Images · {value.assets?.length??0}{filesPending?' · Pending':''}</button></aside></div></fieldset>
 {entity&&<details className="content-details"><summary>Linked Work & Source</summary><RecordConnections kind="content" entity={entity} snapshot={snapshot} refresh={refresh} editTask={editTask} openSource={openSource}/></details>}</>:entity&&tab==='agents'?<ContentAgentWork leaveRef={panelLeave} entity={entity} snapshot={snapshot} state={activity.state} blocked={blocked} blockedReason={value.archived?'Restore this Content item before starting agent work.':command.busy?'A Content change is in progress.':commandHeld?'Check the original Content change before starting.':'Save or discard your edits before starting from this version.'} run={command.run} openSettings={openAssistantSettings}/>:entity&&tab==='review'?<ContentReviews leaveRef={panelLeave} entity={entity} snapshot={snapshot} reviews={activity.state?.reviews??[]} blocked={blocked} run={command.run}/>:entity&&tab==='versions'?<ContentVersions entity={entity} blocked={blocked} run={command.run}/>:null}
 <footer className="content-delivery"><div className="compact-actions"><button onClick={()=>openTool('files')}>Files And Images</button><button onClick={()=>openLibrary('templates')}>Templates</button><button onClick={()=>openLibrary('brands')}>Brands</button>
 {entity&&<><button disabled={!mayExport()} onClick={()=>{if(mayExport())openTool('export');}}>Export Saved Version</button><button disabled={!mayExport()} onClick={()=>{if(mayExport())openLibrary('templates',entity.value);}}>Save As Template</button><button disabled={isDirty||command.busy||!!commandHeld} onClick={()=>void archive()}>{value.archived?'Restore Content':'Archive Content'}</button>{undoAvailable&&<button disabled={isDirty||command.busy||!!commandHeld} onClick={()=>void undo()}>Undo Archive</button>}</>}
 </div>{entity&&<small>Exports use saved version {entity.revision}. Pending writing and uploads must settle first.</small>}</footer>

 </div>{(libraryOpen||librarySeed)&&<ContentLibrary key={libraryInstance} leaveRef={libraryLeave} snapshot={snapshot} seed={librarySeed} initialSection={libraryOpen} close={()=>{setLibrarySeed(undefined);setLibraryOpen(undefined);void library.load();}}/>}
 {tool==='export'&&entity&&<ContentExport entity={entity} scope={`${snapshot.deviceId}:${snapshot.epoch}:${id}`} allowed={mayExport} close={()=>setTool(undefined)} fallbackFocus={()=>writingFocus.current}/>}
 {tool==='files'&&<ContentRecoveryPanel title="Files And Images" tools breakpoint={800} backLabel="Back To Draft" close={()=>setTool(undefined)} fallbackFocus={()=>writingFocus.current}>
  <ContentFiles value={value} uploads={uploads} disabled={!uploadsEnabled} undoName={recovery.fileUndoFor(value)?.file.name}
   remove={file=>{if(!uploadsEnabled)return;editor.change(previous=>{const assets=recovery.detachFile(previous,file);redrawRecovery(n=>n+1);return assets?{...previous,assets}:previous;});}}
   undo={()=>{if(!uploadsEnabled)return;editor.change(previous=>{const assets=recovery.undoFile(previous);redrawRecovery(n=>n+1);return assets?{...previous,assets}:previous;});}}/>
  {recovery.error&&<p role="alert">{recovery.error}</p>}
  <div className="content-image-gallery">{(value.assets??[]).filter(f=>/\.(png|jpe?g|webp)$/i.test(f.name)).map(file=><figure key={file.id}><img src={`/api/attachments/${file.id}?preview=1`} alt={file.name} loading="lazy"/><figcaption className="preserve-case">{file.name}</figcaption>{value.format==='markdown'&&<button disabled={!uploadsEnabled} onClick={()=>{if(uploadsEnabled)editor.change(previous=>({...previous,body:previous.body+`\n\n![${file.name.replace(/[\[\]]/g,'')}](/api/attachments/${file.id})\n`}));}}>Insert Into Draft</button>}</figure>)}</div>
 </ContentRecoveryPanel>}
 {details&&<ContentRecoveryPanel title="Save And Recovery" close={()=>setDetails(false)} fallbackFocus={()=>writingFocus.current}>
  <ContentRecoveryDetails editor={editor} online={online} recovery={recovery} latest={latest} canPrepare={canPrepare}
   prepare={prepareCopy} check={()=>void editor.flush()} retry={retryRecovery}/>
 </ContentRecoveryPanel>}
 </section>;
}
