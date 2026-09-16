import {createHash} from 'node:crypto';
import {Store,Fault} from './store.js';
import type {ContentReview,ContentLibraryItem} from '../../packages/domain/content-workspace.js';
const safeName=(name:string)=>name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^[.-]+|[.-]+$/g,'').slice(0,120)||'file';
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes:Uint8Array){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
/** A bounded, uncompressed ZIP with UTF-8 names; no platform utility or new dependency. */
export function contentZip(files:{name:string;bytes:Buffer}[]){
 const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),crc=crc32(file.bytes),head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(33,12);head.writeUInt32LE(crc,14);head.writeUInt32LE(file.bytes.length,18);head.writeUInt32LE(file.bytes.length,22);head.writeUInt16LE(name.length,26);locals.push(head,name,file.bytes);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(file.bytes.length,20);entry.writeUInt32LE(file.bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=head.length+name.length+file.bytes.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
export function exportContentPackage(store:Store,id:string,revision:number){
 const content=store.readEntityVersion('content',id,revision);if(!content)throw new Fault(404,'content_version_missing','This saved Content version is unavailable.');
 const draftName=`draft.${content.value.format==='markdown'?'md':'txt'}`;
 const files:{name:string;bytes:Buffer}[]=[{name:draftName,bytes:Buffer.from(content.value.body)}];let total=files[0].bytes.length;
 const assets=(content.value.assets??[]).map((asset,i)=>{if(total+asset.size>64*1024*1024)throw new Fault(413,'content_package_large','This package exceeds 64 MB. Download large attachments individually.');const file=store.download(asset.id);if(file.metadata.sha256!==asset.sha256)throw new Fault(409,'content_asset_changed','A saved asset could not be verified.');total+=file.bytes.length;const path=`assets/${String(i+1).padStart(2,'0')}-${safeName(asset.name)}`;files.push({name:path,bytes:file.bytes});return {...asset,path};});
 let portableDraft:string|undefined;
 if(content.value.format==='markdown'){
  portableDraft='portable.md';
  const portable=content.value.body.replace(/\/api\/attachments\/([a-zA-Z0-9:-]+)(?:\?preview=1)?/g,(url,id:string)=>assets.find(a=>a.id===id)?.path??url);
  files.push({name:portableDraft,bytes:Buffer.from(portable)});
 }
 const brand=content.value.brandId?store.internalRead<ContentLibraryItem>('content:library:'+content.value.brandId):undefined;
 const reviews=store.internalList<ContentReview>('content:review:').filter(r=>r.contentId===id&&r.sourceRevision===revision);
 const manifest={format:'nova-content-package-v1',contentId:id,revision,title:content.value.title,savedAt:content.updatedAt,brief:content.value.brief,stage:content.value.stage,platform:content.value.platform,collection:content.value.collection??'',tags:content.value.tags??[],projectId:content.value.projectId,source:content.value.source??null,publication:content.value.publication,draft:draftName,portableDraft,assets,brand:brand?{name:brand.name,guidance:brand.guidance,revision:brand.revision,note:'Brand guidance at export time'}:null,reviews,files:files.map(f=>({path:f.name,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')}))};
 files.push({name:'manifest.json',bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')},{name:'README.txt',bytes:Buffer.from(`Nova Dream Content package\n${content.value.title} · saved version ${revision}\n\n${draftName} contains the exact saved writing.\nassets/ contains the original attached files.\nmanifest.json records source identity, hashes, context and this version's reviews.\n${portableDraft?'portable.md rewrites local attachment links to the bundled assets for use outside Nova Dream.':'Asset paths are listed in the manifest.'}\nExporting does not publish anything.\n`)});
 return {name:`${safeName(content.value.title)}-v${revision}.zip`,bytes:contentZip(files)};
}
