import {taskRelationCatalogueKey,bootstrapTaskCatalogue,verifyImportedTaskCatalogue,verifyRestoredTaskSemantics,type TaskCatalogueCustody} from './task-relation-catalogue.js';
import {ProducerWork,producerKey,producerSlotBytes,producerReceiptBytes,producerReceiptSchema,producerReadSchema,producerReconcileSchema,type ProducerTransition} from './feed-automatic-producer-state.js';
import {producerFacts,producerCurrentFacts,producerMemoReader,ProducerProof,type ProducerCurrentFacts} from './feed-automatic-producer-store.js';
import {withActualProducerCompletionContext,type ProducerCompletionPorts} from './feed-history-completion-reader.js';
import {completionFixtureLimits} from './feed-completion-contract.js';
import {ProjectedCapacityTransaction} from './feed-projected-capacity.js';
import {DraftCapacityContext} from './feed-draft-capacity.js';
import {TaskCapacityPlanner,type TaskServiceChange} from './feed-task-capacity.js';
import {TaskFocusCapacityPlanner,focusStartupHeld} from './feed-task-focus-capacity.js';
import {projectedCapacityPolicySchema,type ProjectedCapacityPolicy} from './feed-projected-capacity-policy.js';
import {HistoryRemovalContext,historyRemovalLimitsSchema,historyRemovalCompositionLimits,type HistoryRemovalLimits,type RemovalRow} from './feed-history-removal-store.js';
import {planHistoryRemovalReceipts} from './feed-history-removal-composition.js';
import {removeConversationSchema,type ConversationRemoval} from '../../packages/domain/conversation-removal.js';
import type {Conversation} from '../../packages/domain/assistant.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {HistoryWriteSequence} from './feed-history-write-sequence.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {attachFeedHistoryOwnerObservation,type FeedHistoryOwnerObservation} from './feed-history-owner-observer.js';
import {feedServicePrefix,isFeedReceipt,verifyFeedStoreLedger,assertFeedStoreTransition,protectedFeedReceiptIds} from './feed-store-protection.js';
import {verifyHistoryInventory} from './feed-history-inventory.js';
import {withHistoryFeedReadGraph,withLegacyFeedReadGraph} from './feed-history-read-lens.js';
import {feedReadProjectionLimits,type FeedReadGraph,type FeedReadProjectionLimits} from '../../packages/domain/news-feed-read-graph.js';
import {HistorySealRuntime,type SealRequest,type SealFaultPhase} from './feed-history-seal.js';
import type {FeedHistoryLease} from './feed-history-owner-fence.js';
import {historyLogicalRow,sealProtection} from './feed-history-seal-records.js';
import {readSqlHistory,historyTableDdl,historySealTableDdl} from './feed-history-sql.js';
import {verifyHistoryBackupInventory} from './feed-history-backup.js';
import {historyStorageAad,historyStoreLimitsSchema,type HistoryStoreLimits,type HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import {assertHistorySqlKey,assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import {workerNativeIdentity} from './worker-plugin/identity.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import {protocolIntent} from '../../packages/domain/news-feed-successor-journal.js';
import { verifyImportedProgress } from './workspace-import-progress.js';
import { z } from 'zod';
import { verifyGroupConversation } from '../../packages/domain/assistant-group-conversation.js';
import { groupExecutionPrefix, executionChildPrefix, executionValueKey, executionEventKey,
  groupExecutionEventSchema, groupExecutionCommandSchema, groupExecutionIntent, executionReceipt,
  hasGroupExecutionReceipt, changeGroupExecution, observeGroupExecution,
  groupExecutionChildBytes, groupExecutionEventLimit, groupExecutionGroupBytes,
  type GroupExecution, type GroupExecutionEvent, type GroupExecutionObservation } from '../../packages/domain/assistant-group-execution.js';
import { assertDirectAgentWrite, hasDirectAgentAuthority, verifyDirectAgentRecords } from '../../packages/domain/direct-agent.js';
import { groupPrefix, groupKey, groupMemberPrefix, groupMemberKey, groupEventPrefix, groupEventKey,
  groupCommandSchema, groupEventSchema, groupIntent, groupReceipt, hasGroupReceipt, changeGroup, verifyGroupRecords,
  type GroupBundle, type GroupEvent, type GroupReceipt } from '../../packages/domain/assistant-groups.js';
import { groupPreparationPrefix, preparationGroupPrefix, groupPreparationEventSchema, groupPreparationCommandSchema,
  groupPreparationIntent, groupPreparationReceipt, hasGroupPreparationReceipt,
  emptyGroupPreparation, changeGroupPreparation, groupPreparationEntries, parseGroupDraft,
  groupPreparationBytes, type GroupDraftScope,
  type GroupPreparationReceipt, type PreparedGroupRound } from '../../packages/domain/assistant-group-turns.js';
import { homeWidgetPreservationKey } from './home-widget-preservation.js';
import { importedProgressSchema } from '../../packages/domain/profile-progression.js';
import { buildProfileProgress, progressHistory, questCommandSchema, type PersonalQuest } from '../../packages/domain/profile-progression.js';
import { backupFormat, backupSnapshotSchema, historyBackupSnapshotSchema, sealingBackupSnapshotSchema, backupPlainMaxBytes, type BackupSnapshot, type HistoryBackupSnapshot, type SealingBackupSnapshot } from '../../packages/domain/workspace-backup.js';
import { hubLayoutKey, reconcileHubLayout, type HubLayout } from '../../packages/domain/hub-layout.js';
import { assistantSpace, spaceDraftId, type AssistantSpace } from '../../packages/domain/assistant-space.js';
import { contactEmails, contactMergeSchema, contactRestoreSchema, mergedContactValue } from '../../packages/domain/contacts.js';
import { imagePreviewType } from './image-preview.js';
import { syncTaskSubtasks } from '../../packages/domain/task-subtasks.js';
import { invalidTaskParents } from '../../packages/domain/task-family.js';
import { inTaskDestination, taskPresentationContext, taskPresentationProjection } from '../../packages/domain/task-presentation.js';
import { reminderActionSchema, reminderDeliverySchema, reminderInstant, reminderWindowMs, type NotificationAttempt, type Reminder } from '../../packages/domain/reminders.js';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync, openSync, closeSync, fsyncSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { attachmentSchema, canonical, commandSchema, defaultLayout, draftSchema, layoutSchema, projectSchema, taskSchema, type Attachment, type Command, type Draft, type Entity, type Kind, type Snapshot, type Values, type Project, type Task, type Layout } from '../../packages/domain/contracts.js';

import { dailyOrderSchema, inTaskView, dayInZone, focusElapsed, focusLeaseMs, focusSchema, nextDay, routineSchema, scheduled, taskHistorySchema, type DailyOrder, type Focus, type Occurrence, type Routine, type RoutineEvent, type TaskEvent, type TaskState } from '../../packages/domain/tasks.js';
import { blankRecord, contentFromAssignmentSchema, contentFromOutputSchema, contentSchema, isRecordKind, recordHistorySchema, recordSchemas, recordTaskSchema, type Assignment, type Content, type RecordKind, type RecordValue } from '../../packages/domain/workspace-records.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import type { AssistantOutput } from '../../packages/domain/assistant.js';
import { contactSchema, type Contact } from '../../packages/domain/workspace-records.js';
import { contactEmailKey, mailContactLinkSchema, mailContactSourceKey, type MailContactReview } from '../../packages/domain/mail-contact.js';
import { draftOrganizationCommandSchema, projectOrganizationCommandSchema, removeDraftSchema, type DraftRemoval, type DraftOrganization, type ProjectOrganization } from '../../packages/domain/contracts.js';

export class Fault extends Error {
  constructor(public status: number, public code: string, message: string, public current?: unknown) { super(message); }
}
type Row = { id: string; revision: number; updated_at: string; device_id: string; payload: Uint8Array };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const schemas = { layout: layoutSchema, task: taskSchema, draft: draftSchema, project: projectSchema, routine: routineSchema, ...recordSchemas };
const historyReviewOpen=Symbol('source-only-read-only-history-review');
const historyWriteOpen=Symbol('source-only-local-history-write-review');
const historyDraftTransaction=Symbol('source-only-closed-draft-transaction');
const historyTaskCatalogueStartup=Symbol('source-only-task-catalogue-startup');
const historyTaskCatalogueRestore=Symbol('source-only-held-task-catalogue-restore');
const historyProducerTransaction=Symbol('source-only-closed-producer-transaction');
const historyFocusTransaction=Symbol('source-only-closed-focus-transaction');
const historyFocusStartupTransaction=Symbol('source-only-closed-focus-startup');
const historyPositive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const historySequenceLimitsSchema=z.object({qualification:z.literal('unqualified'),rowSteps:z.literal(2),entries:historyPositive,
  logicalBytes:historyPositive,predecessorCipherBytes:historyPositive,outgoingCipherBytes:historyPositive,queries:historyPositive,copies:historyPositive}).strict();
const historyProjectionLimitsSchema=z.object({qualification:z.literal('unqualified'),entries:historyPositive,bytes:historyPositive,copies:historyPositive,copyBytes:historyPositive}).strict();
export type HistoryWriteSequenceLimits=z.infer<typeof historySequenceLimitsSchema>;
export type HistoryWriteReviewOptions={schema:61|62;now?:()=>number;protectedKey?:Buffer;projection:FeedReadProjectionLimits;sequence:HistoryWriteSequenceLimits};
export type HistoryCapacityReviewOptions=HistoryWriteReviewOptions & {capacity:ProjectedCapacityPolicy};
export type HistoryRemovalReviewOptions=HistoryWriteReviewOptions & {removal:HistoryRemovalLimits};
export type FeedMutationReadView=FeedReadGraph & {activeRow(id:string):SemanticRow|undefined};
type DerivationContext={open:boolean;failed:boolean;failure?:unknown};
type HistoryReviewOpen={token:typeof historyReviewOpen;limits:HistoryStoreLimits;schema?:61|62}|
  {token:typeof historyWriteOpen;limits:HistoryStoreLimits;schema:61|62;projection:FeedReadProjectionLimits;sequence:HistoryWriteSequenceLimits};

/** Single-owner local preview. No predecessor credentials or databases are opened. */
export class Store {
  private historyOwners?:FeedHistoryOwnerObservation;
  #historyRemoval?:Readonly<HistoryRemovalLimits>;
  #projectedCapacity?:Readonly<ProjectedCapacityPolicy>;
  #draftCapacity=false;
  #contentCapacity=false;
  #taskCapacity=false;
  #taskProducerCapacity=false;
  #taskFocusCapacity=false;
  #focusStartupState:'pending'|'settling'|'done'='pending';
  #producerCapacity=false;
  private capacityTransaction?:ProjectedCapacityTransaction;
  #taskCatalogue?:TaskCatalogueCustody;
  #taskCatalogueStarting=false;
  #taskCatalogueRequired=false;
  private observingProtectedCapacity=false;
  private removalContext?:HistoryRemovalContext;
  private lastHistoryRemovalStats?:ReturnType<HistoryRemovalContext['stats']>;
  private readonly removalBusyScope=new AsyncLocalStorage<{open:boolean;context:HistoryRemovalContext;voice:RemovalRow[]}>();
  private removalReceipt?:{requestId:string;deviceId:string;digest:string;valueJson:string;payload:Buffer;consumed:boolean};
  private removalCompletion?:{conversationId:string;context:HistoryRemovalContext};
  /** Source-only opt-in; ordinary constructors and all history read-only routes stay unchanged. */
  static openFeedOwnerReview(directory:string,now:()=>number=Date.now,protectedKey?:Buffer):Store{
    const store=new Store(directory,now,protectedKey);
    try{store.historyOwners=attachFeedHistoryOwnerObservation(store);store.historyOwners.claim('private-admission');return store;}
    catch(error){store.close();throw error;}
  }
  private db: DatabaseSync;
  private key: Buffer;
  private updateHold = false;
  private updateEffects = new Map<string, number>();
  // Positive-only cache: a rolled-back write may leave an extra guarded key,
  // but can never remove protection or add reads to ordinary transcript deltas.
  private directAgentProtected = new Set<string>();
  private writingFeed = false;
  private mutationTransaction = false;
  private feedTransactionTouched = false;
  private feedReceiptTouched = false;
  private readonly feedDerivation=new AsyncLocalStorage<DerivationContext>();
  private feedFailure?:{error:unknown};
  private historySequence?:HistoryWriteSequence;
  private reservedFeedReceiptPayload?:Buffer;
  private derivingProtectedAdmission=false;
  private feedAdmission?: { requestId:string; deviceId:string; digest:string; pending?:SemanticReceipt; touched:boolean; reservedClose?:{request:unknown;deviceId:string} };
  private readonly feedStoreInstance = randomUUID();
  private feedCommitGeneration = 0;
  private feedObservedChanges?: number;
  private writingGroup = false;
  private writingGroupPreparation = false;
  private writingGroupExecution = false;
  private readonly historyReviewLimits?:HistoryStoreLimits;
  private readonly historyReviewSchema:61|62;
  // The source factory has no caller-controlled native readiness switch.
  readonly #historyWrite?:{readonly projection:FeedReadProjectionLimits;readonly sequence:HistoryWriteSequenceLimits};
  private historySealConnection?:DatabaseSync;
  private historySealer?:HistorySealRuntime;
  readonly directory: string;
  /** Source-only entry: no migration, journal-mode update or ordinary startup
   * mutation. The SQLite connection itself is read-only from its first open. */
  static openHistoryReview(directory:string,limits:HistoryStoreLimits,protectedKey?:Buffer):Store{
    const parsed=historyStoreLimitsSchema.parse(limits);
    if(canonical(parsed)!==canonical(limits))throw new Error('Strict history review limits required');
    return new Store(directory,Date.now,protectedKey,true,{token:historyReviewOpen,limits:parsed});
  }
  /** Explicit existing-state source route. It never migrates or changes journal
   * mode and remains permanently unable to dispatch external Feed effects. */
  static openHistoryWriteReview(directory:string,limits:HistoryStoreLimits,options:HistoryWriteReviewOptions):Store{
    if(!options||Object.keys(options).some(key=>!['schema','now','protectedKey','projection','sequence'].includes(key)))throw Error('Exact history write options required');
    const parsed=historyStoreLimitsSchema.parse(limits),projection=historyProjectionLimitsSchema.parse(options.projection),sequence=historySequenceLimitsSchema.parse(options.sequence);
    if(canonical(parsed)!==canonical(limits)||canonical(projection)!==canonical(options.projection)||canonical(sequence)!==canonical(options.sequence))throw Error('Strict history write limits required');
    if(options.schema!==61&&options.schema!==62)throw Error('Exact history write schema required');
    const store=new Store(directory,options.now??Date.now,options.protectedKey,false,{token:historyWriteOpen,limits:parsed,schema:options.schema,
      projection:Object.freeze(projection),sequence:Object.freeze(sequence)});
    try{store.historyOwners=attachFeedHistoryOwnerObservation(store);store.historyOwners.claim('private-admission');return store;}
    catch(error){store.close();throw error;}
  }
  /** Isolated N2 route. Every unjoined writer stays held; only the exact
   * protected B original/observation can enter an owned mutation transaction. */
  static openHistoryCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    if(!options||Object.keys(options).some(key=>!['schema','now','protectedKey','projection','sequence','capacity'].includes(key)))throw Error('Exact history capacity options required');
    historyJsonBytes(options.capacity,2048);const capacity=projectedCapacityPolicySchema.parse(options.capacity);
    if(canonical(capacity)!==canonical(options.capacity))throw Error('Strict history capacity policy required');
    const store=Store.openHistoryWriteReview(directory,limits,{schema:options.schema,now:options.now,protectedKey:options.protectedKey,projection:options.projection,sequence:options.sequence});
    store.#projectedCapacity=Object.freeze({qualification:'unqualified',durable:Object.freeze(capacity.durable),transientCiphertextBytes:capacity.transientCiphertextBytes});return store;
  }
  static openHistoryDraftCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryCapacityReview(directory,limits,options);store.#draftCapacity=true;return store;
  }
  static openHistoryContentCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryDraftCapacityReview(directory,limits,options);store.#contentCapacity=true;return store;
  }
  /** Isolated Task route. Producer composition is deliberately unavailable. */
  static openHistoryTaskCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryContentCapacityReview(directory,limits,options);store.#taskCapacity=true;return store;
  }
  /** Private local custody route; no automatic authorization or external effect. */
  static openHistoryProducerStateReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryContentCapacityReview(directory,limits,options);store.#producerCapacity=true;
    try{store.verifyProducerOpen();return store;}catch(error){store.close();throw error;}
  }
  /** Private composed Task route; inherited producer proofs remain mandatory. */
  static openHistoryTaskProducerCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryProducerStateReview(directory,limits,options);store.#taskCapacity=true;store.#taskProducerCapacity=true;return store;
  }
  /** Isolated single-Task catalogue route. Generic/batch/restore writers stay
   * held; the exact tested native row ownership contract is not a Node range. */
  static openHistoryTaskCatalogueCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    if(process.versions.node!=='22.23.2'||process.platform!=='win32')throw Error('Task catalogue native source requires the qualified Windows Node22.23.2 runtime');
    const store=Store.openHistoryTaskProducerCapacityReview(directory,limits,options);
    try{
      if(store.reviewOnly||store.recoveryEffectsPaused)throw Error('Task catalogue bootstrap is held for recovery');
      store.#taskCatalogueStarting=true;
      store.#taskCatalogue=store.transaction(()=>store.capacityTransaction!.settleTaskCatalogueStartup(store.historySequence!),historyTaskCatalogueStartup);
      store.#taskCatalogueRequired=true;
      return store;
    }catch(error){store.close();throw error;}finally{store.#taskCatalogueStarting=false;}
  }
  /** Closed local join. Catalogue derivation commits before Focus settlement.
   * A failed second phase returns no Store and rolls back every Focus change;
   * any independently verified catalogue from the first phase remains durable. */
  static openHistoryTaskCatalogueFocusCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryTaskCatalogueCapacityReview(directory,limits,options);store.#taskFocusCapacity=true;
    try{store.settleCapacityFocusStartup();return store;}catch(error){store.close();throw error;}
  }
  /** Closed Focus commands share the qualified Task/producer transaction. */
  static openHistoryTaskFocusCapacityReview(directory:string,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    const store=Store.openHistoryTaskProducerCapacityReview(directory,limits,options);store.#taskFocusCapacity=true;
    try{store.settleCapacityFocusStartup();return store;}catch(error){store.close();throw error;}
  }
  /** Construction-only settlement. Held recovery has no writer transaction;
   * normal startup rechecks its actual hold under the original mutation owner. */
  private settleCapacityFocusStartup(){
    if(!this.#taskFocusCapacity||this.#focusStartupState!=='pending')throw Error('Focus startup is unavailable or consumed');
    this.#focusStartupState='settling';
    try{
      if(this.reviewOnly)return;
      const held=this.internalReadSnapshot(()=>{
        const budget=new MutationPlanBudget(completionFixtureLimits);for(let i=0;i<8;i++)budget.entry();budget.reserveBytes(512);
        const context:DraftCapacityContext=new DraftCapacityContext({db:this.db,budget,limits:this.#historyWrite!.sequence,recordBytes:this.historyReviewLimits!.objectBytes,
          guard:()=>{if(!this.db.isTransaction)throw Error('Focus startup hold snapshot ended');},openText:(aad,payload)=>this.openText(aad,payload),seal:()=>{throw Error('Focus startup hold snapshot cannot encrypt');}});
        try{return focusStartupHeld(context);}finally{context.close();}
      });
      if(held)return;
      this.transaction(()=>{this.capacityTransaction!.settleFocusStartup(this.historySequence!);},historyFocusStartupTransaction);
    }finally{this.#focusStartupState='done';}
  }
  /** Explicit C source route; the private capability cannot be supplied to
   * the older write/read constructors or converted into native authority. */
  static openHistoryRemovalReview(directory:string,limits:HistoryStoreLimits,options:HistoryRemovalReviewOptions):Store{
    if(!options||Object.keys(options).some(key=>!['schema','now','protectedKey','projection','sequence','removal'].includes(key)))throw Error('Exact history removal options required');
    historyJsonBytes(options.removal,4096);const removal=historyRemovalLimitsSchema.parse(options.removal);
    if(canonical(removal)!==canonical(options.removal)||removal.queries<8)throw Error('Strict history removal limits required');
    const store=Store.openHistoryWriteReview(directory,limits,{schema:options.schema,now:options.now,protectedKey:options.protectedKey,projection:options.projection,sequence:options.sequence});
    store.#historyRemoval=Object.freeze(removal);return store;
  }
  /** Source-only schema62 entry. Ordinary methods remain on a read-only
   * connection. Only the private sealing connection can mutate exact originals. */
  static openHistorySealReview(directory:string,limits:HistoryStoreLimits,options:{now?:()=>number;protectedKey?:Buffer;fault?:(phase:SealFaultPhase)=>void}={}):Store{
    const parsed=historyStoreLimitsSchema.parse(limits);if(canonical(parsed)!==canonical(limits))throw Error('Strict sealing limits required');
    const store=new Store(directory,options.now??Date.now,options.protectedKey,true,{token:historyReviewOpen,limits:parsed,schema:62});
    try{
      const db=new DatabaseSync(join(directory,'workspace.sqlite'));store.historySealConnection=db;
      db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
      store.historySealer=new HistorySealRuntime({store,db,limits:parsed,now:options.now??Date.now,
        open:(aad,payload)=>store.open(aad,payload),seal:(aad,value)=>store.seal(aad,value),
        epoch:()=>String(db.prepare("SELECT value FROM meta WHERE key='epoch'").get()?.value),
        recoveryHeld:()=>{const row=db.prepare("SELECT payload FROM service_records WHERE id='recovery:state'").get() as {payload:Uint8Array}|undefined;return !!(row&&store.open('service:recovery:state',row.payload)?.held);},
        fault:options.fault});return store;
    }catch(error){store.close();throw error;}
  }
  constructor(directory: string, private now: () => number = Date.now, protectedKey?: Buffer, private reviewOnly = false, historyReview?:HistoryReviewOpen) {
    this.directory = directory;
    if(historyReview&&historyReview.token!==historyReviewOpen&&historyReview.token!==historyWriteOpen)throw new Error('Unsupported history review route');
    this.historyReviewLimits=historyReview?.limits;this.historyReviewSchema=historyReview?.schema??61;
    if(historyReview?.token===historyWriteOpen)this.#historyWrite=Object.freeze({projection:historyReview.projection,sequence:historyReview.sequence});
    const identityPath = join(directory, 'edition3.identity');
    const identity = 'private.novadream.edition3.preview\n';
    if (existsSync(directory) && readdirSync(directory).length && (!existsSync(identityPath) || readFileSync(identityPath, 'utf8') !== identity)) throw new Error('This directory is not an Nova Dream workspace. Choose a new empty directory.');
    // The legacy route must refuse a newer workspace before even creating a
    // missing blobs directory. This probe never changes encoding/journal/schema.
    if(!historyReview&&existsSync(join(directory,'workspace.sqlite'))){
      const probe=new DatabaseSync(join(directory,'workspace.sqlite'),{readOnly:true});
      try{if((probe.prepare('PRAGMA user_version').get() as {user_version:number}).user_version>60)
        throw new Error('This workspace needs a compatible Nova Dream build.');}
      finally{probe.close();}
    }
    if(historyReview){if(!existsSync(identityPath)||!existsSync(join(directory,'workspace.sqlite')))throw new Error('History review requires an existing workspace');}
    else{
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!existsSync(identityPath)) writeFileSync(identityPath, identity, { mode: 0o600, flag: 'wx' });
      mkdirSync(join(directory, 'blobs'), { recursive: true, mode: 0o700 });
    }
    const keyPath = join(directory, 'preview.key');
    if (!protectedKey && !existsSync(keyPath)) {
      if(historyReview)throw new Error('Existing history workspace key is missing');
      if (existsSync(join(directory, 'workspace.sqlite'))) throw new Error('Existing workspace key is missing. Restore the original key; no data was replaced.');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.key = protectedKey ? Buffer.from(protectedKey) : readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid workspace key. No data was replaced.');
    this.db = new DatabaseSync(join(directory, 'workspace.sqlite'),{readOnly:!!historyReview&&!this.#historyWrite});
    const schema = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (historyReview?schema!==this.historyReviewSchema:schema>60) { this.db.close(); throw new Error('This workspace needs a compatible Nova Dream build.'); }
    // Authenticate an existing workspace before any schema or journal-mode write.
    try {
      if (schema > 0) {
        const check = this.db.prepare("SELECT value FROM meta WHERE key='key-check'").get() as { value: string } | undefined;
        if (!check || this.open('key-check', Buffer.from(check.value, 'base64')) !== 'edition3') throw new Error('Workspace key did not verify.');
        const records = this.db.prepare("SELECT id,revision,payload FROM service_records WHERE id LIKE 'assistant:%'").all() as { id: string; revision: number; payload: Uint8Array }[];
        const opened = records.map(row => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) }));
        verifyDirectAgentRecords(schema, opened);
        if(historyReview)this.internalVerifyFeedHistory();else verifyFeedStoreLedger(this.internalFeedLedger());
        const receipts = this.originalGroupReceipts();
        const groups = verifyGroupRecords(schema, opened, receipts, value => hash(canonical(value)));
        verifyGroupConversation(schema, opened, receipts, groups, this.groupPreparationSaved(), value => hash(canonical(value)));
        for (const row of opened) if (hasDirectAgentAuthority(row.value)) this.directAgentProtected.add(row.id);
      } else if ((this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count) throw new Error('Unrecognized workspace schema. No data was replaced.');
    } catch (error) { this.db.close(); throw error; }
    try{if(schema>0)this.#taskCatalogueRequired=!!this.db.prepare("SELECT 1 FROM service_records WHERE CAST(id AS BLOB)=CAST(? AS BLOB) LIMIT 1").get(taskRelationCatalogueKey);}catch(error){this.db.close();throw error;}
    if(historyReview){
      try{
        if(this.#historyWrite){
          z.string().uuid().parse(this.epoch);
          this.db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
        }
      }catch(error){this.db.close();throw error;}
      return;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, device_id TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS history (cursor INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, device_id TEXT NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS service_records (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bytes INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_refs (entity_id TEXT NOT NULL REFERENCES entities(id), blob_id TEXT NOT NULL REFERENCES blobs(id), PRIMARY KEY(entity_id,blob_id));
      PRAGMA user_version=60;`);
    try {
      if (!this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get()) this.transaction(() => {
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('epoch', randomUUID());
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('key-check', this.seal('key-check', 'edition3').toString('base64'));
        this.write('layout', 'layout', 'service', defaultLayout, 1);
      });
      const check = this.db.prepare("SELECT value FROM meta WHERE key='key-check'").get() as { value: string };
      if (this.open('key-check', Buffer.from(check.value, 'base64')) !== 'edition3') throw new Error('Workspace key did not verify.');
    } catch (error) { this.db.close(); throw error; }
    if (!this.recoveryHeld) this.transaction(() => this.syncHubLayout());
    // A restarted host keeps confirmed focus time, never the time it was offline.
    if (!this.recoveryHeld) for (const focus of this.internalList<Focus>('tasks:focus:')) if (focus.running) this.internalWrite(`tasks:focus:${focus.taskId}`, { ...focus, running: false, revision: focus.revision + 1 });
  }
  syncHubLayout() {
    const previous = this.internalRead<HubLayout>(hubLayoutKey);
    const next = reconcileHubLayout(previous, this.listEntities('agent').map(a => ({ id: a.id, archived: a.value.archived, name: a.value.name })), () => `room:${randomUUID()}`);
    if (next !== previous) this.internalWrite(hubLayoutKey, next);
    return next;
  }
  get epoch(): string { if(this.removalContext){const context:HistoryRemovalContext=this.removalContext,row=context.metaText('epoch');context.need(!!row,'Removal epoch missing','history_removal_changed');return row!.value;}return (this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string }).value; }
  close() { this.assertNotDeriving();this.historyOwners?.assertMutation();this.historyOwners?.assertDisposable();const owners=this.historySealer?.owners.blockers;if(owners&&(owners.maintenance||owners.rawWork))throw Error('History source maintenance/raw owner is still active');this.historyOwners?.beginClose();try{this.historySealConnection?.close();}finally{this.db.close();} }
  private seal(aad: string, value: unknown): Buffer {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  private open(aad: string, data: Uint8Array): any {
    return JSON.parse(this.openText(aad,data));
  }
  private openText(aad:string,data:Uint8Array):string {
    const bytes = Buffer.from(data); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  private invalidateFeedCache() {
    if (!Number.isSafeInteger(this.feedCommitGeneration + 1)) throw new Error('Store cache generation exhausted');
    this.feedCommitGeneration++;
  }
  private assertOrdinaryWritable() {
    this.assertWriteContext(this.derivingProtectedAdmission||this.observingProtectedCapacity);
    if(this.historyReviewLimits&&!this.#historyWrite)throw new Fault(409,'history_read_only','Historical review cannot prepare or change saved work.');
  }
  private assertNotDeriving(){
    const busy=this.removalBusyScope.getStore();if(busy)busy.context.fail(new Fault(409,'history_removal_read_only','Removal busy check cannot change or escape its original read scope.'));
    const context=this.feedDerivation.getStore();
    if(context){const error=context.failure??new Error('Feed derivation is read-only and cannot escape its synchronous scope');
      context.failed=true;context.failure=error;if(context.open)this.feedFailure??={error};throw error;}
  }
  private assertWriteContext(protectedCapacity=false){
    this.assertNotDeriving();this.historyOwners?.assertMutation();
    if(this.#taskCatalogueRequired&&!this.#taskCatalogue&&!this.#taskCatalogueStarting){const error=new Fault(409,'history_capacity_route_held','This workspace requires the complete Task catalogue writer. Saved work remains readable.');if(this.mutationTransaction)this.feedFailure??={error};throw error;}
    if(this.#projectedCapacity&&!protectedCapacity){const error=new Fault(409,'history_capacity_route_held','This writer awaits its complete capacity integration.');if(this.mutationTransaction)this.feedFailure??={error};throw error;}
    if(this.historyReviewLimits&&!this.#historyWrite)throw new Fault(409,'history_read_only','Historical review cannot prepare or change saved work.');
  }
  assertFeedExternalEffectAllowed(){
    if(this.removalBusyScope.getStore())this.assertNotDeriving();
    if(this.historyReviewLimits)throw new Fault(409,'history_external_effects_held','Historical native effects remain held pending complete capacity qualification.');
  }
  private producerCompletionOwner():ProducerCompletionPorts{
    return Object.freeze({db:this.db,openText:(aad:string,payload:Uint8Array)=>this.openText(aad,payload),sequence:this.#historyWrite!.sequence,
      open:(aad:string,payload:Uint8Array)=>this.open(aad,payload),limits:this.historyReviewLimits!,native:workerNativeIdentity,token:()=>canonical(this.internalFeedCacheToken())});
  }
  private initializeFeedTransaction(){
    this.mutationTransaction=true;this.feedTransactionTouched=false;this.feedReceiptTouched=false;this.feedFailure=undefined;this.invalidateFeedCache();
    if(this.#historyWrite){
      const owner=this.producerCompletionOwner();
      const seal=(aad:string,value:unknown)=>this.seal(aad,value);
      if(this.#projectedCapacity)this.capacityTransaction=new ProjectedCapacityTransaction({...owner,policy:this.#projectedCapacity,seal},owner);
      this.historySequence=new HistoryWriteSequence({...owner,schema:this.historyReviewSchema,projection:this.#historyWrite.projection,
        seal,beforeQuery:this.removalContext?()=>this.removalContext!.query():undefined,completion:this.capacityTransaction,owner});
    }
  }
  private verifyFeedTransaction(){
    this.removalContext?.guard();
    if(this.removalReceipt&&!this.removalReceipt.consumed)throw Error('Original removal receipt reservation was not consumed');
    if(this.feedFailure)throw this.feedFailure.error;
    this.historySequence?.checked(()=>undefined);
    this.#taskCatalogue?.verifyBeforeCommit();
    this.capacityTransaction?.finish();
    if(this.feedTransactionTouched||this.feedReceiptTouched){if(this.historyReviewLimits)this.internalVerifyFeedHistory();else verifyFeedStoreLedger(this.internalFeedLedger());}
  }
  private cleanupFeedTransaction(){
    this.capacityTransaction?.close();this.capacityTransaction=undefined;
    this.historySequence?.close();this.historySequence=undefined;this.reservedFeedReceiptPayload=undefined;this.feedFailure=undefined;
    this.mutationTransaction=false;this.feedTransactionTouched=false;this.feedReceiptTouched=false;this.feedAdmission=undefined;this.invalidateFeedCache();
  }
  private transaction<T>(fn: () => T,draftPermit?:symbol): T {
    if(draftPermit!==undefined){if(!(draftPermit===historyTaskCatalogueStartup&&this.#taskCatalogueStarting||draftPermit===historyDraftTransaction&&this.#draftCapacity||draftPermit===historyProducerTransaction&&this.#producerCapacity||draftPermit===historyFocusTransaction&&this.#taskFocusCapacity||draftPermit===historyFocusStartupTransaction&&this.#taskFocusCapacity&&this.#focusStartupState==='settling'))throw Error('Invalid private typed route');this.assertWriteContext(true);}
    else this.assertOrdinaryWritable();
    if(this.historyOwners)return this.historyOwners.transaction({
      inTransaction:()=>this.db.isTransaction,
      begin:()=>{this.removalContext?.disposition('begin');this.db.exec('BEGIN IMMEDIATE');},
      initialize:()=>this.initializeFeedTransaction(),
      verify:()=>this.verifyFeedTransaction(),
      commit:()=>{this.removalContext?.disposition('commit');this.db.exec('COMMIT');},rollback:()=>{this.removalContext?.disposition('rollback');this.db.exec('ROLLBACK');},
      cleanup:()=>this.cleanupFeedTransaction()
    },()=>{if(this.#taskCapacity&&!this.#taskProducerCapacity)this.requireTaskProducerAbsent();return fn();});
    this.db.exec('BEGIN IMMEDIATE');
    this.initializeFeedTransaction();
    try {
      const value = fn();
      if (this.feedTransactionTouched || this.feedReceiptTouched) {
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as {then?:unknown}).then === 'function')
          throw new Error('A Feed mutation transaction must be synchronous');
        // Real rows and real inserted receipts only; the admission overlay is gone.
      }
      this.verifyFeedTransaction();
      this.db.exec('COMMIT'); return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Store mutation and rollback both failed'); }
      throw error;
    } finally {
      this.cleanupFeedTransaction();
    }
  }
  private requireTaskProducerAbsent(){
    const sequence=this.historySequence;
    if(!sequence||!this.db.isTransaction)throw Error('Task guard requires the original owned transaction');
    const context:DraftCapacityContext=new DraftCapacityContext({db:this.db,budget:sequence.budget,limits:this.#historyWrite!.sequence,recordBytes:this.historyReviewLimits!.objectBytes,
      guard:()=>{sequence.checked(()=>undefined);if(this.feedFailure)throw this.feedFailure.error;},openText:(aad,payload)=>this.openText(aad,payload),seal:(aad,value)=>this.seal(aad,value)});
    try{context.checked(()=>{
      const key=context.key('news:automatic-producer:v1');context.slots(4,128);
      // Two exact indexed identities; neither the ciphertext nor its JSON is read.
      const row=context.scalar('SELECT 1 AS present FROM service_records WHERE id = ? OR id = CAST(? AS BLOB) LIMIT 1',[key,key]);
      context.need(row===undefined||(row!==null&&typeof row==='object'&&Object.keys(row).length===1&&Object.hasOwn(row,'present')&&row.present===1),'Task producer presence scalar malformed');
      context.need(row===undefined,'Task capacity is held while any automatic producer record exists');
    });}catch(error){this.feedFailure??={error};throw error;}finally{context.close();}
  }
  private entity<T>(row: Row): Entity<T> {
    return { id: row.id, revision: row.revision, updatedAt: row.updated_at, deviceId: row.device_id, value: this.open(`entity:${row.id}`, row.payload) };
  }
  private get<K extends Kind>(kind: K, id: string): Entity<Values[K]> | undefined {
    this.assertRemovalRead();
    const row = this.db.prepare('SELECT * FROM entities WHERE id=? AND kind=?').get(id, kind) as Row | undefined;
    return row ? this.entity(row) : undefined;
  }
  private list<K extends Kind>(kind: K): Entity<Values[K]>[] {
    this.assertRemovalRead();
    return (this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY updated_at DESC,id').all(kind) as Row[]).map(row => this.entity(row));
  }
  private write<K extends Kind>(kind: K, id: string, device: string, value: Values[K], revision: number): Entity<Values[K]> {
    this.assertWriteContext();
    const priorCursor = this.entityCursor;
    const updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,payload=excluded.payload').run(id, kind, revision, device, updatedAt, this.seal(`entity:${id}`, value));
    const result = { id, revision, updatedAt, deviceId: device, value };
    this.db.prepare('INSERT INTO history (entity_id,revision,payload) VALUES (?,?,?)').run(id, revision, this.seal(`history:${id}:${revision}`, result));
    if (kind === 'contact') {
      this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(id);
      const photo = (value as Contact).photo;
      if (photo) this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id, photo.id);
    }
    this.advanceCursor(priorCursor);
    return result;
  }
  session(token?: string): { deviceId: string; token?: string } {
    if (token) {
      const row = this.db.prepare('SELECT device_id FROM sessions WHERE digest=? AND expires>?').get(hash(token), Date.now()) as { device_id: string } | undefined;
      if (row) return { deviceId: row.device_id };
    }
    this.assertWriteContext();
    const next = randomBytes(32).toString('base64url'); const deviceId = randomUUID();
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(next), deviceId, Date.now() + 30 * 86400000);
    return { deviceId, token: next };
  }
  authenticate(token: string): string {
    const row = this.db.prepare('SELECT device_id FROM sessions WHERE digest=? AND expires>?').get(hash(token), Date.now()) as { device_id: string } | undefined;
    if (!row) throw new Fault(401, 'session_expired', 'Reconnect this browser to continue. Your local draft is kept.');
    return row.device_id;
  }
  matchesKey(candidate: Buffer) { return candidate.length === this.key.length && timingSafeEqual(candidate, this.key); }
  get updateMaintenanceHeld() { return this.updateHold; }
  setUpdateMaintenanceHeld(held: boolean) { this.assertWriteContext();this.updateHold = held; }
  assertUpdateAdmission() { if (this.updateHold) throw new Fault(409, 'update_maintenance', 'An update is preparing. Existing work is kept; finish or cancel it before updating.'); }
  updateEffectsInFlight() { return Object.fromEntries(this.updateEffects); }
  async trackUpdateEffect<T>(kind: string, run: () => Promise<T>, settling = false): Promise<T> {
    this.assertNotDeriving();this.historyOwners?.assertMutation();
    this.assertFeedExternalEffectAllowed();
    if (!settling) this.assertUpdateAdmission();
    this.updateEffects.set(kind, (this.updateEffects.get(kind) ?? 0) + 1);
    try { return await run(); }
    finally { const count = (this.updateEffects.get(kind) ?? 1) - 1; if (count) this.updateEffects.set(kind, count); else this.updateEffects.delete(kind); }
  }
  get recoveryHeld() { return this.reviewOnly || this.internalRead<{ held: boolean }>('recovery:state')?.held === true; }
  get recoveryEffectsPaused() { const state = this.internalRead<{ held: boolean; effectsPaused?: boolean }>('recovery:state'); return this.reviewOnly || state?.held === true || state?.effectsPaused === true; }
  activateRecoveredLocal() {
    const state = this.internalRead<{ held: boolean; backupId: string }>('recovery:state');
    if (!state) throw new Fault(409, 'recovery_missing', 'This directory is not a recovered workspace.');
    if (!this.recoveryHeld) return;
    this.internalWrite('recovery:state', { ...state, held: false, effectsPaused: true, activatedAt: new Date().toISOString() });
  }
  /** Called within the reviewed recovery transition's transaction. */
  pauseRecoveredRoutines(device: string) {
    for (const routine of this.list('routine')) if (routine.value.state === 'active') this.write('routine', routine.id, device, { ...routine.value, state: 'paused' }, routine.revision + 1);
  }
  /** Capture committed rows and their immutable files in one synchronous SQLite
   * transaction. No live database files, key wrappers or SQL enter the archive. */
  captureBackup(version: string, native: BackupSnapshot['native']): BackupSnapshot {
    return this.transaction(() => {
      const entities = (this.db.prepare('SELECT * FROM entities ORDER BY id').all() as (Row & { kind: BackupSnapshot['entities'][number]['kind'] })[]).map(row => ({ ...this.entity(row), kind: row.kind }));
      const history = (this.db.prepare('SELECT * FROM history ORDER BY cursor').all() as { cursor: number; entity_id: string; revision: number; payload: Uint8Array }[]).map(row => ({ cursor: row.cursor, entityId: row.entity_id, revision: row.revision, value: this.open(`history:${row.entity_id}:${row.revision}`, row.payload) }));
      const receipts = (this.db.prepare('SELECT * FROM receipts ORDER BY request_id').all() as { request_id: string; digest: string; device_id: string; payload: Uint8Array }[]).map(row => ({ requestId: row.request_id, digest: row.digest, deviceId: row.device_id, value: this.open(`receipt:${row.request_id}`, row.payload) }));
      const services = (this.db.prepare('SELECT * FROM service_records ORDER BY id').all() as { id: string; revision: number; payload: Uint8Array }[]).filter(row => !row.id.startsWith('backup:')).map(row => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) }));
      const files = (this.db.prepare('SELECT id,device_id FROM blobs ORDER BY id').all() as { id: string; device_id: string }[]).map(row => { const file = this.download(row.id); return { ...file.metadata, deviceId: row.device_id, base64: file.bytes.toString('base64') }; });
      const references = (this.db.prepare('SELECT entity_id,blob_id FROM blob_refs ORDER BY entity_id,blob_id').all() as { entity_id: string; blob_id: string }[]).map(row => ({ entityId: row.entity_id, fileId: row.blob_id }));
      const value: BackupSnapshot = { format: backupFormat, schema: (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version as BackupSnapshot['schema'], version, id: randomUUID(), createdAt: new Date().toISOString(), epoch: this.epoch, cursor: this.entityCursor, entities, history, receipts, services, files, references, native };
      Store.verifyBackup(value); return value;
    });
  }
  /** Read-only held history export. Every portable table and the complete
   * encrypted history catalogue are captured under the same SQLite snapshot. */
  captureHistoryBackup(version:string,native:BackupSnapshot['native']):HistoryBackupSnapshot{
    if(this.historyReviewSchema!==61)throw Error('Exact schema61 export required');return this.captureHistoryBackupValue(version,native) as HistoryBackupSnapshot;
  }
  captureSealingBackup(version:string,native:BackupSnapshot['native']):SealingBackupSnapshot{
    if(this.historyReviewSchema!==62)throw Error('Exact schema62 export required');return this.captureHistoryBackupValue(version,native) as SealingBackupSnapshot;
  }
  private captureHistoryBackupValue(version:string,native:BackupSnapshot['native']):HistoryBackupSnapshot|SealingBackupSnapshot{
    if(this.#projectedCapacity)this.assertWriteContext();
    const limits=this.historyReviewLimits;if(!limits)throw new Error('History export requires the read-only review route');
    return this.internalReadSnapshot(()=>readSqlHistory(this.db,(aad,payload)=>this.open(aad,payload),limits,()=>canonical(this.internalFeedCacheToken()),access=>{
      verifyHistoryInventory(access,limits,workerNativeIdentity);
      // Raw byte guards also cover unrelated backup identities before their TEXT
      // values enter the portable snapshot. No truncation/normalization is repair.
      for(const [table,keys] of [['entities',['id','device_id']],['history',['entity_id']],['service_records',['id']],['receipts',['request_id','device_id']],['blobs',['id','device_id']],['blob_refs',['entity_id','blob_id']]] as const)
        for(const key of keys){const bound=this.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE typeof(${key})!='text' OR length(CAST(${key} AS BLOB))>8192`).get() as {count:number};
          if(bound.count)throw new Error('Backup SQL key type/length unsupported');
          for(const row of this.db.prepare(`SELECT ${key} AS text,CAST(${key} AS BLOB) AS raw FROM ${table}`).iterate() as Iterable<{text:string;raw:Uint8Array}>)assertHistorySqlKey(row.text,row.raw);}
      const entities=(this.db.prepare('SELECT * FROM entities ORDER BY id COLLATE BINARY').all() as (Row&{kind:BackupSnapshot['entities'][number]['kind']})[]).map(row=>({...this.entity(row),kind:row.kind}));
      const history=(this.db.prepare('SELECT * FROM history ORDER BY cursor').all() as {cursor:number;entity_id:string;revision:number;payload:Uint8Array}[]).map(row=>({cursor:row.cursor,entityId:row.entity_id,revision:row.revision,value:this.open(`history:${row.entity_id}:${row.revision}`,row.payload)}));
      const receipts=[...access.receipts()];
      const services=(this.db.prepare('SELECT * FROM service_records ORDER BY id COLLATE BINARY').all() as {id:string;revision:number;payload:Uint8Array}[]).filter(row=>!row.id.startsWith('backup:')).map(row=>({id:row.id,revision:row.revision,value:this.open(`service:${row.id}`,row.payload)}));
      const files=(this.db.prepare('SELECT id,device_id FROM blobs ORDER BY id COLLATE BINARY').all() as {id:string;device_id:string}[]).map(row=>{const file=this.download(row.id);return {...file.metadata,deviceId:row.device_id,base64:file.bytes.toString('base64')};});
      const references=(this.db.prepare('SELECT entity_id,blob_id FROM blob_refs ORDER BY entity_id COLLATE BINARY,blob_id COLLATE BINARY').all() as {entity_id:string;blob_id:string}[]).map(row=>({entityId:row.entity_id,fileId:row.blob_id}));
      const value:HistoryBackupSnapshot|SealingBackupSnapshot={format:backupFormat,schema:this.historyReviewSchema,version,id:randomUUID(),createdAt:new Date().toISOString(),epoch:this.epoch,cursor:this.entityCursor,entities,history,receipts,services,files,references,native,
        feedHistory:{format:1,objects:[...access.objects()]}};
      return value.schema===62?Store.verifySealingBackup(value,limits):Store.verifyHistoryBackup(value,limits);
    },this.historyReviewSchema));
  }
  static verifyBackup(input: unknown): BackupSnapshot {
    return Store.verifyBackupValue(backupSnapshotSchema.parse(input)) as BackupSnapshot;
  }
  static verifyHistoryBackup(input:unknown,limits:HistoryStoreLimits):HistoryBackupSnapshot{
    historyJsonBytes(input,backupPlainMaxBytes);
    const parsedLimits=historyStoreLimitsSchema.parse(limits);
    if(canonical(parsedLimits)!==canonical(limits))throw new Error('Strict history backup limits required');
    const objects=(input as {feedHistory?:{objects?:unknown[]}})?.feedHistory?.objects;
    if(Array.isArray(objects)&&objects.length>parsedLimits.objects)throw new Error('History backup object count bound');
    return Store.verifyBackupValue(historyBackupSnapshotSchema.parse(input),parsedLimits) as HistoryBackupSnapshot;
  }
  static verifySealingBackup(input:unknown,limits:HistoryStoreLimits):SealingBackupSnapshot{
    historyJsonBytes(input,backupPlainMaxBytes);const parsed=historyStoreLimitsSchema.parse(limits);
    if(canonical(parsed)!==canonical(limits))throw Error('Strict sealing backup limits required');
    const objects=(input as {feedHistory?:{objects?:unknown[]}})?.feedHistory?.objects;
    if(Array.isArray(objects)&&objects.length>parsed.objects)throw Error('Sealing backup object count bound');
    return Store.verifyBackupValue(sealingBackupSnapshotSchema.parse(input),parsed) as SealingBackupSnapshot;
  }
  private static verifyBackupValue(value:BackupSnapshot|HistoryBackupSnapshot|SealingBackupSnapshot,historyLimits?:HistoryStoreLimits):BackupSnapshot|HistoryBackupSnapshot|SealingBackupSnapshot{
    if (Buffer.byteLength(JSON.stringify(value)) > backupPlainMaxBytes) throw new Fault(413, 'backup_large', 'This workspace exceeds the backup size limit. Nothing was changed.');
    const unique = (items: string[]) => { if (new Set(items).size !== items.length) throw new Fault(400, 'backup_duplicate', 'The backup contains duplicate identities.'); };
    unique(value.entities.map(e => e.id)); unique(value.history.map(h => String(h.cursor))); unique(value.services.map(s => s.id)); unique(value.receipts.map(r => r.requestId)); unique(value.files.map(f => f.id)); unique(value.references.map(r => r.entityId + '\0' + r.fileId));
    try { if(value.schema===61||value.schema===62){if(!historyLimits)throw new Error('History backup limits missing');verifyHistoryBackupInventory(value,historyLimits);}
      else verifyFeedStoreLedger({schema:value.schema,rows:value.services.filter(row=>row.id.startsWith(feedServicePrefix)),receipts:value.receipts}); }
    catch { throw new Fault(400, 'backup_feed', 'Saved Feed originals do not match their retained history and receipts. Nothing was restored.'); }
    try { verifyDirectAgentRecords(value.schema, value.services); } catch { throw new Fault(400, 'backup_direct_agent', 'Saved direct-agent authority is incompatible or does not match its original work. Nothing was restored.'); }
    try {
      const groups = verifyGroupRecords(value.schema, value.services, value.receipts, input => hash(canonical(input)));
      const currentById = new Map(value.entities.map(entity => [entity.id, entity]));
      let historicalByVersion: Map<string, unknown> | undefined;
      verifyGroupConversation(value.schema, value.services, value.receipts, groups, (kind, id, revision) => {
        const current = currentById.get(id);
        if (!current || current.kind !== kind) return undefined;
        if (current.revision === revision) return current.value;
        if (!historicalByVersion) {
          historicalByVersion = new Map();
          for (const row of value.history) {
            const key = canonical([row.entityId, row.revision]);
            // An ambiguous exact version cannot become authority through first-match ordering.
            historicalByVersion.set(key, historicalByVersion.has(key) ? undefined : row.value);
          }
        }
        const historical = historicalByVersion.get(canonical([id, revision]));
        return historical && typeof historical === 'object' && (historical as { id?: unknown }).id === id
          && (historical as { revision?: unknown }).revision === revision ? (historical as { value?: unknown }).value : undefined;
      }, input => hash(canonical(input)));
    }
    catch { throw new Fault(400, 'backup_groups', 'Saved Group membership does not match its original history and receipts. Nothing was restored.'); }
    try { verifyImportedProgress(value.services); } catch { throw new Fault(400, 'backup_progress', 'The earlier XP balance does not match its preserved source. Nothing was restored.'); }
    const ids = new Set(value.entities.map(e => e.id)), files = new Set(value.files.map(f => f.id));
    if (value.services.some(record => record.id.startsWith('backup:'))) throw new Fault(400, 'backup_transient_state', 'Temporary backup jobs are not portable workspace records.');
    if (value.history.some(entry => entry.cursor > value.cursor)) throw new Fault(400, 'backup_cursor', 'The backup history exceeds its saved workspace cursor.');
    if (value.entities.filter(e => e.kind === 'layout' && e.id === 'layout').length !== 1) throw new Fault(400, 'backup_layout', 'The backup is missing its workspace layout.');
    for (const entity of value.entities) {
      if (entity.kind === 'layout' ? entity.id !== 'layout' : !entity.id.startsWith(entity.kind + ':')) throw new Fault(400, 'backup_identity', 'A saved record has an incompatible identity. Nothing was restored.');
      schemas[entity.kind].parse(entity.value);
    }
    try { verifyImportedTaskCatalogue(value,historyLimits); }
    catch { throw new Fault(400,'backup_task_catalogue','Saved Task relations do not match their complete retained Tasks. Nothing was restored.'); }
    if (invalidTaskParents(value.entities.filter(entity => entity.kind === 'task') as Entity<Task>[]).size) throw new Fault(400, 'backup_task_parent', 'A task parent is missing, cyclic or in Trash while its child is active. Nothing was restored.');
    for (const reference of value.references) if (!ids.has(reference.entityId) || !files.has(reference.fileId)) throw new Fault(400, 'backup_reference', 'The backup has a missing record or file reference.');
    for (const file of value.files) { const bytes = Buffer.from(file.base64, 'base64'); if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Fault(400, 'backup_file', 'A backup attachment did not pass its integrity check.'); }
    if (value.native.status === 'included') { const bytes = Buffer.from(value.native.archive ?? '', 'base64'); if (!bytes.length || bytes.length !== value.native.bytes || hash(bytes) !== value.native.sha256) throw new Fault(400, 'backup_native', 'The Assistant archive did not pass its integrity check.'); }
    else if (value.native.archive || value.native.sha256 || value.native.bytes) throw new Fault(400, 'backup_native', 'The Assistant coverage does not match the archive.');
    unique((value.native.retained ?? []).map(archive => archive.sha256));
    for (const archive of value.native.retained ?? []) { const bytes = Buffer.from(archive.archive, 'base64'); if (!bytes.length || bytes.length !== archive.bytes || hash(bytes) !== archive.sha256 || archive.sha256 === value.native.sha256) throw new Fault(400, 'backup_native', 'An earlier Assistant archive did not pass its integrity check.'); }
    return value;
  }
  /** Import data only into a new directory and encrypt it with a fresh key.
   * Retained receipts keep their old epoch. Restored authority never replays them. */
  static restoreBackup(directory: string, input: unknown): Store {
    return Store.restoreBackupValue(directory,Store.verifyBackup(input));
  }
  /** Offline held import only; validation is complete before any new directory.
   * Re-encrypt, verify actual stored rows before commit, then close and reopen
   * read-only through the same complete persisted-history reader. */
  static restoreHistoryBackup(directory:string,input:unknown,limits:HistoryStoreLimits):Store{
    return Store.restoreBackupValue(directory,Store.verifyHistoryBackup(input,limits),limits);
  }
  static restoreSealingBackup(directory:string,input:unknown,limits:HistoryStoreLimits):Store{
    return Store.restoreBackupValue(directory,Store.verifySealingBackup(input,limits),limits);
  }
  /** Explicit offline held route. Import and catalogue derivation are separate
   * transactions: a late failure preserves a held copy, never a ready Store.
   * No ordinary writer, recovery activation or native effect is admitted. */
  static restoreHistoryTaskCatalogueBackup(directory:string,input:unknown,limits:HistoryStoreLimits,options:HistoryCapacityReviewOptions):Store{
    if(process.versions.node!=='22.23.2'||process.platform!=='win32')throw Error('Task catalogue native source requires the qualified Windows Node22.23.2 runtime');
    if(!options||Object.keys(options).some(key=>!['schema','now','protectedKey','projection','sequence','capacity'].includes(key)))throw Error('Exact held Task restore options required');
    const {schema,now,protectedKey,projection:inputProjection,sequence:inputSequence,capacity:inputCapacity}=options;
    if(protectedKey!==undefined)throw Error('Held Task restore requires a fresh workspace key');
    if(schema!==61&&schema!==62)throw Error('Exact held Task restore schema required');
    if(now!==undefined&&typeof now!=='function')throw Error('Held Task restore clock invalid');
    const retained=historyStoreLimitsSchema.parse(limits),projection=historyProjectionLimitsSchema.parse(inputProjection),sequence=historySequenceLimitsSchema.parse(inputSequence);
    historyJsonBytes(inputCapacity,2048);const capacity=projectedCapacityPolicySchema.parse(inputCapacity);
    if(canonical(retained)!==canonical(limits)||canonical(projection)!==canonical(inputProjection)||canonical(sequence)!==canonical(inputSequence)||canonical(capacity)!==canonical(inputCapacity))throw Error('Strict held Task restore limits required');
    // Snapshot all option metadata before validating aliased unknown backup
    // values. The caller clock first runs after those values are fully sealed.
    const selected:HistoryCapacityReviewOptions={schema,now,projection:Object.freeze(projection),sequence:Object.freeze(sequence),
      capacity:Object.freeze({...capacity,durable:Object.freeze(capacity.durable)})};
    const value=selected.schema===62?Store.verifySealingBackup(input,retained):Store.verifyHistoryBackup(input,retained);
    if(!value.services.some(row=>row.id===taskRelationCatalogueKey))verifyRestoredTaskSemantics(value,retained);
    const backupId=value.id,sourceEpoch=value.epoch;
    // This synchronous original import uses its default clock, not selected.now.
    // Only the already semantically validated derived record is regenerated.
    const imported=Store.restoreBackupValue(directory,value,retained,historyTaskCatalogueRestore);
    let epoch:string;
    try{epoch=imported.epoch;}catch(error){try{imported.close();}catch(closeError){throw new AggregateError([error,closeError],'Held Task import identity and close both failed');}throw error;}
    imported.close();
    const target=realpathSync(directory);
    let remaining:MutationPlanBudget|undefined;
    const staged=Store.openHistoryCapacityReview(directory,retained,selected);
    try{
      if(realpathSync(staged.directory)!==target)throw Error('Held Task restore target changed');
      staged.#taskCatalogueStarting=true;
      staged.transaction(()=>{
        const original=staged.historySequence!;remaining=original.budget;
        // Fixed restore frames, identity context, callbacks and later reopen
        // wrappers are prepaid on this original budget, never per Task.
        for(let i=0;i<24;i++)remaining.entry();remaining.reserveBytes(2048);
        const context:DraftCapacityContext=new DraftCapacityContext({db:staged.db,budget:remaining,limits:selected.sequence,recordBytes:retained.objectBytes,
          guard:()=>original.checked(()=>undefined),openText:(aad,payload)=>staged.openText(aad,payload),seal:()=>{throw Error('Restore identity check cannot encrypt');}});
        try{
          const state=context.row('service_records','recovery:state')?.value;
          context.need(state?.held===true&&state.backupId===backupId&&state.sourceEpoch===sourceEpoch&&context.meta('epoch')===epoch,'Held Task restore identity changed');
        }finally{context.close();}
        // The maintained complete initial proof, derived-record admission and
        // final actual proof remain inside this private original transaction.
        staged.capacityTransaction!.settleTaskCatalogueStartup(original);
      },historyTaskCatalogueStartup);
    }catch(error){
      staged.#taskCatalogueStarting=false;
      try{staged.close();}catch(closeError){throw new AggregateError([error,closeError],'Held Task derivation and close both failed');}
      throw error;
    }
    staged.#taskCatalogueStarting=false;staged.close();
    const reader=selected.schema===62?Store.openHistorySealReview(directory,retained):Store.openHistoryReview(directory,retained);
    try{
      reader.internalReadSnapshot(()=>{
        const budget=remaining!;
        const guard=()=>{if(!reader.reviewOnly||!reader.db.isTransaction)throw Error('Held Task restore readback scope changed');budget.checked(()=>undefined);};
        guard();
        const context:DraftCapacityContext=new DraftCapacityContext({db:reader.db,budget,limits:selected.sequence,recordBytes:retained.objectBytes,guard,
          openText:(aad,payload)=>reader.openText(aad,payload),seal:()=>{throw Error('Held Task restore readback cannot encrypt');}});
        try{
          const state=context.row('service_records','recovery:state')?.value;
          context.need(realpathSync(reader.directory)===target&&state?.held===true&&state.backupId===backupId&&state.sourceEpoch===sourceEpoch&&context.meta('epoch')===epoch,'Held Task restore readback identity changed');
          // A fresh context/transaction rederives the persisted meaning and
          // both full raw passes. No allowance resets; returned custody is
          // discarded and an absent catalogue cannot be repaired on read.
          bootstrapTaskCatalogue({db:reader.db,limits:retained,context,budget,epoch,openText:(aad,payload)=>reader.openText(aad,payload),guard},amount=>{
            context.need(!amount.absent&&amount.previousBytes===amount.nextBytes,'Held Task restore readback catalogue missing');
          });
        }finally{context.close();}
      });
      return reader;
    }catch(error){try{reader.close();}catch(closeError){throw new AggregateError([error,closeError],'Held Task restore readback and close both failed');}throw error;}
  }
  private static restoreBackupValue(directory:string,value:BackupSnapshot|HistoryBackupSnapshot|SealingBackupSnapshot,historyLimits?:HistoryStoreLimits,taskRestore?:typeof historyTaskCatalogueRestore):Store{
    if(value.services.some(row=>row.id===taskRelationCatalogueKey)&&taskRestore!==historyTaskCatalogueRestore)throw new Fault(409,'backup_task_catalogue_route','This saved Task catalogue requires the explicit held restore route. Nothing was restored.');
    if (existsSync(directory)) throw new Fault(409, 'restore_exists', 'Choose a fresh recovery copy. Existing work was not replaced.');
    const restored = new Store(directory);
    let restoredClosed=false;
    try {
      restored.transaction(() => {
        if(value.schema===61||value.schema===62)restored.db.exec(value.schema===62?historySealTableDdl:historyTableDdl);
        restored.db.exec('DELETE FROM blob_refs; DELETE FROM entities; DELETE FROM history; DELETE FROM service_records; DELETE FROM receipts; DELETE FROM sessions; DELETE FROM blobs;');
        for (const e of value.entities) restored.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(e.id, e.kind, e.revision, e.deviceId, e.updatedAt, restored.seal(`entity:${e.id}`, e.value));
        for (const h of value.history) restored.db.prepare('INSERT INTO history (cursor,entity_id,revision,payload) VALUES (?,?,?,?)').run(h.cursor, h.entityId, h.revision, restored.seal(`history:${h.entityId}:${h.revision}`, h.value));
        for (const r of value.receipts) restored.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(r.requestId, r.digest, r.deviceId, restored.seal(`receipt:${r.requestId}`, r.value));
        for (const s of value.services) if(s.id!==taskRelationCatalogueKey||taskRestore!==historyTaskCatalogueRestore)restored.db.prepare('INSERT INTO service_records VALUES (?,?,?)').run(s.id, s.revision, restored.seal(`service:${s.id}`, s.value));
        for (const f of value.files) {
          const metadata = attachmentSchema.parse({ id: f.id, name: f.name, size: f.size, sha256: f.sha256 }), bytes = restored.seal(`blob:${f.id}`, f.base64);
          const fd = openSync(join(directory, 'blobs', f.id), 'wx', 0o600);
          try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
          restored.db.prepare('INSERT INTO blobs VALUES (?,?,?,?)').run(f.id, f.deviceId, bytes.length, restored.seal(`blob-meta:${f.id}`, metadata));
        }
        for (const r of value.references) restored.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(r.entityId, r.fileId);
        if(value.schema===61||value.schema===62){
          for(const input of value.feedHistory.objects){const object=input as HistoryStoredObject;
            restored.db.prepare('INSERT INTO feed_history_objects VALUES (?,?,?,?,?)').run(object.kind,object.key,object.rangeKey,object.revision,restored.seal(historyStorageAad(object.kind,object.key),object));}
          restored.db.exec(`PRAGMA user_version=${value.schema}`);
        }
        restored.db.prepare("INSERT INTO meta VALUES ('workspace-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value.cursor));
        restored.internalWrite('recovery:state', { held: true, backupId: value.id, sourceEpoch: value.epoch, recoveredAt: new Date().toISOString(), native: value.native.status, nativeHash: value.native.sha256, nativeBytes: value.native.bytes });
        restored.internalWrite('recovery:retained-archives', (value.native.retained ?? []).map(({ archive: _archive, ...metadata }) => metadata));
        restored.internalDelete('http:session-cookie');
        restored.internalWrite('phone:access', { enabled: false });
        if(value.schema===61||value.schema===62)restored.internalVerifyFeedHistory(historyLimits,value.schema);else verifyFeedStoreLedger(restored.internalFeedLedger());
      });
      for (const record of value.services) if (hasDirectAgentAuthority(record.value)) restored.directAgentProtected.add(record.id);
      for (const file of value.files) restored.download(file.id);
      if(value.schema===61||value.schema===62){restored.close();restoredClosed=true;return value.schema===62?Store.openHistorySealReview(directory,historyLimits!):Store.openHistoryReview(directory,historyLimits!);}
      return restored;
    } catch (error) {
      if(!restoredClosed)try{restored.close();}catch(closeError){throw new AggregateError([error,closeError],'Restore and Store close both failed');}
      throw error;
    }
  }
  snapshot(deviceId: string): Snapshot {
    // One transaction gives a consistent cursor and all projections.
    return this.transaction(() => { if (!this.recoveryEffectsPaused && !this.updateMaintenanceHeld) { this.materializeRoutines(); this.sweepReminders(); } return { epoch: this.epoch, cursor: this.entityCursor, deviceId,
      layout: this.get('layout', 'layout')!, tasks: this.list('task').filter(t => !t.value.trashed), trashedTasks: this.list('task').filter(t => t.value.trashed), routines: this.list('routine'), calendarCompletions: this.internalList<import('../../packages/domain/calendar-completion.js').CalendarCompletion>('tasks:calendar-completion:'), taskState: this.taskState(), drafts: this.list('draft'), draftOrganization: this.internalList<DraftOrganization>('assistant:draft-organization:'), draftRemovals: this.internalList<DraftRemoval>('assistant:draft-removed:'), projects: this.list('project'),
      projectOrganization: this.internalList<ProjectOrganization>('assistant:project-organization:'),
      records: { contact: this.list('contact'), content: this.list('content'), agent: this.list('agent'), assignment: this.list('assignment'), profile: this.list('profile') },
      capabilities: { assistant: false, voice: false, reason: 'A verified Assistant and speech connection has not been configured for this workspace.' } }; });
  }
  private replay(requestId: string, digest: string, device: string): unknown | undefined {
    if(this.removalContext){const row=this.removalContext.receipt(requestId);if(!row)return undefined;
      if(row.raw.digest!==digest||row.raw.device_id!==device)throw new Fault(409,'request_reused','This request identity was already used for different work.');
      const value=row.value;if(value?.removedWork)throw new Fault(409,`${value.removedWork}_removed`,'This saved work was removed. Its old request cannot restore it.');return value;}
    const existing = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId) as { digest: string; device_id: string; payload: Uint8Array } | undefined;
    if (!existing) return undefined;
    if (existing.digest !== digest || existing.device_id !== device) throw new Fault(409, 'request_reused', 'This request identity was already used for different work.');
    const value = this.open(`receipt:${requestId}`, existing.payload);
    if (value?.removedWork) throw new Fault(409, `${value.removedWork}_removed`, 'This saved work was removed. Its old request cannot restore it.');
    return value;
  }
  projectIsDeleted(projectId: string): boolean {
    return this.internalRead<ProjectOrganization>(`assistant:project-organization:${projectId}`)?.deleted === true;
  }
  organizeProject(device: string, raw: unknown): ProjectOrganization {
    const input = projectOrganizationCommandSchema.parse(raw);
    return this.admit(device, input, { type: 'project.organize', ...input }, () => {
      const project = this.get('project', input.projectId), key = `assistant:project-organization:${input.projectId}`;
      const previous = this.internalRead<ProjectOrganization>(key);
      if (!project || project.revision !== input.projectRevision || (previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'project_changed', 'This Project changed. Review its current version before organizing it.');
      // Sidebar organization must not revise captured project context or remove its files and saved work.
      const result = this.internalWrite(key, { projectId: project.id, revision: (previous?.revision ?? 0) + 1, deleted: input.action === 'delete' } satisfies ProjectOrganization);
      this.advanceCursor();
      return result;
    }).value;
  }
  organizeDraft(device: string, raw: unknown) {
    const input = draftOrganizationCommandSchema.parse(raw);
    return this.admit(device, input, { type: 'draft.organize', ...input }, () => {
      const draft = this.get('draft', input.draftId), key = `assistant:draft-organization:${input.draftId}`;
      const previous = this.internalRead<DraftOrganization>(key);
      if (!draft || draft.revision !== input.draftRevision || (previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'draft_changed', 'This saved draft changed. Review its current version before organizing it.');
      const current = previous?.draftRevision === draft.revision ? previous : undefined;
      return this.internalWrite(key, { draftId: draft.id, draftRevision: draft.revision, revision: (previous?.revision ?? 0) + 1,
        pinned: input.action === 'pin' ? true : input.action === 'unpin' ? false : current?.pinned ?? false,
        folder: input.action === 'delete' ? 'deleted' : input.action === 'archive' ? 'archive' : input.action === 'restore' ? 'active' : current?.folder ?? 'active' } satisfies DraftOrganization);
    }).value;
  }
  removeDraft(device: string, raw: unknown): DraftRemoval {
    this.assertWriteContext();
    if(this.#historyRemoval)return this.removeHistoricalDraft(device,raw);
    if(this.#historyWrite)throw new Fault(409,'history_operation_held','This historical operation awaits its separate capacity or redaction integration.');
    const input = removeDraftSchema.parse(raw);
    return this.admit(device, input, { type: 'draft.remove', ...input }, () => {
      const draft = this.get('draft', input.draftId), organization = this.internalRead<DraftOrganization>(`assistant:draft-organization:${input.draftId}`);
      if (!draft || draft.revision !== input.draftRevision || organization?.draftRevision !== draft.revision || organization.revision !== input.expectedRevision || organization.folder !== 'deleted') throw new Fault(409, 'draft_changed', 'Move this saved draft to Deleted and review its current version before removing it.');
      if (this.internalList<{ draftId: string; state: string; cleanupPending?: boolean }>('dictation:').some(a => a.draftId === draft.id && (a.cleanupPending || !['ended', 'failed'].includes(a.state)))) throw new Fault(409, 'draft_busy', 'Finish dictation in the original draft before removing it.');
      return this.removeDraftData(draft);
    }).value;
  }
  private assertRemovalRead(){const busy=this.removalBusyScope.getStore();if(busy)busy.context.fail(new Fault(409,'history_removal_read_only','Only the exact bounded voice inventory is readable during this check.'));}
  private removalSql(sql:string){this.removalContext?.query();return this.db.prepare(sql);}
  private removalAvailable(){
    this.assertNotDeriving();
    if(!this.historyReviewLimits)return false;
    if(!this.#historyRemoval)throw new Fault(409,'history_operation_held','Historical removal awaits its exact reviewed route.');
    return true;
  }
  private removalPhase<T>(run:(context:HistoryRemovalContext)=>T,mode:'mutation'|'entry'|'failure'='mutation'):T{
    this.assertNotDeriving();if(!this.#historyRemoval||this.removalContext||this.db.isTransaction&&mode!=='entry')throw new Fault(409,'history_removal_context','A removal phase requires its original nonnested owner.');
    const base=this.#historyRemoval,limits:HistoryRemovalLimits={...base,
      ...(mode==='entry'?{inventoryRows:5,selectedRows:5,readCipherBytes:8388608,retainedLogicalBytes:16777216,retainedEntries:4096,queries:32}:{}),
      ...(mode==='failure'?{inventoryRows:8,selectedRows:8,retainedLogicalBytes:4194304,predecessorCipherBytes:4194304,outgoingCipherBytes:4194304}:{})};
    // No per-phase override may widen the caller's explicit finite maximum.
    for(const key of Object.keys(limits) as (keyof HistoryRemovalLimits)[])if(key!=='qualification')limits[key]=Math.min(limits[key] as number,base[key] as number) as never;
    const context:HistoryRemovalContext=new HistoryRemovalContext(this.db,limits,(aad,payload)=>this.open(aad,payload),(aad,value)=>this.seal(aad,value));this.removalContext=context;
    try{return context.checked(()=>run(context));}
    finally{this.lastHistoryRemovalStats=context.stats();context.close();this.removalContext=undefined;this.removalReceipt=undefined;this.removalCompletion=undefined;}
  }
  private removalEntry(context:HistoryRemovalContext,conversationId:string,requestId?:string){
    z.string().uuid().parse(conversationId);if(requestId!==undefined)z.string().uuid().parse(requestId);
    const chat=context.service('assistant:conversation:'+conversationId)?.value as Conversation|undefined;
    const removed=context.service('assistant:removed:'+conversationId)?.value;
    const currentId=context.service('assistant:removal-current:'+conversationId)?.value as string|undefined;
    if(currentId!==undefined)z.string().uuid().parse(currentId);
    const current=currentId?context.service('assistant:removal:'+currentId)?.value as ConversationRemoval|undefined:undefined;
    const requested=requestId?(requestId===currentId?current:context.service('assistant:removal:'+requestId)?.value as ConversationRemoval|undefined):undefined;
    context.need(!chat||chat.id===conversationId,'Stored conversation identity changed','removal_identity');
    context.need(!current||current.requestId===currentId&&current.conversationId===conversationId,'Current removal identity changed','removal_identity');
    context.need(!requested||requested.requestId===requestId&&requested.conversationId===conversationId,'Requested removal identity changed','removal_identity');
    return {chat,removed,currentId,current,requested};
  }
  internalHistoryRemovalEntry(conversationId:string,requestId?:string){
    if(!this.removalAvailable())return undefined;
    if(this.removalContext)return this.removalEntry(this.removalContext,conversationId,requestId);
    return this.removalPhase((context:HistoryRemovalContext)=>this.internalReadSnapshot(()=>this.removalEntry(context,conversationId,requestId)),'entry');
  }
  private reserveRemovalReceipt(context:HistoryRemovalContext,value:unknown){
    const original=this.feedAdmission;
    context.need(!!original&&!original.pending&&!original.touched&&!this.removalReceipt&&!!this.historySequence,'Exact ordinary removal admission required','history_removal_context');
    const pending={requestId:original!.requestId,deviceId:original!.deviceId,digest:original!.digest,value};context.reserveReceipt(pending);const valueJson=JSON.stringify(value);
    const payload=this.historySequence!.apply([],pending);
    context.need(!!payload,'Original removal receipt ciphertext missing','history_removal_receipt');
    this.removalReceipt={requestId:original!.requestId,deviceId:original!.deviceId,digest:original!.digest,valueJson,payload:payload!,consumed:false};this.reservedFeedReceiptPayload=payload;
  }
  private removalBusy(context:HistoryRemovalContext,voice:RemovalRow[],id:string,busy:(id:string)=>boolean){
    context.need(!this.removalBusyScope.getStore(),'Removal busy check cannot reenter','history_removal_read_only');
    const scope={open:true,context,voice};
    const result=this.removalBusyScope.run(scope,()=>this.historyOwners!.synchronous(()=>{
      let value:unknown;try{value=busy(id);}finally{scope.open=false;}
      // The original owner observes any returned thenable once and retains its
      // settlement. Scope is already expired before that observation.
      if(value!==null&&(typeof value==='object'||typeof value==='function'))return value as never;
      context.need(typeof value==='boolean','Removal busy check must return a boolean','history_removal_read_only');return value;
    }));context.need(typeof result==='boolean','Removal busy check must return a boolean','history_removal_read_only');return result;
  }
  private assertRemovalLocal(item:Pick<ConversationRemoval,'nativeId'>|undefined){if(item?.nativeId)this.assertFeedExternalEffectAllowed();}
  internalPrepareHistoryConversationRemoval(device:string,raw:unknown,busy:(id:string)=>boolean){
    if(!this.removalAvailable())return undefined;
    const input=removeConversationSchema.parse(raw);
    return this.removalPhase((context:HistoryRemovalContext)=>this.admit(device,input,{type:'conversation.remove',...input},()=>{
      const {chat,removed,current}=this.removalEntry(context,input.conversationId);
      if(chat?.directAgent)throw new Fault(409,'direct_agent_runtime_unqualified','Keep the original agent chat until its dedicated removal route is qualified.');
      if(current&&['prepared','unknown'].includes(current.state)&&current.epoch===input.epoch&&current.expectedRevision===input.expectedRevision){this.assertRemovalLocal(current);const value={requestId:current.requestId};this.reserveRemovalReceipt(context,value);return value;}
      if(removed)throw new Fault(410,'conversation_removed','This conversation was permanently removed.');
      if(current&&['prepared','unknown'].includes(current.state))throw new Fault(409,'conversation_removing','Finish checking this conversation’s removal before continuing.');
      if(!chat||!chat.deleted||chat.revision!==input.expectedRevision||chat.pendingSettings||chat.state==='creating'||!chat.nativeId&&chat.state!=='failed')throw new Fault(409,'removal_changed','Move this chat to Deleted and resolve its current status before removing it permanently.');
      this.assertRemovalLocal(chat);
      const voice=context.prefix('voice:attempt:');
      if(this.removalBusy(context,voice,chat.id,busy)||context.prefix('assistant:operation:').some(r=>r.value.conversationId===chat.id&&!['completed','failed','cancelled'].includes(r.value.state)))throw new Fault(409,'removal_busy','Finish the original reply or voice call before removing this chat.');
      if(context.prefix('dictation:').some(r=>r.value.draftId.endsWith(':'+chat.id)&&(r.value.cleanupPending||!['ended','failed'].includes(r.value.state))))throw new Fault(409,'removal_busy','Finish dictation and its cleanup before removing this chat.');
      if(voice.some(r=>r.value.target.conversation.id===chat.id&&(!['ended','failed'].includes(r.value.state)||r.value.entries.some((v:any)=>!v.saved)||r.value.consults.some((v:any)=>!['completed','failed'].includes(v.state)))))throw new Fault(409,'removal_busy','Close the original voice call and finish saving its captions before removing this chat.');
      if(context.prefix('assistant:output:').some(r=>r.value.conversationId===chat.id&&r.value.state!=='ready'))throw new Fault(409,'removal_busy','Finish saving this chat’s output before removing the conversation.');
      for(const prefix of ['assistant:approval:','assistant:question:'])if(context.prefix(prefix).some(r=>r.value.conversationId===chat.id&&(r.value.snapshot.status==='pending'||r.value.action&&r.value.action.state!=='confirmed')))throw new Fault(409,'removal_busy','Resolve this chat’s pending decisions before removing it.');
      const item:ConversationRemoval={...input,deviceId:device,nativeId:chat.nativeId,nativeKey:chat.nativeKey,connectionGeneration:chat.connectionGeneration,state:'prepared',updatedAt:new Date(this.now()).toISOString()};
      context.writeService('assistant:removal-current:'+item.conversationId,item.requestId);context.writeService('assistant:removal:'+item.requestId,item);
      const value={requestId:item.requestId};this.reserveRemovalReceipt(context,value);context.apply();return value;
    }));
  }
  private removalIdentity(context:HistoryRemovalContext,item:ConversationRemoval){
    const original=context.service('assistant:removal:'+item.requestId)?.value as ConversationRemoval|undefined;
    context.need(!!original&&['prepared','unknown'].includes(original.state)&&original.requestId===item.requestId&&original.conversationId===item.conversationId&&original.expectedRevision===item.expectedRevision&&original.deviceId===item.deviceId&&original.epoch===item.epoch&&original.epoch===this.epoch&&original.nativeId===item.nativeId&&original.nativeKey===item.nativeKey&&original.connectionGeneration===item.connectionGeneration,'Original removal identity changed','history_removal_changed');
    this.assertRemovalLocal(original);return original!;
  }
  internalCompleteHistoryConversationRemoval(item:ConversationRemoval){
    if(!this.removalAvailable())return undefined;this.assertRemovalLocal(item);
    return this.removalPhase((context:HistoryRemovalContext)=>this.internalAtomic(()=>{
      const original=this.removalIdentity(context,item);const entry=this.removalEntry(context,item.conversationId);
      context.need(entry.currentId===item.requestId&&entry.chat?.deleted===true&&entry.chat.revision===item.expectedRevision&&!entry.chat.directAgent,'Original removal conversation changed','history_removal_changed');
      this.assertRemovalLocal(entry.chat);this.removalCompletion={conversationId:item.conversationId,context};
      this.removeConversationData(item.conversationId);
      const at=new Date(this.now()).toISOString(),completed={...original,state:'completed' as const,updatedAt:at};delete completed.message;
      context.writeService('assistant:removed:'+item.conversationId,{id:item.conversationId,requestId:item.requestId,at});context.writeService('assistant:removal:'+item.requestId,completed);
      this.feedReceiptTouched=true;context.apply();return completed;
    }));
  }
  internalSaveHistoryConversationRemovalFailure(item:ConversationRemoval){
    if(!this.removalAvailable())return undefined;this.assertRemovalLocal(item);
    if(!['unknown','rejected'].includes(item.state))throw new Fault(409,'history_removal_context','Only the original failed removal outcome can be saved.');
    return this.removalPhase((context:HistoryRemovalContext)=>this.internalAtomic(()=>{this.internalVerifyFeedHistory();this.removalIdentity(context,item);
      const next={...item,updatedAt:new Date(this.now()).toISOString()};context.writeService('assistant:removal:'+item.requestId,next);this.feedReceiptTouched=true;context.apply();return next;
    }),'failure');
  }
  private checkRemovalOwnedKey(context:HistoryRemovalContext,row:RemovalRow,prefix:string){context.need(typeof row.value?.id==='string'&&!!row.value.id&&row.raw.id===prefix+row.value.id,'Removal payload identity does not match its exact stored key','history_removal_key_mismatch');context.key(row.value.id);return row.value.id as string;}
  private planHistoricalDraft(context:HistoryRemovalContext,draft:RemovalRow,dictation:RemovalRow[]){
    context.entry(2);const ids:string[]=[];const id=draft.raw.id;
    for(const row of context.scan('blob_refs','entity_id=?',[id]))context.delete(row);
    context.delete(draft);for(const row of context.scan('history','entity_id=?',[id]))context.delete(row);
    const organization=context.service('assistant:draft-organization:'+id);if(organization)context.delete(organization);
    for(const row of dictation)if(row.value.draftId===id){const exact=this.checkRemovalOwnedKey(context,row,'dictation:');context.entry();ids.push(exact);context.delete(row);}
    const removed={draftId:id,revision:draft.raw.revision+1};context.need(Number.isSafeInteger(removed.revision),'Draft revision exhausted');context.writeService('assistant:draft-removed:'+id,removed);return {removed,ids};
  }
  private planHistoricalReceipts(context:HistoryRemovalContext,selection:{draftIds:string[];dictationIds:string[];ownedReceiptIds:string[];conversationId?:string}){
    context.reserveComposition();const candidates=readSqlHistory(this.db,(aad,payload)=>this.open(aad,payload),this.historyReviewLimits!,()=>canonical(this.internalFeedCacheToken()),
      access=>planHistoryRemovalReceipts(access,this.historyReviewLimits!,workerNativeIdentity,historyRemovalCompositionLimits,selection),this.historyReviewSchema,()=>context.query());
    for(const candidate of candidates){const row=context.receipt(candidate.requestId);
      context.need(!!row&&row.raw.device_id===candidate.deviceId&&row.raw.digest===candidate.digest&&JSON.stringify(row.value)===candidate.previousValueJson,'Original redaction predecessor changed','history_removal_changed');
      context.redact(row!,JSON.parse(candidate.replacementValueJson));
    }
  }
  private removeHistoricalDraft(device:string,raw:unknown):DraftRemoval{
    const input=removeDraftSchema.parse(raw);
    return this.removalPhase((context:HistoryRemovalContext)=>this.admit(device,input,{type:'draft.remove',...input},()=>{
      const draft=context.scan('entities','id=? AND kind=?',[input.draftId,'draft'])[0],organization=context.service('assistant:draft-organization:'+input.draftId)?.value as DraftOrganization|undefined;
      if(!draft||!organization||draft.raw.revision!==input.draftRevision||organization.draftRevision!==draft.raw.revision||organization.revision!==input.expectedRevision||organization.folder!=='deleted')throw new Fault(409,'draft_changed','Move this saved draft to Deleted and review its current version before removing it.');
      const dictation=context.prefix('dictation:');if(dictation.some(r=>r.value.draftId===draft.raw.id&&(r.value.cleanupPending||!['ended','failed'].includes(r.value.state))))throw new Fault(409,'draft_busy','Finish dictation in the original draft before removing it.');
      const plan=this.planHistoricalDraft(context,draft,dictation);this.planHistoricalReceipts(context,{draftIds:[draft.raw.id],dictationIds:plan.ids,ownedReceiptIds:[]});context.cursor();
      this.reserveRemovalReceipt(context,plan.removed);context.apply();return plan.removed;
    }).value);
  }
  private planHistoricalConversationCleanup(context:HistoryRemovalContext,conversationId:string){
    context.entry(3);const draftIds:string[]=[],dictationIds:string[]=[],ownedReceiptIds:string[]=[];const dictation=context.prefix('dictation:');
    for(const draft of context.scan('entities','kind=?',['draft']))if(draft.value.conversationId===conversationId){const plan=this.planHistoricalDraft(context,draft,dictation);context.entry(1+plan.ids.length);draftIds.push(draft.raw.id);dictationIds.push(...plan.ids);}
    const prefixes=['assistant:plan:','assistant:operation:','assistant:queue:','assistant:message-pin:','assistant:approval:','assistant:question:','assistant:edit:','assistant:continuation:','assistant:research-progress:'];
    for(const prefix of prefixes)for(const row of context.prefix(prefix))if(row.value.conversationId===conversationId){const id=row.raw.id.slice(prefix.length);if(!ownedReceiptIds.includes(id)){context.entry();ownedReceiptIds.push(id);}context.delete(row);}
    for(const call of context.prefix('voice:attempt:'))if(call.value.target.conversation.id===conversationId){const id=this.checkRemovalOwnedKey(context,call,'voice:attempt:');for(const row of context.prefix('voice:consult-intent:'+id+':'))context.delete(row);context.delete(call);}
    this.planHistoricalReceipts(context,{draftIds,dictationIds,ownedReceiptIds,conversationId});
    for(const prefix of ['assistant:history:','assistant:retained-history:','assistant:transcript-state:','assistant:conversation:']){const row=context.service(prefix+conversationId);if(row)context.delete(row);}
    for(const row of context.prefix('assistant:transcript:'+conversationId+':'))context.delete(row);context.cursor(draftIds.length+1);
  }
  private clearReceipts(matches: (value: any) => boolean, removedWork: 'draft' | 'conversation') {
    this.assertWriteContext();
    const protectedIds = protectedFeedReceiptIds(verifyFeedStoreLedger(this.feedMutationLedger()));
    let after = '';
    for (;;) {
      const rows = this.db.prepare('SELECT request_id,payload FROM receipts WHERE request_id>? ORDER BY request_id LIMIT 100').all(after) as { request_id: string; payload: Uint8Array }[];
      for (const row of rows) if (!protectedIds.has(row.request_id)) {const value=this.open(`receipt:${row.request_id}`,row.payload);if(value?.type!=='feed-automatic-transition'&&matches(value))this.db.prepare('UPDATE receipts SET payload=? WHERE request_id=?').run(this.seal(`receipt:${row.request_id}`, { removedWork }), row.request_id);}
      if (rows.length < 100) break; after = rows.at(-1)!.request_id;
    }
  }
  /** Deletion retains only a revision boundary; a later draft is new work. */
  private removeDraftData(draft: Entity<Draft>): DraftRemoval {
    this.assertWriteContext();
    this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(draft.id);
    this.db.prepare('DELETE FROM entities WHERE id=? AND kind=?').run(draft.id, 'draft');
    this.db.prepare('DELETE FROM history WHERE entity_id=?').run(draft.id);
    this.internalDelete(`assistant:draft-organization:${draft.id}`);
    const dictationIds = new Set(this.internalList<{ id: string; draftId: string }>('dictation:').filter(a => a.draftId === draft.id).map(a => a.id));
    for (const id of dictationIds) this.internalDelete(`dictation:${id}`);
    this.clearReceipts(value => !!(value?.id === draft.id && value.value !== undefined || value?.id && dictationIds.has(value.id)), 'draft');
    const removed = this.internalWrite(`assistant:draft-removed:${draft.id}`, { draftId: draft.id, revision: draft.revision + 1 });
    this.advanceCursor(); return removed;
  }
  /** Exact proof in this mutation transaction only. No token or cross-call cache
   * stands in for authenticated rows and every actual original receipt. */
  private withReceiptGraph<T>(consume:(graph:FeedReadGraph|undefined)=>T,pending=false):T{
    this.assertOrdinaryWritable();
    if(!this.mutationTransaction||!this.db.isTransaction)throw new Error('Receipt proof needs its original mutation transaction');
    if(this.historySequence)return this.historySequence.withGraph(pending?this.feedAdmission?.pending:undefined,consume);
    const schema=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(schema<60)return consume(undefined);
    if(schema!==60)throw new Error('Ordinary receipt mutation needs supported schema60');
    return withLegacyFeedReadGraph(pending?this.feedMutationLedger():this.internalFeedLedger(),hash,workerNativeIdentity,()=>canonical(this.internalFeedCacheToken()),consume);
  }
  private prepareReceipt(requestId:string,digest:string,device:string,allowClose=false) {
    if(this.capacityTransaction)this.capacityTransaction.checkReceipt(requestId,digest,device,this.historySequence!.budget);
    if(!this.derivingProtectedAdmission)this.historySequence?.reserveOrdinaryReceipt();
    return this.withReceiptGraph(graph=>{
      const reserved=graph?.reservedCloseCommands.get(requestId);
      if(!reserved)return undefined;
      if(!allowClose||reserved.deviceId!==device||reserved.request.command.epoch!==this.epoch||hash(canonical(protocolIntent(reserved.request)))!==digest)
        throw new Fault(409,'request_reserved','This request identity is reserved for its exact original Close acknowledgement.');
      return structuredClone(reserved);
    });
  }
  private validateReceiptValue(graph:FeedReadGraph|undefined,requestId:string,digest:string,device:string,result:unknown){
      if(this.capacityTransaction)this.capacityTransaction.checkReceipt(requestId,digest,device,this.historySequence!.budget);
      const admission=this.feedAdmission,pending=admission?.pending;
      if(graph?.reservedCloseCommands.has(requestId))throw new Fault(409,'request_reserved','The original Close acknowledgement has not been protected.');
      if(admission?.reservedClose){
        const original=graph?.originalRequests.get(requestId),local=graph?.locals.get(requestId);
        if(admission.requestId!==requestId||admission.deviceId!==device||admission.digest!==digest||
          !pending||pending.requestId!==requestId||pending.deviceId!==device||pending.digest!==digest||canonical(pending.value)!==canonical(result)||
          local?.kind!=='close-ack'||!original||original.deviceId!==device||canonical(original.request)!==canonical(admission.reservedClose.request)||canonical(original.receipt)!==canonical(pending))
          throw new Error('Reserved Close receipt needs its exact protected original acknowledgement');
      }
      if(isFeedReceipt(result)&&(!pending||pending.requestId!==requestId||pending.deviceId!==device||pending.digest!==digest||canonical(pending.value)!==canonical(result)))
        throw new Error('Feed receipt has no protected original admission');
      if(graph)this.feedReceiptTouched=true;
  }
  private receipt(requestId:string,digest:string,device:string,result:unknown){
    this.withReceiptGraph(graph=>this.validateReceiptValue(graph,requestId,digest,device,result),true);
    if(this.removalContext){const context:HistoryRemovalContext=this.removalContext,reservation=this.removalReceipt;context.need(!!reservation&&!reservation.consumed&&reservation.requestId===requestId&&reservation.deviceId===device&&reservation.digest===digest&&reservation.valueJson===JSON.stringify(result),'Original removal receipt changed','history_removal_receipt');reservation!.consumed=true;}
    const payload=this.reservedFeedReceiptPayload??this.historySequence?.apply([],{requestId,deviceId:device,digest,value:result})??this.seal(`receipt:${requestId}`,result);
    this.removalSql('INSERT INTO receipts VALUES (?,?,?,?)').run(requestId,digest,device,payload);
    this.reservedFeedReceiptPayload=undefined;
  }
  private validateDraftBranch(deviceId:string,cmd:Command,value:Draft,read:<T>(id:string)=>T|undefined){
    const removed=read<DraftRemoval>(`assistant:draft-removed:${cmd.entityId}`);
    if(removed&&cmd.expectedRevision<removed.revision)throw new Fault(409,'draft_removed','This draft was removed. Keep any new writing as a new draft only after reviewing it.');
    const conversationId=value.conversationId,expectedId=conversationId?`draft:${deviceId}:${conversationId}`:spaceDraftId(deviceId,assistantSpace(value));
    if(cmd.entityId!==expectedId)throw new Fault(403,'draft_branch','Continue a copy in your own device draft.');
    if(conversationId){
      const removalId=read<string>(`assistant:removal-current:${conversationId}`),removal=removalId?read<{state:string}>(`assistant:removal:${removalId}`):undefined;
      if(removal&&['prepared','unknown','completed'].includes(removal.state))throw new Fault(409,'conversation_removing','This chat is being removed. Keep a separate copy of any new writing.');
      const conversation=read<{projectId:string|null;space?:AssistantSpace}>(`assistant:conversation:${conversationId}`);
      if(!conversation||conversation.projectId!==value.projectId||(value.space!==undefined&&assistantSpace(value)!==assistantSpace(conversation)))throw new Fault(409,'conversation_changed','This draft does not match the selected conversation and Project.');
    }
  }
  private validateDraftSources(draft:Draft,read:<T>(id:string)=>T|undefined,project:(id:string)=>unknown,blob:(id:string)=>Attachment,equal:(actual:Attachment,proposed:Attachment)=>boolean=(a,b)=>canonical(a)===canonical(b)){
    if(draft.projectId&&!project(draft.projectId))throw new Fault(409,'missing_project','The selected Project is unavailable. Your draft is kept.');
    if(draft.refineSource){
      const source=read<{version:number;projectId:string|null;file?:Attachment}>(`assistant:output:${draft.refineSource.outputId}`);
      if(!source||source.version!==draft.refineSource.version||source.projectId!==draft.projectId||source.file?.sha256!==draft.refineSource.sha256||!draft.attachments.some(a=>a.id===source.file?.id))throw new Fault(409,'output_source_changed','The exact output version must remain attached while refining it.');
    }
    for(const attachment of draft.attachments)if(!equal(blob(attachment.id),attachment))throw new Fault(409,'attachment_changed','An attachment could not be verified.');
  }
  private validateContentFields(item:Content,prior:Content|undefined,sourceAdmission:boolean,blob:(id:string)=>Attachment,equal:(a:unknown,b:unknown)=>boolean=(a,b)=>canonical(a)===canonical(b)){
    if(item.collection===undefined&&prior?.collection!==undefined)item.collection=prior.collection;
    if(item.tags===undefined&&prior?.tags!==undefined)item.tags=prior.tags;
    if(item.brandId===undefined&&prior?.brandId!==undefined)item.brandId=prior.brandId;
    if(!sourceAdmission&&!equal(item.source,prior?.source))throw new Fault(409,'source_changed','Keep the original source of this draft. Start from a saved output to link its exact version.');
    for(const file of item.assets??[])if(!equal(blob(file.id),file))throw new Fault(409,'attachment_changed','A linked Content file could not be verified.');
    if(item.source&&!item.assets?.some(file=>file.id===item.source!.fileId&&file.sha256===item.source!.sha256))throw new Fault(409,'attachment_changed','Keep the original source file with this draft.');
  }
  private verifyProducerOpen(){
    return this.internalReadSnapshot(()=>{const budget=new MutationPlanBudget(completionFixtureLimits);
      return withActualProducerCompletionContext(this.producerCompletionOwner(),budget,{kind:'stored-slot'},actual=>{
        const reader=producerMemoReader(actual.reader,budget);producerFacts(reader,budget,actual.stored);
      });
    });
  }
  /** Returns copied custody facts, never a current automatic permission. */
  private readProducer(owner:string,raw:unknown,reconcile:boolean,currentJob=false){
    if(!this.#producerCapacity)throw Error('Producer source route is not enabled');this.assertNotDeriving();
    return this.internalReadSnapshot(()=>{
      const budget=new MutationPlanBudget(completionFixtureLimits),context:DraftCapacityContext=new DraftCapacityContext({db:this.db,budget,limits:this.#historyWrite!.sequence,recordBytes:producerSlotBytes,
        guard:()=>{if(!this.db.isTransaction)throw Error('Producer read ended');},openText:(aad,payload)=>this.openText(aad,payload),seal:()=>{throw Error('Producer read cannot encrypt');}});
      try{const work:ProducerWork=new ProducerWork(budget);context.key(owner);context.need(/^[0-9a-f-]{36}$/i.test(owner),'Producer owner required');
        const owned=context.capture(raw),input=context.child(owned,()=>reconcile?producerReconcileSchema.parse(owned):producerReadSchema.parse(owned));
        context.need(input.epoch===context.meta('epoch'),'Producer epoch changed');
        return withActualProducerCompletionContext(this.producerCompletionOwner(),budget,{kind:'stored-slot'},actual=>{
          const reader=producerMemoReader(actual.reader,budget),facts=currentJob?producerCurrentFacts(reader,budget,actual.stored):producerFacts(reader,budget,actual.stored);
          const job=actual.state?.pending??actual.state?.checkpoint?.job;
          work.need(!job||job.deviceId===owner&&job.epoch===input.epoch,'Producer current owner changed');
          work.slots(2,256);
          if(currentJob){work.slots(8,512);return budget.copy({format:1,state:facts.state??null,stateSha256:work.hash(facts.state??null),remainingGrowth:facts.remainingGrowth,
            maximumSingleTransitionOverlap:facts.maximumSingleTransitionOverlap,currentJob:(facts as ProducerCurrentFacts).currentJob});}
          if(!reconcile)return budget.copy({format:1,state:facts.state??null,stateSha256:work.hash(facts.state??null),remainingGrowth:facts.remainingGrowth,maximumSingleTransitionOverlap:facts.maximumSingleTransitionOverlap});
          const c=input as ReturnType<typeof producerReconcileSchema.parse>,pending=actual.state?.pending;
          work.need(pending&&c.expectedRevision===actual.state!.revision&&c.expectedSha256===work.hash(actual.state),'Producer reconciliation predecessor changed');
          const proof=new ProducerProof(reader,budget,actual.state);work.slots(2,256);let command:ProducerTransition|undefined;
          if(c.kind==='save-admission'){work.need(pending!.phase==='starting','Producer reconciliation phase');const admission=proof.admission(pending!);if(admission)command={...c,kind:c.kind,command:pending!.command!,admission};}
          else{work.need(pending!.phase!=='preparing','Producer preparation remains unknown');const releaseProof=proof.release(pending!);if(releaseProof)command={...c,kind:c.kind,releaseFromPhase:pending!.phase,releaseProof};}
          return budget.copy(command?{state:'confirmed',command}:{state:'unknown'});
        });
      }finally{context.close();}
    });
  }
  internalReadFeedProducerState(owner:string,raw:unknown){return this.readProducer(owner,raw,false);}
  /** Authenticated saved-job facts only; no current eligibility or effect permission. */
  internalReadFeedProducerCurrentJob(owner:string,raw:unknown){return this.readProducer(owner,raw,false,true);}
  internalReconcileFeedProducer(owner:string,raw:unknown){
    const value=this.readProducer(owner,raw,true) as {state:string;command?:ProducerTransition};
    if(!value.command)return value;return this.internalTransitionFeedProducer(owner,value.command);
  }
  internalTransitionFeedProducer(owner:string,raw:unknown){
    if(!this.#producerCapacity)throw Error('Producer source route is not enabled');this.assertWriteContext(true);
    return this.transaction(()=>{
      const sequence=this.historySequence!,capacity=this.capacityTransaction!,budget=sequence.budget;
      const context:DraftCapacityContext=new DraftCapacityContext({db:this.db,budget,limits:this.#historyWrite!.sequence,recordBytes:producerSlotBytes,
        guard:()=>{sequence.checked(()=>undefined);if(this.feedFailure)throw this.feedFailure.error;},openText:(aad,payload)=>this.openText(aad,payload),seal:(aad,value)=>this.seal(aad,value)});
      try{const work:ProducerWork=new ProducerWork(budget);context.key(owner);context.need(/^[0-9a-f-]{36}$/i.test(owner),'Producer owner required');
        const owned=context.capture(raw),command=work.parseCommand(owned);context.need(command.epoch===context.meta('epoch'),'Producer epoch changed');
        const digest=work.hash(work.intent(command)),old=context.row('receipts',command.requestId);
        if(old){context.need(old.raw.device_id===owner&&old.raw.digest===digest,'Producer request identity reused');
          work.replay(old.value,command,owner);sequence.withGraph(undefined,()=>undefined);capacity.replay();context.slots(1,64);return {fresh:false,value:budget.copy(old.value)};}
        const plan=capacity.prepareProducer(owner,command);context.need(plan.digest===digest,'Producer prepared intent changed');
        context.need(historyJsonBytes(plan.value,producerReceiptBytes)<=producerReceiptBytes,'Producer receipt bound');context.slots(8,512);
        const pending=sequence.preparePending({requestId:command.requestId,deviceId:owner,digest,value:plan.value});
        let payload:Buffer|undefined,receipt:Buffer|undefined;
        capacity.withPendingEffects('producer',pending,sequence,()=>{
          payload=context.encrypted('service:'+producerKey,plan.after);receipt=context.encrypted('receipt:'+command.requestId,plan.value);
          capacity.beforeProducerEffects({receipt:pending,ciphertextBytes:receipt.byteLength},{state:plan.after,ciphertextBytes:payload.byteLength},plan.before?.ciphertextBytes??0);
        },plan);
        capacity.assertEffectsReady();context.need(payload&&receipt,'Producer prepared ciphertext missing');
        const changed=plan.before?context.query('UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?').run(plan.after.revision,payload,producerKey,plan.before.raw.revision,plan.before.raw.payload):
          context.query('INSERT INTO service_records(id,revision,payload) VALUES (?,?,?)').run(producerKey,plan.after.revision,payload!);
        context.need(changed.changes===1,'Producer conditional predecessor changed');
        context.need(context.query('INSERT INTO receipts(request_id,digest,device_id,payload) VALUES (?,?,?,?)').run(command.requestId,digest,owner,receipt).changes===1,'Producer transition receipt changed');
        context.guard();return {fresh:true,value:budget.copy(plan.value)};
      }catch(error){this.feedFailure??={error};throw error;}finally{context.close();}
    },historyProducerTransaction);
  }
  /** Closed draft/Content commands only. No caller callback gets a write permit. */
  private mutateCapacityDraft(deviceId:string,raw:unknown):Entity<unknown>{
    this.assertWriteContext(true);
    const execute=()=>this.transaction(()=>{
      const sequence=this.historySequence!,capacity=this.capacityTransaction!;
      const context:DraftCapacityContext=new DraftCapacityContext({db:this.db,budget:sequence.budget,limits:this.#historyWrite!.sequence,recordBytes:this.historyReviewLimits!.objectBytes,
        guard:()=>{sequence.checked(()=>undefined);if(this.feedFailure)throw this.feedFailure.error;},openText:(aad,payload)=>this.openText(aad,payload),seal:(aad,value)=>this.seal(aad,value)});
      const read=<T>(id:string)=>context.row('service_records',id)?.value as T|undefined;
      const readonly:DerivationContext={open:true,failed:false};
      try{
        const plan=this.feedDerivation.run(readonly,()=>context.checked(()=>{
          context.key(deviceId);
          const owned=context.capture(raw),cmd=context.child(owned,()=>commandSchema.parse(owned));
          const kind=cmd.kind;
          if(!['draft','content','task'].includes(kind)||kind==='content'&&!this.#contentCapacity||kind==='task'&&!this.#taskCapacity)throw new Fault(409,'history_capacity_route_held','This writer awaits its complete capacity integration.');
          context.slots(1,64);const parseContent=(input:unknown):Content=>{
            // The unchanged validator has at most17 offset probes and17
            // distinct-offset checks. Reserve its logical work before parsing.
            context.slots(128,16384);
            if(input!==null&&typeof input==='object'&&(input as {plannedTime?:unknown}).plannedTime)context.slots(4096,262144);
            return context.child(input,()=>contentSchema.parse(input));
          };
          let cataloguePlan:ReturnType<TaskCatalogueCustody['prepare']>|undefined;
          if(kind==='task'&&this.#taskCatalogue)context.slots(2,96);
          const taskPlanner=kind==='task'?new TaskCapacityPlanner(context,()=>this.now(),(status,code,message)=>new Fault(status,code,message),this.#taskCatalogue?{assertTrash:id=>cataloguePlan!.assertTrash(id)}:undefined):undefined;
          let value:Draft|Content|Task=kind==='draft'?sequence.budget.copy(context.child(cmd.payload,()=>draftSchema.parse(cmd.payload))):taskPlanner?taskPlanner.parse(cmd.payload):parseContent(cmd.payload);
          const digest=context.child(cmd,()=>hash(canonical(cmd)));
          const epoch=context.meta('epoch');context.need(epoch!==undefined&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(epoch),'Draft epoch malformed');
          if(cmd.epoch!==epoch)throw new Fault(409,'epoch_changed','The host was recovered or replaced. Review your kept work before saving again.');
          if(kind==='draft')context.child(value,()=>this.validateDraftBranch(deviceId,cmd,value as Draft,read));
          const replay=context.row('receipts',cmd.requestId);
          if(replay){
            if(replay.raw.digest!==digest||replay.raw.device_id!==deviceId)throw new Fault(409,'request_reused','This request identity was already used for different work.');
            if(replay.value?.removedWork)throw new Fault(409,`${replay.value.removedWork}_removed`,'This saved work was removed. Its old request cannot restore it.');
            sequence.withGraph(undefined,()=>undefined);capacity.replay();context.slots(1,48);return {replay:replay.value} as const;
          }
          // Initial N1 proof occurs only after the exact occupied-original branch.
          if(taskPlanner&&this.#taskProducerCapacity){
            if(capacity.initialTaskRequest(cmd.requestId,digest,deviceId,sequence.budget))throw new Fault(409,'request_reserved','This request identity is reserved for its exact original Close acknowledgement.');
          }else{
            capacity.initial();
            capacity.checkReceipt(cmd.requestId,digest,deviceId,sequence.budget);
            sequence.withGraph(undefined,graph=>{if(graph.reservedCloseCommands.has(cmd.requestId))throw new Fault(409,'request_reserved','This request identity is reserved for its exact original Close acknowledgement.');});
          }
          if((kind==='content'||kind==='task')&&!cmd.entityId.startsWith(kind+':'))throw new Fault(400,'invalid_target','Invalid record identity.');
          const current=context.row('entities',cmd.entityId,kind),removed=current||kind!=='draft'?undefined:read<DraftRemoval>(`assistant:draft-removed:${cmd.entityId}`);
          const revision=current?.raw.revision??removed?.revision??0;
          context.need(Number.isSafeInteger(revision)&&revision>=0&&revision<Number.MAX_SAFE_INTEGER,'Draft revision exhausted');
          if(revision!==cmd.expectedRevision)throw new Fault(409,'revision_conflict','Another window saved a newer version. Your proposal is kept.',current?.value);
          if(kind==='task'&&this.#taskCatalogue)cataloguePlan=this.#taskCatalogue.prepare(context);
          if(kind==='draft')context.child(value,()=>this.validateDraftSources(value as Draft,read,id=>context.row('entities',id,'project'),id=>{
              const row=context.row('blobs',id);if(!row)throw new Fault(404,'attachment_missing','This attachment is unavailable.');return row.value;
            },(actual,proposed)=>{context.slots(3,32);const inputs=[actual,proposed];return context.child(inputs,()=>canonical(actual)===canonical(proposed));}));
          else if(kind==='task')value=sequence.budget.copy(taskPlanner!.normalize(cmd.entityId,value as Task,current));
          else{
            const item=value as Content,prior=current?.value as Content|undefined;
            if(item.projectId&&!context.row('entities',item.projectId,'project'))throw new Fault(409,'missing_project','Choose an available Project.');
            if(!current){const count=context.scalar("SELECT count(*) AS count FROM entities WHERE kind='content'");context.need(Number.isSafeInteger(count.count)&&count.count>=0,'Content quota scalar invalid');if(count.count>=2000)throw new Fault(507,'record_quota','This module has reached its saved-record limit. Existing work is kept.');}
            context.slots(5,128);const keys=['collection','tags','brandId'] as const,inherited:(typeof keys)[number][]=[];
            for(const key of keys)if(item[key]===undefined&&prior?.[key]!==undefined){context.slots(1,16);inherited.push(key);}
            context.slots(3,32);const inputs=[item,prior??null];
            context.child(inputs,()=>this.validateContentFields(item,prior,false,id=>{
              const row=context.row('blobs',id);if(!row)throw new Fault(404,'attachment_missing','This attachment is unavailable.');return row.value;
            },(actual,proposed)=>{context.slots(3,32);const pair=[actual??null,proposed??null];return context.child(pair,()=>canonical(actual)===canonical(proposed));}));
            if(inherited.length){const parsed=parseContent(item);
              for(const key of inherited){const a=item[key],b=parsed[key];context.slots(1,32);
                if(key==='tags'){context.need(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length,'Inherited Content metadata changed');for(let i=0;i<a.length;i++){context.slots(1,16);context.need(a[i]===b[i],'Inherited Content metadata changed');}}
                else context.need(a===b,'Inherited Content metadata changed');
              }value=parsed;
            }
            value=sequence.budget.copy(value);
          }
          const cursor=context.cursor();context.slots(2,16);const beforeRefs=kind==='task'?[]:context.refs(cmd.entityId),nextRefs:string[]=[];
          for(const attachment of kind==='task'?[]:kind==='draft'?(value as Draft).attachments:(value as Content).assets??[]){context.key(attachment.id);context.need(!nextRefs.includes(attachment.id),'Duplicate saved attachment reference');context.slots(1,16);nextRefs.push(attachment.id);}
          context.slots(3,256);const result:Entity<Draft|Content|Task>=Object.freeze({id:cmd.entityId,revision:revision+1,updatedAt:new Date().toISOString(),deviceId:current?.raw.device_id??deviceId,value});
          context.slots(1,16);let services:readonly TaskServiceChange[]=taskPlanner&&!this.#taskProducerCapacity?taskPlanner.services(result as Entity<Task>,current):[];
          const pending=kind==='task'&&!this.#taskProducerCapacity?sequence.budget.copy({requestId:cmd.requestId,deviceId,digest,value:result}):sequence.preparePending({requestId:cmd.requestId,deviceId,digest,value:result});
          let entity:Buffer|undefined,history:Buffer|undefined,receipt:Buffer|undefined;
          context.slots(1,64);const prepare=()=>{
            entity=context.encrypted('entity:'+cmd.entityId,value);history=context.encrypted('history:'+cmd.entityId+':'+result.revision,result);receipt=context.encrypted('receipt:'+cmd.requestId,result);
            const catalogue=cataloguePlan?.prepare(cmd.entityId,revision,value as Task,entity);
            let newReferenceEntries=0;for(const id of nextRefs)if(!beforeRefs.includes(id))newReferenceEntries++;
            context.slots(2,256);const footprint={previousEntityBytes:current?.raw.payload.byteLength??0,entityBytes:entity.byteLength,historyBytes:history.byteLength,receiptBytes:receipt.byteLength,
              baseNewEntries:(current?0:1)+2+(cursor.meta===undefined?1:0),previousReferences:beforeRefs.length,nextReferences:nextRefs.length,newReferenceEntries};
            if(kind==='draft')capacity.beforeDraftEffects(Object.freeze({receipt:pending,ciphertextBytes:receipt.byteLength}),footprint);
            else if(taskPlanner){
              const prepared=Object.freeze({receipt:pending,ciphertextBytes:receipt.byteLength}),taskFootprint=Object.freeze({...footprint,taskId:cmd.entityId,taskRevision:result.revision,...taskPlanner.footprint(services)});
              if(this.#taskProducerCapacity)capacity.beforeComposedTaskEffects(prepared,taskFootprint,catalogue);else capacity.beforeTaskEffects(prepared,taskFootprint);
            }
            else capacity.beforeContentEffects(Object.freeze({receipt:pending,ciphertextBytes:receipt.byteLength}),footprint);
          };
          if(taskPlanner&&!this.#taskProducerCapacity){
            // Preserve the separately qualified, producer-absent Task route.
            sequence.withGraph(pending,graph=>this.validateReceiptValue(graph,cmd.requestId,digest,deviceId,result));prepare();
          }else capacity.withPendingEffects(kind==='task'?'task':kind==='draft'?'draft':'content',pending,sequence,graph=>{
            this.validateReceiptValue(graph,cmd.requestId,digest,deviceId,result);
            if(taskPlanner)services=taskPlanner.services(result as Entity<Task>,current);
            prepare();
          });
          capacity.assertEffectsReady();context.need(entity&&history&&receipt,'Prepared entity ciphertext missing');
          context.slots(1,256);return {cmd,kind,digest,current,cursor,beforeRefs,nextRefs,result,entity:entity!,history:history!,receipt:receipt!,services,cataloguePlan} as const;
        }));
        readonly.open=false;if(readonly.failed)throw readonly.failure;
        if('replay'in plan)return plan.replay;
        capacity.assertEffectsReady();
        const {cmd,current,cursor,result}=plan;
        // The complete immutable plan is prepared; every SQL sink is explicit.
        const entity=current?
          context.query('UPDATE entities SET revision=?,updated_at=?,payload=? WHERE id=? AND kind=? AND revision=? AND device_id=? AND updated_at=? AND payload=?').run(result.revision,result.updatedAt,plan.entity,cmd.entityId,plan.kind,current.raw.revision,current.raw.device_id,current.raw.updated_at,current.raw.payload):
          context.query('INSERT INTO entities(id,kind,revision,device_id,updated_at,payload) VALUES (?,?,?,?,?,?)').run(cmd.entityId,plan.kind,result.revision,result.deviceId,result.updatedAt,plan.entity);
        context.need(entity.changes===1,'Draft entity predecessor changed');
        const history=context.query('INSERT INTO history(entity_id,revision,payload) VALUES (?,?,?)').run(cmd.entityId,result.revision,plan.history);
        context.need(history.changes===1&&Number(history.lastInsertRowid)===cursor.history,'Draft history cursor changed');
        const cursorWrite=cursor.meta===undefined?context.query("INSERT INTO meta(key,value) VALUES ('workspace-cursor',?)").run(String(cursor.next)):
          context.query("UPDATE meta SET value=? WHERE key='workspace-cursor' AND value=?").run(String(cursor.next),cursor.meta);
        context.need(cursorWrite.changes===1,'Draft workspace cursor changed');
        if(plan.kind==='task'){
          for(const change of plan.services){const before=change.previous;
            const written=before?context.query('UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?').run(before.raw.revision+1,change.payload,change.key,before.raw.revision,before.raw.payload):
              context.query('INSERT INTO service_records(id,revision,payload) VALUES (?,?,?)').run(change.key,1,change.payload);
            context.need(written.changes===1,'Task service predecessor changed');
          }
        }else{
          const beforeRefs=context.refs(cmd.entityId);context.need(beforeRefs.length===plan.beforeRefs.length&&beforeRefs.every((id,i)=>id===plan.beforeRefs[i]),'Draft reference predecessor changed');
          context.need(context.query('DELETE FROM blob_refs WHERE entity_id=?').run(cmd.entityId).changes===plan.beforeRefs.length,'Draft reference deletion changed');
          for(const id of plan.nextRefs)context.need(context.query('INSERT INTO blob_refs VALUES (?,?)').run(cmd.entityId,id).changes===1,'Draft reference insertion changed');
        }
        context.need(context.query('INSERT INTO receipts VALUES (?,?,?,?)').run(cmd.requestId,plan.digest,deviceId,plan.receipt).changes===1,'Draft original receipt changed');
        plan.cataloguePlan?.applyAndVerify();
        context.guard();return result;
      }catch(error){this.feedFailure??={error};throw error;}finally{readonly.open=false;context.close();}
    },historyDraftTransaction);
    return this.#taskCatalogue?this.#taskCatalogue.mutation(execute):execute();
  }
  mutate(deviceId: string, raw: Command): Entity<unknown> {
    if(this.#draftCapacity)return this.mutateCapacityDraft(deviceId,raw);
    this.assertWriteContext();
    const cmd = commandSchema.parse(raw); const value = schemas[cmd.kind].parse(cmd.payload);
    const digest = hash(canonical(cmd));
    return this.transaction(() => {
      if (cmd.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The host was recovered or replaced. Review your kept work before saving again.');
      if (cmd.kind === 'layout' && cmd.entityId !== 'layout') throw new Fault(400, 'invalid_target', 'Invalid layout identity.');
      if(cmd.kind==='draft')this.validateDraftBranch(deviceId,cmd,value as Draft,<T>(id:string)=>this.internalRead<T>(id));
      const previous = this.replay(cmd.requestId, digest, deviceId); if (previous) return previous as Entity<unknown>;
      this.prepareReceipt(cmd.requestId,digest,deviceId);
      if (cmd.kind !== 'layout' && !cmd.entityId.startsWith(`${cmd.kind}:`)) throw new Fault(400, 'invalid_target', 'Invalid record identity.');
      const current = this.get(cmd.kind, cmd.entityId);
      const currentRevision = current?.revision ?? (cmd.kind === 'draft' ? this.internalRead<DraftRemoval>(`assistant:draft-removed:${cmd.entityId}`)?.revision : 0) ?? 0;
      if (currentRevision !== cmd.expectedRevision) throw new Fault(409, 'revision_conflict', 'Another window saved a newer version. Your proposal is kept.', current);
      // Older layout editors do not know the icon field and cannot reset it.
      if (cmd.kind === 'layout' && (cmd.payload as Partial<Layout>).appIcon === undefined) (value as Layout).appIcon = (current?.value as Layout | undefined)?.appIcon ?? 'red';
      // Original receipts and revision conflicts above retain their authority.
      // The marker's existence retires widget writes even if its body needs review.
      if (cmd.kind === 'layout' && current && this.db.prepare('SELECT 1 FROM service_records WHERE id=?').get(homeWidgetPreservationKey) &&
        canonical((value as Layout).widgets) !== canonical((current.value as Layout).widgets)) {
        throw new Fault(409, 'revision_conflict', 'Home widgets are retired. Your full original proposal is kept; recover its writing in Library before reviewing other Appearance changes.', current);
      }
      if (isRecordKind(cmd.kind)) this.validateRecord(cmd.kind, cmd.entityId, value as RecordValue, current as Entity<RecordValue> | undefined);
      if (cmd.kind === 'project') {
        const project = value as Project, previousProject = current?.value as Project | undefined;
        // Older forms must not change the kind of a Project or drop new context.
        project.space ??= previousProject?.space;
        project.instructions ??= previousProject?.instructions;
        project.workspace ??= previousProject?.workspace;
        if (previousProject && assistantSpace(previousProject) !== assistantSpace(project)) throw new Fault(409, 'project_space', 'Create a separate Project in the other space. Existing conversations stay with their Project.');
        if (assistantSpace(project) === 'chat' && project.workspace) throw new Fault(400, 'project_workspace', 'Chat Projects use shared sources. Create a Work Project for a working folder.');
        if (assistantSpace(project) === 'work') {
          const chosen = project.workspace?.folder.trim();
          const folder = chosen || join(this.directory, 'work-projects', hash(cmd.entityId));
          if (!isAbsolute(folder)) throw new Fault(400, 'project_folder', 'Enter an absolute path to an existing folder.');
          if (!chosen) mkdirSync(folder, { recursive: true, mode: 0o700 });
          try { if (!statSync(folder).isDirectory()) throw Error(); project.workspace = { folder: realpathSync(folder), environment: project.workspace?.environment ?? 'local' }; }
          catch { throw new Fault(400, 'project_folder', 'This working folder is unavailable on this host. Choose an existing folder.'); }
          if (project.workspace.environment === 'worktree') {
            try { execFileSync('git', ['-C', project.workspace.folder, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); }
            catch { throw new Fault(400, 'project_repository', 'Worktrees need a Git repository with at least one commit. Use Local for this folder.'); }
          }
          if (previousProject?.workspace && canonical(previousProject.workspace) !== canonical(project.workspace) && this.internalList<{ projectId: string | null }>('assistant:conversation:').some(c => c.projectId === cmd.entityId)) throw new Fault(409, 'project_bound', 'This folder is already linked to saved work. Create another Work Project to use a different folder or environment.');
        }
        // An older form that does not know source files cannot remove them.
        const previousFiles = (current?.value as Project | undefined)?.attachments;
        if (previousFiles) project.attachments ??= previousFiles;
        for (const attachment of project.attachments ?? []) if (canonical(this.blobMetadata(attachment.id)) !== canonical(attachment)) throw new Fault(409, 'attachment_changed', 'A Project source could not be verified. Choose it again.');
      }
      if(cmd.kind==='draft')this.validateDraftSources(value as Draft,<T>(id:string)=>this.internalRead<T>(id),id=>this.get('project',id),id=>this.blobMetadata(id));
      if (cmd.kind === 'routine') this.validateRoutine(cmd.entityId, value as Routine, current as Entity<Routine> | undefined);
      if (cmd.kind === 'task') { Object.assign(value, syncTaskSubtasks(value as Task, current?.value as Task | undefined)); this.validateTask(cmd.entityId, value as Task, current as Entity<Task> | undefined); }
      const result = this.write(cmd.kind, cmd.entityId, current?.deviceId ?? deviceId, value, currentRevision + 1);
      if (cmd.kind === 'agent') this.syncHubLayout();
      if (cmd.kind === 'task') { this.recordTask(result as Entity<Task>, current as Entity<Task> | undefined); this.syncReminder(result as Entity<Task>, current as Entity<Task> | undefined); }
      if (cmd.kind === 'routine') {
        this.internalWrite(`tasks:routine-event:${cmd.entityId}:${result.revision}`, { id: `${cmd.entityId}:${result.revision}`, routineId: cmd.entityId, revision: result.revision, at: new Date(this.now()).toISOString(), state: (value as Routine).state } satisfies RoutineEvent);
        this.materializeRoutine(result as Entity<Routine>);
      }
      if (cmd.kind === 'draft' || cmd.kind === 'project' || cmd.kind === 'content') {
        this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(cmd.entityId);
        const files = cmd.kind === 'draft' ? (value as Draft).attachments : cmd.kind === 'project' ? (value as Project).attachments ?? [] : (value as Content).assets ?? [];
        for (const attachment of files) this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(cmd.entityId, attachment.id);
      }
      this.receipt(cmd.requestId, digest, deviceId, result);
      return result;
    });
  }
  private validateRecord(kind: RecordKind, id: string, value: RecordValue, current?: Entity<RecordValue>, sourceAdmission = false) {
    if (kind === 'contact') {
      const item = value as Contact, previous = current?.value as Contact | undefined;
      // Older forms cannot erase fields they did not receive. Null explicitly removes a photo.
      if (item.photo === undefined && previous?.photo !== undefined) item.photo = previous.photo;
      if (item.otherOrganizations === undefined && previous?.otherOrganizations !== undefined) item.otherOrganizations = previous.otherOrganizations;
      for (const field of ['pipelineStage', 'keepInTouch', 'relationships'] as const) if (item[field] === undefined && previous?.[field] !== undefined) Object.assign(item, { [field]: previous[field] });
      const relationships = new Set<string>();
      for (const relation of item.relationships ?? []) {
        const other = this.get('contact', relation.contactId);
        const key = relation.kind + ':' + relation.contactId;
        if (!other || relation.contactId === id || relationships.has(key)) throw new Fault(400, 'invalid_relationship', 'Choose another saved contact and keep each relationship once.');
        relationships.add(key);
      }
      if (item.photo) {
        const file = this.download(item.photo.id);
        if (canonical(file.metadata) !== canonical(item.photo) || !imagePreviewType(file.bytes, 512 * 512)) throw new Fault(409, 'attachment_changed', 'This contact photo could not be verified. Choose it again.');
      }
    }
    if (kind === 'contact' && !sourceAdmission && canonical((value as Contact).mailSources) !== canonical((current?.value as Contact | undefined)?.mailSources)) throw new Fault(409, 'source_changed', 'Keep the original email links. Add another from its sender in Inbox.');
    if (kind === 'contact' && !sourceAdmission && ((current?.value as Contact | undefined)?.mergedInto || canonical((value as Contact).mergedInto) !== canonical((current?.value as Contact | undefined)?.mergedInto))) throw new Fault(409, 'contact_merged', 'Open the combined contact or restore this one as a separate contact.');
    if (kind === 'profile' && id !== 'profile:owner') throw new Fault(400, 'invalid_target', 'The personal profile has one workspace identity.');
    if ('projectId' in value && value.projectId && !this.get('project', value.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
    if (!current && Number(this.db.prepare('SELECT count(*) AS count FROM entities WHERE kind=?').get(kind)?.count) >= 2000) throw new Fault(507, 'record_quota', 'This module has reached its saved-record limit. Existing work is kept.');
    if (kind === 'content') {
      this.validateContentFields(value as Content,current?.value as Content|undefined,sourceAdmission,id=>this.blobMetadata(id));
    }
    if (kind === 'assignment') {
      const plan = value as Assignment, prior = current?.value as Assignment | undefined;
      const agent = this.get('agent', plan.agentId);
      if (!agent) throw new Fault(409, 'missing_agent', 'Choose a saved agent design.');
      if ((!prior || plan.agentId !== prior.agentId || plan.agentRevision !== prior.agentRevision) && (agent.value.archived || agent.revision !== plan.agentRevision)) throw new Fault(409, 'agent_changed', 'The agent design changed. Review its current version before choosing it.');
      for (const source of plan.sources ?? []) {
        if (prior?.sources?.some(s => canonical(s) === canonical(source))) continue;
        const record = this.get(source.kind, source.id);
        if (!record || record.value.archived || record.revision !== source.revision) throw new Fault(409, 'assignment_source_changed', 'A selected source changed. Review its saved version before choosing it.');
      }
    }
  }
  taskHistory(raw: unknown) {
    const input = taskHistorySchema.parse(raw);
    if (!this.get('task', input.taskId)) throw new Fault(404, 'task_missing', 'This task is unavailable.');
    const rows = this.db.prepare('SELECT revision,payload FROM history WHERE entity_id=? AND revision<? ORDER BY revision DESC LIMIT 25').all(input.taskId, input.beforeRevision ?? Number.MAX_SAFE_INTEGER) as { revision: number; payload: Uint8Array }[];
    return { versions: rows.map(row => this.open(`history:${input.taskId}:${row.revision}`, row.payload) as Entity<Task>), beforeRevision: rows.length === 25 ? rows.at(-1)!.revision : null };
  }
  recordHistory(raw: unknown) {
    const input = recordHistorySchema.parse(raw);
    if (!this.get(input.kind, input.id)) throw new Fault(404, 'record_missing', 'This saved record is unavailable.');
    const rows = this.db.prepare('SELECT revision,payload FROM history WHERE entity_id=? AND revision<? ORDER BY revision DESC LIMIT 50').all(input.id, input.beforeRevision ?? Number.MAX_SAFE_INTEGER) as { revision: number; payload: Uint8Array }[];
    return { versions: rows.map(row => this.open(`history:${input.id}:${row.revision}`, row.payload) as Entity<RecordValue>), beforeRevision: rows.length === 50 ? rows.at(-1)!.revision : null };
  }
  createContentFromOutput(device: string, raw: unknown): Entity<Content> {
    const input = contentFromOutputSchema.parse(raw);
    return this.admit(device, input, { type: 'content.from-output', ...input }, () => {
      const output = this.internalRead<AssistantOutput>(`assistant:output:${input.outputId}`);
      if (!output || output.state !== 'ready' || output.version !== input.version || output.file?.sha256 !== input.sha256) throw new Fault(409, 'output_source_changed', 'Open the exact saved output before starting a Content draft.');
      const file = this.download(output.file.id);
      if (canonical(file.metadata) !== canonical(output.file)) throw new Fault(409, 'attachment_changed', 'The saved output file changed. Its draft was not created.');
      let body = '', importedText = false;
      if (!output.artifactId || output.mimeType === 'text/plain' || output.mimeType === 'text/markdown') {
        try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); if (text.length <= 100000) { body = text; importedText = true; } } catch { /* Retain the original bytes; never silently replace invalid UTF-8. */ }
      }
      const value = contentSchema.parse({ ...blankRecord('content', 'UTC'),
        title: (output.name.replace(/\.(md|txt)$/i, '').trim() || output.name).slice(0, 240), stage: 'drafting', body,
        format: output.mimeType === 'text/plain' || /\.txt$/i.test(output.name) ? 'text' : 'markdown', projectId: output.projectId,
        assets: [file.metadata], source: { outputId: output.id, version: output.version, sha256: file.metadata.sha256, conversationId: output.conversationId, nativeId: output.nativeId, messageId: output.messageId, messageHash: output.messageHash, fileId: file.metadata.id, name: output.name, importedText },
      });
      const id = `content:${randomUUID()}`;
      this.validateRecord('content', id, value, undefined, true);
      const record = this.write('content', id, device, value, 1);
      this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id, file.metadata.id);
      return record;
    }).value;
  }
  createContentFromAssignment(device: string, raw: unknown): Entity<Content> {
    const input = contentFromAssignmentSchema.parse(raw);
    return this.admit(device, input, { type: 'content.from-assignment', ...input }, () => {
      const attempt = this.internalRead<AssignmentAttempt>(`assignments:attempt:${input.attemptId}`);
      if (!attempt || attempt.epoch !== this.epoch || attempt.state !== 'returned' || attempt.terminal?.status !== 'ok' || !attempt.runId || !attempt.nativeSessionId || attempt.result?.disposition !== 'visible' || attempt.result.file.sha256 !== input.sha256) throw new Fault(409, 'assignment_result_changed', 'Choose an exact returned assignment result before starting a Content draft.');
      const file = this.download(attempt.result.file.id);
      if (canonical(file.metadata) !== canonical(attempt.result.file)) throw new Fault(409, 'attachment_changed', 'The saved assignment result file changed. No draft was created.');
      // Native replies are UTF-8; reject corrupt bytes rather than substituting
      // replacement characters. Larger results remain attached in full.
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
      catch { throw new Fault(409, 'assignment_result_changed', 'The result text could not be verified. Download the original file before continuing.'); }
      if (!text.trim()) throw new Fault(409, 'assignment_result_empty', 'This assignment returned no draft text. Its saved attempt is kept.');
      const importedText = text.length <= 100000;
      const value = contentSchema.parse({ ...blankRecord('content', 'UTC'), title: attempt.title, stage: 'drafting', body: importedText ? text : '', projectId: attempt.projectId,
        assets: [file.metadata], source: { kind: 'assignment', attemptId: attempt.id, version: 1, assignmentId: attempt.assignmentId, assignmentRevision: attempt.assignmentRevision, agentId: attempt.agentId, agentRevision: attempt.agentRevision, runId: attempt.runId, nativeId: attempt.nativeSessionId, turnId: attempt.terminal.turnId, sha256: file.metadata.sha256, fileId: file.metadata.id, name: file.metadata.name, importedText },
      });
      const id = `content:${randomUUID()}`;
      this.validateRecord('content', id, value, undefined, true);
      const record = this.write('content', id, device, value, 1);
      this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id, file.metadata.id);
      return record;
    }).value;
  }
  linkMailContact(device: string, raw: unknown, check: (review: MailContactReview) => void): Entity<Contact> {
    const input = mailContactLinkSchema.parse(raw);
    return this.admit(device, input, { type: 'mail.link-contact', ...input }, () => {
      const review = this.internalRead<MailContactReview>('mail:contact-review:' + input.reviewId);
      if (!review) throw new Fault(409, 'mail_contact_review', 'Review the original sender before linking a Contact.');
      check(review);
      const matches = this.list('contact').filter(item => !item.value.mergedInto && contactEmails(item.value).includes(contactEmailKey(review.source.sender)));
      const current = input.target.kind === 'existing' ? this.get('contact', input.target.id) : undefined;
      if (input.target.kind === 'new' && matches.length) throw new Fault(409, 'contact_matches_changed', 'A Contact with this email already exists. Review the matches before creating another.');
      if (input.target.kind === 'existing' && (!current || current.revision !== input.target.revision || current.value.archived || current.value.mergedInto || !contactEmails(current.value).includes(contactEmailKey(review.source.sender)))) throw new Fault(409, 'contact_matches_changed', 'This Contact changed. Review the matches before linking the email.');
      if (current?.value.mailSources?.some(source => mailContactSourceKey(source) === mailContactSourceKey(review.source))) return current;
      const id = current?.id ?? `contact:${randomUUID()}`;
      const base = current?.value ?? { ...blankRecord('contact', this.get('layout', 'layout')!.value.timezone), name: input.target.kind === 'new' ? input.target.name : review.name, email: review.source.sender };
      const value = contactSchema.parse({ ...base, mailSources: [...(current?.value.mailSources ?? []), review.source] });
      this.validateRecord('contact', id, value, current, true);
      return this.write('contact', id, device, value, (current?.revision ?? 0) + 1);
    }).value;
  }
  mergeContacts(device: string, raw: unknown): Entity<Contact> {
    const input = contactMergeSchema.parse(raw);
    return this.admit(device, input, { type: 'contacts.merge', ...input }, () => {
      const keep = this.get('contact', input.keep.id), other = this.get('contact', input.other.id);
      if (!keep || !other || keep.value.archived || other.value.archived || keep.value.mergedInto || other.value.mergedInto) throw new Fault(409, 'contact_changed', 'Choose two active, separate contacts.');
      if (keep.revision !== input.keep.revision || other.revision !== input.other.revision) throw new Fault(409, 'contact_changed', 'A contact changed. Review both current versions before combining.');
      const value = mergedContactValue(keep.value, other.value, input);
      if (value.relationships) value.relationships = value.relationships.filter(r => r.contactId !== keep.id && r.contactId !== other.id);
      this.validateRecord('contact', keep.id, value, keep, true);
      const result = this.write('contact', keep.id, keep.deviceId, value, keep.revision + 1);
      this.write('contact', other.id, other.deviceId, { ...other.value, archived: true, mergedInto: keep.id }, other.revision + 1);
      return result;
    }).value;
  }
  restoreContact(device: string, raw: unknown): Entity<Contact> {
    const input = contactRestoreSchema.parse(raw);
    return this.admit(device, input, { type: 'contacts.restore', ...input }, () => {
      const current = this.get('contact', input.contact.id);
      if (!current || current.revision !== input.contact.revision || !current.value.mergedInto) throw new Fault(409, 'contact_changed', 'Review the current combined contact before restoring it.');
      const { mergedInto: _target, ...value } = current.value;
      // Restore the retained original without removing information from the combined contact.
      return this.write('contact', current.id, current.deviceId, { ...value, archived: false }, current.revision + 1);
    }).value;
  }
  createRecordTask(device: string, raw: unknown): Entity<Task> {
    const input = recordTaskSchema.parse(raw);
    return this.admit(device, input, { type: 'record-follow-up', ...input }, () => {
      const origin = this.get(input.origin.kind, input.origin.id);
      if (!origin || origin.value.archived) throw new Fault(409, 'record_missing', 'Open an active saved record before creating a follow-up.');
      if (origin.revision !== input.origin.revision) throw new Fault(409, 'source_changed', 'The source changed. Review it before creating this follow-up.', origin);
      const id = `task:${randomUUID()}`;
      const value: Task = { title: input.title, notes: '', status: 'open', planned: '', due: '', bucket: 'capture', projectId: origin.value.projectId, origin: input.origin };
      this.validateTask(id, value);
      const task = this.write('task', id, device, value, 1);
      this.recordTask(task); this.syncReminder(task);
      return task;
    }).value;
  }
  private validateTask(id: string, task: Task, current?: Entity<Task>) {
    if (task.parentTaskId) {
      const seen = new Set([id]);
      let parentId: string | null | undefined = task.parentTaskId;
      while (parentId) {
        const parent: Entity<Task> | undefined = this.get('task', parentId);
        if (!parent || seen.has(parentId) || (!task.trashed && parent.value.trashed)) throw new Fault(409, 'invalid_parent', 'Choose an available parent task outside this task’s own children.');
        seen.add(parentId); parentId = parent.value.parentTaskId;
      }
    }
    if (current && canonical(task.origin) !== canonical(current.value.origin)) {
      // Retained pre-2.8 launch requests used origin for tasks without a source.
      // Admit only their original assignment link; never replace another source.
      const plan = !current.value.origin && task.origin?.kind === 'assignment' ? this.get('assignment', task.origin.id) : undefined;
      if (!plan || plan.value.archived || plan.revision !== task.origin?.revision || (current.value.workLink && current.value.workLink.assignmentId !== plan.id) || (plan.value.projectId ?? null) !== (task.projectId ?? null)) throw new Fault(409, 'source_changed', 'Keep this task linked to its original source.');
    }
    if (!current && task.origin) {
      const source = this.get(task.origin.kind, task.origin.id);
      if (!source || source.value.archived || source.revision !== task.origin.revision) throw new Fault(409, 'source_changed', 'Review the current source before linking a new task.');
    }
    // A client that has not received this additive field cannot erase its link.
    if (!task.workLink && current?.value.workLink) task.workLink = current.value.workLink;
    if (current?.value.workLink && canonical(task.workLink) !== canonical(current.value.workLink)) throw new Fault(409, 'task_work_changed', 'Keep the saved work link. Reopen this task to review its plan.');
    if (task.workLink && !current?.value.workLink) {
      const plan = this.get('assignment', task.workLink.assignmentId);
      if (!current || current.value.trashed || task.workLink.taskRevision !== current.revision || !plan || plan.value.archived || plan.revision !== task.workLink.assignmentRevision ||
          (plan.value.projectId ?? null) !== (task.projectId ?? null) || (task.origin?.kind === 'assignment' && task.origin.id !== plan.id)) throw new Fault(409, 'task_work_changed', 'Review the current task and saved plan before linking work.');
    }
    if (task.workResult && canonical(task.workResult) !== canonical(current?.value.workResult)) {
      const attempt = this.internalRead<AssignmentAttempt>(`assignments:attempt:${task.workResult.attemptId}`);
      const assignmentId = task.workLink?.assignmentId ?? (task.origin?.kind === 'assignment' ? task.origin.id : undefined);
      if (!attempt || attempt.epoch !== this.epoch || attempt.state !== 'returned' || attempt.terminal?.status !== 'ok' || !attempt.runId || !attempt.nativeSessionId || !attempt.result || attempt.assignmentId !== task.workResult.assignmentId ||
          attempt.assignmentId !== assignmentId || (task.workResult.fileId !== undefined && task.workResult.fileId !== attempt.result.file.id)) throw new Fault(409, 'task_work_result_changed', 'Review a returned result from this task’s saved plan before accepting it.');
      try {
        const file = this.download(attempt.result.file.id);
        if (canonical(file.metadata) !== canonical(attempt.result.file)) throw new Fault(409, 'task_work_result_changed', 'The saved result file changed. Review the original attempt.');
      } catch (error) {
        if (error instanceof Fault && ['attachment_missing', 'attachment_corrupt'].includes(error.code)) throw new Fault(409, 'task_work_result_changed', 'The saved result file is unavailable or changed. Review the original attempt.');
        throw error;
      }
    }
    if (task.trashed || current?.value.trashed) {
      if (!current) throw new Fault(409, 'task_trashed', 'Save a task before moving it to Trash.');
      const { trashed: before, ...original } = current.value, { trashed: after, ...proposal } = task;
      if (canonical(original) !== canonical(proposal) || before === after) throw new Fault(409, 'task_trashed', 'Restore this task before editing it.');
      if (after && this.list('task').some(t => !t.value.trashed && t.value.dependencies?.includes(id))) throw new Fault(409, 'task_required', 'Another task needs this prerequisite. Remove that dependency before moving it to Trash.');
      if (after && this.list('task').some(t => !t.value.trashed && t.value.parentTaskId === id)) throw new Fault(409, 'task_has_children', 'Move or trash this task’s children before moving their parent to Trash.');
      return;
    }
    const occurrence = this.internalRead<Occurrence>(`tasks:occurrence:${id}`);
    if ((!current && id.startsWith('task:occ:')) || (task.status === 'skipped' && !occurrence)) throw new Fault(400, 'invalid_occurrence', 'Skip belongs to a recurring occurrence.');
    if ((task.plannedTime && !task.planned) || (task.dueTime && !task.due)) throw new Fault(400, 'invalid_time', 'Choose a date before adding a time.');
    if ((task.plannedTime || task.dueTime) && !task.timezone) throw new Fault(400, 'invalid_time', 'Choose a timezone for this time.');
    if (task.reminder && canonical(task.reminder) !== canonical(current?.value.reminder)) { if (['done', 'skipped'].includes(task.status)) throw new Fault(400, 'invalid_reminder_time', 'Reopen this task before adding a new reminder.'); const time = reminderInstant(task.reminder); if (time.instant === null) throw new Fault(400, 'invalid_reminder_time', time.problem === 'gap' ? 'This reminder time does not exist in its timezone. Choose another time.' : 'This reminder time occurs twice. Choose the earlier or later occurrence.'); }
    if (task.projectId && !this.get('project', task.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
    const reaches = (next: string, visited = new Set<string>()): boolean => {
      if (next === id) return true;
      if (visited.has(next)) return false;
      visited.add(next); return (this.get('task', next)?.value.dependencies ?? []).some(child => reaches(child, visited));
    };
    for (const dependency of task.dependencies ?? []) {
      const other = this.get('task', dependency);
      if (!other || other.value.trashed || reaches(dependency)) throw new Fault(409, 'invalid_dependency', 'Dependencies must exist and cannot form a loop.');
      if (['active', 'done'].includes(task.status) && other.value.status !== 'done') throw new Fault(409, 'dependency_open', 'Complete the prerequisite first, or keep this task blocked.');
    }
    if (task.status === 'done' && task.checklist?.some(item => !item.done)) throw new Fault(409, 'checklist_open', 'Finish the checklist before completing this task.');
  }
  private recordTask(task: Entity<Task>, previous?: Entity<Task>) {
    const trashChanged = !!task.value.trashed !== !!previous?.value.trashed;
    if (task.value.status === previous?.value.status && !trashChanged) return;
    const done = task.value.status === 'done';
    const earned = this.internalRead<{ credited: boolean }>(`tasks:credit:${task.id}`)?.credited ?? false;
    // Earlier completions already belong to the predecessor's separate XP ledger.
    const legacyCompletion = this.internalRead(`tasks:legacy-completion:${task.id}`) !== undefined;
    const xpDelta = legacyCompletion ? 0 : done && !earned ? 10 : !done && earned ? -10 : 0;
    this.internalWrite(`tasks:credit:${task.id}`, { credited: done });
    const event: TaskEvent = { id: `${task.id}:${task.revision}`, taskId: task.id, at: new Date(this.now()).toISOString(), from: previous?.value.status ?? null, to: task.value.status, xpDelta, ...(trashChanged ? { action: task.value.trashed ? 'trash' as const : 'restore' as const } : {}) };
    this.internalWrite(`tasks:event:${event.id}`, event);
    if (task.value.status !== 'active' || task.value.trashed) {
      const focus = this.internalRead<Focus>(`tasks:focus:${task.id}`);
      if (focus?.running) this.internalWrite(`tasks:focus:${task.id}`, { ...focus, running: false, elapsedMs: focusElapsed(focus, this.now()), lastPulse: this.now(), revision: focus.revision + 1 });
    }
  }
  private validateRoutine(id: string, routine: Routine, current?: Entity<Routine>) {
    const today = dayInZone(routine.timezone, this.now());
    if (!/^routine:[0-9a-f-]{36}$/i.test(id)) throw new Fault(400, 'invalid_routine', 'Invalid recurring series identity.');
    if (routine.projectId && !this.get('project', routine.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
    if (current) {
      if (routine.startsOn !== current.value.startsOn || routine.timezone !== current.value.timezone || routine.kind !== current.value.kind) throw new Fault(409, 'routine_identity', 'Start date, timezone and type identify this series. Create a new series to change them.');
      this.materializeRoutine(current);
      if ((this.internalRead<{ next: string }>(`tasks:schedule:${id}`)?.next ?? routine.startsOn) <= today) throw new Fault(409, 'schedule_catching_up', 'Open Tasks to finish reviewing the missed occurrences before editing this series.');
    } else {
      if (routine.startsOn < today) throw new Fault(400, 'routine_past', 'Start a new series today or later. Existing missed occurrences stay in Review.');
      if (this.list('routine').length >= 100) throw new Fault(409, 'routine_limit', 'This workspace supports 100 recurring series.');
    }
  }
  private materializeRoutines() { for (const routine of this.list('routine')) this.materializeRoutine(routine); }
  private materializeRoutine(entity: Entity<Routine>) {
    const routine = entity.value, today = dayInZone(routine.timezone, this.now());
    let cursor = this.internalRead<{ next: string }>(`tasks:schedule:${entity.id}`)?.next ?? routine.startsOn;
    // Bounded catch-up, with the cursor preserved for the next read. No missed day is moved to today.
    let count = 0;
    for (; cursor <= today && count < 366; cursor = nextDay(cursor), count++) {
      if (routine.state !== 'active' || !scheduled(routine, cursor)) continue;
      const taskId = `task:occ:${entity.id.slice('routine:'.length)}:${cursor}`;
      if (this.get('task', taskId)) continue;
      const task = this.write('task', taskId, 'scheduler', { title: routine.title, notes: routine.notes, status: 'open', planned: cursor, due: '', plannedTime: routine.plannedTime, timezone: routine.timezone, projectId: routine.projectId, priority: routine.priority, estimateMinutes: routine.estimateMinutes, bucket: 'anytime', ...(routine.reminderTime ? { reminder: { date: cursor, time: routine.reminderTime, timezone: routine.timezone, ...(routine.reminderOverlap ? { overlap: routine.reminderOverlap } : {}) } } : {}) }, 1);
      this.internalWrite(`tasks:occurrence:${taskId}`, { taskId, routineId: entity.id, templateRevision: entity.revision, date: cursor, timezone: routine.timezone, kind: routine.kind } satisfies Occurrence);
      this.recordTask(task); this.syncReminder(task);
    }
    if (count) this.internalWrite(`tasks:schedule:${entity.id}`, { next: cursor });
  }
  profileProgress() {
    return this.transaction(() => {
      const carried = this.internalRead('profile:imported-progress');
      return buildProfileProgress(this.list('task'), this.internalList<TaskEvent>('tasks:event:'), this.internalList<PersonalQuest>('profile:quest:'), this.get('layout', 'layout')!.value.timezone, this.now(), this.epoch, carried ? importedProgressSchema.parse(carried) : undefined);
    });
  }
  profileHistory(before?: string) {
    const events = this.internalList<TaskEvent>('tasks:event:');
    if (before && !events.some(e => e.id === before && e.xpDelta !== 0)) throw new Fault(409, 'history_changed', 'Reload earned history before continuing.');
    return progressHistory(this.list('task'), events, before);
  }
  saveQuest(device: string, raw: unknown): PersonalQuest {
    const input = questCommandSchema.parse(raw);
    return this.admit(device, input, { operation: 'profile.quest', ...input }, () => {
      const id = input.action === 'save' ? input.quest.id : input.id, key = `profile:quest:${id}`;
      const previous = this.internalRead<PersonalQuest>(key);
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'quest_changed', 'This quest changed in another window. Review your kept edits against the current quest.', previous);
      const at = new Date(this.now()).toISOString();
      if (input.action === 'archive') {
        if (!previous) throw new Fault(404, 'quest_missing', 'This quest is unavailable.');
        return this.internalWrite(key, { ...previous, archived: input.archived, revision: previous.revision + 1, updatedAt: at });
      }
      if (previous?.archived) throw new Fault(409, 'quest_archived', 'Restore this quest before editing its steps.', previous);
      if (!previous && this.internalList<PersonalQuest>('profile:quest:').length >= 200) throw new Fault(409, 'quest_limit', 'This workspace has 200 saved quests. Reuse an existing quest.');
      const draft = input.quest;
      if (draft.projectId && !this.get('project', draft.projectId)) throw new Fault(409, 'quest_project', 'Choose an available Project.');
      const steps = draft.steps.map(step => {
        const old = previous?.steps.find(s => s.id === step.id);
        if (old && old.taskId !== step.taskId) throw new Fault(409, 'quest_step_changed', 'Remove the old step before linking a different Task.');
        if (step.taskId) {
          const task = this.get('task', step.taskId);
          if (!task || task.value.trashed && !old) throw new Fault(409, 'quest_task_missing', 'Choose an available Task. Existing links to Trash are kept.');
          return { id: step.id, taskId: step.taskId };
        }
        const taskId = `task:quest:${id}:${step.id}`;
        if (this.get('task', taskId)) throw new Fault(409, 'quest_task_exists', 'This step already has a Task. Link that Task instead.');
        const task = this.write('task', taskId, device, { title: step.title, notes: '', status: 'open', planned: '', due: '', bucket: 'anytime', projectId: draft.projectId, timezone: this.get('layout', 'layout')!.value.timezone }, 1);
        this.recordTask(task); this.syncReminder(task);
        return { id: step.id, taskId };
      });
      if (new Set(steps.map(s => s.taskId)).size !== steps.length) throw new Fault(400, 'quest_duplicate_task', 'Link each Task only once in a quest.');
      return this.internalWrite(key, { ...draft, steps, revision: (previous?.revision ?? 0) + 1, archived: false, createdAt: previous?.createdAt ?? at, updatedAt: at } satisfies PersonalQuest);
    }).value;
  }
  private taskState(): TaskState {
    const events = this.internalList<TaskEvent>('tasks:event:'), occurrences = this.internalList<Occurrence>('tasks:occurrence:');
    const presentation = taskPresentationProjection(occurrences, events, (id, revision) => this.readEntityVersion('routine', id, revision));
    return { occurrences, presentation, events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500), routineEvents: this.internalList<RoutineEvent>('tasks:routine-event:').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200), focus: this.internalList<Focus>('tasks:focus:'), earnedXp: events.reduce((total, event) => total + event.xpDelta, 0), orders: this.internalList<DailyOrder>('tasks:order:'), reminders: this.reminders(), reminderAttempts: this.internalList<NotificationAttempt>('reminders:attempt:').sort((a, b) => b.at - a.at) };
  }
  orderTasks(device: string, raw: unknown): DailyOrder {
    const cmd = dailyOrderSchema.parse(raw);
    return this.admit(device, cmd, { type: 'task-order', ...cmd }, () => {
      const key = `tasks:order:${JSON.stringify([cmd.date, cmd.timezone])}`;
      const current = this.internalRead<DailyOrder>(key);
      if ((current?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'order_changed', 'Another window changed this day’s order. Your proposal is kept.', current);
      const context = taskPresentationContext(this.taskState(), this.list('routine'), this.now());
      const eligible = this.list('task').filter(t => inTaskDestination(t, 'Today', cmd.date, cmd.timezone, context)).map(t => t.id);
      if (eligible.length !== cmd.taskIds.length || eligible.some(id => !cmd.taskIds.includes(id))) throw new Fault(409, 'order_membership', 'The day’s tasks changed. Review the kept order with the current tasks.');
      return this.internalWrite(key, { date: cmd.date, timezone: cmd.timezone, revision: (current?.revision ?? 0) + 1, taskIds: cmd.taskIds });
    }).value;
  }
  private reminders() { return this.internalList<Reminder>('reminders:item:'); }
  private putReminder(reminder: Reminder) { if (reminder.notification) this.internalWrite(`reminders:attempt:${reminder.notification.attemptId}`, { ...reminder.notification, reminderId: reminder.id, taskId: reminder.taskId, dueAt: reminder.dueAt, snoozes: reminder.snoozes } satisfies NotificationAttempt); return this.internalWrite(`reminders:item:${reminder.id}`, JSON.parse(JSON.stringify(reminder)) as Reminder); }
  private syncReminder(task: Entity<Task>, previous?: Entity<Task>) {
    const oldId = this.internalRead<string>(`reminders:task:${task.id}`), old = oldId && this.internalRead<Reminder>(`reminders:item:${oldId}`);
    const changed = canonical(task.value.reminder) !== canonical(previous?.value.reminder);
    const finished = task.value.trashed || ['done', 'skipped'].includes(task.value.status);
    if (old && (changed || finished) && !['dismissed', 'cancelled'].includes(old.state)) this.putReminder({ ...old, state: 'cancelled', revision: old.revision + 1 });
    if (!changed || !task.value.reminder || finished) return;
    const resolved = reminderInstant(task.value.reminder), reminder: Reminder = { id: randomUUID(), taskId: task.id, taskRevision: task.revision, revision: 1, spec: task.value.reminder, dueAt: resolved.instant, state: resolved.instant === null ? 'unavailable' : 'scheduled', ...(resolved.instant === null ? { reason: resolved.problem === 'gap' ? 'This recurring time does not exist today. Choose a new reminder time for this occurrence.' : 'This recurring time occurs twice. Choose which occurrence to use.' } : {}), snoozes: 0 };
    this.putReminder(reminder); this.internalWrite(`reminders:task:${task.id}`, reminder.id);
  }
  private sweepReminders() {
    const now = this.now();
    for (const original of this.reminders()) {
      let item = original;
      if (item.state === 'scheduled' && item.dueAt !== null && item.dueAt <= now) item = { ...item, state: 'ready' };
      if (item.state === 'ready' && item.dueAt !== null && now - item.dueAt > reminderWindowMs && !item.seenAt && item.notification?.state !== 'shown') item = { ...item, state: 'missed' };
      if (item.notification?.state === 'claimed' && now - item.notification.at > 20000) item = { ...item, notification: { ...item.notification, state: 'unknown' } };
      if (item !== original) this.putReminder({ ...item, revision: original.revision + 1 });
    }
    for (const attempt of this.internalList<NotificationAttempt>('reminders:attempt:')) if (attempt.state === 'claimed' && now - attempt.at > 20000) this.internalWrite(`reminders:attempt:${attempt.attemptId}`, { ...attempt, state: 'unknown' });
  }
  tickTasks() { if(this.updateMaintenanceHeld)return;this.transaction(() => { this.materializeRoutines(); this.sweepReminders(); }); }
  actOnReminder(device: string, raw: unknown): Reminder {
    const cmd = reminderActionSchema.parse(raw);
    return this.admit(device, cmd, { type: 'reminder-action', ...cmd }, () => {
      this.sweepReminders(); const item = this.internalRead<Reminder>(`reminders:item:${cmd.reminderId}`);
      if (!item || item.revision !== cmd.expectedRevision) throw new Fault(409, 'reminder_changed', 'This reminder changed. Review its current state.', item);
      if (['cancelled', 'dismissed'].includes(item.state)) throw new Fault(409, 'reminder_closed', 'This reminder is already closed.');
      if (cmd.action === 'seen' && !['ready', 'missed', 'unavailable'].includes(item.state)) throw new Fault(409, 'reminder_not_due', 'This reminder is not ready to display.');
      if (cmd.action === 'seen' && item.seenAt) return item;
      return this.putReminder({ ...item, revision: item.revision + 1, ...(cmd.action === 'seen' ? { seenAt: this.now() } : cmd.action === 'dismiss' ? { state: 'dismissed' as const } : { state: 'scheduled' as const, dueAt: this.now() + cmd.minutes! * 60000, seenAt: undefined, reason: undefined, notification: undefined, snoozes: item.snoozes + 1 }) });
    }).value;
  }
  deliverReminder(device: string, raw: unknown): Reminder {
    const cmd = reminderDeliverySchema.parse(raw);
    return this.admit(device, cmd, { type: 'reminder-delivery', ...cmd }, () => {
      this.sweepReminders(); const item = this.internalRead<Reminder>(`reminders:item:${cmd.reminderId}`);
      if (!item) throw new Fault(404, 'reminder_missing', 'This reminder is no longer available.');
      if (cmd.action === 'claim') {
        if (item.state !== 'ready' || item.notification) throw new Fault(409, 'reminder_claimed', 'A notification attempt already exists, or this reminder needs in-app review.');
        return this.putReminder({ ...item, revision: item.revision + 1, notification: { attemptId: randomUUID(), clientId: cmd.clientId, deviceId: device, at: this.now(), state: 'claimed' } });
      }
      const attempt = this.internalRead<NotificationAttempt>(`reminders:attempt:${cmd.attemptId}`);
      if (!attempt || attempt.reminderId !== item.id || attempt.clientId !== cmd.clientId || attempt.deviceId !== device) throw new Fault(409, 'reminder_attempt_changed', 'This notification belongs to a different attempt.');
      const state = attempt.state === 'shown' ? 'shown' : cmd.action;
      this.internalWrite(`reminders:attempt:${attempt.attemptId}`, { ...attempt, state });
      // A late observation updates its original attempt only, never a later snooze or closed reminder.
      if (item.notification?.attemptId !== attempt.attemptId) return item;
      return this.putReminder({ ...item, revision: item.revision + 1, notification: { ...item.notification, state } });
    }).value;
  }
  /** Fixed Focus/receipt sinks only; no caller callback receives write authority. */
  private mutateCapacityFocus(device:string,raw:unknown):Focus{
    this.assertWriteContext(true);
    return this.transaction(()=>{
      const sequence=this.historySequence!,capacity=this.capacityTransaction!;
      const context:DraftCapacityContext=new DraftCapacityContext({db:this.db,budget:sequence.budget,limits:this.#historyWrite!.sequence,recordBytes:this.historyReviewLimits!.objectBytes,
        guard:()=>{sequence.checked(()=>undefined);if(this.feedFailure)throw this.feedFailure.error;},openText:(aad,payload)=>this.openText(aad,payload),seal:(aad,value)=>this.seal(aad,value)});
      const readonly:DerivationContext={open:true,failed:false};
      try{
        const prepared=this.feedDerivation.run(readonly,()=>context.checked(()=>{
          context.key(device);const planner=new TaskFocusCapacityPlanner(context,(status,code,message)=>new Fault(status,code,message)),cmd=planner.parse(raw);
          context.slots(1,128);const intent={type:'task-focus',...cmd},digest=context.child(intent,()=>hash(canonical(intent)));
          const epoch=context.meta('epoch');context.need(epoch!==undefined&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(epoch),'Focus epoch malformed');
          if(cmd.epoch!==epoch)throw new Fault(409,'epoch_changed','The workspace changed. Review the original work before continuing.');
          const replay=context.row('receipts',cmd.requestId);
          if(replay){
            if(replay.raw.digest!==digest||replay.raw.device_id!==device)throw new Fault(409,'request_reused','This request identity was already used for different work.');
            if(replay.value?.removedWork)throw new Fault(409,`${replay.value.removedWork}_removed`,'This saved work was removed. Its old request cannot restore it.');
            sequence.withGraph(undefined,()=>undefined);capacity.replay();context.slots(1,48);return {replay:replay.value} as const;
          }
          capacity.initial();capacity.checkReceipt(cmd.requestId,digest,device,sequence.budget);
          sequence.withGraph(undefined,graph=>{if(graph.reservedCloseCommands.has(cmd.requestId))throw new Fault(409,'request_reserved','This request identity is reserved for its exact original Close acknowledgement.');});
          context.slots(1,32);const focusPlan=planner.plan(device,cmd,()=>this.now());
          // The optional predecessor wrapper stays local. Only the exact Focus
          // value enters the strict JSON receipt and ciphertext paths.
          context.slots(1,128);const pending=sequence.preparePending({requestId:cmd.requestId,deviceId:device,digest,value:focusPlan.value});
          let payload:Buffer|undefined,receipt:Buffer|undefined;
          context.slots(1,64);capacity.withPendingEffects('focus',pending,sequence,graph=>{
            this.validateReceiptValue(graph,cmd.requestId,digest,device,focusPlan.value);
            payload=context.encrypted('service:'+focusPlan.key,focusPlan.value);receipt=context.encrypted('receipt:'+cmd.requestId,focusPlan.value);
            context.slots(2,192);capacity.beforeTaskFocusEffects(Object.freeze({receipt:pending,ciphertextBytes:receipt.byteLength}),Object.freeze({taskId:cmd.taskId,key:focusPlan.key,
              previousBytes:focusPlan.previous?.raw.payload.byteLength??0,focusBytes:payload.byteLength,receiptBytes:receipt.byteLength,absent:focusPlan.previous===undefined}));
          });
          capacity.assertEffectsReady();context.need(payload&&receipt,'Prepared Focus ciphertext missing');
          context.slots(1,256);return {cmd,digest,focusPlan,payload:payload!,receipt:receipt!} as const;
        }));
        readonly.open=false;if(readonly.failed)throw readonly.failure;
        if('replay'in prepared)return prepared.replay;
        capacity.assertEffectsReady();const {cmd,digest,focusPlan,payload,receipt}=prepared,previous=focusPlan.previous;
        const written=previous?context.query('UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?').run(previous.raw.revision+1,payload,focusPlan.key,previous.raw.revision,previous.raw.payload):
          context.query('INSERT INTO service_records(id,revision,payload) VALUES (?,?,?)').run(focusPlan.key,1,payload);
        context.need(written.changes===1,'Focus service predecessor changed');
        context.need(context.query('INSERT INTO receipts VALUES (?,?,?,?)').run(cmd.requestId,digest,device,receipt).changes===1,'Focus original receipt changed');
        context.guard();return focusPlan.value;
      }catch(error){this.feedFailure??={error};throw error;}finally{readonly.open=false;context.close();}
    },historyFocusTransaction);
  }
  focus(device: string, raw: unknown): Focus {
    if(this.#taskFocusCapacity)return this.mutateCapacityFocus(device,raw);
    const cmd = focusSchema.parse(raw);
    return this.admit(device, cmd, { type: 'task-focus', ...cmd }, () => {
      const task = this.get('task', cmd.taskId);
      if (!task || task.value.trashed) throw new Fault(404, 'task_missing', 'This task is unavailable.');
      const current = this.internalRead<Focus>(`tasks:focus:${cmd.taskId}`);
      if ((current?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'focus_changed', 'Focus changed in another window. Review its current state.');
      const now = this.now(), live = (focus: Focus) => focus.running && now < focus.lastPulse + focusLeaseMs;
      if (cmd.action === 'start') {
        if (task.value.status !== 'active') throw new Fault(409, 'task_not_active', 'Start this task before focusing on it.');
        this.validateTask(task.id, task.value, task);
        if (this.internalList<Focus>('tasks:focus:').some(f => live(f) && (f.taskId !== task.id || f.clientId !== cmd.clientId || f.deviceId !== device))) throw new Fault(409, 'focus_busy', 'Another focus session is running. Pause it in its window or wait for it to disconnect.');
      } else if (!current || current.deviceId !== device || current.clientId !== cmd.clientId) throw new Fault(409, 'focus_owner', 'Only the window that started this focus session can update it.');
      if (cmd.action === 'pulse' && (!current || !live(current) || task.value.status !== 'active')) throw new Fault(409, 'focus_expired', 'Focus paused after an interruption. Resume explicitly when you are ready.');
      const value: Focus = { taskId: task.id, deviceId: device, clientId: cmd.clientId, revision: (current?.revision ?? 0) + 1, running: cmd.action !== 'pause', elapsedMs: current ? focusElapsed(current, now) : 0, lastPulse: now };
      return this.internalWrite(`tasks:focus:${task.id}`, value);
    }).value;
  }
  /** Internal service records are encrypted and never exposed by the generic client snapshot. */
  internalRead<T>(id: string): T | undefined {
    this.assertRemovalRead();
    const row = this.db.prepare('SELECT payload FROM service_records WHERE id=?').get(id) as { payload: Uint8Array } | undefined;
    return row ? this.open(`service:${id}`, row.payload) as T : undefined;
  }
  /** Non-secret local configuration identity only; never reads or decrypts credentials. */
  internalGatewayConfigurationRevision(): number | undefined {
    const row = this.db.prepare("SELECT revision FROM service_records WHERE id='gateway:configuration'").get() as { revision: number } | undefined;
    if (!row) return undefined;
    if (!Number.isSafeInteger(row.revision) || row.revision < 1)
      throw new Fault(409, 'gateway_configuration_revision_invalid', 'The Gateway configuration identity is unavailable.');
    return row.revision;
  }
  /** Internal synchronous read projection. Join an admission without taking its
   * transaction ownership; otherwise own one deferred snapshot. This is not an
   * authorization check or a sandbox for untrusted callbacks. */
  internalReadSnapshot<T>(read: () => T): T {
    this.assertRemovalRead();
    const owned = !this.db.isTransaction;
    if (owned) {this.removalContext?.disposition('begin');this.db.exec('BEGIN DEFERRED');}
    try {
      const value = read();
      if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
          typeof (value as { then?: unknown }).then === 'function')
        throw new Error('A Store read snapshot must be synchronous.');
      if (owned) {this.removalContext?.disposition('commit');this.db.exec('COMMIT');}
      return value;
    } catch (error) {
      if (owned) {
        try { this.removalContext?.disposition('rollback');this.db.exec('ROLLBACK'); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Store read snapshot and rollback both failed.'); }
      }
      throw error;
    }
  }
  /** Complete actual retained-history read proof only. The access object and all
   * SQL iterators are lexical and expire before this synchronous call returns. */
  internalVerifyFeedHistory(limits=this.historyReviewLimits,schema:61|62=this.historyReviewSchema){
    if(!limits)throw new Error('Explicit unqualified history limits required');
    return this.internalReadSnapshot(()=>readSqlHistory(this.db,(aad,payload)=>this.open(aad,payload),limits,
      ()=>canonical(this.internalFeedCacheToken()),access=>verifyHistoryInventory(access,limits,workerNativeIdentity),schema,this.removalContext?()=>this.removalContext!.query():undefined));
  }
  /** Passive semantic read only. All actual history and current service inputs
   * share this synchronous snapshot; neither inventory nor authorization escapes. */
  internalWithFeedReadGraph<T>(consume:(graph:FeedReadGraph)=>T,projectionLimits:FeedReadProjectionLimits=feedReadProjectionLimits):T{
    return this.internalReadSnapshot(()=>{
      const token=()=>canonical(this.internalFeedCacheToken());
      if(!this.historyReviewLimits)return withLegacyFeedReadGraph(this.internalFeedLedger(),hash,workerNativeIdentity,token,consume,projectionLimits);
      return readSqlHistory(this.db,(aad,payload)=>this.open(aad,payload),this.historyReviewLimits,token,
        access=>withHistoryFeedReadGraph(access,this.historyReviewLimits!,hash,workerNativeIdentity,consume,projectionLimits),this.historyReviewSchema);
    });
  }
  get internalFeedHistoryOwners(){if(!this.historySealer)throw Error('Isolated schema62 sealing route required');return this.historySealer.owners;}
  internalPrepareFeedHistorySeal(input:SealRequest,lease:FeedHistoryLease){if(!this.historySealer||this.db.isTransaction)throw Error('Seal preparation cannot nest or use another route');return this.historySealer.prepare(input,lease);}
  internalCommitFeedHistorySeal(id:string,lease:FeedHistoryLease){if(!this.historySealer||this.db.isTransaction)throw Error('Seal commit cannot nest or use another route');return this.historySealer.commit(id,lease);}
  internalCloseUnperformedFeedHistorySeal(id:string,lease:FeedHistoryLease){if(!this.historySealer||this.db.isTransaction)throw Error('Seal closure cannot nest or use another route');return this.historySealer.closeUnperformed(id,lease);}
  internalReadFeedHistorySeal(id:string){if(!this.historySealer)throw Error('Isolated schema62 route required');return this.historySealer.readOperation(id);}
  internalWithFeedHistoryProjection<T>(query:{rowIds:string[]},consume:(projection:{rows:unknown[];receipts:unknown[]})=>T):T{
    historyJsonBytes(query,32768);const parsed=z.object({rowIds:z.array(z.string().min(1).max(300)).max(50)}).strict().parse(query);
    if(canonical(parsed)!==canonical(query)||new Set(parsed.rowIds).size!==parsed.rowIds.length)throw Error('Exact bounded history selection required');
    const limits=this.historyReviewLimits;if(!limits)throw Error('Explicit history review route required');
    return this.internalReadSnapshot(()=>readSqlHistory(this.db,(aad,payload)=>this.open(aad,payload),limits,()=>canonical(this.internalFeedCacheToken()),access=>{
      verifyHistoryInventory(access,limits,workerNativeIdentity);const protectedRows=parsed.rowIds.length?sealProtection(access,parsed.rowIds,limits):{receipts:[]};
      const result=consume({rows:parsed.rowIds.map(id=>structuredClone(historyLogicalRow(access,id))),receipts:protectedRows.receipts.map(row=>structuredClone(access.receipt(row.id)))});
      if(result&&typeof(result as any).then==='function')throw Error('History projection must remain synchronous');return result;
    },this.historyReviewSchema));
  }
  /** Internal Feed graph input, never a client response or authorization. Read
   * every receipt, including unrelated originals and receipt-only orphans, so
   * pending close identities cannot collide with omitted work. Payloads use
   * their existing authenticated AAD; exact outer metadata still needs the
   * graph's expected-receipt join. No schema migration or record repair here. */
  internalFeedLedger(): { schema: number; rows: { id: string; revision: number; value: unknown }[];
    receipts: { requestId: string; deviceId: string; digest: string; value: unknown }[] } {
    return this.internalReadSnapshot(() => {
      const schema = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const prefix = 'news:semantic-';
      const rows = (this.db.prepare('SELECT id,revision,payload FROM service_records WHERE substr(id,1,?)=? ORDER BY id')
        .all(prefix.length, prefix) as { id: string; revision: number; payload: Uint8Array }[])
        .map(row => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) }));
      const receipts = (this.db.prepare('SELECT request_id,digest,device_id,payload FROM receipts ORDER BY request_id').all() as
        { request_id: string; digest: string; device_id: string; payload: Uint8Array }[])
        .map(row => ({ requestId: row.request_id, deviceId: row.device_id, digest: row.digest,
          value: this.open(`receipt:${row.request_id}`, row.payload) }));
      return structuredClone({ schema, rows, receipts });
    });
  }
  /** Cache invalidation identity only. No authorization, readiness or graph proof.
   * Read in the same snapshot as the data it describes. total_changes also
   * invalidates conservatively for own autocommit writes and rolled-back writes. */
  internalFeedCacheToken(): Readonly<{storeInstance:string;localCommitGeneration:number;dataVersion:number}> {
    return this.internalReadSnapshot(() => {
      const changes=(this.removalSql('SELECT total_changes() AS count').get() as {count:number}).count;
      const dataVersion=(this.removalSql('PRAGMA data_version').get() as {data_version:number}).data_version;
      if(!Number.isSafeInteger(changes)||changes<0||!Number.isSafeInteger(dataVersion)||dataVersion<0)
        throw new Error('Store cache identity unavailable');
      if(this.feedObservedChanges!==undefined&&this.feedObservedChanges!==changes)this.invalidateFeedCache();
      this.feedObservedChanges=changes;
      return Object.freeze({storeInstance:this.feedStoreInstance,localCommitGeneration:this.feedCommitGeneration,dataVersion});
    });
  }
  private feedMutationLedger() {
    const ledger=this.internalFeedLedger();
    const pending=this.feedAdmission?.pending;
    if(pending){
      if(ledger.receipts.some(row=>row.requestId===pending.requestId))throw new Error('Pending Feed original already exists');
      ledger.receipts.push(structuredClone(pending));
    }
    return ledger;
  }
  private deriveFeed<T>(derive:(read:FeedMutationReadView)=>T):T{
    if(!this.mutationTransaction||!this.db.isTransaction)throw Error('Feed derivation needs its original transaction');
    const context:DerivationContext={open:true,failed:false};
    const budget=this.historySequence?.budget??new MutationPlanBudget({qualification:'unqualified',entries:10000,bytes:32*1024*1024,queries:100000});
    const consume=(graph:FeedReadGraph):T=>this.feedDerivation.run(context,()=>{
      let alive=true;
      const read:FeedMutationReadView=Object.freeze({...graph,activeRow:(id:string)=>{
        try{return budget.checked(()=>{
          if(!alive||!context.open)throw Error('Feed mutation read scope has ended');budget.entry();budget.bytes(id);
          if(typeof id!=='string'||!id.startsWith(feedServicePrefix)||id.length>8192||Buffer.byteLength(id,'utf8')>8192)throw Error('Exact bounded semantic active-row key required');
          assertHistoryUtf8Key(id);budget.query();
          const meta=this.db.prepare('SELECT typeof(payload) AS type,length(payload) AS bytes FROM service_records WHERE id=?').get(id) as {type:string;bytes:number}|undefined;
          if(!meta)return undefined;
          if(meta.type!=='blob'||!Number.isSafeInteger(meta.bytes)||meta.bytes<28||meta.bytes>(this.historyReviewLimits?.objectBytes??8*1024*1024)+28)throw Error('Active-row ciphertext bound');
          budget.reserveBytes(meta.bytes);budget.query();
          const row=this.db.prepare('SELECT id,CAST(id AS BLOB) AS raw_id,revision,payload FROM service_records WHERE id=?').get(id) as {id:string;raw_id:Uint8Array;revision:number;payload:Uint8Array};
          assertHistorySqlKey(row.id,row.raw_id);if(row.id!==id||!Number.isSafeInteger(row.revision)||row.revision<1||row.payload.byteLength!==meta.bytes)throw Error('Active-row SQL identity changed');
          return budget.copy({id,revision:row.revision,value:this.open('service:'+id,row.payload)});
        });}catch(error){context.failed=true;context.failure=error;if(context.open)this.feedFailure??={error};throw error;}
      }});
      try{
        const produce=()=>derive(read);let value:T;
        if(this.historyOwners)value=this.historyOwners.synchronous(produce);
        else{
          value=produce();let then:unknown;
          if(value!==null&&(typeof value==='object'||typeof value==='function'))then=(value as {then?:unknown}).then;
          if(typeof then==='function'){
            const original=new Promise<unknown>((resolve,reject)=>{try{Reflect.apply(then,value,[resolve,reject]);}catch(error){reject(error);}});
            void original.then(()=>undefined,()=>undefined);throw Error('Feed derivation must remain synchronous');
          }
        }
        if(context.failed)throw context.failure;
        return budget.copy(value);
      }catch(error){this.feedFailure??={error};throw error;}
      finally{alive=false;context.open=false;}
    });
    try{return this.historySequence?this.historySequence.withGraph(undefined,consume):this.internalWithFeedReadGraph(consume);}
    finally{context.open=false;}
  }
  internalAdmitFeed<T>(device:string,input:{requestId:string;epoch:string},intent:unknown,derive:(read:FeedMutationReadView)=>{writes:readonly SemanticRow[];receiptValue:T}):{value:T;fresh:boolean}{
    this.assertWriteContext(true);if(this.derivingProtectedAdmission)throw Error('Nested Feed original derivation refused');
    this.derivingProtectedAdmission=true;try{return this.admit(device,input,intent,()=>{
      const draft=this.deriveFeed(derive);if(!draft||!Array.isArray(draft.writes)||draft.writes.length>2)throw Error('Exact bounded Feed derivation required');
      const admission=this.feedAdmission!;const pending:SemanticReceipt={requestId:admission.requestId,deviceId:admission.deviceId,digest:admission.digest,value:draft.receiptValue};
      if(this.historySequence){
        if(draft.writes.length){admission.pending=pending;admission.touched=true;this.feedTransactionTouched=true;}
        this.reservedFeedReceiptPayload=this.historySequence.apply(draft.writes,pending);
      }else for(const row of draft.writes)this.internalFeedWrite({...row,pendingReceipt:pending});
      return draft.receiptValue;
    });}finally{this.derivingProtectedAdmission=false;}
  }
  internalObserveFeed<T>(derive:(read:FeedMutationReadView)=>{writes:readonly SemanticRow[];value:T}):T{
    this.assertWriteContext(true);if(this.observingProtectedCapacity)throw Error('Nested protected observation refused');
    this.observingProtectedCapacity=true;try{return this.transaction(()=>{
      this.capacityTransaction?.initial();
      const draft=this.deriveFeed(derive);if(!draft||!Array.isArray(draft.writes)||draft.writes.length>2)throw Error('Exact bounded Feed observation required');
      if(this.historySequence){this.historySequence.apply(draft.writes);if(draft.writes.length)this.feedTransactionTouched=true;}
      else for(const row of draft.writes)this.internalFeedWrite(row);
      return draft.value;
    });}finally{this.observingProtectedCapacity=false;}
  }
  /** One Store-owned protected mutation. The pending receipt must belong to the
   * actual current admission; the public internal ledger remains actual-only. */
  internalFeedWrite<T>(input:{id:string;revision:number;value:T;pendingReceipt?:SemanticReceipt}):T {
    this.assertWriteContext();if(this.historyReviewLimits)throw Error('Historical writes require complete Store-owned sequence derivation');
    const proposed=structuredClone(input);
    const write=()=>{
      if(!this.mutationTransaction)throw new Error('Feed writes cannot enter through a read snapshot');
      if(!proposed.id.startsWith(feedServicePrefix))throw new Error('Not a protected Feed record');
      this.feedTransactionTouched=true;if(this.feedAdmission)this.feedAdmission.touched=true;
      const ledger=this.feedMutationLedger();
      verifyFeedStoreLedger(ledger);
      const prior=ledger.rows.find(row=>row.id===proposed.id);
      const next={id:proposed.id,revision:proposed.revision,value:proposed.value};
      assertFeedStoreTransition(prior,next);
      const admission=this.feedAdmission;
      if(proposed.pendingReceipt){
        const pending=proposed.pendingReceipt;
        if(!admission||pending.requestId!==admission.requestId||pending.deviceId!==admission.deviceId||pending.digest!==admission.digest||
          this.db.prepare('SELECT 1 FROM receipts WHERE request_id=?').get(pending.requestId))
          throw new Error('Feed pending receipt is not the actual original admission');
        if(admission.pending&&canonical(admission.pending)!==canonical(pending))throw new Error('Feed pending original changed between writes');
        if(!admission.pending)admission.pending=structuredClone(pending);
      }
      const pending=admission?.pending;
      const receipts=ledger.receipts.filter(row=>row.requestId!==pending?.requestId);
      if(pending)receipts.push(structuredClone(pending));
      verifyFeedStoreLedger({...ledger,rows:[...ledger.rows.filter(row=>row.id!==proposed.id),next],receipts});
      this.feedTransactionTouched=true;if(admission)admission.touched=true;
      this.writingFeed=true;
      try { this.internalWrite(proposed.id,proposed.value); }
      finally { this.writingFeed=false; }
      return structuredClone(proposed.value);
    };
    return this.db.isTransaction?write():this.transaction(write);
  }
  internalList<T>(prefix: string): T[] {
    const busy:{open:boolean;context:HistoryRemovalContext;voice:RemovalRow[]}|undefined=this.removalBusyScope.getStore();if(busy){const context:HistoryRemovalContext=busy.context;context.need(busy.open&&context===this.removalContext&&prefix==='voice:attempt:','Exact current removal voice read required','history_removal_read_only');context.entry(1+busy.voice.length);context.logical(2+busy.voice.length);return busy.voice.map(row=>context.copy(row.value)) as T[];}
    if(this.removalContext)this.removalContext.fail(new Fault(409,'history_removal_read_only','Unplanned removal list is unavailable.'));
    const rows = this.db.prepare('SELECT id,payload FROM service_records WHERE substr(id,1,?)=? ORDER BY id').all(prefix.length, prefix) as { id: string; payload: Uint8Array }[];
    return rows.map(row => this.open(`service:${row.id}`, row.payload) as T);
  }
  internalWrite<T>(id: string, value: T): T {
    this.assertWriteContext();
    if(id===taskRelationCatalogueKey){const error=new Fault(409,'history_capacity_route_held','Task catalogue is owned by its complete derivation.');if(this.mutationTransaction)this.feedFailure??={error};throw error;}
    if(id===producerKey)throw new Fault(409,'producer_original_required','Producer custody requires its exact typed transition.');
    if(id.startsWith(feedServicePrefix)&&!this.writingFeed)throw new Fault(409,'feed_original_required','Feed history requires its exact protected original transition.');
    if (id.startsWith(groupPrefix) && !this.writingGroup) throw new Fault(409, 'group_original_required', 'Group history can only change through its original admitted command.');
    if (id.startsWith(groupPreparationPrefix) && !this.writingGroupPreparation)
      throw new Fault(409, 'group_preparation_original_required', 'Group writing and prepared inputs require their exact original command.');
    if (id.startsWith(groupExecutionPrefix) && !this.writingGroupExecution)
      throw new Fault(409, 'group_execution_original_required', 'Group execution requires its exact original child transition.');
    if (id.startsWith('assistant:') && (this.directAgentProtected.has(id) || hasDirectAgentAuthority(value) || id.startsWith('assistant:operation:') || id.startsWith('assistant:queue:'))) {
      assertDirectAgentWrite(id, this.internalRead(id), value, key => this.internalRead(key));
      if (hasDirectAgentAuthority(value)) this.directAgentProtected.add(id);
    }
    this.db.prepare('INSERT INTO service_records VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,payload=excluded.payload').run(id, this.seal(`service:${id}`, value));
    return value;
  }
  /** Called inside the removal transaction. Saved outputs, memories and shared files are separate records. */
  removeConversationData(conversationId: string) {
    this.assertWriteContext();
    if(this.#historyRemoval){const current=this.removalCompletion;
      if(!current||current.context!==this.removalContext||current.conversationId!==conversationId)throw new Fault(409,'history_removal_context','Removal cleanup requires its exact completion transaction.');
      return this.planHistoricalConversationCleanup(current.context,conversationId);}
    if(this.#historyWrite)throw new Fault(409,'history_operation_held','This historical operation awaits its separate capacity or redaction integration.');
    const drafts = this.list('draft').filter(draft => draft.value.conversationId === conversationId);
    for (const draft of drafts) this.removeDraftData(draft);
    const ownedReceipts = new Set<string>();
    const prefixes = ['assistant:plan:', 'assistant:operation:', 'assistant:queue:', 'assistant:message-pin:', 'assistant:approval:', 'assistant:question:', 'assistant:edit:', 'assistant:continuation:', 'assistant:research-progress:'];
    for (const prefix of prefixes) {
      let after = '';
      for (;;) {
        const page = this.internalPage<{ conversationId?: string }>(prefix, after, 100);
        for (const row of page) if (row.value.conversationId === conversationId) { ownedReceipts.add(row.id.slice(prefix.length)); this.internalDelete(row.id); }
        if (page.length < 100) break; after = page[page.length - 1].id;
      }
    }
    for (const call of this.internalList<{ id: string; target: { conversation: { id: string } } }>('voice:attempt:').filter(call => call.target.conversation.id === conversationId)) {
      for (const row of this.internalPage(`voice:consult-intent:${call.id}:`, '', 500)) this.internalDelete(row.id);
      this.internalDelete(`voice:attempt:${call.id}`);
    }
    this.clearReceipts(value => !!(value?.id === conversationId && value.nativeKey || value?.conversationId === conversationId && (ownedReceipts.has(value.id) || ownedReceipts.has(value.requestId)) || value?.target?.conversation?.id === conversationId), 'conversation');
    this.advanceCursor();
    this.internalDelete(`assistant:history:${conversationId}`);
    this.internalDelete(`assistant:retained-history:${conversationId}`);
    for (;;) {
      const page = this.internalPage(`assistant:transcript:${conversationId}:`, '', 100);
      for (const row of page) this.internalDelete(row.id);
      if (page.length < 100) break;
    }
    this.internalDelete(`assistant:transcript-state:${conversationId}`);
    this.internalDelete(`assistant:conversation:${conversationId}`);
  }
  internalDelete(id: string) {
    this.assertWriteContext();
    if(id===taskRelationCatalogueKey){const error=new Fault(409,'history_capacity_route_held','Task catalogue is owned by its complete derivation.');if(this.mutationTransaction)this.feedFailure??={error};throw error;}
    if(id===producerKey)throw new Fault(409,'producer_history_kept','Producer custody requires its exact typed transition.');
    if(id.startsWith(feedServicePrefix))throw new Fault(409,'feed_history_kept','Original Feed history and receipts are retained.');
    if (id.startsWith(groupPrefix)) throw new Fault(409, 'group_history_kept', 'Group history is retained. Archive or move the Group to Trash instead.');
    if (id.startsWith(groupPreparationPrefix))
      throw new Fault(409, 'group_preparation_kept', 'Group writing, prepared inputs and original receipts are retained.');
    if (id.startsWith(groupExecutionPrefix))
      throw new Fault(409, 'group_execution_kept', 'Original Group attempts and their observed outcomes are retained.');
    this.db.prepare('DELETE FROM service_records WHERE id=?').run(id);
  }
  /** Bounded reads let large private indexes yield between encrypted pages. */
  internalPage<T>(prefix: string, after = '', limit = 100): { id: string; value: T }[] {
    this.assertRemovalRead();
    if (!prefix || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid internal page.');
    const rows = this.db.prepare('SELECT id,payload FROM service_records WHERE id>=? AND id<? AND id>? ORDER BY id LIMIT ?')
      .all(prefix, prefix + '\uffff', after, limit) as { id: string; payload: Uint8Array }[];
    return rows.map(row => ({ id: row.id, value: this.open(`service:${row.id}`, row.payload) as T }));
  }
  /** One provider page and its resume position must survive together. */
  internalBatch(entries: { id: string; value: unknown }[], remove: string[] = []) {
    this.transaction(() => { for (const entry of entries) this.internalWrite(entry.id, entry.value); for (const id of remove) this.internalDelete(id); });
  }
  /** Transcript observations share an enclosing admission's commit or rollback. */
  internalBatchJoined(entries: { id: string; value: unknown }[], remove: string[] = []) {
    if (!this.db.isTransaction) return this.internalBatch(entries, remove);
    for (const entry of entries) this.internalWrite(entry.id, entry.value);
    for (const id of remove) this.internalDelete(id);
  }
  /** Atomic service-owned state transitions; callers must not nest this inside admission. */
  internalAtomic<T>(work: () => T): T { return this.transaction(work); }
  /** Receipt payloads are encrypted and untyped in the existing table. A single
   * startup scan detects orphaned originals even if every Group row is missing.
   * Ordinary unrelated receipts are never interpreted as Group authority. */
  private originalGroupReceipts() {
    const receipts: { requestId: string; deviceId: string; digest: string; value: unknown }[] = [];
    for (const saved of this.db.prepare('SELECT request_id,digest,device_id,payload FROM receipts').iterate()) {
      const requestId = String(saved.request_id), value = this.open(`receipt:${requestId}`, saved.payload as Uint8Array);
      if (hasGroupReceipt(value) || hasGroupPreparationReceipt(value) || hasGroupExecutionReceipt(value))
        receipts.push({ requestId, digest: String(saved.digest), deviceId: String(saved.device_id), value });
    }
    return receipts;
  }
  private groupReceipts(rows: { id: string; value: unknown }[]) {
    return rows.filter(row => row.id.startsWith(groupPrefix + 'event:')).map(row => {
      const event = groupEventSchema.parse(row.value);
      const saved = this.db.prepare('SELECT request_id,digest,device_id,payload FROM receipts WHERE request_id=?')
        .get(event.command.requestId) as { request_id: string; digest: string; device_id: string; payload: Uint8Array } | undefined;
      if (!saved) throw new Fault(409, 'group_receipt_missing', 'An original Group receipt is unavailable. Its saved history is kept.');
      return { requestId: saved.request_id, digest: saved.digest, deviceId: saved.device_id, value: this.open(`receipt:${saved.request_id}`, saved.payload) };
    });
  }
  private groupRows(id: string): { id: string; revision: number; value: unknown }[] {
    const open = (row: { id: string; revision: number; payload: Uint8Array }) => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) });
    const original = this.db.prepare('SELECT id,revision,payload FROM service_records WHERE id=?').get(groupKey(id)) as { id: string; revision: number; payload: Uint8Array } | undefined;
    const rows = original ? [open(original)] : [];
    for (const prefix of [groupMemberPrefix(id), groupEventPrefix(id)]) {
      let after = '', count = 0;
      for (;;) {
        const page = (this.db.prepare('SELECT id,revision,payload FROM service_records WHERE id>=? AND id<? AND id>? ORDER BY id LIMIT 500')
          .all(prefix, prefix + '\uffff', after) as { id: string; revision: number; payload: Uint8Array }[]).map(open);
        rows.push(...page); count += page.length;
        if (count > 10032) throw new Fault(409, 'group_history_bound', 'This Group history exceeds the supported bound. Its original records are kept.');
        if (page.length < 500) break; after = page.at(-1)!.id;
      }
    }
    return rows;
  }
  /** Pure authoritative read. It does not repair unknown records or materialize work. */
  readAssistantGroup(id: string): GroupBundle {
    z.string().uuid().parse(id);
    const rows = this.groupRows(id);
    return verifyGroupRecords(57, rows, this.groupReceipts(rows), value => hash(canonical(value))).get(id)
      ?? { group: null, members: [], events: [] };
  }
  /** A4 metadata-only transaction. Native operations are deliberately not dependencies. */
  admitAssistantGroup(device: string, raw: unknown, prepare: (bundle: GroupBundle) => GroupEvent): GroupReceipt {
    const input = groupCommandSchema.parse(raw);
    this.assertUpdateAdmission();
    if (this.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Finish reviewing the recovered workspace before changing Groups.');
    const admitted = this.admit(device, input, groupIntent(input), () => {
      const rows = this.groupRows(input.groupId), receipts = this.groupReceipts(rows);
      const bundle = verifyGroupRecords(57, rows, receipts, value => hash(canonical(value))).get(input.groupId)
        ?? { group: null, members: [], events: [] };
      const event = groupEventSchema.parse(prepare(bundle));
      if (event.deviceId !== device || canonical(event.command) !== canonical(input))
        throw new Fault(409, 'group_original_changed', 'The Group result does not match its original command.');
      const profile = this.readEntity('profile', 'profile:owner');
      const actor = { profileId: 'profile:owner', revision: profile?.revision ?? 0, name: profile?.value.name ?? 'You',
        ...(profile ? { appearance: profile.value.appearance } : {}) };
      if (canonical(event.actor) !== canonical(actor)) throw new Fault(409, 'group_owner_changed', 'The saved owner capture changed before admission.');
      for (const member of event.addedMembers) {
        const agent = this.readEntity('agent', member.agentId);
        if (!agent || agent.value.archived || agent.revision !== member.agentRevision || agent.value.name !== member.name
          || canonical(agent.value.appearance) !== canonical(member.appearance))
          throw new Fault(409, 'group_agent_changed', 'A selected agent changed before admission.');
      }
      const projectId = event.after.projectId;
      if (input.action !== 'set-archived' && input.action !== 'set-trashed' && projectId
        && (!this.readEntity('project', projectId) || this.projectIsDeleted(projectId)))
        throw new Fault(409, 'group_project_unavailable', 'Restore the original Project before changing this Group.');
      const expected = changeGroup(bundle, input, { eventId: event.id, at: event.at, deviceId: device,
        actor: event.actor, addedMembers: event.addedMembers });
      if (canonical(expected) !== canonical(event)) throw new Fault(409, 'group_transition_changed', 'The Group transition could not be verified.');
      const receipt = groupReceipt(event), entries = [
        { id: groupEventKey(input.groupId, event.sequence), revision: 1, value: event },
        ...event.addedMembers.map(member => ({ id: groupMemberKey(input.groupId, member.id), revision: 1, value: member })),
        { id: groupKey(input.groupId), revision: event.after.revision, value: event.after },
      ];
      for (const entry of entries.slice(0, -1)) if (this.internalRead(entry.id) !== undefined)
        throw new Fault(409, 'group_history_exists', 'An original Group history record already exists.');
      const next = [...rows.filter(row => row.id !== groupKey(input.groupId)), ...entries];
      verifyGroupRecords(57, next, [...receipts, { requestId: input.requestId, deviceId: device,
        digest: hash(canonical(groupIntent(input))), value: receipt }], value => hash(canonical(value)));
      this.writingGroup = true;
      try { for (const entry of entries) this.internalWrite(entry.id, entry.value); }
      finally { this.writingGroup = false; }
      return receipt;
    });
    if (!admitted.fresh) {
      const original = this.readAssistantGroup(input.groupId).events.find(event => event.command.requestId === input.requestId);
      if (!original || original.deviceId !== device || canonical(groupReceipt(original)) !== canonical(admitted.value))
        throw new Fault(409, 'group_original_unavailable', 'The original Group receipt has no complete saved history. Nothing was replayed.');
    }
    return admitted.value;
  }
  private groupPreparationSaved() {
    const versions = new Map<string, unknown>();
    return (kind: string, id: string, revision: number) => {
      const key = canonical([kind, id, revision]);
      if (!versions.has(key)) versions.set(key, this.readEntityVersion(kind as Kind, id, revision)?.value);
      return versions.get(key);
    };
  }
  private groupPreparationRows(groupId: string) {
    const prefix = preparationGroupPrefix(groupId);
    const rows: { id: string; revision: number; value: unknown }[] = [];
    let after = '', bytes = 0;
    for (;;) {
      const page = this.db.prepare('SELECT id,revision,payload FROM service_records WHERE id>=? AND id<? AND id>? ORDER BY id LIMIT 200')
        .all(prefix, prefix + '\uffff', after) as { id: string; revision: number; payload: Uint8Array }[];
      for (const row of page) {
        bytes += row.payload.byteLength;
        if (rows.length >= 4000 || bytes > groupPreparationBytes * 3)
          throw new Fault(409, 'group_preparation_bound', 'This Group preparation history exceeds its supported bound. Its original writing is kept.');
        rows.push({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) });
      }
      if (page.length < 200) return rows;
      after = page.at(-1)!.id;
    }
  }
  private preparationReceipts(rows: { id: string; value: unknown }[]) {
    return rows.filter(row => row.id.includes(':event:')).map(row => {
      const event = groupPreparationEventSchema.parse(row.value);
      const saved = this.db.prepare('SELECT request_id,digest,device_id,payload FROM receipts WHERE request_id=?')
        .get(event.command.requestId) as { request_id: string; digest: string; device_id: string; payload: Uint8Array } | undefined;
      if (!saved) throw new Fault(409, 'group_preparation_receipt_missing', 'An original Group preparation receipt is unavailable.');
      return { requestId: saved.request_id, digest: saved.digest, deviceId: saved.device_id, value: this.open(`receipt:${saved.request_id}`, saved.payload) };
    });
  }
  private groupConversationRows(groupId: string) {
    // Validate the group identity through the maintained prefix constructor.
    preparationGroupPrefix(groupId);
    const prefix = `${groupExecutionPrefix}${groupId}:`;
    const limit = this.db.prepare('SELECT count(*) AS count,COALESCE(SUM(length(payload)),0) AS bytes FROM service_records WHERE id>=? AND id<?')
      .get(prefix, prefix + '\uffff') as { count: number; bytes: number };
    if (limit.count > 1000 * 32 * (groupExecutionEventLimit + 1) || limit.bytes > groupExecutionGroupBytes * 2)
      throw new Fault(409, 'group_execution_bound', 'This Group exceeds its supported retained execution bound.');
    const children = this.db.prepare('SELECT id,revision,payload FROM service_records WHERE id>=? AND id<? ORDER BY id')
      .all(prefix, prefix + '\uffff') as { id: string; revision: number; payload: Uint8Array }[];
    return { preparationRows: this.groupPreparationRows(groupId),
      executionRows: children.map(row => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) })) };
  }
  /** Pure complete saved conversation. No runtime, repair, source refresh or send. */
  readGroupPreparation(groupId: string) {
    const group = this.readAssistantGroup(groupId), { preparationRows, executionRows } = this.groupConversationRows(groupId);
    const verified = verifyGroupConversation(59, [...preparationRows, ...executionRows],
      [...this.preparationReceipts(preparationRows), ...this.groupExecutionReceipts(executionRows)],
      new Map([[groupId, group]]), this.groupPreparationSaved(), value => hash(canonical(value)));
    return { group, preparation: verified.preparations.get(groupId) ?? emptyGroupPreparation(),
      executions: verified.executions, response: verified.response,
      authority: { group, saved: this.groupPreparationSaved(), digest: (value: unknown) => hash(canonical(value)), response: verified.response } };
  }
  private assertCurrentGroupScope(scope: GroupDraftScope, group: GroupBundle) {
    const current = group.group;
    if (!current || current.id !== scope.groupId || current.revision !== scope.groupRevision
      || current.archived || current.trashed || current.membershipRevision !== scope.membershipRevision
      || current.defaultRevision !== scope.defaultRevision || current.projectId !== (scope.project?.id ?? null))
      throw new Fault(409, 'group_scope_changed', 'The original Group scope changed. Its draft and prepared inputs are kept.');
    if (scope.project) {
      const project = this.readEntity('project', scope.project.id);
      if (!project || project.revision !== scope.project.revision || this.projectIsDeleted(project.id))
        throw new Fault(409, 'group_project_changed', 'Review the exact current Project before preparing this Group input.');
    }
    for (const selected of scope.recipients) {
      const member = group.members.find(row => row.id === selected.membershipId);
      const agent = member && this.readEntity('agent', member.agentId);
      if (!member || !current.activeMembershipIds.includes(member.id) || !agent || agent.value.archived
        || agent.revision !== selected.agentRevision)
        throw new Fault(409, 'group_recipient_changed', 'An original recipient changed or left. Keep this draft and review the recipients.');
    }
  }
  /** Revalidation is owner-visible status only. It never upgrades a prepared input to native authority. */
  groupPreparationAvailability(round: PreparedGroupRound, group = this.readAssistantGroup(round.groupId)) {
    try {
      this.assertUpdateAdmission();
      if (this.recoveryEffectsPaused || round.epoch !== this.epoch) throw new Fault(409, 'group_workspace_changed', 'The original workspace needs review.');
      this.assertCurrentGroupScope(round.scope, group);
      for (const source of round.context.sources) {
        const current = this.readEntity(source.kind, source.id);
        if (!current || current.revision !== source.revision || hash(canonical(current.value)) !== source.sha256
          || ('archived' in current.value && current.value.archived)
          || ('trashed' in current.value && current.value.trashed)
          || source.kind === 'project' && this.projectIsDeleted(source.id))
          throw new Fault(409, 'group_source_changed', 'An exact provided source changed or is unavailable.');
      }
      return { current: true as const, execution: 'unavailable' as const, mode: 'provided-context-only' as const };
    } catch (error) {
      if (!(error instanceof Fault)) throw error;
      return { current: false as const, execution: 'unavailable' as const, mode: 'provided-context-only' as const,
        reason: error.code, message: error.message };
    }
  }
  /** Draft revision, prepared input, membership captures and original receipt commit together. */
  admitGroupPreparation(device: string, raw: unknown): GroupPreparationReceipt {
    const input = groupPreparationCommandSchema.parse(raw);
    this.assertUpdateAdmission();
    if (this.recoveryEffectsPaused)
      throw new Fault(409, 'recovery_held', 'Finish reviewing the recovered workspace before preparing Group work.');
    const admitted = this.admit(device, input, groupPreparationIntent(input), () => {
      const { group, preparation, response } = this.readGroupPreparation(input.groupId);
      if (!group.group) throw new Fault(404, 'group_missing', 'The original Group is unavailable.');
      if (input.action === 'prepare') {
        const draft = parseGroupDraft(input.expectedRaw);
        this.assertCurrentGroupScope(draft.scope, group);
      } else if ((input.action === 'grant-history' || input.action === 'grant-history-v2') && (group.group.revision !== input.expectedGroupRevision
        || group.group.archived || group.group.trashed))
        throw new Fault(409, 'group_scope_changed', 'Review the current Group before sharing earlier history.');
      const profile = this.readEntity('profile', 'profile:owner');
      const event = changeGroupPreparation(preparation, input, {
        eventId: randomUUID(), at: new Date(this.now()).toISOString(), deviceId: device,
        ...(input.action === 'prepare' ? { roundId: randomUUID(),
          attemptIds: parseGroupDraft(input.expectedRaw).scope.recipients.map(() => randomUUID()),
          owner: profile ? { id: 'profile:owner' as const, revision: profile.revision, value: profile.value } : null } : {}),
        ...(input.action === 'grant-history' || input.action === 'grant-history-v2' ? { grantId: randomUUID() } : {}),
      }, { group, saved: this.groupPreparationSaved(),
        digest: value => hash(canonical(value)), response });
      if (event.round) {
        const availability = this.groupPreparationAvailability(event.round, group);
        if (!availability.current) throw new Fault(409, availability.reason!, availability.message!);
        if (Buffer.byteLength(canonical(event.round)) > 1024 * 1024)
          throw new Fault(413, 'group_round_large', 'The selected agent designs and provided context exceed the supported prepared input size.');
      }
      const { preparationRows: rows, executionRows } = this.groupConversationRows(input.groupId);
      const receipts = [...this.preparationReceipts(rows), ...this.groupExecutionReceipts(executionRows)];
      const entries = groupPreparationEntries(event), replacing = new Set(entries.map(row => row.id));
      for (const entry of entries) if (!entry.id.includes(':draft:group:') && this.internalRead(entry.id) !== undefined)
        throw new Fault(409, 'group_preparation_exists', 'An original preparation identity already exists. Observe that original work.');
      const receipt = groupPreparationReceipt(event);
      verifyGroupConversation(59, [...rows.filter(row => !replacing.has(row.id)), ...entries, ...executionRows],
        [...receipts, { requestId: input.requestId, deviceId: device, digest: hash(canonical(groupPreparationIntent(input))), value: receipt }],
        new Map([[input.groupId, group]]), this.groupPreparationSaved(),
        value => hash(canonical(value)));
      this.writingGroupPreparation = true;
      try { for (const entry of entries) this.internalWrite(entry.id, entry.value); }
      finally { this.writingGroupPreparation = false; }
      return receipt;
    });
    if (!admitted.fresh) {
      const event = this.readGroupPreparation(input.groupId).preparation.events.find(row => row.command.requestId === input.requestId);
      if (!event || event.deviceId !== device || canonical(groupPreparationReceipt(event)) !== canonical(admitted.value))
        throw new Fault(409, 'group_preparation_original_missing', 'The original receipt has no complete saved preparation. Nothing was replayed.');
    }
    return admitted.value;
  }
  private groupExecutionRows(groupId: string, attemptId: string) {
    const prefix = executionChildPrefix(groupId, attemptId);
    const rows = this.db.prepare('SELECT id,revision,payload FROM service_records WHERE id>=? AND id<? ORDER BY id LIMIT ?')
      .all(prefix, prefix + '\uffff', groupExecutionEventLimit + 2) as { id: string; revision: number; payload: Uint8Array }[];
    if (rows.length > groupExecutionEventLimit + 1
      || rows.reduce((total, row) => total + row.payload.byteLength, 0) > groupExecutionChildBytes * 2)
      throw new Fault(409, 'group_execution_bound', 'This original Group child exceeds its supported retained history bound.');
    return rows.map(row => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) }));
  }
  private groupExecutionReceipts(rows: { id: string; value: unknown }[]) {
    return rows.filter(row => row.id.includes(':event:')).flatMap(row => {
      const event = groupExecutionEventSchema.parse(row.value);
      if (!event.command) return [];
      const saved = this.db.prepare('SELECT request_id,digest,device_id,payload FROM receipts WHERE request_id=?')
        .get(event.command.requestId) as { request_id: string; digest: string; device_id: string; payload: Uint8Array } | undefined;
      if (!saved) throw new Fault(409, 'group_execution_receipt_missing', 'An original child receipt is unavailable.');
      return [{ requestId: saved.request_id, digest: saved.digest, deviceId: saved.device_id,
        value: this.open(`receipt:${saved.request_id}`, saved.payload) }];
    });
  }
  readGroupExecution(groupId: string, attemptId: string) {
    return this.readGroupPreparation(groupId).executions.get(executionChildPrefix(groupId, attemptId));
  }
  private writeGroupExecution(event: GroupExecutionEvent, receipts: ReturnType<Store['groupExecutionReceipts']>) {
    const { group } = this.readGroupPreparation(event.groupId);
    const { preparationRows, executionRows: rows } = this.groupConversationRows(event.groupId);
    const key = executionValueKey(event.groupId, event.attemptId);
    if (this.internalRead(executionEventKey(event)) !== undefined)
      throw new Fault(409, 'group_execution_event_exists', 'This original child transition already exists.');
    const prefix = `${groupExecutionPrefix}${event.groupId}:`;
    const total = this.db.prepare('SELECT COALESCE(SUM(length(payload)),0) AS bytes FROM service_records WHERE id>=? AND id<?')
      .get(prefix, prefix + '\uffff') as { bytes: number };
    // Ciphertext accounting is conservative; reserve both new sealed values
    // without subtracting the current row until the original transaction commits.
    if (total.bytes + Buffer.byteLength(canonical(event)) + Buffer.byteLength(canonical(event.value)) + 1024 > groupExecutionGroupBytes)
      throw new Fault(409, 'group_execution_storage_bound', 'This Group has reached its retained execution storage bound.');
    const childPrefix = executionChildPrefix(event.groupId, event.attemptId);
    verifyGroupConversation(59, [...preparationRows, ...rows.filter(row => row.id !== key),
      { id: key, revision: event.sequence, value: event.value },
      { id: executionEventKey(event), revision: 1, value: event }],
    [...this.preparationReceipts(preparationRows),
      ...this.groupExecutionReceipts(rows.filter(row => !row.id.startsWith(childPrefix))), ...receipts],
    new Map([[event.groupId, group]]), this.groupPreparationSaved(), value => hash(canonical(value)));
    this.writingGroupExecution = true;
    try { this.internalWrite(executionEventKey(event), event); this.internalWrite(key, event.value); }
    finally { this.writingGroupExecution = false; }
  }
  /** Admission and receipt share the original Store transaction. Only the caller
   * receiving fresh:true owns the subsequent native boundary. */
  admitGroupExecution(device: string, raw: unknown, beforeAdmission: (current: GroupExecution | undefined,
    round: PreparedGroupRound) => void) {
    const command = groupExecutionCommandSchema.parse(raw);
    this.assertUpdateAdmission();
    if (this.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Group execution is paused in this recovered copy.');
    const admitted = this.admit(device, command, groupExecutionIntent(command), () => {
      const { preparation, group } = this.readGroupPreparation(command.groupId);
      const round = preparation.rounds.get(command.roundId), original = this.readGroupExecution(command.groupId, command.attemptId);
      if (!round) throw new Fault(404, 'group_round_missing', 'The exact prepared Group input is unavailable.');
      // Stopping an already sent original remains possible after membership or source revocation.
      if (command.action !== 'stop' && command.action !== 'continue-stop') {
        const availability = this.groupPreparationAvailability(round, group);
        if (!availability.current) throw new Fault(409, availability.reason!, availability.message!);
      }
      beforeAdmission(original?.value, round);
      const value = changeGroupExecution(original?.value, command, device, round, input => hash(canonical(input)));
      const event: GroupExecutionEvent = { format: 1, kind: 'assistant-group-child-event',
        groupId: command.groupId, attemptId: command.attemptId, sequence: value.revision,
        at: new Date(this.now()).toISOString(), previousSha256: original ? hash(canonical(original.value)) : null,
        command, observation: null, value };
      const receipt = executionReceipt(event, input => hash(canonical(input)));
      this.writeGroupExecution(event, [...this.groupExecutionReceipts(this.groupExecutionRows(command.groupId, command.attemptId)),
        { requestId: command.requestId, deviceId: device, digest: hash(canonical(groupExecutionIntent(command))), value: receipt }]);
      return receipt;
    });
    const current = this.readGroupExecution(command.groupId, command.attemptId);
    const original = current?.events.find(event => event.command?.requestId === command.requestId);
    if (!original || original.value.binding.deviceId !== device
      || canonical(executionReceipt(original, input => hash(canonical(input)))) !== canonical(admitted.value))
      throw new Fault(409, 'group_execution_original_missing', 'The exact original child receipt has no complete retained history.');
    return { ...admitted, current: current!.value };
  }
  /** A current owner may append an authenticated observation; never replace an
   * old event or infer that interrupted preparing records were never sent. */
  recordGroupExecutionObservation(groupId: string, attemptId: string, expectedSha256: string,
    observation: GroupExecutionObservation) {
    return this.internalAtomic(() => {
      this.assertUpdateAdmission();
      if (this.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Group observations are paused in this recovered copy.');
      const original = this.readGroupExecution(groupId, attemptId);
      if (!original || original.value.binding.epoch !== this.epoch || hash(canonical(original.value)) !== expectedSha256)
        throw new Fault(409, 'group_execution_changed', 'The original Group child changed before this observation was retained.');
      const value = observeGroupExecution(original.value, observation);
      const event: GroupExecutionEvent = { format: 1, kind: 'assistant-group-child-event', groupId, attemptId,
        sequence: value.revision, at: new Date(this.now()).toISOString(), previousSha256: expectedSha256,
        command: null, observation, value };
      this.writeGroupExecution(event, this.groupExecutionReceipts(this.groupExecutionRows(groupId, attemptId)));
      return value;
    });
  }
  readEntity<K extends Kind>(kind: K, id: string): Entity<Values[K]> | undefined { return this.get(kind, id); }
  /** Content service calls inside admission, keeping entity/history/blob references atomic. */
  reviseContent(device:string,id:string,payload:Content,expectedRevision:number):Entity<Content>{
    const current=this.get('content',id);
    if((current?.revision??0)!==expectedRevision)throw new Fault(409,'content_changed','This Content item changed. Review its latest saved version.',current);
    const value=contentSchema.parse(JSON.parse(JSON.stringify(payload)));this.validateRecord('content',id,value,current);
    const result=this.write('content',id,current?.deviceId??device,value,expectedRevision+1);
    this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(id);
    for(const attachment of value.assets??[])this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id,attachment.id);
    return result;
  }
  createContentPlan(device:string,id:string,payload:Assignment):Entity<Assignment>{
    if(this.get('assignment',id))throw new Fault(409,'content_plan_exists','This work plan already exists.');
    const value=recordSchemas.assignment.parse(payload);this.validateRecord('assignment',id,value);
    return this.write('assignment',id,device,value,1);
  }
  /** Trusted CRM services call inside admission/atomic blocks, preserving the same entity/history authority. */
  reviseContact(device: string, id: string, payload: Contact, expectedRevision: number): Entity<Contact> {
    const current = this.get('contact', id);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Fault(409, 'contact_changed', 'This contact changed. Review the current details.');
    const value = contactSchema.parse(payload); this.validateRecord('contact', id, value, current);
    return this.write('contact', id, current?.deviceId ?? device, value, expectedRevision + 1);
  }
  reviseCrmTask(device: string, id: string, payload: Task): Entity<Task> {
    const current = this.get('task', id), value = taskSchema.parse(payload);
    this.validateTask(id, value, current);
    const result = this.write('task', id, current?.deviceId ?? device, value, (current?.revision ?? 0) + 1);
    this.recordTask(result, current); this.syncReminder(result, current); return result;
  }
  listEntities<K extends Kind>(kind: K): Entity<Values[K]>[] { return this.list(kind); }
  get entityCursor(): number { return Math.max(Number(this.db.prepare("SELECT value FROM meta WHERE key='workspace-cursor'").get()?.value ?? 0), Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='history'").get()?.seq ?? 0)); }
  private advanceCursor(prior = this.entityCursor) { this.assertWriteContext(); const next = Math.max(prior + 1, this.entityCursor); this.db.prepare("INSERT INTO meta (key,value) VALUES ('workspace-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next)); }
  /** Resolve an exact saved version only within its current canonical kind. */
  readEntityVersion<K extends Kind>(kind: K, id: string, revision: number): Entity<Values[K]> | undefined {
    const current = this.get(kind, id);
    if (!current || !Number.isInteger(revision) || revision < 1) return undefined;
    if (current.revision === revision) return current;
    const row = this.db.prepare('SELECT payload FROM history WHERE entity_id=? AND revision=?').get(id, revision) as { payload: Uint8Array } | undefined;
    return row ? this.open(`history:${id}:${revision}`, row.payload) as Entity<Values[K]> : undefined;
  }
  /** Capture one immutable effect intent and its receipt atomically, before any external await. */
  replayAdmission<T>(device: string, input: { requestId: string; epoch: string }, intent: unknown): T | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Fault(400, 'invalid_request', 'Invalid request identity.');
    if (input.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Review the original work before continuing.');
    return this.internalReadSnapshot(()=>{if(this.historyReviewLimits)this.internalVerifyFeedHistory();return this.replay(input.requestId,hash(canonical(intent)),device) as T|undefined;});
  }
  admit<T>(device: string, input: { requestId: string; epoch: string }, intent: unknown, prepare: () => T): { value: T; fresh: boolean } {
    this.assertWriteContext(this.derivingProtectedAdmission);
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Fault(400, 'invalid_request', 'Invalid request identity.');
    const digest = hash(canonical(intent)), requestId=input.requestId, epoch=input.epoch;
    return this.transaction(() => {
      if (epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Review the original work before continuing.');
      if(this.historyReviewLimits)this.internalVerifyFeedHistory();
      const original = this.replay(requestId, digest, device);
      if (original !== undefined) {this.capacityTransaction?.replay();return { value: original as T, fresh: false };}
      this.capacityTransaction?.initial();
      const reservedClose=this.prepareReceipt(requestId,digest,device,true);
      const admission={requestId,deviceId:device,digest,touched:false,...(reservedClose?{reservedClose}:{})} as NonNullable<Store['feedAdmission']>;
      this.feedAdmission=admission;
      try {
        const result=this.historyOwners?this.historyOwners.synchronous(prepare):prepare();
        if(admission.touched&&(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof (result as {then?:unknown}).then==='function'))
          throw new Error('Feed admission preparation must be synchronous');
        if(admission.pending&&canonical(result)!==canonical(admission.pending.value))throw new Error('Feed admission result changed after protected validation');
        if(isFeedReceipt(result)&&!admission.pending)throw new Error('Feed receipt has no protected original admission');
        this.receipt(requestId,digest,device,result);
        // transaction() verifies the complete actual graph after this receipt.
        return {value:result,fresh:true};
      } finally { this.feedAdmission=undefined; }
    });
  }
  upload(device: string, requestId: string, epoch: string, name: string, base64: string): Attachment {
    this.assertWriteContext();
    if(this.#historyWrite)throw new Fault(409,'history_operation_held','This historical operation awaits its separate capacity or redaction integration.');
    if (!/^[a-z0-9-]{36}$/i.test(requestId) || !name || name.length > 200 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Fault(400, 'invalid_upload', 'Invalid attachment.');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > 8 * 1024 * 1024) throw new Fault(413, 'file_too_large', 'Choose a file smaller than 8 MB.');
    const digest = hash(canonical({ epoch, name, sha256: hash(bytes), requestId }));
    return this.transaction(() => {
      if (epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'Review this attachment after host recovery.');
      const previous = this.replay(requestId, digest, device); if (previous) return previous as Attachment;
      this.prepareReceipt(requestId,digest,device);
      const total = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM blobs').get() as { total: number }).total;
      if (total + Buffer.byteLength(base64) + 30 > 256 * 1024 * 1024) throw new Fault(507, 'quota', 'This preview’s attachment storage is full. Existing files are kept.');
      const metadata = attachmentSchema.parse({ id: randomUUID(), name: name.replace(/[\x00-\x1f/\\]/g, '_'), size: bytes.length, sha256: hash(bytes) });
      const file = join(this.directory, 'blobs', metadata.id);
      const temporary = `${file}.tmp`;
      const handle = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(handle, this.seal(`blob:${metadata.id}`, base64)); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temporary, file);
      if (process.platform !== 'win32') { const folder = openSync(join(this.directory, 'blobs'), 'r'); try { fsyncSync(folder); } finally { closeSync(folder); } }
      this.db.prepare('INSERT INTO blobs VALUES (?,?,?,?)').run(metadata.id, device, statSync(file).size, this.seal(`blob-meta:${metadata.id}`, metadata));
      this.receipt(requestId, digest, device, metadata);
      return metadata;
    });
  }
  blobMetadata(id: string): Attachment {
    const row = this.db.prepare('SELECT payload FROM blobs WHERE id=?').get(id) as { payload: Uint8Array } | undefined;
    if (!row) throw new Fault(404, 'attachment_missing', 'This attachment is unavailable.');
    return this.open(`blob-meta:${id}`, row.payload);
  }
  download(id: string): { metadata: Attachment; bytes: Buffer } {
    const metadata = this.blobMetadata(id); // Validate authoritative identity before constructing a path.
    const bytes = Buffer.from(this.open(`blob:${id}`, readFileSync(join(this.directory, 'blobs', metadata.id))), 'base64');
    if (hash(bytes) !== metadata.sha256 || bytes.length !== metadata.size) throw new Fault(409, 'attachment_corrupt', 'Attachment integrity check failed.');
    return { metadata, bytes };
  }
}
