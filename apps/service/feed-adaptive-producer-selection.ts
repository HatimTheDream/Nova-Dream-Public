import {adaptiveWrittenCurrent,captureAdaptivePreview,type AdaptiveWrittenBasis,type AdaptiveResult,type AdaptiveLearningCapture} from '../../packages/domain/news-feed-adaptive.js';
import type {AdaptiveSource} from '../../packages/domain/news-feed-adaptive-capture.js';
import {feedHardFilter,type FeedStory} from '../../packages/domain/news-feed.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import type {FeedWorkerSaved} from '../../packages/domain/news-feed-adaptive-worker.js';
import {MutationPlanBudget,mutationNeed as need} from './feed-history-projected-inventory.js';
import {SelectionWork} from './feed-adaptive-selection-budget.js';
import {issueHistoryLearningApplication,readHistoryLearningApplicationDigest,historyLearningProjectionAvailable,
 readHistoryLearningApplicationHead,issueHistoryLearningApplicationWorker,readHistoryLearningApplicationTerminal,
 readHistoryLearningApplicationSource,readHistoryLearningApplicationPreference,type HistoryLearningApplication} from './feed-history-read-lens.js';
import type {AdaptiveLearningSaved} from '../../packages/domain/news-feed-adaptive-graph.js';
import {isPreparedFeedSource,preparedFeedHash,preparedFeedBasisHash,preparedFeedBasis,preparedFeedLearningEligibility} from './feed-adaptive-owned-source.js';

export type ProducerCandidate=Readonly<{kind:'learn';basis:AdaptiveWrittenBasis}>|Readonly<{kind:'classify';basis:AdaptiveWrittenBasis;story:FeedStory;hidden:readonly string[];following:boolean}>;
export type ProducerSelectionInput=Readonly<{graph:FeedReadGraph;source:AdaptiveSource;owner:Readonly<{deviceId:string;epoch:string}>;candidate:ProducerCandidate;at:number;snapshotToken:string;guard:()=>void}>;
export type ProducerSelection=Readonly<{format:1;qualification:'unqualified';planningOnly:true;deviceId:string;epoch:string;snapshotToken:string;kind:'learn'|'classify';
 state:'eligible'|'consumed'|'held';reason:string;inputSha256:string;sourceSha256:string;contextSha256:string;basisSha256:string;groupSha256?:string;story?:Readonly<{id:string;revision:number;sourceId:string;sourceDigest:string}>;originalIds:readonly string[];count:number}>;
const probeId='00000000-0000-4000-8000-000000000001';
const terminal=(state:string)=>state==='completed'||state==='failed'||state==='cancelled'||state==='withdrawn'||state==='rejected';

type CurrentProjection={graph:FeedReadGraph;source:AdaptiveSource;budget:MutationPlanBudget;alive:boolean;
 selected?:ProducerSelection;application?:HistoryLearningApplication;worker?:FeedWorkerSaved;preferenceUsed:boolean};
const currentProjections=new WeakMap<object,CurrentProjection>(),selectedProjections=new WeakMap<object,CurrentProjection>(),activeProjections=new WeakMap<MutationPlanBudget,CurrentProjection>();
/** Own a fresh immutable data copy; no caller value is adopted as authority.
 * This scope is nested inside the original complete Store read. The outer read
 * retains its original Promise refusal/observation; finally expires this data
 * continuation immediately even if an invalid consumer returns a Promise. */
export function withFeedProducerProjection<T>(graph:FeedReadGraph,raw:AdaptiveSource,budget:MutationPlanBudget,consume:(source:AdaptiveSource)=>T):T{
 if(!raw.learningHead||!historyLearningProjectionAvailable(graph,budget))return consume(raw);
 budget.reserveBytes(2048);for(let i=0;i<32;i++)budget.entry();
 return budget.checked(()=>{need(!activeProjections.has(budget),'Producer current projection reentered');
  const source=isPreparedFeedSource(raw,graph,budget)?raw:budget.copy(raw),scope:CurrentProjection={graph,source,budget,alive:true,preferenceUsed:false};
  currentProjections.set(source,scope);activeProjections.set(budget,scope);
  try{return consume(source);}finally{scope.alive=false;activeProjections.delete(budget);}
 });
}
/** Only this module's successful original consumed branch creates a selected
 * continuation. A copied result/source cannot inherit the historical digest. */
