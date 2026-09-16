import {outlookFilePlan,applyOutlookFileChange,verifiedFileChange,type OutlookFileChange,type OutlookFileProgress} from './outlook-draft-files.js';
import {MailFiles} from './mail-files.js';
import {mailDeliveryMessageSchema} from '../../packages/domain/mail-delivery.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AccountCapabilities, ConnectedAccount } from '../../packages/domain/accounts.js';
import { canonical } from '../../packages/domain/contracts.js';
import { mailDeliveryPrepareSchema, mailDeliveryConfirmSchema, mailDeliveryReadSchema, mailDeliveryOpenSchema, type MailDeliveryMessage, type MailDeliveryReview, type MailDeliveryStage, type MailDraftSnapshot } from '../../packages/domain/mail-delivery.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { ProviderError } from './providers.js';
import { applyDeliveryStage, readDeliverySource, verifyDeliverySender, reconcileDelivery } from './provider-mail-delivery.js';
import { buildMailMime, mailAttachmentBytes, withMailQuote, removeDraftInlineImages, type MailReplySource } from './mail-mime.js';
import { readProviderDraft, verifyDraftAttachments } from './provider-mail-drafts.js';
import { readExistingProviderDraft, type MailDraftEnvelope } from './provider-mail-open.js';
import { mailDeliveryFileSchema, type MailDeliveryFile } from '../../packages/domain/mail-delivery.js';
import { imagePreviewType } from './image-preview.js';

type Head = { review: Omit<MailDeliveryReview,'message'>; device: string; intentFingerprint: string; attempted?: MailDeliveryStage; completed: MailDeliveryStage[]; files?:OutlookFileProgress };
type Content = { message:MailDeliveryMessage; rawMime?:string; source?:MailReplySource; draft?:MailDraftSnapshot; envelope?:MailDraftEnvelope; filePlan?:OutlookFileChange[] };
const key=(id:string)=>`mail:delivery:head:${id}`,contentKey=(id:string)=>`mail:delivery:content:${id}`;
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

/** Original draft/reply/send flows with immutable E3 review and effect receipts.
 * An uncertain write is inspectable, never automatically replayed. */
