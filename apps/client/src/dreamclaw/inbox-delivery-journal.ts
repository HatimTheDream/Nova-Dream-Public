import { createStore } from 'zustand/vanilla';
import type { z } from 'zod';
import type { mailDeliveryConfirmSchema, mailDeliveryPrepareSchema, mailDeliveryOpenSchema, MailDeliveryReview } from '../../../../packages/domain/mail-delivery';
import { ApiError, readLocal, request, saveLocal } from '../api';

type Prepare = z.infer<typeof mailDeliveryPrepareSchema>;
type Confirm = z.infer<typeof mailDeliveryConfirmSchema>;
type Open = z.infer<typeof mailDeliveryOpenSchema>;
export type InboxDeliveryInput = Omit<Prepare, 'requestId' | 'writerId' | 'previous'>;
export type InboxDraftOpenInput = Omit<Open,'requestId'|'writerId'> & {accountEmail:string};
export type InboxDeliveryRecord = {
  prepare: Prepare;
  review?: MailDeliveryReview;
  confirmation?: Confirm;
  pending?: 'prepare' | 'confirm' | 'open';
  opening?:Open;
  error?: string;
  editing?:boolean;
  base?:{prepare:Prepare;review:MailDeliveryReview};
};
type Transport = (action: 'prepare' | 'read' | 'confirm' | 'reconcile' | 'open', input: unknown) => Promise<MailDeliveryReview>;
type Records = Record<string, InboxDeliveryRecord>;
type Persistence = { read(key: string): Records | undefined; write(key: string, records: Records): boolean };
type State = { records: Records; storageError: boolean; busy: Record<string, boolean> };
const persistence: Persistence = { read: readLocal, write: saveLocal };
const transport: Transport = (action, input) => request(`mail/delivery/${action}`, input, undefined, 35000);

/** The original composer owns its text. This separate journal owns each exact
 * provider operation, so navigation or response loss cannot turn Retry into Send. */
