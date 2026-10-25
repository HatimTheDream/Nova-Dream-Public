import {z} from 'zod';
import {canonical} from '../../../packages/domain/contracts';
import {contentWorkspaceCommandSchema,type ContentWorkspaceCommand,type ContentWorkspaceReceipt} from '../../../packages/domain/content-workspace';
import {RetainedBook} from './content-library-recovery';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const receiptSchema=z.discriminatedUnion('state',[
 z.object({command:contentWorkspaceCommandSchema,state:z.literal('unknown'),message:z.string().max(2000)}).strict(),
 z.object({command:contentWorkspaceCommandSchema,state:z.literal('recorded'),message:z.string().max(2000),result:z.unknown()}).strict(),
 z.object({command:contentWorkspaceCommandSchema,state:z.literal('rejected'),message:z.string().max(2000),code:z.string().min(1).max(100)}).strict(),
]);
export function checkedContentReceipt(command:ContentWorkspaceCommand,raw:unknown):ContentWorkspaceReceipt{
 const receipt=receiptSchema.parse(raw);
 if(!same(receipt.command,command))throw Error('The receipt belongs to another Content request.');
 if(receipt.state==='recorded'){
  const result=receipt.result;
  if(!result||typeof result!=='object'||!('id'in result)||typeof result.id!=='string')throw Error('The original Content result is incomplete.');
  if(command.type==='work'||command.type==='work-control'){
   if(!('planId'in result)||typeof result.planId!=='string'||!('contentId'in result)||typeof result.contentId!=='string')throw Error('The original run identity is incomplete.');
   if(command.type==='work'&&(!('sourceRevision'in result)||result.contentId!==command.contentId||result.sourceRevision!==command.expectedRevision)
    ||command.type==='work-control'&&result.id!==command.jobId)throw Error('The receipt belongs to another Content run.');
  }else if(command.type==='restore'||command.type==='apply-work'){
   if(result.id!==command.contentId||!('revision'in result)||result.revision!==command.expectedRevision+1)throw Error('The saved Content revision does not match the original request.');
  }else if(command.type==='library-save'){
   if(!same(result,{...command.item,revision:command.expectedRevision+1}))throw Error('The original library version does not match.');
  }else{
   if(!('contentId'in result)||result.contentId!==command.contentId||!('revision'in result)
    ||command.type==='review-request'&&(!('sourceRevision'in result)||result.sourceRevision!==command.expectedRevision||result.revision!==1)
    ||command.type!=='review-request'&&(result.id!==command.reviewId||result.revision!==command.reviewRevision+1))
    throw Error('The review receipt does not match the original saved version.');
  }
 }
 return receipt as ContentWorkspaceReceipt;
}
const book=z.object({format:z.literal(1),legacy:z.string().nullable(),command:contentWorkspaceCommandSchema.optional(),receipt:receiptSchema.optional()}).strict();
export class ContentCommandJournal extends RetainedBook<z.infer<typeof book>>{
 readonly legacyKey:string;
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,readonly scope:{deviceId:string;epoch:string;id:string}){
  super(storage,`e3:content-request-v2:${scope.deviceId}:${scope.epoch}:${scope.id}`,book,{format:1,legacy:null});
  this.legacyKey=`e3:content-command:${scope.deviceId}:${scope.epoch}:${scope.id}`;
  if(this.invalid)return;
  try{
   const raw=storage.getItem(this.legacyKey);
   if(raw&&raw!=='null'&&this.value.legacy!==raw){
    if(this.value.command)throw Error('The earlier Content request changed in another window. Its original remains kept.');
    if(!this.keep({format:1,legacy:raw,command:this.checked(contentWorkspaceCommandSchema.parse(JSON.parse(raw)))}))
     throw Error(this.error||'The original request could not be retained. Its legacy bytes remain untouched.');
   }
   if(this.value.command)this.checked(this.value.command);
   if(this.value.receipt){if(!this.value.command)throw Error('The receipt has no original request.');checkedContentReceipt(this.value.command,this.value.receipt);}
  }catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'The original Content request cannot be read.';}
 }
 private checked(command:ContentWorkspaceCommand){
  if(command.epoch!==this.scope.epoch||'contentId'in command&&command.contentId!==this.scope.id||command.type==='library-save')
   throw Error('This request belongs to another Content item or workspace.');
  return command;
 }
 get pending(){return this.value.command&&(!this.value.receipt||this.value.receipt.state==='unknown')?this.value.command:undefined;}
 begin(command:ContentWorkspaceCommand){
  if(this.pending){this.error='Check the original Content request before another change.';return false;}
  try{
   this.checked(command);
   const raw=this.storage.getItem(this.legacyKey);
   if(raw&&raw!=='null'&&raw!==this.value.legacy)throw Error('An earlier request changed in another window.');
   return this.keep({format:1,legacy:this.value.legacy,command});
  }catch(error){this.error=error instanceof Error?error.message:'The request could not be kept.';return false;}
 }
 acknowledge(command:ContentWorkspaceCommand,raw:unknown){
  try{
   if(!same(this.value.command,command))throw Error('This is not the original Content request.');
   const receipt=checkedContentReceipt(this.checked(command),raw);
   if(command.type==='work-control'&&receipt.state==='recorded'&&(receipt.result as {contentId:string}).contentId!==this.scope.id)
    throw Error('The original control belongs to another Content item.');
   return this.keep({...this.value,receipt});
  }catch(error){this.error=error instanceof Error?error.message:'The original request remains unconfirmed.';return false;}
 }
}
