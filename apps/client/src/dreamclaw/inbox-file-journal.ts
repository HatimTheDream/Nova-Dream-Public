import {createStore} from 'zustand/vanilla';
import type {MailAttachment,MailDeliveryReview,MailFile,MailFileReference,MailDeliveryFile} from '../../../../packages/domain/mail-delivery';
import {readLocal,saveLocal,request} from '../api';
import {verifyMailFileBytes} from './inbox-draft-files';

type Metadata=Omit<MailAttachment,'base64'|'sha256'>&{sha256?:string};
export type InboxSelectedFile={id:string;file:Metadata;reference?:MailFileReference;ready:boolean;error?:string};
type Records=Record<string,{files:InboxSelectedFile[]}>;
type Disk={read(key:string):Records|undefined;write(key:string,value:Records):boolean};
type Transport=(action:'upload'|'read'|'saved',input:unknown,signal?:AbortSignal)=>Promise<MailFile|MailDeliveryFile>;
const transport:Transport=(action,input,signal)=>request(action==='upload'?'mail/files':action==='read'?'mail/files/read':'mail/delivery/file',input,signal,35000);
export const savedFileSelection=(review?:MailDeliveryReview):InboxSelectedFile[]=>review?.digest?review.message.attachments.map((file,index)=>({id:`${review.id}:${index}`,file,ready:true,reference:{kind:'saved',operationId:review.id,digest:review.digest!,index,sha256:file.sha256}})):[];
const validMime=(value:string)=>/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value)?value:'application/octet-stream';

/** File identities, never file bytes, travel with each original compose/reply
 * journal. A lost upload is recovered by its original id before any reselection. */
