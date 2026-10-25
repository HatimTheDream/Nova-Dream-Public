import {z} from 'zod';
import {canonical} from '../../../packages/domain/contracts';
import {contentWorkspaceCommandSchema,libraryItemSchema,type ContentLibraryCommand,type ContentLibraryItem,type ContentLibraryReceipt} from '../../../packages/domain/content-workspace';

type StoragePort=Pick<Storage,'getItem'|'setItem'>;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b),limit=2*1024*1024;
const draftSchema=libraryItemSchema.extend({name:z.string().max(100),platform:z.string().max(100),revision:z.number().int().nonnegative()});
const rowSchema=z.object({item:draftSchema,rawTags:z.string().max(1000)}).strict();
export type LibraryDraft=z.infer<typeof rowSchema>;
const draftBookSchema=z.object({format:z.literal(1),legacyImported:z.boolean(),selected:z.string().nullable(),rows:z.array(rowSchema).max(32),
 comparisons:z.array(z.object({original:rowSchema,saved:libraryItemSchema}).strict()).max(16)}).strict()
 .refine(book=>new Set(book.rows.map(row=>row.item.id)).size===book.rows.length&&(!book.selected||book.rows.some(row=>row.item.id===book.selected))
  &&book.comparisons.every(row=>row.original.item.id===row.saved.id),'The kept library identities do not agree. Original recovery is untouched.');
const commandSchema=contentWorkspaceCommandSchema.options[0];
const receiptSchema=z.discriminatedUnion('state',[
 z.object({command:commandSchema,state:z.literal('unknown')}).strict(),
 z.object({command:commandSchema,state:z.literal('saved'),item:libraryItemSchema}).strict(),
 z.object({command:commandSchema,state:z.literal('rejected'),code:z.string().min(1).max(100),message:z.string().max(1000)}).strict(),
]);
const requestBookSchema=z.object({format:z.literal(1),legacy:z.string().nullable(),command:commandSchema.optional(),receipt:receiptSchema.optional()}).strict();
export function checkedLibraryReceipt(command:ContentLibraryCommand,raw:unknown):ContentLibraryReceipt{
 const receipt=receiptSchema.parse(raw);
 if(!same(receipt.command,command))throw Error('The response belongs to a different library save.');
 if(receipt.state==='saved'&&!same(receipt.item,{...command.item,revision:command.expectedRevision+1}))throw Error('The response does not confirm the exact saved library item.');
 return receipt as ContentLibraryReceipt;
}
/** Synchronous, bounded, compare-and-readback storage. Failed writes keep both
 * the existing bytes and the attempted data available; they never authorize I/O. */
