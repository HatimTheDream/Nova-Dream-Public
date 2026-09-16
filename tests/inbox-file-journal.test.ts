import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInboxFileJournal} from '../apps/client/src/dreamclaw/inbox-file-journal';
import type {MailFile} from '../packages/domain/mail-delivery';
const scope=()=>({epoch:randomUUID(),deviceId:'owner',windowId:randomUUID()});
function disk(){const records=new Map<string,any>();let full=false;return {records,setFull(value:boolean){full=value;},read:(key:string)=>structuredClone(records.get(key)),write(key:string,value:unknown){if(full)return false;assert.doesNotMatch(JSON.stringify(value),/"base64"|data:image/);records.set(key,structuredClone(value));return true;}};}
function remote(epoch:string){const files=new Map<string,MailFile>();let uploads=0,lose=false,delay:Promise<void>|undefined;return {files,get uploads(){return uploads;},lose(){lose=true;},delay(value:Promise<void>){delay=value;},async send(action:string,input:any){if(action==='upload'){uploads++;const value={id:input.requestId,epoch,file:structuredClone(input.file)};files.set(value.id,value);if(delay)await delay;if(lose){lose=false;throw Error('Upload response lost');}const {base64,...metadata}=value.file;return {...value,file:metadata};}const file=files.get(input.id);if(!file)throw Error('File not received; select the same file');const {base64,...metadata}=file.file;return {...file,file:input.bytes?file.file:metadata};}};}

test('lost file upload survives reload and clone as exact metadata references without another upload',async()=>{
 const s=scope(),d=disk(),r=remote(s.epoch);let journal=createInboxFileJournal(s,r.send,d);r.lose();await journal.add('compose',[new File(['Original document'],'plan.txt',{type:'text/plain'})]);
 assert.equal(journal.store.getState().records.compose.files[0].ready,false);assert.throws(()=>journal.selection('compose'),/Finish keeping/);assert.equal(r.uploads,1);
 journal=createInboxFileJournal(s,r.send,d);const id=journal.store.getState().records.compose.files[0].id;await journal.retry('compose',id);
 const refs=journal.selection('compose');assert.equal(refs.length,1);assert.equal(refs[0].kind,'upload');assert.equal(r.uploads,1);
 const clone=createInboxFileJournal({...s,windowId:randomUUID(),previousWindowId:s.windowId},r.send,d);assert.deepEqual(clone.selection('compose'),refs);clone.remove('compose',id);assert.equal(clone.selection('compose').length,0);assert.equal(journal.selection('compose').length,1);
 const bytes=await journal.read(journal.store.getState().records.compose.files[0]);assert.equal(Buffer.from(bytes.file.base64,'base64').toString(),'Original document');
});
test('late uploads cannot resurrect removed files or attach themselves to another message',async()=>{
 const s=scope(),d=disk(),r=remote(s.epoch),journal=createInboxFileJournal(s,r.send,d);let finish!:()=>void;r.delay(new Promise(resolve=>finish=resolve));
 const pending=journal.add('compose',[new File(['held'],'held.txt',{type:'text/plain'})]);while(r.uploads===0)await new Promise(resolve=>setTimeout(resolve,1));
 const id=journal.store.getState().records.compose.files[0].id;journal.remove('compose',id);await journal.add('other',[]);finish();await pending;
 assert.deepEqual(journal.selection('compose'),[]);assert.deepEqual(journal.selection('other'),[]);assert.equal(r.uploads,1);
});
test('storage failure starts no upload or removal, and unfinished selections reject different reselected contents',async()=>{
 const s=scope(),d=disk(),r=remote(s.epoch),journal=createInboxFileJournal(s,r.send,d);d.setFull(true);assert.throws(()=>journal.add('compose',[new File(['a'],'a.txt')]),/storage/);assert.equal(r.uploads,0);d.setFull(false);
 r.lose();await journal.add('compose',[new File(['first'],'a.txt')]);const entry=journal.store.getState().records.compose.files[0];r.files.clear();
 const restored=createInboxFileJournal(s,r.send,d);await restored.retry('compose',entry.id,new File(['other'],'a.txt'));assert.equal(restored.store.getState().records.compose.files[0].ready,false);assert.match(restored.store.getState().records.compose.files[0].error??'',/same file contents/);assert.equal(r.uploads,1);
 await restored.retry('compose',entry.id,new File(['first'],'a.txt'));assert.equal(restored.selection('compose').length,1);assert.equal(r.uploads,2);
 d.setFull(true);assert.throws(()=>restored.remove('compose',entry.id),/storage/);assert.equal(restored.store.getState().records.compose.files.length,1);
});
test('the supported ten-megabyte selection verifies bytes without stack overflow and keeps limits before uploading',async()=>{
 const s=scope(),d=disk(),r=remote(s.epoch),journal=createInboxFileJournal(s,r.send,d);const file=new File([new Uint8Array(10*1024*1024)],'ten.bin');await journal.add('compose',[file]);
 const entries=journal.store.getState().records.compose.files;assert.equal(entries[0].ready,true,entries[0].error);assert.equal((await journal.read(entries[0])).file.bytes,file.size);
 assert.throws(()=>journal.add('compose',[new File([new Uint8Array(10*1024*1024+1)],'too-large.bin')]),/10 MB/);
 assert.throws(()=>journal.add('compose',Array.from({length:20},()=>new File(['x'],'x'))),/20 files/);
 assert.throws(()=>journal.add('compose',[file,file]),/25 MB/);assert.equal(r.uploads,1);
});
