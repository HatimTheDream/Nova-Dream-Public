import {canonical} from '../../packages/domain/contracts.js';
import {ideaBindingSchema,ideaCommandSchema,type IdeaBinding,type IdeaCommand,type IdeaEntry,type IdeaPursuit,type IdeaReceipt,type IdeaRun,type IdeaPage,type IdeaRunDetail} from '../../packages/domain/idea-pursuits.js';
import type {AssistantOperation,AssistantOutput,Conversation} from '../../packages/domain/assistant.js';
import type {HomeSourceCapture} from '../../packages/domain/home-library.js';
import {Fault,type Store} from './store.js';
import {ideaActivityIndex} from './idea-activity.js';

const prefix='home:ideas:',pursuitKey=(id:string)=>prefix+'pursuit:'+id,entryKey=(id:string)=>prefix+'entry:'+id;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(value:string){if(!uuid.test(value))throw new Fault(400,'idea_identity','Use the exact original Idea identity.');return value;}
export function captureIdeaBinding(store:Store,raw:IdeaBinding|undefined):IdeaBinding|undefined{
 if(!raw)return;
 const binding=ideaBindingSchema.parse(raw),pursuit=store.internalRead<IdeaPursuit>(pursuitKey(binding.pursuitId)),
  entry=store.internalRead<IdeaEntry>(entryKey(binding.entryId));
 if(!pursuit||pursuit.epoch!==store.epoch||!entry||entry.epoch!==store.epoch||entry.pursuitId!==pursuit.id)
  throw new Fault(409,'idea_changed','The original Idea pursuit is unavailable. Your Assistant writing is kept; reopen its original pursuit.');
 return binding;
}
/** Joined with the original operation write; contains no copied result or mutable outcome. */
export function ideaOperationIndex(store:Store,operation:AssistantOperation):{id:string;value:unknown}[]{
 const binding=operation.context.idea;
 if(!binding)return [];
 const value:IdeaRun={...binding,operationId:operation.id,conversationId:operation.conversationId,createdAt:operation.createdAt};
 const id=prefix+`run:${binding.pursuitId}:${operation.createdAt}:${operation.id}`,before=store.internalRead<IdeaRun>(id);
 if(before&&!same(before,value))throw new Fault(409,'idea_run_changed','The original Idea run link changed.');
 return before?[]:[{id,value},...ideaActivityIndex(store,value,operation.input)];
}
export class IdeaPursuits{
 constructor(private store:Store,private now=Date.now){}
 private at(){return new Date(this.now()).toISOString();}
 private intent(command:IdeaCommand){return {operation:'home.idea',...command};}
 private pursuit(id:string){
  const value=this.store.internalRead<IdeaPursuit>(pursuitKey(identity(id)));
  if(!value||value.epoch!==this.store.epoch)throw new Fault(404,'idea_missing','This original pursuit is unavailable. Its identity has not been replaced.');
  return value;
 }
 list(after=''):IdeaPage<IdeaPursuit>{return this.page(prefix+'pursuit:',after);}
 entries(id:string,after=''):IdeaPage<IdeaEntry>{
  this.pursuit(id);
  return this.page<{entryId:string},IdeaEntry>(prefix+`entries:${id}:`,after,link=>{
   const entry=this.store.internalRead<IdeaEntry>(entryKey(link.entryId));
   if(!entry||entry.pursuitId!==id||entry.epoch!==this.store.epoch)throw new Fault(409,'idea_entry_missing','An original brief is unavailable. Its link remains kept.');
   return entry;
  });
 }
 runs(id:string,after=''):IdeaPage<IdeaRun>{this.pursuit(id);return this.page(prefix+`run:${id}:`,after);}
 private page<T,R=T>(key:string,after:string,project?:(value:T)=>R):IdeaPage<R>{
  if(after&&(after.length>300||!after.startsWith(key)))throw new Fault(400,'idea_cursor','Use this list’s original continuation.');
  const page=this.store.internalPage<T>(key,after,51),rows=page.slice(0,50);
  return {epoch:this.store.epoch,rows:rows.map(row=>project?project(row.value):row.value as unknown as R),next:page.length>50?rows.at(-1)!.id:null};
 }
 entry(id:string){
  const entry=this.store.internalRead<IdeaEntry>(entryKey(identity(id)));
  if(!entry||entry.epoch!==this.store.epoch)throw new Fault(404,'idea_entry_missing','The original brief is unavailable.');
  this.pursuit(entry.pursuitId);return {epoch:this.store.epoch,entry};
 }
 detail(id:string){return {epoch:this.store.epoch,pursuit:this.pursuit(id)};}
 run(id:string,operationId:string):IdeaRunDetail{
  this.pursuit(id);identity(operationId);
  // Exact identity lookup stays available beyond the recent Assistant activity page.
  const operation=this.store.internalRead<AssistantOperation>('assistant:operation:'+operationId);
  if(!operation||operation.epoch!==this.store.epoch||operation.context.idea?.pursuitId!==id)
   throw new Fault(404,'idea_run_missing','The exact original operation is unavailable. Earlier pursuit links remain kept.');
  const link=this.store.internalRead<IdeaRun>(prefix+`run:${id}:${operation.createdAt}:${operation.id}`);
  if(!link||link.entryId!==operation.context.idea.entryId||link.conversationId!==operation.conversationId)
   throw new Fault(409,'idea_run_changed','The original operation link could not be verified.');
  const entry=this.entry(link.entryId).entry;
  const conversation=this.store.internalRead<Conversation>('assistant:conversation:'+operation.conversationId)??null;
  // Permanently removed conversations retain their pursuit link, not a second access path to deleted work.
  if(!conversation||conversation.deleted||this.store.internalRead('assistant:removed:'+operation.conversationId))
   return {epoch:this.store.epoch,link,operation:null,outputs:[],conversation:null,capture:null};
  const outputs=this.store.internalList<AssistantOutput>('assistant:output:').filter(output=>output.conversationId===operation.conversationId&&output.nativeId===operation.nativeId&&!!operation.nativeRunId&&output.runId===operation.nativeRunId);
  const capture=this.store.internalRead<HomeSourceCapture>('home:context:'+entry.handoff.sourceCaptureId)??null;
  return {epoch:this.store.epoch,link,operation,outputs,conversation,capture:capture?.epoch===this.store.epoch?capture:null};
 }
 receipt(device:string,raw:unknown):IdeaReceipt{
  const command=ideaCommandSchema.parse(raw);
  return this.store.replayAdmission<IdeaReceipt>(device,command,this.intent(command))??{command,state:'unknown'};
 }
 command(device:string,raw:unknown):IdeaReceipt{
  this.store.assertUpdateAdmission();
  const command=ideaCommandSchema.parse(raw);
  return this.store.admit(device,command,this.intent(command),():IdeaReceipt=>{
   const reject=(code:string,message:string):IdeaReceipt=>({command,state:'rejected',code,message});
   if(this.store.recoveryEffectsPaused)return reject('idea_held','Idea changes are paused during recovery.');
   let pursuit=this.store.internalRead<IdeaPursuit>(pursuitKey(command.id));const at=this.at();
   let entry:IdeaEntry|undefined;
   if(command.type==='create'){
    if(pursuit)return reject('idea_exists','This pursuit already exists. Reopen it; starting another requires a distinct identity.');
    const capture=this.store.internalRead<HomeSourceCapture>('home:context:'+command.handoff.sourceCaptureId);
    if(!capture||capture.epoch!==command.epoch||!same(capture.sources.map(source=>source.reference),command.handoff.sourceRefs))
     return reject('idea_sources_changed','The exact captured source versions are unavailable. Your original brief remains kept.');
    pursuit={id:command.id,epoch:command.epoch,starterId:command.handoff.ideaId,title:command.handoff.title,revision:1,createdAt:at,updatedAt:at,initialEntryId:command.entryId,reviewed:false};
    entry={id:command.entryId,pursuitId:pursuit.id,epoch:command.epoch,createdAt:at,handoff:command.handoff};
   }else{
    if(!pursuit||pursuit.epoch!==command.epoch)return reject('idea_missing','This original pursuit is unavailable.');
    if(pursuit.revision!==command.expectedRevision)return reject('idea_changed','This pursuit changed elsewhere. The original writing is kept; reload before another change.');
    pursuit={...pursuit,revision:pursuit.revision+1,updatedAt:at};
    if(command.type==='review')pursuit.reviewed=command.reviewed;
    else{
     if(!command.text.trim())return reject('idea_question_empty','Write a question before preparing it.');
     const original=this.store.internalRead<IdeaEntry>(entryKey(pursuit.initialEntryId));
     if(!original||original.epoch!==command.epoch||original.pursuitId!==pursuit.id)return reject('idea_entry_missing','The original brief is unavailable.');
     const text=`${original.handoff.text}\n\nFollow-Up Question:\n${command.text}`;
     if(text.length>100000)return reject('idea_brief_large','The complete brief and question exceed the Assistant limit. Nothing was shortened.');
     pursuit.reviewed=false;
     entry={id:command.entryId,pursuitId:pursuit.id,epoch:command.epoch,createdAt:at,question:command.text,handoff:{...original.handoff,text}};
    }
   }
   if(entry){
    if(this.store.internalRead(entryKey(entry.id)))return reject('idea_entry_exists','This brief identity already exists. Check the original request.');
    this.store.internalWrite(entryKey(entry.id),entry);
    this.store.internalWrite(prefix+`entries:${pursuit.id}:${at}:${entry.id}`,{entryId:entry.id});
   }
   this.store.internalWrite(pursuitKey(pursuit.id),pursuit);
   return {command,state:'saved',pursuit,...(entry?{entryId:entry.id}:{})};
  }).value;
 }
}
