import type {AdaptiveWrittenCapture,AdaptiveWrittenApproval,readAdaptiveWrittenPlan} from '../../../packages/domain/news-feed-adaptive';
import type {AdaptiveReviewCommand} from '../../../packages/domain/news-feed-adaptive-commands';
import type {FeedBriefSpan} from '../../../packages/domain/news-feed-interpretation';
import type {FeedWorkerSummary,OwnerStopCommand,Stop} from '../../../packages/domain/news-feed-adaptive-worker';
import {ContentRecoveryPanel} from './ContentRecoveryPanel';

export type FeedReviewTarget=Omit<AdaptiveReviewCommand,'requestId'>;
export type FeedOriginalTarget=Omit<OwnerStopCommand,'requestId'>;
export type FeedCurrentWriting=Pick<AdaptiveWrittenCapture,'epoch'|'deviceId'|'profileRevision'|'writing'|'writingSha256'>;
type ReadPlan=Extract<ReturnType<typeof readAdaptiveWrittenPlan>,{ok:true}>['value'];
export type FeedInterpretationAttempt=Pick<FeedWorkerSummary,'id'|'state'|'reason'|'createdAt'|'deadlineAt'>&{
 capture:AdaptiveWrittenCapture;stop?:Stop;result?:ReadPlan;resultError?:string;terminalSha256?:string;
};
export type FeedAcceptanceState={state:'idle'}|{state:'pending'|'unknown';command:AdaptiveReviewCommand}
 |{state:'accepted';command:AdaptiveReviewCommand;approval:AdaptiveWrittenApproval}
 |{state:'failed';command:AdaptiveReviewCommand;message:string};
export type FeedPanelAction={kind:'check'|'stop';target:FeedOriginalTarget}|{kind:'accept';target:FeedReviewTarget}
 |{kind:'check-acceptance';command:AdaptiveReviewCommand};
export type FeedInterpretationPanelProps={
 attempt:FeedInterpretationAttempt|null;currentWriting:FeedCurrentWriting|null;acceptance:FeedAcceptanceState;
 authorized:boolean;canCheck:boolean;canCheckAcceptance:boolean;canStop:boolean;canAccept:boolean;busy:boolean;
 /** Live synchronous owner/capability/target check, independent of this render.
  * Acceptance readback checks its own kept command, not the selected attempt. */
 currentAction(action:FeedPanelAction):boolean;
 check(target:FeedOriginalTarget):void;stop(target:FeedOriginalTarget):void;
 accept(target:FeedReviewTarget):void;checkAcceptance(command:AdaptiveReviewCommand):void;
 close():void;fallbackFocus():HTMLElement|null;
};
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sameWriting=(a:FeedCurrentWriting,b:FeedCurrentWriting)=>a.writingSha256===b.writingSha256&&
 a.writing.directions===b.writing.directions&&JSON.stringify(a.writing.interests)===JSON.stringify(b.writing.interests)&&
 JSON.stringify(a.writing.exclusions)===JSON.stringify(b.writing.exclusions);
const labels={prepared:'Prepared — Not Sent',dispatching:'Sending — Confirmation Pending',running:'Working',unknown:'Original Attempt Unconfirmed',
 completed:'Completed — Review Required',failed:'Failed',cancelled:'Stopped',withdrawn:'Withdrawn',rejected:'Result Rejected'} as const;
const fieldLabel=(span:FeedBriefSpan)=>span.field==='directions'?'Directions':`${span.field==='interests'?'Interest':'Exclusion'} ${span.index+1}`;
function quote(span:FeedBriefSpan,key:number){return <div key={key}><dt>{fieldLabel(span)}</dt><dd className="preserve-case">“{span.quote}”</dd></div>;}
function writing(title:string,value:FeedCurrentWriting){return <details className="content-readable-copy"><summary>{title} · Version {value.profileRevision}</summary>
 <dl className="news-brief-summary"><dt>Interests</dt><dd>{value.writing.interests.map((entry,index)=><pre className="preserve-case" key={index}>{entry}</pre>)}</dd>
 <dt>Directions</dt><dd><pre className="preserve-case">{value.writing.directions||'No Directions'}</pre></dd>
 <dt>Exclusions</dt><dd>{value.writing.exclusions.map((entry,index)=><pre className="preserve-case" key={index}>{entry}</pre>)}</dd></dl></details>;}
