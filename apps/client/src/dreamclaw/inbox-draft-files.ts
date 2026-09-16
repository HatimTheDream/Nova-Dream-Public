import {isMailBase64} from '../../../../packages/domain/mail-file-bytes';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {MailDeliveryFile,MailDeliveryReview,MailAttachment} from '../../../../packages/domain/mail-delivery';
import {request} from '../api';

type FileMetadata=MailDeliveryReview['message']['attachments'][number];
type Scope=Pick<MailDeliveryFile,'epoch'|'operationId'|'digest'>;
type Transport=(input:Scope&{index:number;sha256:string},signal:AbortSignal)=>Promise<MailDeliveryFile>;
const transport:Transport=(input,signal)=>request('mail/delivery/file',input,signal);
const stopped=()=>new DOMException('This message is no longer open.','AbortError');

export async function verifyMailFileBytes(file:MailAttachment,expected:Omit<MailAttachment,'base64'>) {
  if(typeof file.base64!=='string'||file.base64.length>13981016||!isMailBase64(file.base64))throw new Error('The file bytes could not be verified.');
  const binary=atob(file.base64),bytes=new Uint8Array(binary.length);
  for(let offset=0;offset<binary.length;offset++)bytes[offset]=binary.charCodeAt(offset);
  if(bytes.length!==expected.bytes)throw new Error('The complete file could not be verified.');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
  if(digest!==expected.sha256)throw new Error('The file contents changed before preview.');
}

/** Temporary verified bytes for one immutable mail operation. Never stored in
 * writing/delivery journals; disposal also rejects late transport completions. */
export function createDraftFileReader(scope:Scope,metadata:readonly FileMetadata[],send:Transport=transport) {
  const controller=new AbortController(),files=structuredClone(metadata),identity={...scope};
  const cache=new Map<number,MailDeliveryFile>(),jobs=new Map<number,Promise<MailDeliveryFile>>();let closed=false;
  function read(index:number):Promise<MailDeliveryFile> {
    if(closed)return Promise.reject(stopped());
    if(cache.has(index))return Promise.resolve(cache.get(index)!);
    if(jobs.has(index))return jobs.get(index)!;
    const expected=files[index];if(!expected)return Promise.reject(new Error('This file is not in the open message.'));
    const job=(async()=>{
      const result=await send({...identity,index,sha256:expected.sha256},controller.signal);
      if(closed)throw stopped();
      const file=result?.file;
      if(result?.epoch!==identity.epoch||result.operationId!==identity.operationId||result.digest!==identity.digest||result.index!==index||result.sha256!==expected.sha256||!file||
        ['name','mimeType','bytes','sha256','cid','disposition'].some(key=>file[key as keyof FileMetadata]!==expected[key as keyof FileMetadata])||
        typeof file.base64!=='string'||file.base64.length>13981016||!isMailBase64(file.base64)||
        result.previewMimeType&&!['image/png','image/jpeg','image/webp'].includes(result.previewMimeType))throw new Error('The returned file does not match this saved message.');
      await verifyMailFileBytes(file,expected);
      if(closed)throw stopped();
      cache.set(index,result);return result;
    })();
    jobs.set(index,job);void job.finally(()=>jobs.delete(index)).catch(()=>{});return job;
  }
  return {read,dispose(){closed=true;controller.abort();cache.clear();jobs.clear();}};
}

type State={key:string;files:Record<number,MailDeliveryFile>;errors:Record<number,string>;loading:Record<number,boolean>};
const empty=(key:string):State=>({key,files:{},errors:{},loading:{}});
export function useInboxDraftFiles(review:MailDeliveryReview|undefined,enabled:boolean,sourceKey:string) {
  const key=enabled&&review?.digest?JSON.stringify([sourceKey,review.epoch,review.id,review.digest]):'';
  const current=useRef<{key:string;load(index:number):Promise<MailDeliveryFile>}|undefined>(undefined);
  const [state,setState]=useState<State>(()=>empty(''));
  useEffect(()=>{
    if(!key||!review?.digest){current.current=undefined;setState(empty(key));return;}
    let active=true;
    const reader=createDraftFileReader({epoch:review.epoch,operationId:review.id,digest:review.digest},review.message.attachments);
    const load=async(index:number)=>{
      if(!active)throw stopped();
      setState(value=>value.key===key?{...value,loading:{...value.loading,[index]:true},errors:{...value.errors,[index]:''}}:value);
      try {const result=await reader.read(index);if(active)setState(value=>value.key===key?{...value,files:{...value.files,[index]:result}}:value);return result;}
      catch(error){if(active)setState(value=>value.key===key?{...value,errors:{...value.errors,[index]:error instanceof Error?error.message:'The file could not be loaded.'}}:value);throw error;}
      finally{if(active)setState(value=>value.key===key?{...value,loading:{...value.loading,[index]:false}}:value);}
    };
    setState(empty(key));current.current={key,load};
    // All bytes are bounded by the mail operation's 25 MB total. Three reads at
    // a time keep file controls responsive without an unbounded request fanout.
    let next=0;const count=review.message.attachments.length;
    void Promise.allSettled(Array.from({length:Math.min(3,count)},async()=>{while(active&&next<count){const index=next++;try{await load(index);}catch{/* Each file offers its own explicit retry. */}}}));
    return()=>{active=false;reader.dispose();if(current.current?.key===key)current.current=undefined;};
    // The immutable digest covers file metadata. Scope changes also clear bytes.
  },[key]);
  const load=useCallback((index:number)=>current.current?.key===key?current.current.load(index):Promise.reject(stopped()),[key]);
  return {...(state.key===key?state:empty(key)),load};
}
