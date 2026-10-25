import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { mailDisplayedSchema, mailTriagePrepareSchema, mailTriageReadSchema, mailTriageConfirmSchema, type MailTriagePlan, type MailTriageTarget, type MailTriageOutcome, type TriageMessageState, type TriageChange, type TriageStep, type TriageThreadState } from '../../packages/domain/mail-triage.js';
import type { MailAssistantPlan, MailAssistantTarget, MailAssistantApprovalReceipt } from '../../packages/domain/dreamclaw/mail-actions.js';
import { MailAssistantService } from './dreamclaw/mail-assistant.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { ProviderError } from './providers.js';
import { applyTriageStep, matchesChange, messageFingerprint, readTriageMessage, readTriageThread, resolveTriageResource, touchedState, triageChange, triageHash, triageSteps, restoreDestination } from './provider-mail-triage.js';

type Prepare=z.infer<typeof mailTriagePrepareSchema>;
type Preparation={id:string;device:string;input:Prepare;state:'preparing'|'ready'|'failed';planId?:string;error?:string};
type RestoreOrigin={planId:string;itemId:string;sha256:string};
type Head={restore?:true;device:string;epoch:string;writerId:string;plan:MailAssistantPlan;revision:number;itemIds:string[];running?:'apply'|'undo'|'acknowledge'|'continue';receipt?:MailAssistantApprovalReceipt;detail?:string};
type Item={restoreOrigin?:RestoreOrigin;applySteps?:TriageStep[];applyCursor?:number;applyGuard?:TriageChange;id:string;target:MailTriageTarget;before:TriageMessageState;change:TriageChange;original:TriageChange;outcome:MailTriageOutcome;undoSteps?:TriageStep[];undoCursor:number;undoGuard?:TriageChange;attempted?:TriageStep};
const headKey=(id:string)=>`mail:triage:head:${id}`,prepKey=(id:string)=>`mail:triage:prepare:${id}`,itemsKey=(id:string)=>`mail:triage:items:${id}:`,threadsKey=(id:string)=>`mail:triage:threads:${id}`;
const restoreHeadKey=(id:string)=>`mail:restore:head:${id}`,restoreClaimKey=(origin:RestoreOrigin)=>`mail:restore:source:${origin.planId}:${origin.itemId}`;
const originDigest=(head:Head,item:Item)=>triageHash({planId:head.plan.id,itemId:item.id,device:head.device,epoch:head.epoch,target:item.target,before:item.before,original:item.original,change:item.change,approvedAt:head.receipt?.approvedAt});
const lockKey=(target:MailTriageTarget,messageId:string)=>'mail:triage:lock:'+triageHash([target.accountId,target.generation,messageId]);
const reason=(error:unknown)=>error instanceof Fault||error instanceof ProviderError?error.message:'The provider result could not be confirmed. Check this saved review.';
const rejected=(error:unknown)=>error instanceof ProviderError&&(['permission','reconnect','not_found','throttled'].includes(error.code)||(error.responseStatus!==undefined&&error.responseStatus>=400&&error.responseStatus<500&&error.responseStatus!==408));

/** Original Dream Claw review construction, with encrypted E3 per-message
 * receipts. Restart and response loss never dispatch an action again. */
