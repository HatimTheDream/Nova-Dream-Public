import {randomUUID} from 'node:crypto';
import {canonical} from '../../packages/domain/contracts.js';
import {TextDecoder} from 'node:util';
import {contentWorkspaceCommandSchema,contentWorkBrief,type ContentLibraryItem,type ContentJob,type ContentReview,type ContentWorkspaceState} from '../../packages/domain/content-workspace.js';
import {Store,Fault} from './store.js';
import {AssignmentService} from './assignments.js';
type SavedJob=Omit<ContentJob,'attempt'>&{device:string;epoch:string;startId:string;stopId:string;ackId:string;projectRevision:number|null};
const jobKey='content:job:',reviewKey='content:review:',libraryKey='content:library:';
export class ContentWorkspace {
 constructor(private store:Store,private assignments:AssignmentService,private now=Date.now){}
 library(){return this.store.internalList<ContentLibraryItem>(libraryKey).sort((a,b)=>a.name.localeCompare(b.name));}
 private content(id:string,revision?:number){const c=this.store.readEntity('content',id);if(!c)throw new Fault(404,'content_missing','This Content item is unavailable.');if(revision!==undefined&&(c.revision!==revision||c.value.archived))throw new Fault(409,'content_changed','Save or review the current Content version first.',c);return c;}
 private job(id:string){const j=this.store.internalRead<SavedJob>(jobKey+id);if(!j||j.epoch!==this.store.epoch)throw new Fault(404,'content_job_missing','This Content run is unavailable.');return j;}
 private publicJob(j:SavedJob):ContentJob{const {device,epoch,startId,stopId,ackId,projectRevision,...item}=j;return {...item,attempt:this.assignments.state(j.planId).attempts.find(a=>a.assignmentId===j.planId)};}
 state(id:string):ContentWorkspaceState{this.content(id);const status=this.assignments.state();return {reviews:this.store.internalList<ContentReview>(reviewKey).filter(r=>r.contentId===id).sort((a,b)=>b.createdAt-a.createdAt),jobs:this.store.internalList<SavedJob>(jobKey).filter(j=>j.contentId===id&&j.epoch===this.store.epoch).sort((a,b)=>b.createdAt-a.createdAt).map(j=>this.publicJob(j)),canStart:status.canStart,reason:status.reason};}
 result(id:string){const job=this.job(id),attempt=this.assignments.state(job.planId).attempts.find(a=>a.assignmentId===job.planId);if(attempt?.state!=='returned'||!attempt.result||attempt.result.disposition!=='visible')throw new Fault(409,'content_result_pending','A complete visible result has not returned.');const file=this.store.download(attempt.result.file.id);if(file.bytes.length>400000)throw new Fault(413,'content_result_large','Download this result; it is too large for a Content draft.');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{throw new Fault(400,'content_result_format','This result is not a text draft. Download the original file.');}if(text.length>100000)throw new Fault(413,'content_result_large','The result exceeds the Content draft limit. Download the original.');return {job:this.publicJob(job),text,file:attempt.result.file};}
 async command(device:string,raw:unknown){
  const input=contentWorkspaceCommandSchema.parse(raw);
  if(input.type==='work-control'){
   const j=this.store.admit(device,input,{operation:'content.work-control',...input},()=>this.job(input.jobId)).value;
   if(input.action==='start')this.start(j);
   else {const attempt=this.assignments.state(j.planId).attempts.find(a=>a.assignmentId===j.planId);if(!attempt)throw new Fault(409,'content_not_started','This work has not started.');if(input.action==='check')await this.assignments.reconcile(attempt.id);else if(input.action==='stop')this.assignments.stop(device,{requestId:j.stopId,epoch:j.epoch,attemptId:attempt.id});else this.assignments.acknowledgeUnresolved(device,{requestId:j.ackId,epoch:j.epoch,attemptId:attempt.id,understandUnconfirmed:true});}
   return this.publicJob(this.job(j.id));
  }
  const result=this.store.admit(device,input,{operation:'content.workspace',...input},()=>{
   if(input.type==='library-save'){
    const old=this.store.internalRead<ContentLibraryItem>(libraryKey+input.item.id);
    if((old?.revision??0)!==input.expectedRevision||old&&old.type!==input.item.type)throw new Fault(409,'content_library_changed','This library item changed. Reload it before saving.');
    if(!old&&this.library().length>=300)throw new Fault(409,'content_library_limit','Archive and reuse existing library entries before adding more.');
    if(input.item.type==='brand'&&input.item.brandId)throw new Fault(400,'content_brand','A brand cannot reference another brand.');
    if(input.item.brandId&&!this.library().some(b=>b.id===input.item.brandId&&b.type==='brand'&&(!b.archived||old?.brandId===b.id)))throw new Fault(409,'content_brand','Choose an available brand.');
    for(const file of input.item.assets??[])if(canonical(this.store.download(file.id).metadata)!==canonical(file))throw new Fault(409,'content_library_asset','A template attachment changed. Reopen the saved Content item.');
    return this.store.internalWrite(libraryKey+input.item.id,{...input.item,revision:input.expectedRevision+1});
   }
   const c=this.content(input.contentId,input.expectedRevision);
   if(input.type==='restore'){
    const old=this.store.readEntityVersion('content',c.id,input.revision);if(!old)throw new Fault(404,'content_version_missing','This saved version is unavailable.');
    const sourceFile=c.value.assets?.find(f=>f.id===c.value.source?.fileId),assets=[...(old.value.assets??[])];if(sourceFile&&!assets.some(f=>f.id===sourceFile.id))assets.push(sourceFile);
    const restored=this.store.reviseContent(device,c.id,{...old.value,source:c.value.source,assets,archived:false,stage:'drafting',publication:null},c.revision);
    this.store.internalWrite(`content:change:${c.id}:${restored.revision}`,{type:'restore',fromRevision:old.revision,revision:restored.revision,at:this.now()});return restored;
   }
   if(input.type==='work'){
    if(this.store.internalList<SavedJob>(jobKey).filter(j=>j.contentId===c.id).length>=100)throw new Fault(409,'content_work_limit','This item has reached its saved run limit. Start another Content item to continue.');
    if(!this.assignments.state().canStart)throw new Fault(409,'content_worker_busy',this.assignments.state().reason);
    const agent=this.store.readEntity('agent',input.agentId);if(!agent||agent.value.archived)throw new Fault(409,'content_agent_missing','Choose an active agent.');
    const brand=c.value.brandId?this.library().find(b=>b.id===c.value.brandId&&b.type==='brand'):undefined;
    if(c.value.brandId&&!brand)throw new Fault(409,'content_brand','The selected brand is unavailable.');
    const reviewContext=input.mode==='improve'?this.state(c.id).reviews.filter(r=>r.sourceRevision===c.revision).map(r=>({id:r.id,revision:r.revision,reviewerName:r.reviewerName,comments:r.comments.filter(comment=>!comment.resolved)})).filter(r=>r.comments.length):undefined;
    const id=randomUUID(),planId=`assignment:content:${id}`,j:SavedJob={id,contentId:c.id,sourceRevision:c.revision,agentId:agent.id,agentName:agent.value.name,agentRevision:agent.revision,mode:input.mode,instructions:input.instructions,...(reviewContext?.length?{reviewContext}:{}),planId,createdAt:this.now(),device,epoch:input.epoch,startId:randomUUID(),stopId:randomUUID(),ackId:randomUUID(),projectRevision:c.value.projectId?this.store.readEntity('project',c.value.projectId)!.revision:null,...(brand?{brand:{id:brand.id,name:brand.name,revision:brand.revision,guidance:brand.guidance}}:{})};
    const brief=contentWorkBrief(c.value,input.mode,input.instructions,j.brand,reviewContext);if(brief.length>20000)throw new Fault(413,'content_context_large','The guidance and open review comments exceed this run’s context limit. Resolve completed comments or shorten the run directions. Nothing was truncated or started.');
    this.store.createContentPlan(device,planId,{title:`${input.mode[0].toUpperCase()+input.mode.slice(1)}: ${c.value.title}`.slice(0,300),brief,expectedOutput:input.mode==='review'?'Actionable review with quoted passages and requested changes.':'Complete UTF-8 Markdown response for owner review.',agentId:agent.id,agentRevision:agent.revision,projectId:c.value.projectId,due:'',state:'planned',archived:false,sources:[{kind:'content',id:c.id,revision:c.revision}],maxMinutes:5,executionMode:'proposal'});
    this.store.internalWrite(jobKey+id,j);return this.publicJob(j);
   }
   if(input.type==='apply-work'){
    const j=this.job(input.jobId);if(j.contentId!==c.id)throw new Fault(403,'content_job_mismatch','Choose a result for this Content item.');if(j.sourceRevision!==c.revision)throw new Fault(409,'content_result_stale','The draft changed after this run. Compare the result and keep your current writing; start a new run against the latest version.');if(j.mode==='review')throw new Fault(400,'content_review_result','Add review feedback as a comment. It cannot replace the draft.');
    const result=this.result(j.id),assets=[...(c.value.assets??[])];if(!assets.some(f=>f.id===result.file.id))assets.push(result.file);
    const revised=this.store.reviseContent(device,c.id,{...c.value,body:input.placement==='append'?[c.value.body,result.text].filter(Boolean).join('\n\n'):result.text,stage:'drafting',publication:null,assets},c.revision);
    this.store.internalWrite(jobKey+j.id,{...j,appliedRevision:revised.revision});this.store.internalWrite(`content:change:${c.id}:${revised.revision}`,{type:'agent',jobId:j.id,sourceRevision:j.sourceRevision,at:this.now()});return revised;
   }
   if(input.type==='review-request'){
    const reviewer=input.reviewerId?this.store.readEntity('agent',input.reviewerId):null;if(input.reviewerId&&(!reviewer||reviewer.value.archived))throw new Fault(409,'content_reviewer','Choose an active reviewer.');
    const all=this.state(c.id).reviews;if(all.length>=200)throw new Fault(409,'content_review_limit','This item has reached its review history limit.');
    if(all.some(r=>r.sourceRevision===c.revision&&r.reviewerId===input.reviewerId&&r.state==='requested'))throw new Fault(409,'content_review_exists','This version already has a pending review for that reviewer.');
    const review:ContentReview={id:randomUUID(),revision:1,contentId:c.id,sourceRevision:c.revision,reviewerId:input.reviewerId,reviewerName:reviewer?.value.name??'You',state:'requested',createdAt:this.now(),updatedAt:this.now(),comments:[]};return this.store.internalWrite(reviewKey+review.id,review);
   }
   const review=this.store.internalRead<ContentReview>(reviewKey+input.reviewId);
   if(!review||review.contentId!==c.id||review.revision!==input.reviewRevision)throw new Fault(409,'content_review_changed','This review changed. Reload it before continuing.');
   let next={...review,revision:review.revision+1,updatedAt:this.now()};
   if(input.type==='review-comment'){
    if(review.comments.length>=200)throw new Fault(409,'content_comment_limit','This review has reached its comment limit.');
    let text=input.text,author='You';if(input.jobId){const result=this.result(input.jobId);if(result.job.contentId!==c.id||result.job.mode!=='review'||result.job.sourceRevision!==review.sourceRevision)throw new Fault(409,'content_review_result','This agent feedback belongs to another draft version.');text=result.text;if(text.length>10000)throw new Fault(413,'content_review_large','Select a shorter excerpt and add it as your comment; the full response stays saved.');author=`${result.job.agentName} · AI feedback`;}
    next.comments=[...review.comments,{id:randomUUID(),text,quote:input.quote,author,at:this.now(),resolved:false,...(input.jobId?{jobId:input.jobId}:{})}];
    if(next.state==='approved'){next.state='requested';next.decisionBy=undefined;}
   }else if(input.type==='review-resolve'){
    if(!review.comments.some(c=>c.id===input.commentId))throw new Fault(404,'content_comment_missing','This comment is unavailable.');next.comments=review.comments.map(c=>c.id===input.commentId?{...c,resolved:input.resolved}:c);if(!input.resolved&&next.state==='approved'){next.state='requested';next.decisionBy=undefined;}
   }else {
    if(review.sourceRevision!==c.revision)throw new Fault(409,'content_review_stale','This review is for an earlier version. Request review of the current version.');
    if(input.decision==='approved'&&review.comments.some(c=>!c.resolved))throw new Fault(409,'content_review_unresolved','Resolve the open comments before approving this version.');
    if(input.note.trim()&&review.comments.length>=200)throw new Fault(409,'content_comment_limit','This review has reached its comment limit.');
    next={...next,state:input.decision,decisionBy:'You'};if(input.note.trim())next.comments=[...next.comments,{id:randomUUID(),text:input.note,quote:'',author:'You · decision',at:this.now(),resolved:input.decision==='approved'}];
   }
   return this.store.internalWrite(reviewKey+next.id,next);
  });
  if(input.type==='work'){const job=this.job((result.value as ContentJob).id);this.start(job);return this.publicJob(this.job(job.id));}
  return result.value;
 }
 private start(j:SavedJob){
  const existing=this.assignments.state(j.planId).attempts.find(a=>a.assignmentId===j.planId);if(existing)return;
  try{this.assignments.start(j.device,{requestId:j.startId,epoch:j.epoch,assignmentId:j.planId,revision:1,projectRevision:j.projectRevision});this.store.internalWrite(jobKey+j.id,{...j,error:undefined});}
  catch(error){this.store.internalWrite(jobKey+j.id,{...j,error:error instanceof Error?error.message:'The original run could not start.'});}
 }
}
