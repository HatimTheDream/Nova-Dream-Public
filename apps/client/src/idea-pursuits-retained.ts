import {z} from 'zod';
import {canonical} from '../../../packages/domain/contracts';
import {ideaCommandSchema,ideaReceiptSchema,type IdeaCommand,type IdeaReceipt} from '../../../packages/domain/idea-pursuits';
import {RetainedBook} from './content-library-recovery';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const book=z.object({format:z.literal(1),command:ideaCommandSchema.optional(),receipt:ideaReceiptSchema.optional()}).strict();
export function checkedIdeaReceipt(command:IdeaCommand,raw:unknown):IdeaReceipt{
 const receipt=ideaReceiptSchema.parse(raw);
 if(!same(receipt.command,command))throw Error('The response belongs to another Idea request.');
 if(receipt.state==='saved'){
  if(receipt.pursuit.id!==command.id||receipt.pursuit.epoch!==command.epoch
   ||receipt.pursuit.revision!==(command.type==='create'?1:command.expectedRevision+1)
   ||(command.type!=='review'&&receipt.entryId!==command.entryId)
   ||(command.type==='create'&&(receipt.pursuit.initialEntryId!==command.entryId||receipt.pursuit.starterId!==command.handoff.ideaId||receipt.pursuit.title!==command.handoff.title))
   ||(command.type==='review'&&receipt.pursuit.reviewed!==command.reviewed))throw Error('The saved pursuit does not match the original change.');
 }
 return receipt;
}
export class IdeaRequestJournal extends RetainedBook<z.infer<typeof book>>{
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,readonly scope:{deviceId:string;epoch:string}){
  super(storage,`e3:idea-request:${scope.deviceId}:${scope.epoch}`,book,{format:1});
  try{
   if(this.value.command&&this.value.command.epoch!==scope.epoch)throw Error('The original request belongs to another workspace.');
   if(this.value.receipt){if(!this.value.command)throw Error('The receipt has no original request.');checkedIdeaReceipt(this.value.command,this.value.receipt);}
  }catch(reason){this.invalid=true;this.error=reason instanceof Error?reason.message:'Original request unreadable.';}
 }
 get pending(){return this.value.command&&(!this.value.receipt||this.value.receipt.state==='unknown')?this.value.command:undefined;}
 begin(command:IdeaCommand){
  if(this.pending){this.error='Check the original Idea request before starting another.';return false;}
  if(command.epoch!==this.scope.epoch){this.error='This is a different workspace.';return false;}
  if(new TextEncoder().encode(JSON.stringify(command)).byteLength>500000){this.error='This complete Idea brief is too large to send. Your writing is kept; reduce the selected context before starting the pursuit.';return false;}
  return this.keep({format:1,command});
 }
 acknowledge(command:IdeaCommand,raw:unknown){
  try{if(!same(command,this.value.command))throw Error('The original Idea request changed.');return this.keep({...this.value,receipt:checkedIdeaReceipt(command,raw)});}
  catch(reason){this.error=reason instanceof Error?reason.message:'The request remains unconfirmed.';return false;}
 }
}
const question=z.object({format:z.literal(1),text:z.string().max(50000)}).strict();
export class IdeaQuestionJournal extends RetainedBook<z.infer<typeof question>>{
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,scope:{deviceId:string;epoch:string;windowId:string},id:string){
  super(storage,`e3:idea-question:${scope.deviceId}:${scope.epoch}:${scope.windowId}:${id}`,question,{format:1,text:''});
 }
}