export class RetainedBook<T>{
 value:T;error='';invalid=false;private raw:string|null=null;private attempted?:string;
 constructor(protected storage:StoragePort,readonly key:string,private schema:z.ZodType<T>,empty:T){
  this.value=empty;
  try{this.raw=storage.getItem(key);if(this.raw!==null){if(this.raw.length>limit)throw Error('This recovery record is too large. Its original remains untouched.');this.value=schema.parse(JSON.parse(this.raw));}}
  catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'Recovery could not be read.';}
 }
 keep(value:T){
  if(this.invalid)return false;
  try{
   const raw=JSON.stringify(this.schema.parse(value));
   if(new TextEncoder().encode(raw).length>limit)throw Error('Recovery storage is full. Copy your complete writing before leaving.');
   const actual=this.storage.getItem(this.key);
   if(actual!==this.raw&&actual!==this.attempted)throw Error('Another window changed this recovery record. Reopen it before making another change.');
   this.attempted=raw;this.storage.setItem(this.key,raw);
   if(this.storage.getItem(this.key)!==raw)throw Error('The latest changes are kept only in this window. Copy them before leaving.');
   this.raw=raw;this.attempted=undefined;this.value=JSON.parse(raw);this.error='';return true;
  }catch(error){this.error=error instanceof Error?error.message:'The latest changes are kept only in this window.';return false;}
 }
 copy(){return JSON.stringify({saved:this.raw,attempted:this.attempted,current:this.value},null,2);}
}
export class ContentLibraryDrafts extends RetainedBook<z.infer<typeof draftBookSchema>>{
 constructor(storage:StoragePort,scope:{deviceId:string;epoch:string;windowId:string}){
  super(storage,`e3:content-library-drafts-v2:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,draftBookSchema,{format:1,legacyImported:false,selected:null,rows:[],comparisons:[]});
  if(this.invalid||this.value.legacyImported)return;
  // Never overwrite the legacy single draft. Import it once into the new book.
  try{const raw=storage.getItem(`e3:content-library-draft:${scope.deviceId}:${scope.epoch}:${scope.windowId}`);
   if(raw&&raw!=='null'){const item=draftSchema.parse(JSON.parse(raw));this.put({item,rawTags:item.tags.join(', ')});}
  }catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'The earlier library writing remains untouched.';}
 }
 put(row:LibraryDraft){return this.keep({...this.value,legacyImported:true,selected:row.item.id,rows:[...this.value.rows.filter(r=>r.item.id!==row.item.id),row]});}
 select(id:string|null){return this.keep({...this.value,selected:id});}
 discard(id:string){return this.keep({...this.value,selected:null,rows:this.value.rows.filter(r=>r.item.id!==id)});}
 prepare(original:LibraryDraft,saved:ContentLibraryItem,useSaved:boolean){
  if(original.item.id!==saved.id){this.error='These are different library items.';return false;}
  const row=useSaved?{item:saved,rawTags:saved.tags.join(', ')}:{...original,item:{...original.item,revision:saved.revision}};
  return this.keep({...this.value,selected:row.item.id,rows:[...this.value.rows.filter(r=>r.item.id!==row.item.id),row],
   comparisons:[...this.value.comparisons,{original,saved}]});
 }
}
export class ContentLibraryRequest extends RetainedBook<z.infer<typeof requestBookSchema>>{
 readonly legacyKey:string;
 constructor(storage:StoragePort,scope:{deviceId:string;epoch:string}){
  super(storage,`e3:content-library-request-v2:${scope.deviceId}:${scope.epoch}`,requestBookSchema,{format:1,legacy:null});
  this.legacyKey=`e3:content-command:${scope.deviceId}:${scope.epoch}:library`;
  if(this.invalid)return;
  try{
   const raw=storage.getItem(this.legacyKey);
   if(raw&&raw!=='null'&&this.value.legacy!==raw){
    if(this.value.command)throw Error('An earlier library save changed. Its original is kept; check it before starting another save.');
    const command=commandSchema.parse(JSON.parse(raw));
    if(command.epoch!==scope.epoch)throw Error('The original library save belongs to another workspace.');
    this.keep({format:1,legacy:raw,command});
   }
   if(this.value.receipt){if(!this.value.command)throw Error('A saved receipt has no original command.');checkedLibraryReceipt(this.value.command,this.value.receipt);}
   if(this.value.command&&this.value.command.epoch!==scope.epoch)throw Error('This request belongs to another workspace.');
  }catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'The earlier library request remains untouched.';}
 }
 get pending(){return this.value.command&&(!this.value.receipt||this.value.receipt.state==='unknown')?this.value.command:undefined;}
 begin(command:ContentLibraryCommand){
  if(this.pending){this.error='Check the original library save before starting another.';return false;}
  try{const raw=this.storage.getItem(this.legacyKey);if(raw&&raw!=='null'&&raw!==this.value.legacy)throw Error('An earlier library request changed in another window.');}
  catch(error){this.error=error instanceof Error?error.message:'The original request could not be checked.';return false;}
  return this.keep({format:1,legacy:this.value.legacy,command});
 }
 acknowledge(command:ContentLibraryCommand,raw:unknown){
  try{
   if(!same(this.value.command,command))throw Error('This is not the original library save.');
   return this.keep({...this.value,receipt:checkedLibraryReceipt(command,raw)});
  }catch(error){this.error=error instanceof Error?error.message:'The save is still unconfirmed.';return false;}
 }
}