export function createInboxDeliveryJournal(
  scope: { epoch: string; deviceId: string; windowId: string; previousWindowId?: string },
  send: Transport = transport,
  disk: Persistence = persistence,
) {
  const keyFor = (windowId: string) => `e3:inbox-delivery:${scope.epoch}:${scope.deviceId}:${windowId}`;
  const key = keyFor(scope.windowId), kept = disk.read(key);
  const copied = !kept && scope.previousWindowId ? disk.read(keyFor(scope.previousWindowId)) : undefined;
  // Clone operation identities too. Copying only text could allow an uncertain
  // send to be repeated from what looks like a fresh composer.
  const initial = structuredClone(kept ?? copied ?? {});
  const store = createStore<State>(() => ({ records: initial, storageError: !!copied && !disk.write(key, initial), busy: {} }));
  const jobs = new Map<string, Promise<InboxDeliveryRecord>>();
  function retain(source: string, record: InboxDeliveryRecord) {
    const records = { ...store.getState().records, [source]: structuredClone(record) };
    const saved = disk.write(key, records);
    store.setState({ records, storageError: !saved });
    return saved;
  }
  function durable(source: string, record: InboxDeliveryRecord) {
    if (!retain(source, record)) throw new Error('The mail operation could not be kept on this device. Free browser storage before continuing. Your writing is kept; no new provider request was started.');
  }
  function current(source: string) {
    const record = store.getState().records[source];
    if (!record) throw new Error('Open the original message before checking this operation.');
    if (record.prepare.epoch !== scope.epoch) throw new Error('This operation belongs to an earlier workspace. Your writing is kept.');
    return record;
  }
  function validate(record: InboxDeliveryRecord, review: MailDeliveryReview) {
    const expected = record.prepare;
    if (review.epoch !== scope.epoch || review.writerId !== expected.writerId || review.accountId !== expected.accountId || review.generation !== expected.generation || review.mode !== expected.mode || (record.review && review.id !== record.review.id)) {
      throw new Error('The returned mail operation belongs to a different message or account. Keep the original operation for recovery.');
    }
    if (record.review && review.revision < record.review.revision) throw new Error('The returned mail status is older than the saved operation. Check its current status again.');
    if(record.opening&&(review.openedDraft?.messageId!==record.opening.source.messageId||review.openedDraft?.threadId!==record.opening.source.threadId))throw new Error('The returned draft belongs to a different provider message. Your current writing is kept.');
  }
  function tracked(source: string, run: () => Promise<InboxDeliveryRecord>) {
    const active = jobs.get(source); if (active) return active;
    store.setState(state => ({ busy: { ...state.busy, [source]: true } }));
    const job = run().catch(error => {
      const record = store.getState().records[source];
      if (record) retain(source, { ...record, error: error instanceof Error ? error.message : 'Mail status is unavailable. Keep the original operation and check again.' });
      throw error;
    }).finally(() => {
      jobs.delete(source); store.setState(state => ({ busy: { ...state.busy, [source]: false } }));
    });
    jobs.set(source, job); return job;
  }
  async function dispatch(source: string, action: Parameters<Transport>[0], payload: unknown) {
    const record = current(source);
    let review:MailDeliveryReview;
    try { review = await send(action, payload); }
    catch(error) {
      const operationId=error instanceof ApiError&&['mail_delivery_pending','mail_draft_changed'].includes(error.code)?(error.current as unknown as {operationId?:string})?.operationId:undefined;
      if(action!=='prepare'||!operationId||!record.prepare.previous)throw error;
      const latest=await send('read',{epoch:scope.epoch,operationId});
      const expected=record.prepare;
      if(latest.epoch!==scope.epoch||latest.writerId!==expected.writerId||latest.accountId!==expected.accountId||latest.generation!==expected.generation||latest.id!==operationId)throw new Error('The newer mail operation belongs to a different message or account. Your writing is kept.');
      const next={...record,prepare:{...record.prepare,mode:latest.mode},review:latest,pending:undefined,confirmation:undefined,error:'Another window has a newer mail operation. Its current status is shown; your writing is kept.'};
      retain(source,next);return next;
    }
    validate(record, review);
    const terminal = ['saved', 'accepted', 'failed', 'cancelled'].includes(review.state);
    // An ordinary read of Prepared does not prove a timed-out confirmation was
    // never admitted. Retain its original request until it is settled or retried.
    const settled = action === 'confirm' || terminal;
    const next: InboxDeliveryRecord = { ...record, review, error: undefined,
      pending: settled || action === 'prepare' || action === 'open' ? undefined : record.pending,
      confirmation: settled ? undefined : record.confirmation,
      ...(action==='open'&&review.state==='saved'?{editing:true,prepare:{...record.prepare,message:{...review.message,attachments:[]}}}:{}),
    };
    retain(source, next); return next;
  }
  function retry(source: string) {
    return tracked(source, async () => {
      const record = current(source); durable(source, { ...record, error: undefined });
      if(record.opening&&(record.pending==='open'||!record.review))return dispatch(source,'open',record.opening);
      if (record.pending === 'confirm' && record.confirmation) return dispatch(source, 'confirm', record.confirmation);
      if (!record.review || record.pending === 'prepare') return dispatch(source, 'prepare', record.prepare);
      return dispatch(source, 'read', { epoch: scope.epoch, operationId: record.review.id });
    });
  }
  function openDraft(source:string,input:InboxDraftOpenInput) {
    if(input.epoch!==scope.epoch)return Promise.reject(new Error('Reopen Inbox after workspace recovery.'));
    if(store.getState().records[source])return retry(source);
    return tracked(source,async()=>{
      const {accountEmail,...identity}=input;
      const opening:Open={...identity,requestId:crypto.randomUUID(),writerId:crypto.randomUUID()};
      const record:InboxDeliveryRecord={opening,pending:'open',prepare:{epoch:input.epoch,requestId:opening.requestId,writerId:opening.writerId,accountId:input.accountId,generation:input.generation,mode:'draft',message:{from:accountEmail,to:[],cc:[],bcc:[],subject:'',bodyText:'',attachments:[]}}};
      durable(source,record);return dispatch(source,'open',opening);
    });
  }
  function prepare(source: string, input: InboxDeliveryInput) {
    if (input.epoch !== scope.epoch) return Promise.reject(new Error('Reopen Inbox after workspace recovery.'));
    const prior=store.getState().records[source];
    if (prior&&!prior.editing) return retry(source);
    return tracked(source, async () => {
      if(prior&&(!prior.review?.digest||prior.prepare.accountId!==input.accountId||prior.prepare.generation!==input.generation))throw new Error('Keep this saved draft with its original account. Your writing is kept.');
      const previous=prior?{operationId:prior.review!.id,expectedRevision:prior.review!.revision,digest:prior.review!.digest!}:undefined;
      const record: InboxDeliveryRecord = { prepare: { ...structuredClone(input), requestId: crypto.randomUUID(), writerId: prior?.prepare.writerId??crypto.randomUUID(),...(previous?{previous}:{}) }, pending: 'prepare',...(prior?{base:{prepare:prior.prepare,review:prior.review!}}:{}) };
      durable(source, record); return dispatch(source, 'prepare', record.prepare);
    });
  }
  function editSaved(source:string) {
    return tracked(source,async()=>{
      const record=current(source);
      if(record.pending||!record.review)throw new Error('Reconcile the original request before editing the saved draft.');
      const fresh=await dispatch(source,'read',{epoch:scope.epoch,operationId:record.review.id});
      if(fresh.review?.superseded)throw new Error('Another message has opened this draft. Your writing is kept; return to that message or reopen Drafts.');
      if(fresh.review?.state!=='saved'&&!fresh.review?.canEditDraft)throw new Error('The saved draft is not ready to edit. Check this operation first.');
      const next={...fresh,editing:true};durable(source,next);return next;
    });
  }
  function confirm(source: string, expected: { id: string; revision: number; digest: string }, decision: Confirm['decision']) {
    return tracked(source, async () => {
      const record = current(source), review = record.review;
      if (!review || review.id !== expected.id || review.revision !== expected.revision || review.digest !== expected.digest) throw new Error('The mail review changed. Open its current status before continuing.');
      if (record.pending) throw new Error('Check or retry the original request before starting another action.');
      if (!['prepared', 'interrupted'].includes(review.state)) throw new Error('This mail operation cannot be confirmed again. Open its current status.');
      const confirmation: Confirm = { epoch: scope.epoch, requestId: crypto.randomUUID(), operationId: review.id, expectedRevision: review.revision, digest: expected.digest, decision };
      durable(source, { ...record, confirmation, pending: 'confirm', error: undefined });
      return dispatch(source, 'confirm', confirmation);
    });
  }
  function check(source: string) {
    return tracked(source, async () => {
      const record = current(source);
      if (!record.review) throw new Error('Retry the original review request to recover its saved status.');
      const action = ['uncertain', 'interrupted'].includes(record.review.state) ? 'reconcile' : 'read';
      return dispatch(source, action, { epoch: scope.epoch, operationId: record.review.id });
    });
  }
  /** Only an explicit UI action may retire a settled operation. Text is owned
   * separately and must not be cleared by an asynchronous provider response. */
  function release(source: string, expectedId: string) {
    if (jobs.has(source)) throw new Error('Wait for this mail status check before starting another message.');
    const record = current(source);
    if (record.pending || record.review?.id !== expectedId || !['accepted', 'failed', 'cancelled'].includes(record.review.state)) throw new Error('Keep this operation until its result is settled. A saved provider draft must be updated through its original operation.');
    const records = { ...store.getState().records };
    if(record.base&&record.review?.state!=='accepted')records[source]={...record.base,editing:true};else delete records[source];
    if (!disk.write(key, records)) { store.setState({ storageError: true }); throw new Error('The new-message state could not be kept. Free browser storage first.'); }
    store.setState({ records, storageError: false });
  }
  function discardPreparation(source: string) {
    if (jobs.has(source)) throw new Error('Wait for the review request to settle first.');
    const record = current(source);
    if (record.review || record.confirmation) throw new Error('Open this saved operation before changing it.');
    // Prepare cannot mutate provider mail, including when its response is lost.
    // No confirmation has ever been issued from a record without a review.
    const records = { ...store.getState().records }; if(record.base)records[source]={...record.base,editing:true};else delete records[source];
    if (!disk.write(key, records)) { store.setState({ storageError: true }); throw new Error('The review state could not be kept. Free browser storage first.'); }
    store.setState({ records, storageError: false });
  }
  return { store, prepare, retry, confirm, check, release, discardPreparation, editSaved, openDraft };
}
export type InboxDeliveryJournal = ReturnType<typeof createInboxDeliveryJournal>;