function live(p:FeedInterpretationPanelProps,action:FeedPanelAction){
 try{const answer:unknown=p.currentAction?.(structuredClone(action));if(answer===true)return true;
  if(answer&&typeof (answer as PromiseLike<unknown>).then==='function')void Promise.resolve(answer).catch(()=>{});
 }catch{/* A stale or unavailable controller cannot authorize a callback. */}return false;
}

/** Presentation of validated, currently authorized observations only. No request
 * IDs, persistence, effects, model calls or hash authentication live here. The
 * controller retains each original before effects and rechecks after its awaits. */
export function NewsFeedInterpretationPanel(p:FeedInterpretationPanelProps){
 const a=p.attempt,r=a?.result,b=a?.capture,c=p.currentWriting,q=p.acceptance;
 const pending=q.state==='pending'||q.state==='unknown'?structuredClone(q.command):null;
 const original:FeedOriginalTarget|null=a&&b&&b.format===2&&a.id===b.requestId?{format:3,id:a.id,epoch:b.epoch}:null;
 const current=!!(b&&c&&b.epoch===c.epoch&&b.deviceId===c.deviceId&&c.profileRevision>=b.profileRevision&&sameWriting(b,c));
 const joined=!!(original&&r&&r.plan.format===2&&r.plan.requestId===a!.id&&r.plan.briefSha256===b!.briefSha256&&hash(r.planSha256));
 const target:FeedReviewTarget|null=joined&&c&&hash(a!.terminalSha256)?{format:3,epoch:b!.epoch,operationId:a!.id,
  expectedRevision:c.profileRevision,briefSha256:b!.briefSha256,planSha256:r!.planSha256,terminalSha256:a!.terminalSha256!}:null;
 const hasRules=!!r&&r.plan.rules.length>0,hasInclude=!!r&&r.plan.rules.some(rule=>rule.kind==='include');
 const reviewable=!!r&&r.plan.unsupported.length===0&&hasRules&&
  (r.status==='reviewable'&&hasInclude||r.status==='constraints-only'&&!hasInclude);
 const accepted=!!(joined&&reviewable&&!a!.resultError&&a!.state==='completed'&&hash(a!.terminalSha256)&&q.state==='accepted'&&q.command.format===3&&
  q.command.epoch===b!.epoch&&q.command.operationId===a!.id&&q.command.briefSha256===b!.briefSha256&&q.command.planSha256===r!.planSha256&&
  q.command.terminalSha256===a!.terminalSha256&&q.approval.format===2&&q.approval.kind==='approved-written'&&
  q.approval.reviewRequestId===q.command.requestId&&q.approval.epoch===b!.epoch&&q.approval.deviceId===b!.deviceId&&
  q.approval.originalRequestId===a!.id&&q.approval.briefSha256===b!.briefSha256&&q.approval.planSha256===r!.planSha256&&
  q.approval.writingSha256===b!.writingSha256&&q.approval.profileRevisionAtAcceptance===q.command.expectedRevision&&
  q.approval.profileRevisionAtAcceptance>=b!.profileRevision);
 const acceptedCurrent=accepted&&current&&q.state==='accepted'&&c!.profileRevision>=q.approval.profileRevisionAtAcceptance;
 const empty=!!(joined&&r!.status==='empty'&&r!.plan.rules.length===0&&r!.plan.unsupported.length===0&&
  !b!.writing.interests.length&&!b!.writing.exclusions.length&&!b!.writing.directions.trim());
 const active=!!a&&['prepared','dispatching','running','unknown'].includes(a.state);
 const allowed=p.authorized&&!p.busy,accept=allowed&&p.canAccept&&!pending&&!accepted&&current&&!!target&&reviewable&&!a!.resultError&&a!.state==='completed';
 const check=p.authorized&&p.canCheck&&!!original,stop=allowed&&p.canStop&&!!original&&active&&!a!.stop;
 return <ContentRecoveryPanel title="Review Feed Interpretation" close={p.close} fallbackFocus={p.fallbackFocus} breakpoint={800} backLabel="Back To Feed">
  {!p.authorized?<p role="alert">Access is unavailable. Reconnect to an authorized workspace to view or check this interpretation.</p>:<>
   {pending&&<section aria-label="Original Acceptance"><p role="status">{q.state==='unknown'?'Acceptance Unconfirmed':'Acceptance Pending'}. The original acceptance is kept; its result must be checked before another acceptance.</p>
    <details><summary>Original Acceptance Details</summary><dl className="news-brief-summary"><dt>Request</dt><dd className="preserve-case">{pending.requestId}</dd>
     <dt>Interpretation Attempt</dt><dd className="preserve-case">{pending.operationId}</dd></dl></details><button disabled={!p.authorized||!p.canCheckAcceptance}
     onClick={()=>{if(p.authorized&&p.canCheckAcceptance&&pending&&live(p,{kind:'check-acceptance',command:pending}))p.checkAcceptance(structuredClone(pending));}}>Check Original Acceptance</button></section>}
   {q.state==='failed'&&<p role="alert">Acceptance Failed For Attempt <span className="preserve-case">{q.command.operationId}: {q.message}</span></p>}
   {!a?<p>No original interpretation is selected.</p>:<>
    <p role="status">{acceptedCurrent?'Accepted Interpretation':accepted?'Previously Accepted Interpretation':labels[a.state]}</p>
    {a.state==='unknown'&&<p>The outcome is unknown. Check the original attempt; opening this panel does not send another request.</p>}
    {a.stop&&<p role="status">{a.stop.state==='acknowledged'?'Stop Request Acknowledged':a.stop.state==='unknown'?'Stop Request Unconfirmed':'Stop Requested'}.
     {active?' The original attempt has not reached a confirmed final state. Check it again.':''}</p>}
    <div className="button-row"><button disabled={!check} onClick={()=>{if(check&&original&&live(p,{kind:'check',target:original}))p.check(structuredClone(original));}}>Check Original Attempt</button>
     {active&&<button disabled={!stop} onClick={()=>{if(stop&&original&&live(p,{kind:'stop',target:original}))p.stop(structuredClone(original));}}>Stop Original Attempt</button>}</div>
    {!original&&<p role="alert">The captured writing does not match this original attempt. Acceptance is unavailable.</p>}
    {b&&writing('Captured Saved Writing',b)}
    {!current&&<><p role="status">{c?'The saved writing or workspace has changed. This result is kept for comparison; it cannot be accepted for the current writing.':'The current saved writing has not been confirmed. Acceptance is unavailable.'}</p>
     {c&&writing('Current Saved Writing',c)}</>}
    {r&&joined?<><p>Review every meaning against its quoted writing. Complete coverage does not prove the interpretation is correct.</p>
     {(['include','require','exclude'] as const).map(kind=><section className="content-readable-copy" key={kind}><h3>{kind==='include'?'Include':kind==='require'?'Require':'Exclude'}</h3>
      {r.plan.rules.filter(rule=>rule.kind===kind).map(rule=><div key={rule.id}><p className="preserve-case">{rule.meaning}</p><dl>{rule.sources.map(quote)}</dl></div>)}</section>)}
     {r.plan.unsupported.length>0&&<section className="content-readable-copy"><h3>Not Understood</h3><p>These passages need clarification. This interpretation cannot be accepted.</p><dl>{r.plan.unsupported.map(quote)}</dl></section>}
     {r.status==='constraints-only'&&reviewable&&<p>These requirements and exclusions can be accepted without adding an inclusion rule.</p>}
     {empty?<p role="status">There are no written preferences to accept. Activity-only learning needs its own enabled permissions and enough qualifying activity; this panel does not start it.</p>:<>
      {!reviewable&&r.plan.unsupported.length===0&&<p role="alert">The result does not contain a complete reviewable written plan. Acceptance is unavailable.</p>}
      {!hash(a.terminalSha256)&&<p role="alert">The original completed result has not been verified for acceptance. Check the original attempt.</p>}
      <button disabled={!accept} onClick={()=>{if(accept&&target&&live(p,{kind:'accept',target}))p.accept(structuredClone(target));}}>Accept This Exact Interpretation</button>
      <p>Acceptance keeps this reviewed writing. It does not send another interpretation, learn from activity or fetch stories.</p></>}</>:
     a.state==='completed'&&<p role="alert">The completed result is not available as a fully reviewable interpretation. Check the original attempt.</p>}
    {a.resultError&&<p role="alert" className="preserve-case">{a.resultError}</p>}
    <details><summary>Original Attempt Details</summary><dl className="news-brief-summary"><dt>Request</dt><dd className="preserve-case">{a.id}</dd>
     <dt>State Detail</dt><dd className="preserve-case">{a.reason}</dd></dl></details>
   </>}
  </>}
 </ContentRecoveryPanel>;
}
