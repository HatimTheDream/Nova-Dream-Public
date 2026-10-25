import { useEffect,useMemo,useRef,useState } from 'react';
import type { Attachment, Snapshot } from '../../../packages/domain/contracts';
import type { Content, RecordValue } from '../../../packages/domain/workspace-records';
import { useAttachments } from './useAttachments';
import { retainedWindowId } from './useWorkspace';
import { File, Paperclip, X } from './icons';
import {ContentRecoveryJournal} from './content-recovery';
import {draftBrowserStorage} from './draft-browser-storage';

export function useContentFiles(id:string,value:Content,snapshot:Snapshot,change:(update:(value:RecordValue)=>RecordValue)=>boolean,enabled:boolean){
 return useAttachments(snapshot,{attachments:value.assets??[]},update=>change(previous=>({...previous,assets:update({attachments:(previous as Content).assets??[]}).attachments})),`content-sources:${id}:${retainedWindowId}`,'Content draft',{uploadEnabled:enabled});
}
/** The compact record editor still uses the same retained file controller. */
export function RecordContentFiles({id,value,snapshot,change,pendingChanged,disabled=false}:{id:string;value:Content;snapshot:Snapshot;change(update:(value:RecordValue)=>RecordValue):boolean;pendingChanged(value:boolean):void;disabled?:boolean}){
 const uploads=useContentFiles(id,value,snapshot,change,!value.archived&&!disabled),[,render]=useState(0);
 const recovery=useMemo(()=>new ContentRecoveryJournal(draftBrowserStorage,{id,epoch:snapshot.epoch,deviceId:snapshot.deviceId,windowId:retainedWindowId}),[id,snapshot.deviceId,snapshot.epoch]);
 useEffect(()=>pendingChanged(uploads.staging||uploads.pending.length>0),[uploads.staging,uploads.pending.length,pendingChanged]);
 return <><ContentFiles value={value} uploads={uploads} disabled={value.archived||disabled} undoName={recovery.fileUndoFor(value)?.file.name}
  remove={file=>{if(value.archived||disabled)return;change(previous=>{const assets=recovery.detachFile(previous as Content,file);render(n=>n+1);return assets?{...previous,assets}:previous;});}}
  undo={()=>{if(value.archived||disabled)return;change(previous=>{const assets=recovery.undoFile(previous as Content);render(n=>n+1);return assets?{...previous,assets}:previous;});}}/>
  {recovery.error&&<p role="alert">{recovery.error}</p>}</>;
}
export function ContentFiles({value,uploads,disabled,remove,undo,undoName}:{value:Content;uploads:ReturnType<typeof useContentFiles>;disabled:boolean;remove(file:Attachment):void;undo():void;undoName?:string}){
  const input = useRef<HTMLInputElement>(null);
  return <section><div className="section-heading"><h3>Source Files</h3><button type="button" disabled={disabled||(value.assets?.length ?? 0) + uploads.pending.length >= 10} onClick={() => input.current?.click()}><Paperclip size={17}/>Add Attachments</button></div>
    <input ref={input} type="file" hidden multiple aria-label="Content attachments" onChange={event => { void uploads.add(event.target.files); event.target.value = ''; }}/>
    <p className="metadata">Each upload is limited to 8 MB, with up to 10 files through this uploader. Existing drafts can retain 32 file references. Agent work reads complete TXT, Markdown, CSV and JSON files up to 64 KB each, 128 KB total.</p>
    <p className="metadata">Remove From Draft detaches this reference only. It does not delete the original file. Save Version keeps the changed references.</p>
    {(value.assets ?? []).map(file => <div className="source-link" key={file.id}><a href={`/api/attachments/${file.id}`}><File size={17}/>{file.name}</a>{file.id !== value.source?.fileId ? <button className="icon-button" type="button" disabled={disabled} aria-label={`Remove ${file.name} From Draft`} onClick={()=>remove(file)}><X size={17}/></button>:<small>Original Source</small>}</div>)}
    {undoName&&<button type="button" disabled={disabled} onClick={undo}>Undo Removal · <span className="preserve-case">{undoName}</span></button>}
    {uploads.pending.map(file => <div className="upload" key={file.id}><span>{file.name}</span><span className="metadata">{uploads.errors[file.id] || 'Uploading And Keeping Draft Link…'}</span>{uploads.errors[file.id] && <button type="button" disabled={disabled} onClick={() => void uploads.retry(file)}>Retry Original Upload</button>}<button type="button" disabled={disabled} onClick={() => void uploads.remove(file.id)}>Remove Staged Upload</button></div>)}
    {uploads.notice && <p role="status" className="field-error">{uploads.notice}</p>}
  </section>;
}
