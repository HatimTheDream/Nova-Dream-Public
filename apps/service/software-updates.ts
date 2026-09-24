import { z } from 'zod';
import type { AgentServiceInfo } from '../../packages/domain/agent-service.js';
import type { SoftwareUpdateStatus } from '../../packages/domain/software-update.js';
import { Fault } from './store.js';
import { UpdateHostClient, UpdateHostRejected, type UpdateHeartbeat, type UpdateHostView } from './update-host-client.js';

export interface UpdateWorkspace {
  epoch(): string;
  installed(): { novaVersion: string; candidateId: string; agent: AgentServiceInfo };
  hold(jobId: string | null): void;
  heldFor(): string | null;
  blockers(): { code: string; message: string }[];
  native?: {
    acquire(jobId:string):Promise<{code:string;message:string}[]>;
    release(jobId:string):Promise<{code:string;message:string}[]>;
    snapshot(jobId:string|null):{nativeSuspended:boolean};
    pendingJobIds():string[];
  };
}
const installInput = z.object({epoch:z.string().uuid(),candidateId:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().uuid(),when:z.enum(['now','idle'])}).strict();
const cancelInput = z.object({epoch:z.string().uuid(),jobId:z.string().uuid()}).strict();
const checkInput = z.object({epoch:z.string().uuid()}).strict();

/** App-side status bridge. The durable job and installer live outside the app
 * and workspace so replacing either cannot lose the original update attempt. */
export class SoftwareUpdates {
  private view?: UpdateHostView;
  private unavailable = false;
  private timer?: ReturnType<typeof setTimeout>;
  private reading?: Promise<void>;
  private closed = false;
  constructor(private readonly workspace: UpdateWorkspace, private readonly host?: Pick<UpdateHostClient, 'call'>) {}
  status(readOnly = false): SoftwareUpdateStatus {
    const installation = !this.host ? {supported:false,reason:'Updates are managed by this host’s administrator.'}
      : this.unavailable ? {supported:false,reason:'The update service is unavailable. Try again shortly.'}
      : readOnly ? {supported:false,reason:'Manage software updates from the owner’s workspace.'}
      : this.view?.installation ?? {supported:false,reason:'Checking the host update service…'};
    return { installed:this.workspace.installed(), availability:this.unavailable ? 'error' : this.view?.availability ?? (this.host ? 'checking' : 'unavailable'),
      ...(this.view?.checkedAt ? {checkedAt:this.view.checkedAt}:{}), ...(this.view?.release ? {release:this.view.release}:{}),
      ...(this.unavailable ? {error:'Could not reach the update service.'} : this.view?.error ? {error:this.view.error}:{}), installation,
      ...(this.view?.job ? {job:this.view.job}:{}), ...(this.view?.blocker ? {blocker:this.view.blocker}:{}) };
  }
  async start() { if (!this.host || this.closed) return; await this.refresh(); this.schedule(); }
  private schedule() { if (this.closed || !this.host) return; clearTimeout(this.timer); this.timer=setTimeout(()=>void this.refresh().finally(()=>this.schedule()),this.view?.holdFor || this.workspace.heldFor() || this.view?.job && !['completed','restored','failed','cancelled'].includes(this.view.job.state) ? 2000:30000); this.timer.unref(); }
  private heartbeat(blockers=this.workspace.blockers()):UpdateHeartbeat {
    const heldFor=this.workspace.heldFor();
    return {candidateId:this.workspace.installed().candidateId,epoch:this.workspace.epoch(),heldFor,nativeSuspended:this.workspace.native?.snapshot(heldFor).nativeSuspended??false,blockers:blockers.slice(0,30)};
  }
  private async release(jobId:string) {
    if(!this.workspace.native)return [];
    try{return await this.workspace.native.release(jobId);}catch{return [{code:'native_unknown',message:'Waiting to reconnect and release the Assistant update hold.'}];}
  }
  refresh(): Promise<void> {
    if (this.closed || !this.host) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading=(async()=>{try {
      const beat=this.heartbeat();
      const view=await this.host!.call<UpdateHostView>('heartbeat',beat);
      if (this.closed) return;
      this.view=view; this.unavailable=false;
      // A confirmed root release also reconciles our process-local native lease.
      // Preserve the local hold until an ambiguous resume has been resolved.
      const pending=new Set(this.workspace.native?.pendingJobIds()??[]);
      const previous=this.workspace.heldFor();if(previous)pending.add(previous);
      for(const id of pending)if(id!==view.holdFor){
        this.workspace.hold(id);
        const blockers=await this.release(id);if(this.closed)return;
        if(blockers.length){this.view={...view,blocker:blockers[0]};return;}
      }
      this.workspace.hold(view.holdFor);
      if(view.holdFor){
        let blockers=this.workspace.blockers();
        const waiting=view.job?.state==='waiting';
        // Release immediately when local work is busy and no native acquisition
        // has occurred. Existing work can then finish its next dispatch.
        if(waiting&&blockers.length&&!this.workspace.native?.pendingJobIds().includes(view.holdFor))this.workspace.hold(null);
        else if(!blockers.length){
          try{blockers=this.workspace.native?await this.workspace.native.acquire(view.holdFor):[{code:'native_unknown',message:'Assistant update readiness could not be verified.'}];}
          catch{blockers=[{code:'native_unknown',message:'Assistant update readiness could not be verified.'}];}
          if(this.closed)return;
          blockers.push(...this.workspace.blockers());
          if(this.workspace.epoch()!==beat.epoch||this.workspace.installed().candidateId!==beat.candidateId)blockers.push({code:'workspace_changed',message:'The workspace changed. Refresh Software Update.'});
        }
        if(waiting&&blockers.length&&this.workspace.heldFor()){
          const released=await this.release(view.holdFor);if(this.closed)return;
          if(!released.length)this.workspace.hold(null);else blockers.push(...released);
        }
        this.view=await this.host!.call<UpdateHostView>('heartbeat',this.heartbeat(blockers));
      }
    } catch { this.unavailable=true; /* A lost supervisor must never release an admitted maintenance hold. */ }
    finally { this.reading=undefined; }})(); return this.reading;
  }
  private guard(epoch:string) { if(epoch!==this.workspace.epoch())throw new Fault(409,'epoch_changed','Refresh Software Update after changing workspaces.'); if(!this.host)throw new Fault(409,'update_rejected','Updates are managed by this host’s administrator.'); }
  async check(value:unknown) { const input=checkInput.parse(value);this.guard(input.epoch); await this.host!.call('check'); await this.refresh(); return this.status(); }
  async install(value:unknown) {
    const input=installInput.parse(value);this.guard(input.epoch); await this.refresh();this.guard(input.epoch);
    let acknowledged:UpdateHostView;
    try{acknowledged=await this.host!.call<UpdateHostView>('install',{...input,currentCandidateId:this.workspace.installed().candidateId});}catch(error){if(error instanceof UpdateHostRejected)throw new Fault(409,'update_rejected',error.message);throw error;}
    await this.refresh();this.schedule();return {...this.status(),...(acknowledged.job?{job:acknowledged.job}:{})};
  }
  async cancel(value:unknown) {const input=cancelInput.parse(value);this.guard(input.epoch);await this.host!.call('cancel',input);await this.refresh();return this.status();}
  close() {this.closed=true;clearTimeout(this.timer);}
}
