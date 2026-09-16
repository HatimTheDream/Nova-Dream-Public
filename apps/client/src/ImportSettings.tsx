import { useEffect, useRef, useState } from 'react';
import { importGroupLabel, importMaxBytes, type ImportReview } from '../../../packages/domain/workspace-import';
import { readLocal, request, saveLocal } from './api';
import { readImportFile } from './import-file';

export function ImportSettings({ epoch, deviceId, onPrepared }: { epoch: string; deviceId: string; onPrepared: () => void }) {
  const journal = `e3:import-request:${deviceId}`;
  const [reviews,setReviews] = useState<ImportReview[]>([]), [selected,setSelected] = useState(''), [file,setFile] = useState<File>();
  const [keyFile,setKeyFile] = useState<File>(), [sourceId,setSourceId] = useState(()=>readLocal<string>('e3:nova-import-source')??crypto.randomUUID());
  const [sourceZone,setSourceZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [filter,setFilter] = useState(''), [limit,setLimit] = useState(30);
  const [outcome,setOutcome] = useState('editable');
  const [confirm,setConfirm] = useState(false), [remove,setRemove] = useState(false), active = useRef(false);
  const load = async () => { const result = await request<{reviews:ImportReview[]}>('storage/imports'); setReviews(result.reviews); return result.reviews; };
  useEffect(()=>{let alive=true;void request<{reviews:ImportReview[]}>('storage/imports').then(r=>{if(alive){setReviews(r.reviews);setSelected(r.reviews.at(-1)?.id??'');}}).catch(()=>{if(alive)setMessage('Reconnect to load your import reviews.');});return()=>{alive=false;};},[epoch,deviceId]);
  const inspect = async () => {
    if(!file || active.current)return;active.current=true;setBusy(true);setMessage('');
    try {
      if(file.size>importMaxBytes)throw new Error('Choose an export smaller than 32 MB.');
      const bytes=await file.arrayBuffer(), fileHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
      const source=await readImportFile(bytes,keyFile,sourceId,sourceZone);
      if(source.format==='nova-dream-backup-15')saveLocal('e3:nova-import-source',sourceId);
      const kept=readLocal<{epoch:string;requestId:string;fileHash:string}>(journal), requestId=kept?.epoch===epoch&&kept.fileHash===fileHash?kept.requestId:crypto.randomUUID();
      if(!saveLocal(journal,{epoch,requestId,fileHash}))throw new Error('Free browser storage so this request can be recovered.');
      const review=await request<ImportReview>('storage/imports/review',{requestId,epoch,source},undefined,60000);
      saveLocal(journal,null);await load();setSelected(review.id);setConfirm(false);setRemove(false);
    } catch(e){setMessage(e instanceof Error?e.message:'The import review was interrupted. Reselect the same file and retry.');}
    finally{active.current=false;setBusy(false);}
  };
  const review=reviews.find(r=>r.id===selected), visible=review?.items.filter(i=>(outcome==='all'||i.outcome===outcome)&&`${i.title} ${importGroupLabel(i.source)} ${i.outcome}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))??[];
  const restore=async()=>{
    if(!review||active.current)return;active.current=true;setBusy(true);setMessage('');
    try {
      await request('storage/imports/restore',{requestId:review.restoreId??crypto.randomUUID(),epoch,reviewId:review.id,sourceHash:review.sourceHash,targetHash:review.targetHash});
      await load();onPrepared();setConfirm(false);setMessage('Preparing the separate workspace. Its verified copy will appear in Backup & recovery below.');
    }catch(e){await load().catch(()=>{});setMessage(e instanceof Error?e.message:'Check the original import before retrying.');}
    finally{active.current=false;setBusy(false);}
  };
  return <section className="card settings-card backup-settings"><div className="section-heading"><div><h2>Import saved work</h2><p>Review an earlier workspace before creating a separate copy.</p></div><button disabled={busy} onClick={()=>void load().catch(()=>setMessage('Reconnect to load your reviews.'))}>Refresh</button></div>
    <details><summary>Choose an export</summary><form className="backup-form" onSubmit={e=>{e.preventDefault();void inspect();}}><label>Workspace export<input type="file" accept=".json,.nova-backup" disabled={busy} onChange={e=>setFile(e.target.files?.[0])}/></label><p className="metadata">Prepared Dream Claw 0.57.2 storage exports and Nova Dream schema 15 backups are supported. The original application, accounts and native Assistant history stay with their existing owners.</p>
      {file?.name.endsWith('.nova-backup')&&<><label>Matching Nova backup key<input type="file" disabled={busy} onChange={e=>setKeyFile(e.target.files?.[0])}/></label><p className="metadata">Choose the original .backup.key from that backup folder. It is used in this browser and is never uploaded.</p><label>Source timezone<input value={sourceZone} onChange={e=>setSourceZone(e.target.value)} required/></label><details><summary>Source workspace identity</summary><label>Workspace ID<input value={sourceId} onChange={e=>setSourceId(e.target.value)} required/></label><p className="metadata">Keep this identity for later exports of the same workspace. Use a different identity for a different workspace.</p></details></>}
      <button disabled={busy||!file}>Review export</button></form></details>
    {reviews.length>0&&<><label>Saved review<select value={selected} onChange={e=>{setSelected(e.target.value);setConfirm(false);setRemove(false);setFilter('');setLimit(30);}}><option value="">Choose a review</option>{reviews.map(r=><option key={r.id} value={r.id}>{r.source} {r.version} · {new Date(r.createdAt).toLocaleString()}</option>)}</select></label>{review&&<div className="backup-review"><h3>{review.source} import review</h3><p><strong>{review.counts.editable}</strong> editable records · <strong>{review.counts.linked}</strong> linked sources and schedules · <strong>{review.counts.preserved}</strong> preserved originals · {review.timezone}</p><ul>{review.notes.map(n=><li key={n}>{n}</li>)}</ul>{review.duplicates.length>0&&<p role="status">{review.duplicates.length} groups of tasks have matching titles. They remain separate; review them before any merge.</p>}
      {review.priorProgress&&<p>Earlier profile: {review.priorProgress.name} · {review.priorProgress.xp} XP. {review.priorProgress.carried ? 'Verified earlier XP is included in Profile; completing imported work again does not award it twice.' : 'Earlier XP remains in the source archive until its profile and complete ledger can be verified.'} All {review.priorProgress.ledgerEvents} recorded XP entries are preserved.{review.priorProgress.ledgerTotal!==review.priorProgress.xp?' The recorded entries do not add up to the saved total; both originals are kept.':''}</p>}
      <label>Show<select value={outcome} onChange={e=>{setOutcome(e.target.value);setLimit(30);}}><option value="editable">Editable work</option><option value="linked">Linked sources and schedules</option><option value="preserved">Preserved originals</option><option value="all">All records</option></select></label>
      <label>Find reviewed work<input type="search" value={filter} onChange={e=>{setFilter(e.target.value);setLimit(30);}}/></label><p className="metadata" role="status">{visible.length?`${visible.length} matching records`:'No records match this view. Change the filter or search.'}</p><ul className="backup-jobs">{visible.slice(0,limit).map(item=><li key={item.source+':'+item.sourceId}><details><summary>{item.title} · {item.outcome==='editable'?'Editable':item.outcome==='linked'?'Linked':'Preserved'}</summary><p className="metadata">{importGroupLabel(item.source)}</p><ul>{item.notes.map((n,index)=><li key={index}>{n}</li>)}</ul></details></li>)}</ul>{visible.length>limit&&<button onClick={()=>setLimit(n=>n+30)}>Show more records</button>}
      <p><a href={`/api/storage/imports/${review.id}/source`} download>Download preserved source</a></p>
      {!review.restoreId&&!review.savedInWorkspace&&<button className="primary" disabled={busy} onClick={()=>setConfirm(true)}>Prepare separate workspace</button>}
      {review.savedInWorkspace&&<p>This source archive belongs to the current workspace and is included in its backups.</p>}
      {review.restoreId&&<p>The separate workspace has been requested. Open its verified copy in Backup & recovery.</p>}
      {confirm&&<div className="notice"><p>Create a separate workspace with these {review.counts.editable} editable records and the complete source archive? Accounts, agent work and recurring schedules stay paused.</p><button className="primary" disabled={busy} onClick={()=>void restore()}>Create reviewed copy</button><button disabled={busy} onClick={()=>setConfirm(false)}>Keep reviewing</button></div>}
      <details><summary>Review details</summary><p className="metadata">Source {review.sourceHash.slice(0,16)} · Mapping {review.targetHash.slice(0,16)}</p>{!review.savedInWorkspace&&<button disabled={busy} onClick={()=>setRemove(true)}>Remove prepared review</button>}{remove&&<div className="notice"><p>Remove this prepared review? Your source file and any completed workspace copies stay saved.</p><button disabled={busy} onClick={async()=>{setBusy(true);try{await request('storage/imports/remove',{requestId:crypto.randomUUID(),epoch,reviewId:review.id});await load();setSelected('');setRemove(false);}catch(e){setMessage(e instanceof Error?e.message:'Could not remove this review.');}finally{setBusy(false);}}}>Remove review</button><button onClick={()=>setRemove(false)}>Keep review</button></div>}</details>
    </div>}</>}{message&&<p role="status">{message}</p>}
  </section>;
}
