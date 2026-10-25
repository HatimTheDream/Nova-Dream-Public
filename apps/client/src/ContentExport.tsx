import {useEffect,useRef,useState} from 'react';
import {canonical,type Entity} from '../../../packages/domain/contracts';
import type {Content} from '../../../packages/domain/workspace-records';
import {ContentRecoveryPanel} from './ContentRecoveryPanel';
import {clientHeaders} from './api';
import {contentFile} from './record-files';

export function cleanContentExport(entity:Entity<Content>|undefined,value:Content,revision:number,blocked:boolean){
 return !!entity&&!blocked&&entity.revision===revision&&canonical(entity.value)===canonical(value);
}
/** Download-requested is the last browser-observable state. It is never a
 * claim that a file reached disk or that Content was published. */
export function ContentExport({entity,scope,allowed,close,fallbackFocus}:{entity:Entity<Content>;scope:string;allowed:()=>boolean;close():void;fallbackFocus():HTMLElement|null}){
 const [captured]=useState(()=>structuredClone(entity)),[prepared,setPrepared]=useState<Blob>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[requested,setRequested]=useState('');
 const [capturedScope]=useState(scope),latest=useRef({entity,scope,allowed});latest.current={entity,scope,allowed};const mounted=useRef(true),controller=useRef<AbortController|undefined>(undefined);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
 const valid=()=>mounted.current&&latest.current.scope===capturedScope&&latest.current.allowed()&&canonical(latest.current.entity)===canonical(captured);
 const file=contentFile(captured.value,captured.revision);
 const prepare=async()=>{
  if(busy||!valid())return;
  setBusy(true);setError('');setRequested('');controller.current=new AbortController();
  try{
   const response=await fetch(`/api/content/package?id=${encodeURIComponent(captured.id)}&revision=${captured.revision}`,{credentials:'same-origin',headers:clientHeaders(),cache:'no-store',signal:AbortSignal.any([controller.current.signal,AbortSignal.timeout(30000)])});
   if(!response.ok)throw Error('The exact saved package could not be prepared. Your draft is unchanged.');
   const blob=await response.blob();
   if(!valid())throw Error('The draft changed while preparing this package. Save and reopen Export for the current version.');
   if(response.headers.get('content-type')?.split(';')[0]!=='application/zip')throw Error('The host did not return a Content package.');
   setPrepared(blob);
  }catch(error){if(mounted.current)setError(error instanceof Error?error.message:'Package preparation is unconfirmed.');}
  finally{if(mounted.current)setBusy(false);}
 };
 const download=(packageFile:boolean)=>{
  if(!valid()||busy||packageFile&&!prepared)return;
  const name=packageFile?file.name.replace(/\.(md|txt)$/,'.zip'):file.name;
  const blob=packageFile?prepared!:new Blob([file.body],{type:file.type}),url=URL.createObjectURL(blob);
  try{const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setRequested(name);}
  catch{setError('The browser did not accept the download request. The prepared content is still here.');}
  finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
 };
 return <ContentRecoveryPanel title="Export Saved Content" tools breakpoint={800} backLabel="Back To Draft" close={close} fallbackFocus={fallbackFocus}>
  <div className="content-tools"><h3 className="preserve-case">{captured.value.title}</h3><p>Saved Version {captured.revision} · {captured.value.format==='markdown'?'Markdown':'Plain Text'} · {captured.value.assets?.length??0} Attached {captured.value.assets?.length===1?'File':'Files'}</p>
   <p>Text contains the exact saved body. The package also keeps original files, a separate portable Markdown copy where applicable, source references, reviews for this version and a manifest with file hashes.</p>
   <p>Brand guidance in the package is captured when it is prepared. Earlier agent runs retain the guidance they originally captured.</p>
   <details><summary>Exact Saved Writing</summary><pre className="preserve-case">{captured.value.body}</pre></details>
   {!valid()&&<p role="status">Save the current writing, finish pending uploads or review conflicting versions, then reopen Export.</p>}
   <div className="compact-actions"><button disabled={!valid()||busy} onClick={()=>download(false)}>Download Text</button>
    <button disabled={!valid()||busy} onClick={()=>void prepare()}>{busy?'Preparing Package…':prepared?'Prepare Package Again':'Prepare Draft And Assets'}</button>
    {prepared&&<button className="primary" disabled={!valid()||busy} onClick={()=>download(true)}>Download Prepared Package</button>}</div>
   {prepared&&<p role="status">Prepared · {(prepared.size/1024).toFixed(1)} KB</p>}
   {requested&&<p role="status">Download Requested · <span className="preserve-case">{requested}</span>. Check your browser downloads for completion.</p>}
   {error&&<p role="alert">{error}</p>}<p className="metadata">Exporting does not publish the draft or mark any task complete.</p>
  </div>
 </ContentRecoveryPanel>;
}
