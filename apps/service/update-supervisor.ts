import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SoftwareUpdateJob } from '../../packages/domain/software-update.js';
import type { UpdateFeed, VerifiedUpdateRelease } from './update-feed.js';
import type { UpdateHeartbeat, UpdateHostView } from './update-host-client.js';

export class UpdateAdmissionError extends Error {}
const terminal=new Set(['completed','restored','failed','cancelled']);
export type HostUpdateJob=SoftwareUpdateJob & {epoch:string;fromCandidateId:string;idempotencyKey:string;when:'now'|'idle';hold:boolean;started:boolean;prepared?:boolean;release:VerifiedUpdateRelease};
type Job=HostUpdateJob;
export interface UpdateJournal { current():Job|undefined; find(key:string):Job|undefined; save(job:Job):void; }
export type InstallerResult='completed'|'restored'|'unchanged'|{outcome:'unchanged';reasonCode:'insufficient_storage'|'preflight_failed'};
const resultState=(result:InstallerResult)=>typeof result==='string'?result:result.outcome;
const resultMessage=(result:InstallerResult)=>typeof result!=='string'&&result.reasonCode==='insufficient_storage'
  ? 'There is not enough free storage to prepare this update. Nothing was installed.'
  : resultState(result)==='completed'?'Update installed.':resultState(result)==='restored'?'Previous version restored.':'The update could not be prepared. Nothing was installed.';
export interface Installer {
  prepare(release:VerifiedUpdateRelease,progress:(received:number,total:number)=>void):Promise<void>;
  run(release:VerifiedUpdateRelease,jobId:string,phase:(state:'preparing'|'installing'|'restarting'|'checking')=>void):Promise<InstallerResult>;
  reconcile(release:VerifiedUpdateRelease,jobId:string):Promise<InstallerResult|undefined>;
}
const install=z.object({epoch:z.string().uuid(),candidateId:z.string().regex(/^[0-9a-f]{64}$/),releaseId:z.string().regex(/^[0-9a-f]{64}$/).optional(),currentCandidateId:z.string().regex(/^[0-9a-f]{64}$/),idempotencyKey:z.string().uuid(),when:z.enum(['now','idle'])}).strict();

/** Durable single-job state machine owned by a separate host service. A browser
 * disconnect, application replacement or repeated click cannot re-run a switch. */