export function createInboxFileJournal(scope:{epoch:string;deviceId:string;windowId:string;previousWindowId?:string},send:Transport=transport,disk:Disk={read:readLocal,write:saveLocal}) {
  const keyFor=(windowId:string)=>`e3:inbox-files:${scope.epoch}:${scope.deviceId}:${windowId}`;
  const key=keyFor(scope.windowId),kept=disk.read(key),copied=!kept&&scope.previousWindowId?disk.read(keyFor(scope.previousWindowId)):undefined;
  const initial=structuredClone(kept??copied??{});
  const store=createStore<{records:Records;storageError:boolean;busy:Record<string,boolean>}>(()=>({records:initial,storageError:!!copied&&!disk.write(key,initial),busy:{}}));
  const jobs=new Map<string,Promise<void>>(),localFiles=new Map<string,File>();
  const jobKey=(source:string,id:string)=>JSON.stringify([source,id]);
  const entries=(source:string)=>store.getState().records[source]?.files??[];
  function retain(source:string,files:InboxSelectedFile[],required=false) {
    const records={...store.getState().records,[source]:{files:structuredClone(files)}},saved=disk.write(key,records);
    if(!saved&&required){store.setState({storageError:true});throw new Error('Free browser storage before changing this file selection. The original files and writing are kept.');}
    store.setState({records,storageError:!saved});return saved;
  }
  function flush(){const records=store.getState().records;if(!disk.write(key,records)){store.setState({storageError:true});throw new Error('The file selection could not be kept. Free browser storage before continuing.');}store.setState({storageError:false});}
  function update(source:string,id:string,patch:Partial<InboxSelectedFile>,required=false){const files=entries(source);if(!files.some(file=>file.id===id))return false;return retain(source,files.map(file=>file.id===id?{...file,...patch}:file),required);}
  function ensure(source:string,review?:MailDeliveryReview){if(!store.getState().records[source]&&review?.digest)retain(source,savedFileSelection(review),true);}
  function validate(entry:InboxSelectedFile,result:MailFile|MailDeliveryFile) {
    const ref=entry.reference,file=result.file;
    if(result.epoch!==scope.epoch||!file||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||['name','mimeType','bytes','cid','disposition'].some(key=>file[key as keyof Metadata]!==entry.file[key as keyof Metadata])||(entry.file.sha256&&file.sha256!==entry.file.sha256)||
      ref?.kind==='upload'&&(!('id' in result)||result.id!==ref.id)||ref?.kind==='saved'&&(!('operationId'in result)||result.operationId!==ref.operationId||result.digest!==ref.digest||result.index!==ref.index||result.sha256!==ref.sha256))throw new Error('The returned file belongs to a different selection. Your message is kept.');
    if(!ref&&(!('id'in result)||result.id!==entry.id))throw new Error('The returned file belongs to a different selection.');
    return file;
  }
  function tracked(source:string,id:string,run:()=>Promise<void>) {
    const key=jobKey(source,id),existing=jobs.get(key);if(existing)return existing;
    store.setState(state=>({busy:{...state.busy,[key]:true}}));
    const job=run().catch(error=>{update(source,id,{error:error instanceof Error?error.message:'This file could not be kept. Check again.'});}).finally(()=>{jobs.delete(key);store.setState(state=>({busy:{...state.busy,[key]:false}}));});
    jobs.set(key,job);return job;
  }
  async function upload(source:string,id:string,file:File) {
    const entry=entries(source).find(item=>item.id===id);if(!entry){localFiles.delete(jobKey(source,id));return;}
    const bytes=new Uint8Array(await file.arrayBuffer());
    const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(entry.file.sha256&&entry.file.sha256!==sha256)throw new Error('Select the same file contents, or remove this selection before adding another file.');
    if(!update(source,id,{file:{...entry.file,sha256},reference:{kind:'upload',id,sha256},error:undefined},true)){localFiles.delete(jobKey(source,id));return;}
    let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
    const result=await send('upload',{epoch:scope.epoch,requestId:id,file:{...entry.file,sha256,base64:btoa(binary)}});
    const expected=entries(source).find(item=>item.id===id);if(!expected){localFiles.delete(jobKey(source,id));return;}
    validate(expected,result);update(source,id,{ready:true,error:undefined});localFiles.delete(jobKey(source,id));
  }
  function add(source:string,files:readonly File[]) {
    const old=entries(source);
    if(old.length+files.length>20)throw new Error('Choose at most 20 files for one message.');
    if(old.reduce((sum,item)=>sum+item.file.bytes,0)+files.reduce((sum,file)=>sum+file.size,0)>25*1024*1024)throw new Error('Choose files totaling 25 MB or less.');
    for(const file of files)if(!file.name||file.name.length>1000||/[\r\n\0]/.test(file.name)||file.size>10*1024*1024)throw new Error('Choose files of 10 MB or less with a valid filename.');
    const added=files.map(file=>({id:crypto.randomUUID(),ready:false,file:{name:file.name,mimeType:validMime(file.type),bytes:file.size}}));
    retain(source,[...old,...added],true);
    let next=0;return Promise.allSettled(Array.from({length:Math.min(2,files.length)},async()=>{while(next<files.length){const index=next++,id=added[index].id,file=files[index];localFiles.set(jobKey(source,id),file);await tracked(source,id,()=>upload(source,id,file));}}));
  }
  function retry(source:string,id:string,file?:File) {
    const entry=entries(source).find(item=>item.id===id);if(!entry)return Promise.resolve();
    if(file&&(file.name!==entry.file.name||file.size!==entry.file.bytes||validMime(file.type)!==entry.file.mimeType))return Promise.reject(new Error('Select the same file, or remove this selection before choosing another.'));
    if(file)localFiles.set(jobKey(source,id),file);
    return tracked(source,id,async()=>{
      flush();update(source,id,{error:undefined});
      if(entry.reference?.kind==='saved'){await read(entry);return;}
      try{const result=await send('read',{epoch:scope.epoch,id,sha256:entry.file.sha256});const received=validate(entry,result);update(source,id,{ready:true,file:{...entry.file,sha256:received.sha256},reference:{kind:'upload',id,sha256:received.sha256},error:undefined});localFiles.delete(jobKey(source,id));}
      catch(error){const local=localFiles.get(jobKey(source,id));if(local){await upload(source,id,local);return;}throw error;}
    });
  }
  function remove(source:string,id:string){retain(source,entries(source).filter(entry=>entry.id!==id),true);localFiles.delete(jobKey(source,id));}
  function selection(source:string,review?:MailDeliveryReview){ensure(source,review);flush();const files=entries(source);if(files.some(file=>!file.ready||!file.reference)||files.some(file=>store.getState().busy[jobKey(source,file.id)]))throw new Error('Finish keeping the selected files, or remove them, before reviewing this message.');return files.map(file=>file.reference!);}
  async function read(entry:InboxSelectedFile,signal?:AbortSignal) {
    const ref=entry.reference;if(!ref||!entry.ready)throw new Error('Finish keeping this file first.');
    const result=await send(ref.kind==='upload'?'read':'saved',ref.kind==='upload'?{epoch:scope.epoch,id:ref.id,sha256:ref.sha256,bytes:true}:{epoch:scope.epoch,operationId:ref.operationId,digest:ref.digest,index:ref.index,sha256:ref.sha256},signal);
    const file=validate(entry,result);await verifyMailFileBytes(file as MailAttachment,entry.file as MailAttachment);
    if(result.previewMimeType&&!['image/png','image/jpeg','image/webp'].includes(result.previewMimeType))throw new Error('This image preview could not be verified.');
    return {file:file as MailAttachment,previewMimeType:result.previewMimeType};
  }
  return {store,ensure,add,retry,remove,selection,read};
}
export type InboxFileJournal=ReturnType<typeof createInboxFileJournal>;