export class MailTriageService {
  private closed=false;
  private controller=new AbortController();
  private jobs=new Map<string,Promise<unknown>>();
  constructor(private store:Store,private accounts:Pick<Accounts,'state'|'mailOperation'>,private now:()=>number=Date.now,private changed?:(target:MailTriageTarget,unread?:boolean)=>Promise<unknown>) {
    for(const prep of store.internalList<Preparation>('mail:triage:prepare:'))if(prep.state==='preparing')store.internalWrite(prepKey(prep.id),{...prep,state:'failed',error:'Review preparation was interrupted. No mail was changed; select the conversations again.'});
    for(const head of [...store.internalList<Head>('mail:triage:head:'),...store.internalList<Head>('mail:restore:head:')])if(head.epoch===store.epoch&&head.running) {
      for(const item of this.items(head)) {
        if(item.outcome.state==='applying'){item.outcome.state=head.restore&&!item.attempted?'failed':'uncertain';item.outcome.detail=head.restore&&!item.attempted?'Restore stopped between confirmed steps. Continue the same saved Restore.':'The service restarted before this message result was confirmed.';}
        if(item.outcome.undo==='applying'){item.outcome.undo=item.attempted?'uncertain':'available';item.outcome.detail='Undo stopped during service restart. Check its recorded progress.';}
        if(item.outcome.state==='pending'){item.outcome.state='failed';item.outcome.detail='Not attempted before service restart.';}
        this.saveItem(head,item);
      }
      head.running=undefined;this.settle(head);
    }
  }
  private stamp(){return new Date(this.now()).toISOString();}
  private open(){if(this.closed)throw new Fault(503,'mail_triage_closed','Mail actions are restarting. Reopen the saved review.');}
  private epoch(epoch:string){if(epoch!==this.store.epoch)throw new Fault(409,'epoch_changed','Reopen Inbox after workspace recovery.');}
  private head(id:string){return this.store.internalRead<Head>(headKey(id))??this.store.internalRead<Head>(restoreHeadKey(id));}
  private items(head:Head){return head.itemIds.map(id=>{const item=this.store.internalRead<Item>(itemsKey(head.plan.id)+id);if(!item)throw new Fault(409,'mail_triage_missing','Part of this mail review is unavailable. No further action can run.');return item;});}
  private save(head:Head){head.revision++;this.store.internalWrite(head.restore?restoreHeadKey(head.plan.id):headKey(head.plan.id),head);}
  private saveItem(head:Head,item:Item) {
    const unresolved=!!(head.restore&&item.outcome.state==='failed'&&(item.applyCursor??0)>0)||item.outcome.state==='applying'||item.outcome.state==='uncertain'||item.outcome.state==='pending'||item.outcome.undo==='applying'||item.outcome.undo==='uncertain'||(!!head.running&&(item.outcome.state==='applied'||item.outcome.undo==='available'||item.outcome.undo==='undone'));
    const lock=lockKey(item.target,item.before.id);
    this.store.internalBatch([{id:itemsKey(head.plan.id)+item.id,value:item}],!unresolved&&this.store.internalRead<string>(lock)===head.plan.id?[lock]:[]);
  }
  private owned(device:string,epoch:string,id:string){this.open();this.epoch(epoch);const head=this.head(id);if(!head||head.device!==device||head.epoch!==epoch)throw new Fault(404,'mail_triage_missing','This mail review is unavailable in this workspace.');return head;}
  private account(target:MailTriageTarget,modify=true) {
    this.open();const account=this.accounts.state('').accounts.find(a=>a.id===target.accountId);
    if(!account||account.generation!==target.generation||(account.provider==='google'?'gmail':'microsoft')!==target.provider||!['connected','refreshing'].includes(account.state))throw new Fault(409,'account_changed','This mail connection changed. Reopen the original account before continuing.');
    if(!account.capabilities.mailRead||(modify&&!account.capabilities.mailModify))throw new Fault(403,'mail_permission_required','Organizing mail needs additional account permission. Open Account permissions in Settings.');
    return account;
  }
  private tracked<T>(id:string,run:()=>Promise<T>):Promise<T> {
    const active=this.jobs.get(id);if(active)return active as Promise<T>;
    const job=run();this.jobs.set(id,job);void job.finally(()=>{if(this.jobs.get(id)===job)this.jobs.delete(id);}).catch(()=>{});return job;
  }
  private view(head:Head):MailTriagePlan {
    const items=this.items(head),outcomes=items.map(item=>item.outcome),undoAlive=!!head.receipt&&Date.parse(head.receipt.undo.expiresAt??'')>this.now();
    const canUndo=!head.restore&&!head.running&&undoAlive&&outcomes.some(outcome=>outcome.undo==='available');
    const canContinue=!!head.restore&&!head.running&&items.some(item=>item.outcome.state==='failed'&&!item.attempted&&(item.applyCursor??0)<(item.applySteps?.length??0));
    return {...head.plan,epoch:head.epoch,writerId:head.writerId,revision:head.revision,accountLabels:Object.fromEntries(this.accounts.state('').accounts.map(a=>[a.id,a.email])),receipt:head.receipt,resultMessage:head.detail,outcomes,canCheck:!!head.running||outcomes.some(outcome=>outcome.state==='uncertain'||outcome.undo==='uncertain'),canUndo,canContinue};
  }
  /** Existing encrypted Delete receipts are provenance; a provider folder alone
   * never proves where externally deleted mail originated. Bound history work. */
  private restoreOrigins(device:string,targets:MailTriageTarget[]) {
    const heads=this.store.internalList<Head>('mail:triage:head:').filter(head=>head.device===device&&head.epoch===this.store.epoch&&head.plan.action==='delete'&&head.receipt);
    if(heads.length>1000)throw new Fault(409,'mail_restore_history_limit','There are too many saved reviews to safely resolve this Restore. No mail was changed.');
    const wanted=new Set(targets.map(triageHash)),found=new Map<string,{head:Head;item:Item;at:number}>();
    let count=0;
    for(const head of heads) {
      if(head.device!==device||head.epoch!==this.store.epoch||head.plan.action!=='delete'||!head.receipt)continue;
      const at=Date.parse(head.receipt.approvedAt);if(!Number.isFinite(at))continue;
      for(const item of this.items(head)) {
        if(!wanted.has(triageHash(item.target)))continue;
        if(++count>10000)throw new Fault(409,'mail_restore_history_limit','Select a smaller saved Restore history. No mail was changed.');
        const key=lockKey(item.target,item.before.id),prior=found.get(key);
        if(prior&&prior.at===at&&prior.head.plan.id!==head.plan.id)throw new Fault(409,'mail_restore_origin_ambiguous','Two saved Delete records have the same order. Their originals are preserved; no folder was guessed.');
        if(!prior||at>prior.at)found.set(key,{head,item,at});
      }
    }
    return found;
  }
  private restoreSource(head:Pick<Head,'restore'|'device'|'epoch'>&{plan:Pick<MailAssistantPlan,'id'>},item:Item,latest?:ReturnType<MailTriageService['restoreOrigins']>) {
    const origin=item.restoreOrigin;
    if(!head.restore||!origin)throw new Fault(409,'mail_restore_origin_missing','The original Delete record is unavailable. No folder was guessed.');
    const source=this.owned(head.device,head.epoch,origin.planId),saved=this.items(source).find(row=>row.id===origin.itemId);
    const newest=latest?.get(lockKey(item.target,item.before.id));
    if(source.plan.action!=='delete'||source.running||!saved||saved.outcome.state!=='applied'||saved.outcome.undo!=='available'||
      originDigest(source,saved)!==origin.sha256||triageHash(saved.target)!==triageHash(item.target)||saved.before.id!==item.before.id||
      (latest&&(!newest||newest.head.plan.id!==source.plan.id||newest.item.id!==saved.id)))
      throw new Fault(409,'mail_restore_origin_changed','The confirmed original Delete changed or was already undone. Open its saved review.');
    const claimed=this.store.internalRead<string>(restoreClaimKey(origin));
    if(claimed&&claimed!==head.plan.id) {
      const prior=this.head(claimed),row=prior&&this.items(prior).find(candidate=>candidate.restoreOrigin?.planId===origin.planId&&candidate.restoreOrigin.itemId===origin.itemId);
      if(!prior||prior.running||!row||row.outcome.state!=='failed'||row.attempted||(row.applyCursor??0)>0)
        throw new Fault(409,'mail_restore_original_pending','This Delete already has a Restore. Open that saved Restore; it will not be repeated.');
    }
    return saved;
  }
  read(device:string,raw:unknown){const input=mailTriageReadSchema.parse(raw);return this.view(this.owned(device,input.epoch,input.planId));}
  prepare(device:string,raw:unknown):Promise<MailTriagePlan> { return this.prepareSelection(device,raw); }
  /** Opening a rendered conversation authorizes only read status for its displayed
   * membership. Reuse the durable executor, provider checks and restart receipts. */
  async displayed(device:string,raw:unknown):Promise<{plan?:MailTriagePlan}> {
    const input=mailDisplayedSchema.parse(raw);
    const commandId=(part:string)=>{const hex=createHash('sha256').update(input.requestId+part).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};
    try {
      const plan=await this.prepareSelection(device,{epoch:input.epoch,requestId:input.requestId,writerId:commandId('writer'),action:'mark-read',targets:[input.target]},new Set(input.messageIds));
      if(plan.status!=='awaiting_confirmation')return {plan};
      return {plan:await this.confirm(device,{epoch:input.epoch,requestId:commandId('confirm'),planId:plan.id,expectedRevision:plan.revision,digest:plan.digest,decision:'apply'})};
    }catch(error){if(error instanceof Fault&&error.code==='mail_triage_no_change'){await this.refreshReadTarget(input.epoch,input.target);return {};}throw error;}
  }
  private async prepareSelection(device:string,raw:unknown,displayed?:Set<string>):Promise<MailTriagePlan> {
    this.open();const input=mailTriagePrepareSchema.parse(raw);this.epoch(input.epoch);
    const admitted=this.store.admit(device,input,{type:'mail-triage-prepare',...input,...(displayed?{displayed:[...displayed].sort()}: {})},()=>{
      const prep:Preparation={id:randomUUID(),device,input,state:'preparing'};this.store.internalWrite(prepKey(prep.id),prep);return {id:prep.id};
    });
    const id=admitted.value.id;
    if(!admitted.fresh) {
      if(this.jobs.has(id))return this.jobs.get(id) as Promise<MailTriagePlan>;
      const prep=this.store.internalRead<Preparation>(prepKey(id))!;
      if(prep.planId)return this.view(this.owned(device,input.epoch,prep.planId));
      throw new Fault(409,'mail_triage_prepare_failed',prep.error??'The original review is still preparing. Check it again.');
    }
    return this.tracked(id,async()=>{
      const prep=this.store.internalRead<Preparation>(prepKey(id))!;
      try {
        const targets=[...new Map(input.targets.map(target=>[triageHash(target),target])).values()],threads:TriageThreadState[]=[],items:Item[]=[],verified:MailAssistantTarget[]=[];
        const restore=input.action==='restore',origins=restore?this.restoreOrigins(device,targets):undefined;
        for(const target of targets) {
          const account=this.account(target);
          const {thread,resource}=await this.accounts.mailOperation(account.id,account.generation,['mailRead','mailModify'],this.controller.signal,async(current,request,check)=>{const thread=await readTriageThread(request,current,target),resource=await resolveTriageResource(request,current,restore?'delete':input.action,input.organization);check();this.epoch(input.epoch);return {thread,resource};});
          if(displayed&&[...displayed].some(id=>!thread.messages.some(message=>message.id===id)))throw new Fault(409,'mail_triage_source_changed','The displayed conversation changed. Reopen it to update its read status.');
          threads.push(thread);const change=restore?undefined:triageChange(account.provider,input.action,resource);
          const affected=thread.messages.filter(message=>(!displayed||displayed.has(message.id))&&!message.draft&&(restore?(account.provider==='google'?message.labels.includes('TRASH'):message.parentFolderId===resource):!matchesChange(message,change!)));
          const destinations=new Set<string>();
          for(const message of affected) {
            if(this.store.internalRead(lockKey(target,message.id)))throw new Fault(409,'mail_triage_pending','A selected message has an unresolved mail action. Open its saved review before changing it again.');
            const item:Item={id:randomUUID(),target,before:message,change:change??{},original:change?touchedState(message,change):{},undoCursor:0,outcome:{messageId:message.id,accountId:target.accountId,threadId:target.threadId,subject:message.subject,state:'pending'}};
            if(restore) {
              const source=origins!.get(lockKey(target,message.id));
              if(!source)throw new Fault(409,'mail_restore_origin_missing','A selected Trash message has no confirmed Delete in this workspace and device. Its original folder cannot be proved; no Inbox fallback was used.');
              item.restoreOrigin={planId:source.head.plan.id,itemId:source.item.id,sha256:originDigest(source.head,source.item)};
              item.change=structuredClone(source.item.original);item.original=touchedState(message,item.change);
              this.restoreSource({restore:true,device,epoch:input.epoch,plan:{id:''}},item,origins);
              const destination=await this.accounts.mailOperation(account.id,account.generation,['mailRead','mailModify'],this.controller.signal,async(current,request,check)=>{const name=await restoreDestination(request,current,item.change);check();this.epoch(input.epoch);return name;});
              destinations.add(destination);item.applySteps=triageSteps(account,message,item.change);item.applyCursor=0;
              item.outcome.completedSteps=0;item.outcome.totalSteps=item.applySteps.length;
            }
            items.push(item);
          }
          if(items.length>2000)throw new Fault(413,'mail_triage_too_large','Select fewer conversations for one mail review.');
          if(affected.length)verified.push({...target,subject:affected[0].subject,from:affected[0].from,date:affected[0].date,messageCount:affected.length,before:`${affected.length} message${affected.length===1?' needs':'s need'} this change`,after:restore?`Restore To ${[...destinations].join(' / ')}`:input.action==='delete'?'Moved to trash':input.action==='archive'?'Archived':input.action==='mark-read'?'Read':input.action==='mark-unread'?'Unread':input.action==='flag'?'Flagged':input.action==='unflag'?'Flag removed':`${input.action==='organize'?'Add':'Remove'} ${input.organization}`,stateFingerprint:thread.fingerprint});
        }
        this.open();this.epoch(input.epoch);for(const target of targets)this.account(target);
        if(!items.length)throw new Fault(409,'mail_triage_no_change','These messages already have the requested state, or are saved drafts. No mail was changed.');
        const original=new MailAssistantService({listIndexes:()=>[],applyTarget:async()=>{throw new Error('E3 owns durable execution.');},now:this.now});
        const result=await original.prepareVerifiedSelection(input,verified);
        if(!result.plan)throw new Fault(409,'mail_triage_prepare_failed',result.error??result.clarification??'The original review could not be prepared.');
        const plan=result.plan;
        plan.warning=restore?'Restore only the listed messages to the folders captured by their confirmed Nova Delete. This is a new reviewed operation; the original Undo deadline stays unchanged.':'Only the messages listed in this review will change. Saved drafts are excluded.';
        plan.digest=triageHash({originalDigest:plan.digest,epoch:input.epoch,writerId:input.writerId,threads,changes:items.map(item=>({id:item.before.id,change:item.change,...(item.restoreOrigin?{restoreOrigin:item.restoreOrigin}: {})}))});
        const head:Head={...(restore?{restore:true as const}:{}),device,epoch:input.epoch,writerId:input.writerId,plan,revision:1,itemIds:items.map(item=>item.id)};
        this.store.internalBatch([{id:restore?restoreHeadKey(plan.id):headKey(plan.id),value:head},{id:threadsKey(plan.id),value:threads},...items.map(item=>({id:itemsKey(plan.id)+item.id,value:item})),{id:prepKey(id),value:{...prep,state:'ready',planId:plan.id}}]);
        return this.view(head);
      }catch(error){this.store.internalWrite(prepKey(id),{...prep,state:'failed',error:reason(error)});throw error;}
    });
  }
  async confirm(device:string,raw:unknown):Promise<MailTriagePlan> {
    const input=mailTriageConfirmSchema.parse(raw),known=this.owned(device,input.epoch,input.planId);
    const expected=input.decision==='undo'?known.receipt?.undo.digest:known.plan.digest;
    if(input.digest!==expected)throw new Fault(409,'mail_triage_changed','This mail review changed. Open its current status.');
    const admission=this.store.admit(device,input,{type:'mail-triage-confirm',...input},()=>{
      const head=this.owned(device,input.epoch,input.planId),items=this.items(head);
      if(head.running||head.revision!==input.expectedRevision)throw new Fault(409,'mail_triage_changed','This mail review changed. Open its current status.');
      if(input.decision==='apply'||input.decision==='cancel') {
        if(head.plan.status!=='awaiting_confirmation')throw new Fault(409,'mail_triage_changed','This mail action already has a result. Open its current status.');
        if(input.decision==='apply'&&Date.parse(head.plan.expiresAt)<=this.now())throw new Fault(409,'mail_triage_expired','This review expired. Cancel it and select the current messages again.');
      }else if(input.decision==='continue'&&!this.view(head).canContinue)throw new Fault(409,'mail_restore_continue_unavailable','Only a proven stopped Restore step can continue. Check the original result.');
      else if(input.decision==='undo'&&!this.view(head).canUndo)throw new Fault(409,'mail_triage_undo_unavailable','No confirmed change is currently available to undo. Check the saved review.');
      else if(input.decision==='acknowledge'&&!items.some(item=>item.outcome.state==='uncertain'||item.outcome.undo==='uncertain'))throw new Fault(409,'mail_triage_changed','There are no uncertain results to acknowledge.');
      if(input.decision==='cancel'){head.plan.status='cancelled';head.detail='Cancelled before any mail was changed.';this.save(head);return {id:head.plan.id};}
      const selected=items.filter(item=>input.decision==='apply'||(input.decision==='undo'&&item.outcome.undo==='available')||(input.decision==='continue'&&item.outcome.state==='failed'&&!item.attempted));
      const origins=head.restore?this.restoreOrigins(device,selected.map(item=>item.target)):undefined;
      for(const item of selected) {
        this.account(item.target);if(head.restore)this.restoreSource(head,item,origins);const lock=this.store.internalRead<string>(lockKey(item.target,item.before.id));
        if(lock&&lock!==head.plan.id)throw new Fault(409,'mail_triage_pending','A message has another unresolved action. Check its saved review.');
      }
      for(const item of selected){this.store.internalWrite(lockKey(item.target,item.before.id),head.plan.id);if(head.restore){this.store.internalWrite(restoreClaimKey(item.restoreOrigin!),head.plan.id);if(input.decision==='continue'){item.outcome.state='pending';item.outcome.detail='Continuing the original proven stopped step.';this.store.internalWrite(itemsKey(head.plan.id)+item.id,item);}}}
      head.running=input.decision;head.plan.status='applying';head.detail=input.decision==='continue'?'Continuing the original Restore…':input.decision==='undo'?'Undoing the confirmed changes…':input.decision==='acknowledge'?'Reading the current state of uncertain messages…':'Applying the reviewed messages…';
      if(input.decision==='apply')head.receipt={id:head.plan.id,planId:head.plan.id,approvalDigest:head.plan.digest,action:head.plan.action,organization:head.plan.organization,decision:'approved',status:'applying',approvedAt:this.stamp(),scopes:head.plan.scopes,targetCount:head.plan.targetCount,messageCount:head.plan.messageCount,succeeded:0,failed:0,summary:head.plan.summary,undo:{status:'unsupported',...(head.restore?{reason:'Restore has its own saved result; the original Delete Undo deadline was not extended.'}:{digest:triageHash({plan:head.plan.digest,undo:true}),expiresAt:new Date(this.now()+15*60000).toISOString()})}};
      this.save(head);return {id:head.plan.id};
    });
    if(!admission.fresh)return this.view(this.head(known.plan.id)!);
    if(input.decision==='cancel')return this.view(this.head(known.plan.id)!);
    if(input.decision==='acknowledge')return this.tracked(known.plan.id,()=>this.inspect(known.plan.id,true));
    return this.tracked(known.plan.id,()=>this.execute(known.plan.id,input.decision==='undo'));
  }
  private settle(head:Head) {
    const outcomes=this.items(head).map(item=>item.outcome),receipt=head.receipt;
    if(!receipt)return;
    const applied=outcomes.filter(o=>o.state==='applied').length,observed=outcomes.filter(o=>o.state==='observed').length,failed=outcomes.filter(o=>o.state==='failed').length,uncertain=outcomes.filter(o=>o.state==='uncertain'||o.undo==='uncertain').length;
    const undoFailed=outcomes.filter(o=>o.undo==='failed').length,undoObserved=outcomes.filter(o=>o.undo==='observed').length;
    const undone=outcomes.filter(o=>o.undo==='undone').length,undoAvailable=outcomes.some(o=>o.undo==='available');
    head.running=undefined;for(const item of this.items(head))this.saveItem(head,item);head.plan.status=failed||uncertain||observed||undoFailed||undoObserved?'partial':'completed';
    receipt.succeeded=applied;receipt.failed=failed;receipt.completedAt??=this.stamp();
    receipt.status=undone===applied&&applied>0&&!uncertain?'undone':head.plan.status==='completed'?'completed':'partial';
    receipt.undo.status=head.restore?'unsupported':undoAvailable?(Date.parse(receipt.undo.expiresAt??'')>this.now()?'available':'expired'):uncertain||undoObserved||undoFailed?(undone?'partial':'failed'):undone?'completed':'unsupported';
    head.detail=head.restore?`${applied} restored · ${failed} stopped · ${outcomes.reduce((sum,item)=>sum+(item.completedSteps??0),0)} steps confirmed${uncertain?` · ${uncertain} uncertain`:''}${observed?` · ${observed} observed, not attributed`:''}.`:`${applied} confirmed changed · ${failed} not changed${uncertain?` · ${uncertain} uncertain`:''}${observed?` · ${observed} observed or acknowledged` :''}${undone?` · ${undone} undone`:''}${undoFailed?` · ${undoFailed} undo stopped`:''}${undoObserved?` · ${undoObserved} undo observed or acknowledged`:''}.`;
    this.save(head);
  }
  private async execute(id:string,undo:boolean):Promise<MailTriagePlan> {
    const head=this.head(id)!;const items=this.items(head);
    try {
      if(!undo&&head.running!=='continue') {
        for(const thread of this.store.internalRead<TriageThreadState[]>(threadsKey(id))??[]) {
          const account=this.account(thread.target);
          await this.accounts.mailOperation(account.id,account.generation,['mailRead','mailModify'],this.controller.signal,async(current,request,check)=>{const latest=await readTriageThread(request,current,thread.target);check();this.epoch(head.epoch);if(latest.fingerprint!==thread.fingerprint)throw new Fault(409,'mail_triage_source_changed','A conversation changed after review. No mail was changed; select its current messages again.');});
        }
      }
      let cursor=0;
      const worker=async()=>{while(cursor<items.length){const item=items[cursor++];if(undo?item.outcome.undo!=='available':item.outcome.state!=='pending')continue;await this.executeItem(head,item,undo);}};
      await Promise.all([worker(),worker(),worker()]);
    }catch(error){for(const item of this.items(head))if(item.outcome.state==='pending'){item.outcome.state='failed';item.outcome.detail=reason(error);this.saveItem(head,item);}}
    this.settle(head);await this.refresh(head);return this.view(head);
  }
  private async executeItem(head:Head,item:Item,undo:boolean) {
    try {
      const account=this.account(item.target);
      await this.accounts.mailOperation(account.id,account.generation,['mailRead','mailModify'],this.controller.signal,async(current,request,check)=>{
        let message=await readTriageMessage(request,current,item.before.id);check();this.epoch(head.epoch);
        if(message.draft||message.threadId!==item.before.threadId)throw new Fault(409,'mail_triage_source_changed','This message changed identity or became a draft. No further change was made.');
        if(head.restore&&!undo) {
          this.restoreSource(head,item);
          await restoreDestination(request,current,item.change);check();this.epoch(head.epoch);
          const steps=item.applySteps;
          if(!steps?.length)throw new Fault(409,'mail_restore_steps_missing','The original Restore steps are unavailable. No replacement was created.');
          const cursor=item.applyCursor??0;
          if(cursor===0?messageFingerprint(message)!==messageFingerprint(item.before):!item.applyGuard||!matchesChange(message,item.applyGuard))
            throw new Fault(409,'mail_restore_source_changed','The affected message changed after this Restore review. Its saved progress is preserved.');
          for(let i=cursor;i<steps.length;i++) {
            if(i>cursor){message=await readTriageMessage(request,current,item.before.id);check();this.epoch(head.epoch);
              if(message.draft||message.threadId!==item.before.threadId||!item.applyGuard||!matchesChange(message,item.applyGuard))
                throw new Fault(409,'mail_restore_source_changed','This message changed between confirmed Restore steps. Continue only its saved review.');}
            const step=steps[i];
            const returned=await applyTriageStep(request,current,message,step,()=>{
              check();this.store.assertUpdateAdmission();this.epoch(head.epoch);this.open();this.restoreSource(head,item);
              if(this.store.internalRead(lockKey(item.target,item.before.id))!==head.plan.id)throw new Fault(409,'mail_restore_owner_changed','The original Restore no longer owns this message.');
              item.outcome.state='applying';item.attempted=step;this.saveItem(head,item);
            });
            item.attempted=undefined;item.applyCursor=i+1;item.applyGuard=touchedState(returned,item.change);
            item.outcome.completedSteps=i+1;item.outcome.totalSteps=steps.length;
            item.outcome.state=i===steps.length-1?'applied':'applying';item.outcome.undo='unsupported';
            item.outcome.detail=i===steps.length-1?'Provider confirmed Restore to the captured original folder.':`Provider confirmed Restore step ${i+1} of ${steps.length}.`;
            this.saveItem(head,item);
          }
          return;
        }
        if(undo) {
          const expected=item.undoCursor?item.undoGuard:item.change;
          if(!expected||!matchesChange(message,expected))throw new Fault(409,'mail_triage_undo_changed','The affected mail state changed after this action. Undo stopped to preserve it.');
          if(!item.undoSteps)item.undoSteps=triageSteps(current,message,item.original);
        }else if(messageFingerprint(message)!==messageFingerprint(item.before))throw new Fault(409,'mail_triage_source_changed','This message changed after review and was not modified.');
        const steps=undo?item.undoSteps!:triageSteps(current,message,item.change);
        const start=undo?item.undoCursor:0;
        for(let i=start;i<steps.length;i++) {
          if(i>start){message=await readTriageMessage(request,current,item.before.id);check();if(item.undoGuard&&!matchesChange(message,item.undoGuard))throw new Fault(409,'mail_triage_undo_changed','This mail state changed between undo steps. Undo stopped to preserve it.');}
          let step=steps[i];
          // Category PATCH must merge the current unrelated categories, including
          // during a resumed undo. The conditional validator is the provider's.
          if(current.provider==='microsoft'&&step.expected.category)step=triageSteps(current,message,step.expected)[0];
          const returned=await applyTriageStep(request,current,message,step,()=>{
            check();this.store.assertUpdateAdmission();this.epoch(head.epoch);this.open();
            if(undo)item.outcome.undo='applying';else item.outcome.state='applying';
            item.attempted=step;this.saveItem(head,item);
          });
          item.attempted=undefined;if(undo){item.undoGuard=touchedState(returned,item.original);item.undoCursor=i+1;item.outcome.undo=i===steps.length-1?'undone':'available';}else{item.outcome.state='applied';item.outcome.undo='available';}
          item.outcome.detail=undo?'Provider confirmed this undo step.':'Provider confirmed the reviewed change.';this.saveItem(head,item);
        }
      });
    }catch(error) {
      const uncertain=!!item.attempted&&!rejected(error);
      if(undo)item.outcome.undo=uncertain?'uncertain':'failed';else item.outcome.state=uncertain?'uncertain':'failed';
      item.outcome.detail=reason(error);if(!uncertain)item.attempted=undefined;this.saveItem(head,item);
    }
  }
  async reconcile(device:string,raw:unknown):Promise<MailTriagePlan> {
    const input=mailTriageReadSchema.parse(raw),head=this.owned(device,input.epoch,input.planId);
    if(this.jobs.has(head.plan.id)||!this.items(head).some(item=>item.outcome.state==='uncertain'||item.outcome.undo==='uncertain'))return this.view(head);
    return this.tracked(head.plan.id,()=>this.inspect(head.plan.id,false));
  }
  private async inspect(id:string,acknowledge:boolean):Promise<MailTriagePlan> {
    const head=this.head(id)!;
    for(const item of this.items(head)) {
      const undo=item.outcome.undo==='uncertain';if(item.outcome.state!=='uncertain'&&!undo)continue;
      try {
        const account=this.account(item.target,false);
        await this.accounts.mailOperation(account.id,account.generation,['mailRead'],this.controller.signal,async(current,request,check)=>{
          const message=await readTriageMessage(request,current,item.before.id);check();this.epoch(head.epoch);
          if(message.threadId!==item.before.threadId||message.draft)throw new Fault(409,'mail_triage_source_changed','The original message identity could not be verified.');
          if(acknowledge) {
            if(undo)item.outcome.undo='observed';else item.outcome.state='observed';
            item.outcome.detail='Current provider state acknowledged. The uncertain action was not repeated and is not attributed to this review.';item.attempted=undefined;
          }else if(item.attempted&&matchesChange(message,item.attempted.expected)) {
            if(undo){item.outcome.undo='observed';}
            else{item.outcome.state='observed';item.outcome.undo='unsupported';}
            item.attempted=undefined;item.outcome.detail='Current provider state matches the reviewed step; its original response was lost. No request was repeated.';
          }else item.outcome.detail='The current provider state does not establish the uncertain result. Keep this review, or explicitly keep the current state.';
          this.saveItem(head,item);
        });
      }catch(error){item.outcome.detail=reason(error);this.saveItem(head,item);}
    }
    if(head.receipt)this.settle(head);else{head.running=undefined;this.save(head);}await this.refresh(head);return this.view(head);
  }
  private async refresh(head:Head){
    if(!this.changed||this.closed)return;
    const targets=[...new Map(this.items(head).filter(item=>['applied','observed','uncertain'].includes(item.outcome.state)||(head.restore&&(item.applyCursor??0)>0)).map(item=>[triageHash(item.target),item.target])).values()];
    await Promise.allSettled(targets.map(async target=>{
      if(['mark-read','mark-unread'].includes(head.plan.action)){
        await this.refreshReadTarget(head.epoch,target);return;
      }
      await this.changed!(target);
    }));
  }
  private async refreshReadTarget(epoch:string,target:MailTriageTarget){
    if(!this.changed||this.closed)return;
    const account=this.account(target,false);
    const unread=await this.accounts.mailOperation(account.id,account.generation,['mailRead'],this.controller.signal,async(current,request,check)=>{
      const thread=await readTriageThread(request,current,target);check();this.epoch(epoch);
      return thread.messages.some(message=>!message.draft&&!message.isRead);
    });
    await this.changed(target,unread);
  }
  async close(){this.closed=true;this.controller.abort();await Promise.allSettled([...this.jobs.values()]);}
}