export class UpdateSupervisor {
  private heartbeat?:UpdateHeartbeat & {at:number};
  private job?:Job;
  private working?:Promise<void>;
  private stopped=false;
  constructor(private readonly feed:Pick<UpdateFeed,'status'|'check'|'verifiedRelease'>,private readonly journal:UpdateJournal,private readonly installer:Installer,private readonly current:()=>string,private readonly now=Date.now) {this.job=journal.current();}
  private freshHeartbeat(){const age=this.heartbeat?this.now()-this.heartbeat.at:-1;return age>=0&&age<10000;}
  view():UpdateHostView {
    const status=this.feed.status();
    const blockers=this.heartbeat?.blockers ?? [{code:'workspace_unknown',message:'Waiting for the workspace to reconnect.'}];
    const fresh=this.freshHeartbeat();
    const blocker=!fresh?{code:'workspace_unknown',message:'Waiting for the workspace to reconnect.'}:blockers[0];
    return {...status,installation:this.job?.hold&&this.job.state==='failed'?{supported:false,reason:'The previous update needs host review before another installation.'}:{supported:true},...(this.job?{job:this.publicJob(this.job)}:{}),...(blocker?{blocker}:{}),holdFor:this.job?.hold?this.job.id:null};
  }
  private publicJob(job:Job):SoftwareUpdateJob {
    const {id,candidateId,releaseId,state,requestedAt,updatedAt,message,download}=job;
    return {id,candidateId,...(releaseId?{releaseId}:{}),state,requestedAt,updatedAt,...(message?{message}:{}),...(download?{download}:{})};
  }
  beat(input:UpdateHeartbeat) { if(input.candidateId!==this.current())throw new Error('The workspace version changed. Reconnect before updating.'); this.heartbeat={...input,at:this.now()};if(this.job?.hold&&!this.job.started&&input.heldFor===null&&input.blockers.length)this.change({hold:false,state:'waiting',message:input.blockers[0].message});this.kick();return this.view(); }
  async check() {await this.feed.check(true);return this.view();}
  async request(value:unknown) {
    const input=install.parse(value),prior=this.journal.find(input.idempotencyKey);
    if(prior) {
      // currentCandidateId is derived anew by the app bridge. It can legitimately
      // change after the original operation completed; the owner's intent cannot.
      if(prior.epoch!==input.epoch||prior.candidateId!==input.candidateId||prior.releaseId!==input.releaseId||prior.when!==input.when)throw new UpdateAdmissionError('This update request already identifies a different operation.');
      const persisted=this.journal.current();
      if(persisted?.id===prior.id&&this.job?.id!==prior.id&&!this.working){this.job=persisted;this.kick();}
      return {...this.view(),job:this.publicJob(this.job?.id===prior.id?this.job:prior)};
    }
    if(this.working)throw new UpdateAdmissionError('The previous update request is still settling. Try again shortly.');
    if(this.job && (!terminal.has(this.job.state)||this.job.hold))throw new UpdateAdmissionError('Finish or review the current software update first.');
    if(input.currentCandidateId!==this.current()||this.heartbeat?.candidateId!==input.currentCandidateId||this.heartbeat.epoch!==input.epoch||!this.freshHeartbeat())throw new UpdateAdmissionError('Refresh Software Update before installing.');
    const release=this.feed.verifiedRelease(input.candidateId);
    if(!release||release.fromCandidateId!==input.currentCandidateId)throw new UpdateAdmissionError('This compatible update is no longer verified. Check for updates again.');
    if(input.releaseId!==undefined&&input.releaseId!==release.bundle.sha256||release.runtimeBundle&&!input.releaseId)throw new UpdateAdmissionError('The available update changed. Refresh and review its versions before updating.');
    if(input.when==='now'&&this.heartbeat.blockers.length)throw new UpdateAdmissionError(this.heartbeat.blockers[0].message);
    const job:Job={id:randomUUID(),candidateId:input.candidateId,...(input.releaseId?{releaseId:input.releaseId}:{}),fromCandidateId:input.currentCandidateId,epoch:input.epoch,idempotencyKey:input.idempotencyKey,when:input.when,hold:false,started:false,prepared:false,state:'waiting',requestedAt:this.now(),updatedAt:this.now(),release};
    this.journal.save(job);this.job=job;this.kick();return this.view();
  }
  cancel(value:unknown) {
    const input=z.object({epoch:z.string().uuid(),jobId:z.string().uuid()}).strict().parse(value);
    if(!this.job||this.job.id!==input.jobId||this.job.epoch!==input.epoch)throw new UpdateAdmissionError('This update request is no longer current.');
    if(this.job.state==='cancelled')return this.view();
    if(this.job.started||!['waiting','downloading','verifying'].includes(this.job.state))throw new UpdateAdmissionError('Installation has begun. Wait for verification to finish.');
    this.change({state:'cancelled',hold:false,message:'Update cancelled.'});return this.view();
  }
  private change(patch:Partial<Job>) {if(!this.job)throw new Error('No update is active.');if(Object.entries(patch).every(([key,value])=>JSON.stringify(this.job![key as keyof Job])===JSON.stringify(value)))return; const next={...this.job,...patch,updatedAt:this.now()};this.journal.save(next);this.job=next;}
  private admitted(job:Job) {
    const beat=this.heartbeat;
    return !!beat&&this.freshHeartbeat()&&beat.candidateId===job.fromCandidateId&&beat.epoch===job.epoch&&beat.blockers.length===0;
  }
  private kick() {
    if(this.working||this.stopped||!this.job||terminal.has(this.job.state)&&!(this.job.started&&this.job.hold))return;
    const id=this.job.id;
    this.working=this.advance().catch(()=>{if(this.job?.id===id&&(!terminal.has(this.job.state)||this.job.started&&this.job.hold))this.change({state:'failed',message:this.job.started?'The update needs review. Saved recovery data was retained.':'Could not prepare this update. Nothing was installed.',hold:this.job.started});}).finally(()=>{this.working=undefined;});
  }
  private async advance() {
    const job=this.job!;
    const same=()=>this.job?.id===job.id;
    const release=job.started?job.release:this.feed.verifiedRelease(job.candidateId);
    if(!release) {this.unverified();return;}
    if(release.bundle.sha256!==job.release.bundle.sha256||JSON.stringify(release.runtimeBundle)!==JSON.stringify(job.release.runtimeBundle)||release.agentVersion!==job.release.agentVersion)throw new Error('The reviewed update changed.');
    if(job.started) {
      // Restart recovery is read-only. The original runner is never launched a second time.
      const observed=await this.installer.reconcile(release,job.id),result=observed&&resultState(observed);
      if(!same())return;
      if(result==='completed'&&this.current()!==job.candidateId)throw new Error('The installed candidate did not match.');
      if((result==='restored'||result==='unchanged')&&this.current()!==job.fromCandidateId)throw new Error('The original candidate did not match.');
      this.change(result?{state:result==='unchanged'?'failed':result,hold:false,message:resultMessage(observed!)}:{state:'failed',hold:true,message:'The interrupted update needs review before work resumes.'});return;
    }
    if(!this.admitted(job)) {this.change({state:'waiting',message:this.heartbeat?.blockers[0]?.message??'Waiting for the workspace to reconnect.'});return;}
    // Download counts are observations, not a durable verification receipt.
    // A crash after the final chunk must still verify and extract the package.
    if(!job.prepared) {
      this.change({state:'downloading',message:'Downloading update.'});
      await this.installer.prepare(release,(received,total)=>{if(this.job?.id===job.id&&this.job.state!=='cancelled')this.change({download:{received,total}});});
      if(!same()||this.job?.state==='cancelled')return;
      this.change({state:'verifying',prepared:true,message:'Update verified.'});
    }
    if(!same()||this.job?.state==='cancelled'||this.stopped)return;
    if(!this.admitted(job)) {this.change({state:'waiting',message:'Waiting for current work to finish.'});return;}
    // Request maintenance first, then wait for a subsequent live heartbeat that
    // acknowledges it and observes all old work/effects drained.
    const refreshed=this.feed.verifiedRelease(job.candidateId);
    if(!refreshed){this.unverified();return;}
    if(refreshed.bundle.sha256!==release.bundle.sha256||JSON.stringify(refreshed.runtimeBundle)!==JSON.stringify(release.runtimeBundle)||refreshed.agentVersion!==release.agentVersion)throw Error('The reviewed update changed during preparation.');
    if(!this.job!.hold){this.change({state:'waiting',hold:true,message:'Preparing to update.'});return;}
    if(this.heartbeat?.heldFor!==job.id||this.heartbeat.nativeSuspended!==true)return;
    this.change({state:'preparing',started:true,message:'Preparing recovery.'});
    const observed=await this.installer.run(release,job.id,state=>{if(same())this.change({state,message:({preparing:'Preparing recovery.',installing:'Installing update.',restarting:'Restarting Nova Dream.',checking:'Checking the update.'})[state]});}),result=resultState(observed);
    if(!same())return;
    if(result==='completed'&&this.current()!==job.candidateId)throw new Error('The installed candidate did not match.');
    if((result==='restored'||result==='unchanged')&&this.current()!==job.fromCandidateId)throw new Error('The original candidate did not match.');
    this.change({state:result==='unchanged'?'failed':result,hold:false,message:resultMessage(observed)});
  }
  private unverified() {
    // An in-flight refresh may temporarily hide availability. A confirmed loss
    // of release verification must release an unstarted request, not strand it.
    if(this.feed.status().availability==='checking')return;
    this.change({state:'failed',hold:false,message:'This update is no longer verified. Nothing was installed. Check for updates again.'});
  }
  async settle(){await this.working;}
  poll(){this.kick();return this.view();}
  stop(){this.stopped=true;}
}