export class MailDeliveryService {
  private closed=false;
  private controller=new AbortController();
  private jobs=new Map<string,Promise<MailDeliveryReview>>();
  constructor(private store:Store,private accounts:Pick<Accounts,'state'|'mailOperation'>,private now:()=>number=Date.now) {
    for(const head of store.internalList<Head>('mail:delivery:head:')) {
      if(head.review.epoch!==store.epoch)continue;
      if(head.review.state==='preparing')this.write(head,{state:'failed',detail:'Review preparation was interrupted. Your writing is kept; prepare it again.'});
      if(head.review.state==='running')this.write(head,{state:head.attempted?'uncertain':'interrupted',detail:head.attempted?'The service restarted before this provider result was confirmed. Do not send again; check this operation.':'The operation stopped between confirmed stages. Your writing and provider draft are kept.'});
    }
  }
  private stamp(){return new Date(this.now()).toISOString();}
  private open(){if(this.closed)throw new Fault(503,'mail_delivery_closed','Mail delivery is restarting. Reopen the saved operation.');}
  private head(id:string){return this.store.internalRead<Head>(key(id));}
  private content(id:string){const content=this.store.internalRead<Content>(contentKey(id));if(!content)throw new Fault(409,'mail_delivery_content_missing','The saved message is unavailable. Do not resend from this operation.');return content;}
  private draftKey(accountId:string,draftId:string){return `mail:delivery:draft-owner:${hash({epoch:this.store.epoch,accountId,draftId})}`;}
  private draftOwner(accountId:string,draftId:string):Head|undefined {
    const kept=this.store.internalRead<{operationId:string}>(this.draftKey(accountId,draftId));
    let head=kept?this.head(kept.operationId):undefined;
    const seen=new Set<string>();
    while(head&&['failed','cancelled'].includes(head.review.state)&&head.review.previousOperationId&&!seen.has(head.review.id)) {
      seen.add(head.review.id);head=this.head(head.review.previousOperationId);
    }
    if(head)return head;
    // Existing saved operations predate the ownership index. Their most recent
    // live lineage remains authoritative when a draft is first reopened.
    const candidates=this.store.internalList<Head>('mail:delivery:head:').filter(item=>item.review.epoch===this.store.epoch&&item.review.accountId===accountId&&item.review.providerDraftId===draftId&&!['failed','cancelled'].includes(item.review.state));
    const tips=candidates.filter(item=>!candidates.some(child=>child.review.previousOperationId===item.review.id));
    return tips.sort((a,b)=>Number(!['saved','accepted'].includes(b.review.state))-Number(!['saved','accepted'].includes(a.review.state))||Date.parse(b.review.updatedAt)-Date.parse(a.review.updatedAt))[0];
  }
  private assertDraftOwner(head:Head) {
    if(!head.review.providerDraftId)return;
    const owner=this.draftOwner(head.review.accountId,head.review.providerDraftId);
    if(owner&&owner.review.id!==head.review.id&&owner.device===head.device&&owner.review.writerId===head.review.writerId)throw new Fault(409,'mail_delivery_pending','This writing already has a newer saved mail operation. Review its current status before continuing.',{operationId:owner.review.id,state:owner.review.state});
    if(owner&&owner.review.id!==head.review.id)throw new Fault(409,'mail_draft_open_elsewhere','Another message has opened this provider draft. Your writing is kept; return to that message or reopen Drafts.');
  }
  private rememberDraft(head:Head) {
    const draftId=head.review.providerDraftId;if(!draftId)return;
    const owner=this.draftOwner(head.review.accountId,draftId);
    if(!owner||owner.review.id===head.review.id)this.store.internalWrite(this.draftKey(head.review.accountId,draftId),{operationId:head.review.id});
  }
  private write(head:Head,patch:Partial<Head['review']>,extra:Partial<Head>={}) {
    const next={...head,...extra,review:{...head.review,...patch,revision:head.review.revision+1,updatedAt:this.stamp()}};
    this.store.internalWrite(key(next.review.id),next);return next;
  }
  private epoch(epoch:string){if(epoch!==this.store.epoch)throw new Fault(409,'epoch_changed','Reopen mail after workspace recovery.');}
  private owned(device:string,epoch:string,id:string){this.open();this.epoch(epoch);const head=this.head(id);if(!head||head.device!==device||head.review.epoch!==epoch)throw new Fault(404,'mail_delivery_missing','This saved mail operation is unavailable in this workspace.');return head;}
  private account(id:string,generation:string) {
    this.open();const account=this.accounts.state('').accounts.find(item=>item.id===id);
    if(!account||account.generation!==generation||!['connected','refreshing'].includes(account.state))throw new Fault(409,'account_changed','This mail connection changed. Your writing is kept; review the current account.');
    return account;
  }
  private permissions(account:ConnectedAccount,mode:'draft'|'send'):(keyof AccountCapabilities)[]{return ['mailRead',...(mode==='draft'?['mailDraft' as const]:[]),...(mode==='send'?['mailSend' as const]:[])];}
  private view(head:Head):MailDeliveryReview {
    const {message}=this.content(head.review.id);
    const owner=head.review.providerDraftId?this.draftOwner(head.review.accountId,head.review.providerDraftId):undefined;
    let prior=head;const seen=new Set<string>();
    while(['failed','cancelled'].includes(prior.review.state)&&prior.review.previousOperationId&&!seen.has(prior.review.id)) {
      seen.add(prior.review.id);const parent=this.head(prior.review.previousOperationId);if(!parent)break;prior=parent;
    }
    const returnedToOwnDraft=owner?.review.id===prior.review.id&&owner.device===head.device&&owner.review.writerId===head.review.writerId;
    const superseded=!!owner&&owner.review.id!==head.review.id&&!returnedToOwnDraft;
    const canEditDraft=!superseded&&!!head.review.providerDraftId&&(head.review.state==='saved'||(head.review.state==='interrupted'&&!head.attempted&&head.completed.includes('update-draft')));
    return {...head.review,canEditDraft,superseded,message:{...message,attachments:message.attachments.map(({base64:_bytes,...file})=>file)}};
  }
  read(device:string,raw:unknown){const input=mailDeliveryReadSchema.parse(raw);return this.view(this.owned(device,input.epoch,input.operationId));}
  readFile(device:string,raw:unknown):MailDeliveryFile {
    const input=mailDeliveryFileSchema.parse(raw),head=this.owned(device,input.epoch,input.operationId);
    const account=this.account(head.review.accountId,head.review.generation);
    if(!account.capabilities.mailRead)throw new Fault(403,'mail_permission_required','Connect mail reading before opening this file.');
    if(head.review.digest!==input.digest)throw new Fault(409,'mail_review_changed','Open this file from its original saved message.');
    const content=this.content(head.review.id),file=content.message.attachments[input.index];
    if(!file||file.sha256!==input.sha256)throw new Fault(404,'mail_file_missing','This file is not part of the selected saved message.');
    const [{buffer}]=mailAttachmentBytes({...content.message,attachments:[file]});
    const previewMimeType=imagePreviewType(buffer) as MailDeliveryFile['previewMimeType'];
    return {...input,file,...(previewMimeType?{previewMimeType}:{})};
  }
  private tracked(id:string,run:()=>Promise<MailDeliveryReview>) {
    const current=this.jobs.get(id);if(current)return current;
    const job=run();this.jobs.set(id,job);void job.finally(()=>{if(this.jobs.get(id)===job)this.jobs.delete(id);}).catch(()=>{});return job;
  }
  async openDraft(device:string,raw:unknown):Promise<MailDeliveryReview> {
    this.open();const input=mailDeliveryOpenSchema.parse(raw);this.epoch(input.epoch);
    const account=this.account(input.accountId,input.generation);
    if(!account.capabilities.mailRead)throw new Fault(403,'mail_permission_required','Connect mail reading before opening this draft.');
    const admission=this.store.admit(device,input,{type:'mail-delivery-open',...input},()=>{
      if(this.store.internalList<Head>('mail:delivery:head:').some(item=>item.device===device&&item.review.epoch===input.epoch&&item.review.writerId===input.writerId))throw new Fault(409,'mail_writer_used','Open the provider draft in a separate kept message.');
      const id=randomUUID(),createdAt=this.stamp();
      const head:Head={device,intentFingerprint:hash(input.source),completed:[],review:{id,epoch:input.epoch,accountId:account.id,generation:account.generation,writerId:input.writerId,provider:account.provider,accountEmail:account.email,mode:'draft',state:'preparing',revision:1,createdAt,updatedAt:createdAt,expiresAt:new Date(this.now()+30*60000).toISOString(),openedDraft:input.source}};
      this.store.internalWrite(key(id),head);this.store.internalWrite(contentKey(id),{message:{from:account.email,to:[],cc:[],bcc:[],subject:'',bodyText:'',attachments:[]}} satisfies Content);
      return {id};
    });
    const id=admission.value.id;
    if(!admission.fresh)return this.jobs.get(id)??this.view(this.owned(device,input.epoch,id));
    return this.tracked(id,async()=>{
      let head=this.head(id)!;
      try {
        const opened=await this.accounts.mailOperation(account.id,account.generation,['mailRead'],this.controller.signal,async(current,request,check)=>{
          const result=await readExistingProviderDraft(request,current,input.source);check();this.epoch(input.epoch);return result;
        });
        this.open();this.account(input.accountId,input.generation);this.epoch(input.epoch);
        const owner=this.draftOwner(account.id,opened.draft.id),marker=opened.envelope.operationId?this.head(opened.envelope.operationId):undefined;
        for(const pending of [owner,marker])if(pending&&pending.review.epoch===input.epoch&&pending.review.accountId===account.id&&!['saved','accepted','failed','cancelled'].includes(pending.review.state))throw new Fault(409,'mail_draft_pending','This draft has an unfinished mail operation. Check its original message before opening another editor.');
        const content:Content={message:opened.message,envelope:opened.envelope,draft:opened.draft};
        const digest=hash({id,epoch:input.epoch,accountId:account.id,generation:account.generation,writerId:input.writerId,content});
        head={...head,review:{...head.review,state:'saved',revision:2,updatedAt:this.stamp(),digest,providerDraftId:opened.draft.id,providerMessageId:opened.draft.messageId,providerChangeKey:opened.draft.changeKey,detail:'Opened the existing provider draft. Changes stay here until you review and save or send.'}};
        this.store.internalBatch([{id:key(id),value:head},{id:contentKey(id),value:content},{id:this.draftKey(account.id,opened.draft.id),value:{operationId:id}}]);
        return this.view(head);
      }catch(error){head=this.write(head,{state:'failed',detail:error instanceof Fault||error instanceof ProviderError?error.message:'The provider draft could not be opened completely. Your original draft and kept writing are unchanged.'});return this.view(head);}
    });
  }
  async prepare(device:string,raw:unknown):Promise<MailDeliveryReview> {
    this.open();const input=mailDeliveryPrepareSchema.parse(raw);this.epoch(input.epoch);
    const account=this.account(input.accountId,input.generation),permissions=this.permissions(account,input.mode);
    let previous:Head|undefined;
    if(input.previous) {
      previous=this.owned(device,input.epoch,input.previous.operationId);
      const editable=previous.review.state==='saved'||(previous.review.state==='interrupted'&&!previous.attempted&&previous.completed.includes('update-draft'));
      if(!editable||!previous.review.providerDraftId||previous.review.revision!==input.previous.expectedRevision||previous.review.digest!==input.previous.digest||previous.review.writerId!==input.writerId||previous.review.accountId!==account.id||previous.review.generation!==account.generation)throw new Fault(409,'mail_draft_changed','Open the current saved draft before editing it.',{operationId:previous.review.id,state:previous.review.state});
      const priorReply=this.content(previous.review.id).message.reply;
      if(priorReply?.threadId!==input.message.reply?.threadId||priorReply?.messageId!==input.message.reply?.messageId)throw new Fault(409,'mail_draft_source_changed','Keep this draft attached to its original conversation. Your writing is kept.');
      if(!permissions.includes('mailDraft'))permissions.push('mailDraft');
    }
    const priorContent=previous?this.content(previous.review.id):undefined;
    if(priorContent?.envelope&&!input.preserveDraft)throw new Fault(409,'mail_draft_content_required','Keep the opened draft’s formatting and files attached to this review.');
    if(input.files&&input.message.attachments.length)throw new Fault(400,'mail_file_selection','Review one exact attachment selection.');
    const selected=input.files?.map(ref=>{
      if(ref.kind==='upload')return new MailFiles(this.store).attachment(device,input.epoch,ref.id,ref.sha256);
      const source=this.owned(device,input.epoch,ref.operationId);
      if(!previous||source.review.writerId!==input.writerId||source.review.accountId!==account.id||source.review.generation!==account.generation)throw new Fault(409,'mail_file_source','Keep saved files with their original message and account.');
      let ancestor:Head|undefined=previous;const seen=new Set<string>();
      while(ancestor&&ancestor.review.id!==source.review.id&&!seen.has(ancestor.review.id)){seen.add(ancestor.review.id);ancestor=ancestor.review.previousOperationId?this.head(ancestor.review.previousOperationId):undefined;}
      if(!ancestor||ancestor.review.id!==source.review.id)throw new Fault(409,'mail_file_source','This file is not from the saved message’s original history.');
      return this.readFile(device,{epoch:input.epoch,operationId:ref.operationId,digest:ref.digest,index:ref.index,sha256:ref.sha256}).file;
    });
    const proposed:MailDeliveryMessage=mailDeliveryMessageSchema.parse({...input.message,...(input.preserveDraft?{
      attachments:priorContent!.message.attachments,
      ...(input.preserveDraft.body?{bodyText:priorContent!.message.bodyText,bodyHtml:priorContent!.message.bodyHtml}:{}),
    }:{}),...(selected?{attachments:selected}:{})});
    if(selected&&input.preserveDraft?.body&&priorContent){const removed=priorContent.message.attachments.filter(file=>file.cid&&!selected.some(item=>item.cid===file.cid)).map(file=>file.cid!);proposed.bodyHtml=removeDraftInlineImages(proposed.bodyHtml,removed);}
    if(permissions.some(permission=>!account.capabilities[permission]))throw new Fault(403,'mail_permission_required','This mail action needs additional account permission. Your writing is kept.');
    if(input.mode==='send'&&!proposed.to.length&&!proposed.cc.length&&!proposed.bcc.length)throw new Fault(400,'mail_recipient_required','Add a recipient before sending.');
    if(!proposed.subject.trim()&&!proposed.bodyText.trim()&&!proposed.bodyHtml?.trim()&&!proposed.attachments.length)throw new Fault(400,'mail_content_required','Add a subject or message before saving.');
    mailAttachmentBytes(proposed);
    if(account.provider==='microsoft' && !previous && (proposed.attachments.some(file=>file.bytes>=3*1024*1024)||Buffer.byteLength(JSON.stringify(proposed))>3500000))throw new Fault(413,'mail_upload_required','This Outlook message needs a large-attachment upload. That integration is not ready; your writing is kept and no provider draft was created.');
    const intentFingerprint=hash({accountId:input.accountId,generation:input.generation,mode:input.mode,message:proposed,preserveDraft:input.preserveDraft,...(input.previous?{previous:input.previous}:{} )});
    const admission=this.store.admit(device,input,{type:'mail-delivery-prepare',...input},()=>{
      const lineage=this.store.internalList<Head>('mail:delivery:head:').filter(item=>item.device===device&&item.review.epoch===input.epoch&&item.review.writerId===input.writerId&&!['failed','cancelled'].includes(item.review.state));
      const latest=lineage.find(item=>!lineage.some(child=>child.review.previousOperationId===item.review.id));
      if(latest&&latest.review.id!==previous?.review.id) {
        if(latest.intentFingerprint===intentFingerprint)return {id:latest.review.id,reused:true};
        throw new Fault(409,'mail_delivery_pending','This writing already has a saved mail operation. Review it before changing or sending again.',{operationId:latest.review.id,state:latest.review.state});
      }
      if(previous)this.assertDraftOwner(previous);
      const id=randomUUID(),createdAt=this.stamp();
      const head:Head={device,intentFingerprint,completed:[],review:{id,epoch:input.epoch,accountId:account.id,generation:account.generation,writerId:input.writerId,provider:account.provider,accountEmail:account.email,mode:input.mode,state:'preparing',revision:1,createdAt,updatedAt:createdAt,expiresAt:new Date(this.now()+30*60000).toISOString(),...(previous?{previousOperationId:previous.review.id,providerDraftId:previous.review.providerDraftId,providerMessageId:previous.review.providerMessageId,providerChangeKey:previous.review.providerChangeKey,openedDraft:previous.review.openedDraft}:{})}};
      this.store.internalWrite(key(id),head);this.store.internalWrite(contentKey(id),{message:proposed,envelope:priorContent?.envelope} satisfies Content);if(previous)this.store.internalWrite(this.draftKey(account.id,previous.review.providerDraftId!),{operationId:id});return {id,reused:false};
    });
    const id=admission.value.id;
    if(!admission.fresh||admission.value.reused)return this.jobs.get(id)??this.view(this.owned(device,input.epoch,id));
    return this.tracked(id,async()=>{
      let head=this.head(id)!;
      try {
        const content=await this.accounts.mailOperation(account.id,account.generation,permissions,this.controller.signal,async(current,request,check)=>{
          await verifyDeliverySender(request,current,proposed.from);check();this.epoch(input.epoch);
          const source=proposed.reply?await readDeliverySource(request,current,proposed.reply):undefined;check();
          const subject=(value:string)=>value.trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i,'').toLowerCase();
          if(current.provider==='google'&&((source&&subject(proposed.subject)!==subject(source.subject))||(priorContent?.envelope?.inReplyTo&&subject(proposed.subject)!==subject(priorContent.envelope.subject))))throw new Fault(409,'mail_reply_subject_changed','To keep this reply in its original Gmail conversation, restore that conversation’s subject. Your writing is kept.');
          const message=withMailQuote(proposed,source);
          const draft=previous?await readProviderDraft(request,current,previous.review.providerDraftId!):undefined;check();
          if(draft&&current.provider==='microsoft'&&!input.files)verifyDraftAttachments(draft,message);
          const filePlan=draft&&current.provider==='microsoft'&&input.files?outlookFilePlan(draft,message):undefined;
          if(message.bodyText.length>1000000||(message.bodyHtml?.length??0)>2000000)throw new Fault(413,'mail_quote_too_large','The verified reply quote is too large. Review the message without the quote.');
          if(current.provider==='microsoft'&&!previous&&Buffer.byteLength(JSON.stringify(message))>3500000)throw new Fault(413,'mail_upload_required','The quoted Outlook message exceeds the current upload limit. Your writing is kept.');
          const rawMime=current.provider==='microsoft'&&previous?undefined:(await buildMailMime(message,id,head.review.createdAt,source,priorContent?.envelope)).toString('base64url');
          if(current.provider==='microsoft'&&!previous&&rawMime&&(input.mode==='send'||(message.reply&&message.attachments.length))&&Buffer.byteLength(Buffer.from(rawMime,'base64url').toString('base64'))>4*1024*1024)throw new Fault(413,'mail_upload_required','This Outlook message needs a large-attachment upload. Your writing is kept; no mail was changed.');
          check();this.epoch(input.epoch);
          return {message,rawMime,source,draft,envelope:priorContent?.envelope,filePlan} satisfies Content;
        });
        this.open();this.account(input.accountId,input.generation);this.epoch(input.epoch);
        const source=content.source&&{messageId:content.source.messageId,threadId:content.source.threadId,subject:content.source.subject,from:content.source.from,fingerprint:content.source.fingerprint};
        const digest=hash({id,epoch:input.epoch,accountId:account.id,generation:account.generation,mode:input.mode,writerId:input.writerId,content});
        const draft=content.draft&&{...content.draft,changed:account.provider==='google'?content.draft.messageId!==previous?.review.providerMessageId:content.draft.changeKey!==previous?.review.providerChangeKey};
        this.store.internalBatch([{id:contentKey(id),value:content},{id:key(id),value:{...head,review:{...head.review,state:'prepared',revision:head.review.revision+1,digest,source,draft,updatedAt:this.stamp()}}}]);
        return this.view(this.head(id)!);
      } catch(error) {
        head=this.write(head,{state:'failed',detail:error instanceof Fault||error instanceof ProviderError?error.message:'The mail review could not be prepared. Your writing is kept.'});return this.view(head);
      }
    });
  }
  async confirm(device:string,raw:unknown):Promise<MailDeliveryReview> {
    const input=mailDeliveryConfirmSchema.parse(raw);const known=this.owned(device,input.epoch,input.operationId);
    if(known.review.digest!==input.digest)throw new Fault(409,'mail_review_changed','This saved mail review changed. Open its current status.');
    if(this.jobs.has(known.review.id)) {
      if(input.decision==='cancel')throw new Fault(409,'mail_delivery_active','This provider operation has already started. Open its current status.');
      return this.jobs.get(known.review.id)!;
    }
    const admission=this.store.admit(device,input,{type:'mail-delivery-confirm',...input},()=>{
      const head=this.owned(device,input.epoch,input.operationId);
      if(head.review.digest!==input.digest||head.review.revision!==input.expectedRevision||!['prepared','interrupted'].includes(head.review.state))throw new Fault(409,'mail_review_changed','This saved mail review changed. Open its current status before continuing.');
      if(input.decision==='confirm')this.assertDraftOwner(head);
      if(input.decision==='confirm'&&Date.parse(head.review.expiresAt)<=this.now())throw new Fault(409,'mail_review_expired','This mail review expired. Your writing is kept; cancel this review before preparing it again.');
      this.write(head,{state:input.decision==='cancel'?'cancelled':'running',detail:input.decision==='cancel'?((head.completed.length||(head.files?.cursor??0)>0)?'Stopped. The existing provider draft and your writing are kept.':'Cancelled before any provider change.'):undefined});return {id:head.review.id};
    });
    if(!admission.fresh)return this.jobs.get(known.review.id)??this.view(this.head(known.review.id)!);
    if(input.decision==='cancel')return this.view(this.head(known.review.id)!);
    return this.tracked(known.review.id,()=>this.execute(known.review.id));
  }
  private async execute(id:string):Promise<MailDeliveryReview> {
    let head=this.head(id)!;const content=this.content(id);
    try {
      const account=this.account(head.review.accountId,head.review.generation),permissions=this.permissions(account,head.review.mode);
      if(head.review.previousOperationId&&!permissions.includes('mailDraft'))permissions.push('mailDraft');
      const stages:MailDeliveryStage[]=head.review.previousOperationId
        ?account.provider==='google'?[head.review.mode==='send'?'send-draft':'update-draft']:[...(content.filePlan?.length?['update-files' as const]:[]),'update-draft',...(head.review.mode==='send'?['send-draft' as const]:[])]
        :head.review.mode==='send'?['send']:account.provider==='google'?['create']:content.message.reply?['create-reply',...(content.message.attachments.length?[]:['update-reply' as const])]:['create'];
      await this.accounts.mailOperation(account.id,account.generation,permissions,this.controller.signal,async(current,request,check)=>{
        await verifyDeliverySender(request,current,content.message.from);check();this.epoch(head.review.epoch);
        if(content.message.reply) {
          const source=await readDeliverySource(request,current,content.message.reply);check();
          if(source.fingerprint!==content.source?.fingerprint)throw new Fault(409,'mail_source_changed','The original reply source changed after review. Your writing is kept; prepare a current review.');
        }
        for(const phase of stages.filter(stage=>!head.completed.includes(stage))) {
          if(phase==='update-files'){
            if(!head.files){head={...head,files:{cursor:0,draft:content.draft!}};this.store.internalWrite(key(id),head);}
            while(head.files!.cursor<content.filePlan!.length){
              const progress=head.files!,change=content.filePlan![progress.cursor];
              const after=await applyOutlookFileChange(request,current,progress.draft,change,content.message,()=>{this.open();check();this.epoch(head.review.epoch);this.assertDraftOwner(head);head=this.write(head,{phase},{attempted:phase,files:{...progress,pending:true}});});
              head=this.write(head,{providerChangeKey:after.changeKey},{attempted:undefined,files:{cursor:progress.cursor+1,draft:after}});
            }
            head=this.write(head,{}, {completed:[...head.completed,phase]});continue;
          }

          const before=()=>{this.open();check();this.epoch(head.review.epoch);this.assertDraftOwner(head);head=this.write(head,{phase},{attempted:phase});};
          const result=await applyDeliveryStage(request,current,{id,mode:head.review.mode,message:content.message,rawMime:content.rawMime!,phase,providerDraftId:head.review.providerDraftId,providerChangeKey:head.review.providerChangeKey,draft:head.files?.draft??content.draft,envelope:content.envelope},before);
          // Capture affirmative provider evidence even if the account disconnected
          // or shutdown began while that exact HTTP call was in flight.
          head=this.write(head,{providerDraftId:result.draftId??head.review.providerDraftId,providerMessageId:result.messageId??head.review.providerMessageId,providerChangeKey:result.changeKey??head.review.providerChangeKey},{attempted:undefined,completed:[...head.completed,phase]});
          this.rememberDraft(head);
        }
      });
      head=this.write(head,{state:head.review.mode==='send'?'accepted':'saved',detail:head.review.mode==='send'?'The provider accepted this message for sending. Delivery to recipients is not confirmed.':'The provider confirmed saving this draft.'});
    } catch(error) {
      head=this.head(id)??head;
      const knownRejection=error instanceof ProviderError&&(['permission','reconnect','not_found','throttled'].includes(error.code)||(error.responseStatus!==undefined&&error.responseStatus>=400&&error.responseStatus<500&&error.responseStatus!==408));
      const uncertain=!!head.attempted&&!knownRejection;
      const interrupted=!uncertain&&(head.completed.length>0||(head.files?.cursor??0)>0);
      head=this.write(head,{state:uncertain?'uncertain':interrupted?'interrupted':'failed',detail:uncertain?'The provider result is not confirmed. Your writing is kept. Check this operation before trying again.':error instanceof Fault||error instanceof ProviderError?error.message:interrupted?'The operation stopped between confirmed stages. Your provider draft and writing are kept.':'The operation stopped before a provider change was confirmed. Your writing is kept.'},{attempted:knownRejection?undefined:head.attempted,...(knownRejection&&head.files?{files:{...head.files,pending:false}}:{})});
    }
    return this.view(head);
  }
  async reconcile(device:string,raw:unknown):Promise<MailDeliveryReview> {
    const input=mailDeliveryReadSchema.parse(raw),known=this.owned(device,input.epoch,input.operationId);
    if(this.jobs.has(known.review.id))return this.jobs.get(known.review.id)!;
    if(!['uncertain','interrupted'].includes(known.review.state))return this.view(known);
    return this.tracked(known.review.id,async()=>{
      let head=this.head(known.review.id)!;
      try {
        const content=this.content(head.review.id),account=this.account(head.review.accountId,head.review.generation);
        if(head.files&&content.filePlan&&head.attempted==='update-files'){
          const progress=head.files,change=content.filePlan[progress.cursor];
          const after=await this.accounts.mailOperation(account.id,account.generation,['mailRead'],this.controller.signal,async(current,request,check)=>{const result=await readProviderDraft(request,current,progress.draft.id);check();this.epoch(input.epoch);return result;});
          this.open();this.account(account.id,account.generation);this.epoch(input.epoch);
          if(change&&verifiedFileChange(progress.draft,after,change,content.message)){
            const cursor=progress.cursor+1,completed=cursor===content.filePlan.length?[...head.completed,'update-files' as const]:head.completed;
            head=this.write(head,{state:'interrupted',expiresAt:new Date(this.now()+30*60000).toISOString(),providerChangeKey:after.changeKey,detail:'Outlook confirms the file change. Review and continue the remaining draft steps.'},{attempted:undefined,files:{cursor,draft:after},completed});
          }else head=this.write(head,{detail:'The exact Outlook file change is still unconfirmed. Your files and writing are kept; no file was added or removed again.'});
          return this.view(head);
        }

        const evidence=await this.accounts.mailOperation(account.id,account.generation,['mailRead'],this.controller.signal,async(current,request,check)=>{
          const result=await reconcileDelivery(request,current,{id:head.review.id,mode:head.review.mode,message:content.message,attempted:head.attempted,completed:head.completed,providerDraftId:head.review.providerDraftId,providerChangeKey:head.review.providerChangeKey,previousOperationId:head.review.previousOperationId,rawMime:content.rawMime,createdAt:head.review.createdAt});check();this.epoch(input.epoch);return result;
        });
        this.open();this.account(head.review.accountId,head.review.generation);this.epoch(input.epoch);
        if(evidence.outcome&&evidence.result)head=this.write(head,{state:evidence.outcome,...(evidence.outcome==='interrupted'?{expiresAt:new Date(this.now()+30*60000).toISOString()}:{}),detail:evidence.detail,providerDraftId:evidence.result.draftId??head.review.providerDraftId,providerMessageId:evidence.result.messageId??head.review.providerMessageId,providerChangeKey:evidence.result.changeKey??head.review.providerChangeKey},{attempted:undefined,completed:evidence.completed??head.completed});
        else head=this.write(head,{detail:evidence.detail});
        this.rememberDraft(head);
      }catch(error){head=this.write(head,{detail:error instanceof Fault||error instanceof ProviderError?error.message:'The provider check could not complete. Your writing is kept; no message was sent again.'});}
      return this.view(head);
    });
  }
  async close(){this.closed=true;this.controller.abort();await Promise.allSettled([...this.jobs.values()]);}
}