export function hashFeedProducerPreferences(work:SelectionWork,graph:FeedReadGraph,source:AdaptiveSource,owner:Readonly<{deviceId:string;epoch:string}>,selected:ProducerSelection):string{
 const scope=selectedProjections.get(selected)??currentProjections.get(source);
 if(!scope?.selected)return work.hash({epoch:owner.epoch,deviceId:owner.deviceId,preferences:source.preferences});
 const charged=scope.budget;
 if(charged!==work.budget){let first:unknown;
  try{charged.reserveBytes(256);for(let i=0;i<4;i++)charged.entry();charged.fail(Error('Producer current projection budget changed'));}catch(error){first=error;}
  try{work.budget.fail(first);}catch{/* Genuine first refusal wins. */}throw first;
 }
 charged.reserveBytes(256);for(let i=0;i<4;i++)charged.entry();
 return charged.checked(()=>{
  need(scope.alive&&scope.graph===graph&&scope.source===source&&scope.selected===selected&&scope.application&&scope.worker&&!scope.preferenceUsed&&
   source.context.epoch===owner.epoch&&source.context.deviceId===owner.deviceId&&selected.epoch===owner.epoch&&selected.deviceId===owner.deviceId,
   'Producer current preference continuation changed or ended');
  const tuple={epoch:owner.epoch,deviceId:owner.deviceId,preferences:source.preferences};
  work.measure(tuple);work.budget.query();work.guard();scope.preferenceUsed=true;
  const digest=readHistoryLearningApplicationPreference(scope.application,graph,scope.application.record,scope.worker,work.budget);
  work.guard();return digest;
 });
}

/** Keep strict measurement and both current guards at the original hash point.
 * Only the private fresh read-lens ticket can avoid repeating canonical bytes. */
function applicationHash(work:SelectionWork,graph:FeedReadGraph,record:AdaptiveLearningSaved,proof:HistoryLearningApplication|null|undefined){
 if(!proof)return work.hash(record);
 work.measure(record);work.budget.query();work.guard();
 const digest=readHistoryLearningApplicationDigest(proof,graph,record,work.budget);work.guard();return digest;
}
function applicationHead(work:SelectionWork,graph:FeedReadGraph,record:AdaptiveLearningSaved,id:string,proof:HistoryLearningApplication|null|undefined){
 if(!proof)return work.get(graph.mutations,id);
 work.guard();work.budget.query();work.reserve(2,64);
 const head=readHistoryLearningApplicationHead(proof,graph,record,id,work.budget);work.guard();return head;
}
function applicationWorker(work:SelectionWork,graph:FeedReadGraph,record:AdaptiveLearningSaved,proof:HistoryLearningApplication|null|undefined){
 if(!proof)return work.get(graph.adaptiveWorkers,record.command.operationId);
 work.guard();work.budget.query();work.reserve(2,64);
 const worker=issueHistoryLearningApplicationWorker(proof,graph,record,record.command.operationId,work.budget);work.guard();return worker;
}
function applicationTerminalHash(work:SelectionWork,graph:FeedReadGraph,record:AdaptiveLearningSaved,worker:FeedWorkerSaved,proof:HistoryLearningApplication|null|undefined){
 if(!proof)return work.hash(worker.terminal);
 work.measure(worker.terminal);work.budget.query();work.guard();
 const digest=readHistoryLearningApplicationTerminal(proof,graph,record,worker,worker.terminal,work.budget);work.guard();return digest;
}
function applicationSourceMatches(work:SelectionWork,graph:FeedReadGraph,record:AdaptiveLearningSaved,worker:FeedWorkerSaved,proof:HistoryLearningApplication|null|undefined){
 if(!proof)return work.same(record.before,worker.capture.source);
 work.guard();work.budget.query();work.reserve(2,64);
 const same=readHistoryLearningApplicationSource(proof,graph,record,worker,record.before,worker.capture.source,work.budget);work.guard();return same;
}

/** Internal read-only planning kernel. Caller owns current authenticated source,
 * exact story and complete graph inside one existing Store/lens snapshot.
 * No shape/hash/result from an arbitrary caller grants authority. */
export function selectFeedProducerCandidate(input:ProducerSelectionInput,budget:MutationPlanBudget):ProducerSelection{
 return budget.checked(()=>{
  budget.entry();budget.reserveBytes(128);const w=new SelectionWork(budget,input.guard);w.guard();
  const {source,owner,candidate,graph}=input;
  need(source.context.deviceId===owner.deviceId&&source.context.epoch===owner.epoch,'Selector current source owner changed');
  need(typeof input.snapshotToken==='string'&&input.snapshotToken.length>0&&input.snapshotToken.length<=512&&owner.deviceId.length<=200&&owner.epoch.length<=200,'Selector identity bound');
  need(Number.isSafeInteger(input.at)&&input.at>0,'Selector current time invalid');
  need(candidate.kind==='learn'||candidate.kind==='classify','Selector kind invalid');
  w.reserve(12,512);const sourceSha256=preparedFeedHash(w,graph,source,'source')??w.hash(source),contextSha256=preparedFeedHash(w,graph,source,'context')??w.hash(source.context),basisSha256=preparedFeedBasisHash(w,graph,source,candidate.basis)??w.hash(candidate.basis);
  const story=candidate.kind==='classify'?{id:candidate.story.id,revision:candidate.story.revision,sourceId:candidate.story.sourceId,sourceDigest:candidate.story.sourceDigest}:undefined;
  const groupSha256=candidate.kind==='classify'?w.hash({format:1,kind:'classify',context:source.context,story:candidate.story}):undefined;
  const inputSha256=w.hash({format:1,kind:candidate.kind,sourceSha256,basisSha256,...(candidate.kind==='classify'?{storySha256:w.hash(candidate.story)}:{})});
  const finish=(state:ProducerSelection['state'],reason:string,ids:readonly string[]=[],count=ids.length)=>{
   w.reserve(3,256);return w.result({format:1 as const,qualification:'unqualified' as const,planningOnly:true as const,deviceId:owner.deviceId,epoch:owner.epoch,snapshotToken:input.snapshotToken,kind:candidate.kind,
    state,reason,inputSha256,sourceSha256,contextSha256,basisSha256,...(story?{story,groupSha256}:{}),originalIds:ids,count});};
  let busy:string|undefined;w.scan(graph.workers,row=>{if(!terminal(row.state)){busy=row.id;return false;}});
  if(busy){w.reserve(1,64);return finish('held','unresolved-global-original',[busy]);}
  function basisExact(basis:AdaptiveWrittenBasis){if(basis.kind==='empty')return;
   const review=w.get(graph.adaptiveReviews,basis.approval.reviewRequestId);need(review&&w.same(review.source,basis),'Selector exact accepted basis unavailable');}
  basisExact(candidate.basis);
  function currentBasis(basis:AdaptiveWrittenBasis){w.reserve(2,64);const prepared=preparedFeedBasis(w,graph,source,basis),value=prepared!==undefined?prepared!==null:w.child(source.context,[source.context.profile,basis],hash=>adaptiveWrittenCurrent(source.context,basis,hash),'basis');basisExact(basis);return value;}
  let learningCapture:((requestId:string,at:number)=>AdaptiveResult<AdaptiveLearningCapture>)|undefined;
  function capture(id:string,at:number){w.reserve(2,64);
   if(candidate.kind==='learn'){need(learningCapture,'Selector learning capture scope missing');return learningCapture(id,at);}
   return w.child(source.context,[source.context,candidate.basis,candidate.story],hash=>captureAdaptivePreview(source.context,candidate.basis,candidate.story,id,at,hash),'preview',candidate.story);
  }
  if(candidate.kind==='classify'){
   need(typeof candidate.following==='boolean'&&Array.isArray(candidate.hidden),'Selector current story options invalid');
   w.reserve(2,64);const hard=w.child(source.context,[source.context.profile,candidate.story,candidate.hidden],()=>feedHardFilter(source.context.profile,candidate.story,{following:candidate.following,hidden:candidate.hidden}),'hard',candidate.story);
   if(hard)return finish('held','current-domain-ineligible');
   let count=0;w.reserve(1,32);const ids:string[]=[];
   w.scan(graph.adaptiveWorkers,worker=>{
    if(worker.deviceId!==owner.deviceId||worker.command.epoch!==owner.epoch||worker.state!=='completed'||worker.capture.kind!=='classify')return;
    const preview=worker.capture.preview;
    if(preview.at>input.at||preview.contextSha256!==contextSha256||!w.same(preview.story,candidate.story)||!currentBasis(preview.basis))return;
    // Complete graph already invokes validateFeedWorkerRecord, which validates
    // readAdaptiveOutput for this exact completed capture (lines106–109).
    need(worker.terminal?.kind==='reply'&&typeof worker.output?.text==='string','Selector completed output proof changed');
    count++;if(ids.length<2){w.reserve(1,64);ids.push(worker.id);}
   });
   if(count)return finish(count===1?'consumed':'held',count===1?'retained-classification':'ambiguous-classification-group',ids,count);
  }else{
   let found:string|undefined;w.scan(graph.adaptiveWorkers,worker=>{
    if(worker.deviceId!==owner.deviceId||worker.command.epoch!==owner.epoch||worker.capture.kind!=='learn')return;
    if(w.same(worker.capture.source,source)&&w.same(worker.capture.basis,candidate.basis)){found=worker.id;return false;}
   });
   if(found){w.reserve(1,64);return finish('consumed','retained-learning-original',[found]);}
   if(source.learningHead){
    // Preserve get's original guards/query/reservation. Unsupported graphs keep
    // their original copy/hash route; known missing learning rows need no copy.
    w.guard();budget.query();w.reserve(2,64);
    const application=issueHistoryLearningApplication(graph,source.learningHead,budget);
    const applied=application===undefined?graph.learning.get(source.learningHead):application?.record;w.guard();
    if(applied){
     // Complete graph already proved the retained application. An unrelated
     // current source needs no repeated application proof or suppression.
     w.reserve(2,128);const before=applied.before.context,current=source.context;
     const unchanged=w.same({epoch:before.epoch,deviceId:before.deviceId,profile:before.profile,control:before.control,activity:before.activity},{epoch:current.epoch,deviceId:current.deviceId,profile:current.profile,control:current.control,activity:current.activity})&&
      w.same(applied.before.preferences,source.preferences)&&w.same(applied.before.selection,source.selection)&&w.same(applied.after,source.context.learning);
     if(unchanged){const head=applicationHead(w,graph,applied,source.learningHead,application);need(head&&w.same(head,applied),'Selector current learning head mismatch');
     const worker=applicationWorker(w,graph,applied,application),receipt=w.get(graph.receipts,applied.id),original=w.get(graph.originalRequests,applied.id);
     need(worker&&worker.capture.kind==='learn'&&worker.state==='completed'&&worker.terminal,'Selector applied worker missing');
     need(applied.deviceId===owner.deviceId&&applied.command.epoch===owner.epoch&&worker.deviceId===owner.deviceId&&worker.command.epoch===owner.epoch,'Selector applied owner changed');
     need(receipt&&original&&receipt.requestId===applied.id&&receipt.deviceId===owner.deviceId&&original.deviceId===owner.deviceId&&original.request.kind==='apply-learning'&&w.same(original.request.command,applied.command)&&w.same(original.receipt,receipt),'Selector application receipt mismatch');
     const admission=receipt.value as any;w.reserve(1,64);
     need(admission?.type==='feed-semantic-learning'&&admission.id===applied.id&&admission.epoch===owner.epoch&&admission.operationId===worker.id&&admission.recordSha256===applicationHash(w,graph,applied,application)&&
      applied.command.captureSha256===worker.capture.learning.captureSha256&&applied.command.terminalSha256===applicationTerminalHash(w,graph,applied,worker,application)&&applicationSourceMatches(w,graph,applied,worker,application),'Selector application lineage mismatch');
     if(w.same(worker.capture.basis,candidate.basis)){w.reserve(1,64);const selected=finish('consumed','consumed-by-retained-application',[worker.id,applied.id]);
      if(application&&candidate.basis.kind==='empty'){
       w.reserve(12,768);const scope=currentProjections.get(source);
       if(scope){need(scope.alive&&scope.graph===graph&&scope.budget===budget&&!scope.selected&&worker.command.kind==='learn'&&worker.command.basis.kind==='empty-written',
        'Producer current consumed correspondence changed');scope.selected=selected;scope.application=application;scope.worker=worker;selectedProjections.set(selected,scope);}
      }
      return selected;
     }
     }
    }
   }
  }
  w.reserve(8,512);
  type Decision={state:ProducerSelection['state'];reason:string;ids?:readonly string[]};
  const decide=():Decision=>{let retained:string|undefined,uncertain:string|undefined;
  w.scan(graph.locals,local=>{
   if(local.kind!=='closed-before-admission'&&local.kind!=='refused-before-admission')return;
   const command=local.request.command;
   if(local.deviceId!==owner.deviceId||local.epoch!==owner.epoch||command.kind!==candidate.kind)return;
   if(!('format'in command)){uncertain??=local.id;return;}
   if(command.expectedRevision!==source.context.profile.revision)return;
   if(command.basis.kind==='accepted'){
    if(candidate.basis.kind!=='accepted'||command.basis.reviewId!==candidate.basis.approval.reviewRequestId||command.basis.originalProofSha256!==basisSha256)return;
   }else{
    if(candidate.basis.kind!=='empty')return;w.reserve(1,64);
    if(command.basis.preferenceProofSha256!==w.hash({epoch:owner.epoch,deviceId:owner.deviceId,preferences:source.preferences}))return;
   }
   if(candidate.kind==='classify'&&(command.kind!=='classify'||!w.same(command.story,story)))return;
   const original=w.get(graph.originalRequests,local.id),receipt=w.get(graph.receipts,local.id);
   need(original&&receipt&&original.deviceId===owner.deviceId&&w.same(original.request,local.request)&&w.same(original.receipt,receipt),'Selector retained disposition proof mismatch');
   const rebuilt=capture(command.requestId,command.expectation.preparedAt);
   if(!rebuilt.ok){uncertain??=local.id;return;}
   w.reserve(1,128);const captured=candidate.kind==='learn'?{format:3,kind:'learn',source,basis:candidate.basis,learning:rebuilt.value}:{format:3,kind:'classify',source,basis:candidate.basis,preview:rebuilt.value};
   if(w.hash(captured)===command.expectation.captureSha256){retained=local.id;return false;}
  });
  if(retained){w.reserve(2,96);return {state:'consumed',reason:'retained-local-start',ids:[retained]};}
  if(uncertain){w.reserve(2,96);return {state:'held',reason:'retained-correspondence-unresolved',ids:[uncertain]};}
  const eligible=(candidate.kind==='learn'?preparedFeedLearningEligibility(w,graph,source,candidate.basis,probeId,input.at):undefined)??capture(probeId,input.at);w.reserve(1,64);return {state:eligible.ok?'eligible':'held',reason:eligible.ok?'current-candidate':'current-domain-ineligible'};
  };
  let decision:Decision|undefined;
  if(candidate.kind==='learn')w.withLearningCaptures(source.context,candidate.basis,scoped=>{learningCapture=scoped;decision=decide();});
  else decision=decide();
  need(decision,'Selector decision missing');return finish(decision.state,decision.reason,decision.ids);
 });
}
