import {z} from 'zod';
import {historyStoredObject62Schema,type HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';

const natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key=z.string().max(8192),sha=z.string().regex(/^[a-f0-9]{64}$/);
const row=z.object({id:key.min(1),revision:positive,value:z.unknown()}).strict();
const receipt=z.object({requestId:key,deviceId:key,digest:sha,value:z.unknown()}).strict();
export const completionRowFactSchema=z.object({row,ciphertextBytes:positive}).strict();
export const completionObjectFactSchema=z.object({object:historyStoredObject62Schema,ciphertextBytes:positive}).strict();
export const completionReceiptFactSchema=z.object({receipt,ciphertextBytes:positive}).strict();
export type CompletionRowFact=Readonly<{row:SemanticRow;ciphertextBytes:number}>;
export type CompletionObjectFact=Readonly<{object:HistoryStoredObject;ciphertextBytes:number}>;
export type CompletionReceiptFact=Readonly<{receipt:SemanticReceipt;ciphertextBytes:number}>;

// An ACK may be archived: its logical row has no standalone active ciphertext.
// The exact descriptor/receipt remain stored facts; the adapter proves custody.
const acknowledged=z.object({row,descriptor:completionObjectFactSchema,receipt:completionReceiptFactSchema}).strict();
export const completionWorkerFactSchema=z.object({kind:z.literal('worker'),row:completionRowFactSchema,descriptor:completionObjectFactSchema,
 originalReceipt:completionReceiptFactSchema,closeAcknowledgement:acknowledged.optional()}).strict();
export const completionCloseFactSchema=z.object({kind:z.literal('pending-close'),fence:completionRowFactSchema,descriptor:completionObjectFactSchema,
 originalReceipt:completionReceiptFactSchema,pendingRequest:completionObjectFactSchema}).strict();
export const completionSealFactSchema=z.object({kind:z.literal('pending-seal'),intent:completionObjectFactSchema,
 selected:z.array(z.object({row:completionRowFactSchema,descriptor:completionObjectFactSchema}).strict()).min(1).max(50),
 // Exact intent.protection.rows minus selected IDs. Archived dependencies are
 // logical rows, never invented standalone active ciphertext facts.
 dependencies:z.array(row),
 requests:z.array(completionObjectFactSchema),receipts:z.array(completionReceiptFactSchema)}).strict();

/** Untrusted copied facts, not a proof or an actual length certificate. The pure
 * derivation validates all embedded domain values and correspondence. Only a
 * separately admitted Store adapter can attest actual complete enumeration. */
export const completionFactsSchema=z.object({format:z.literal(1),schema:z.union([z.literal(61),z.literal(62)]),
 originalToken:z.string().min(1).max(2048),current:z.object({entries:natural,ciphertextBytes:natural}).strict(),
 workers:z.array(completionWorkerFactSchema),pendingCloses:z.array(completionCloseFactSchema),pendingSeals:z.array(completionSealFactSchema)}).strict();
export type CompletionFacts=z.infer<typeof completionFactsSchema>;
export type CompletionWorkerFact=z.infer<typeof completionWorkerFactSchema>;
export type CompletionCloseFact=z.infer<typeof completionCloseFactSchema>;
export type CompletionSealFact=z.infer<typeof completionSealFactSchema>;

export type CompletionIdentity=Readonly<{kind:'worker'|'pending-close'|'pending-seal';id:string}>;
export type CompletionAmount=Readonly<{entries:number;ciphertextBytes:number}>;
export type CompletionUnsupportedReason='worker-events-exhausted'|'worker-revision-exhausted'|'row-descriptor-revision-exhausted'
 |'request-descriptor-revision-exhausted'|'seal-row-descriptor-revision-exhausted';
export type WorkerCompletionSize=Readonly<{kind:'worker';identity:CompletionIdentity;workerPayloadMax:number;workerCipherMax:number;
 rowDescriptorCipherMax:number;remainingOwnerStops:number;eachStopRequestCipherMax:number;eachStopReceiptCipherMax:number;
 closeHeadroom:CompletionAmount;growth:CompletionAmount;overlap:CompletionAmount}>;
export type CloseCompletionSize=Readonly<{kind:'pending-close';identity:CompletionIdentity;rowCipherMax:number;rowDescriptorCipherMax:number;
 requestDescriptorCipherMax:number;receiptCipherMax:number;growth:CompletionAmount;overlap:CompletionAmount}>;
export type SealCompletionSize=Readonly<{kind:'pending-seal';identity:CompletionIdentity;normalizedIntentCipherBytes:number;
 commit:CompletionAmount;notPerformed:CompletionAmount;growth:CompletionAmount;overlap:CompletionAmount}>;
export type CompletionObligationSize=WorkerCompletionSize|CloseCompletionSize|SealCompletionSize;
export type CompletionResult=Readonly<{kind:'sized';qualification:'unqualified';originalToken:string;
 occupancyScope:'history-objects+semantic-service-records+all-receipts';current:CompletionAmount;obligations:readonly CompletionObligationSize[];
 remainingGrowth:CompletionAmount;maximumSingleTransitionOverlap:CompletionAmount;liveness:'not-qualified'}>
 |Readonly<{kind:'unsupported-completion';qualification:'unqualified';originalToken:string;reason:CompletionUnsupportedReason;identity:CompletionIdentity}>;

const identity=z.object({kind:z.enum(['worker','pending-close','pending-seal']),id:key.min(1)}).strict();
const amount=z.object({entries:natural,ciphertextBytes:natural}).strict();
const common={identity,growth:amount,overlap:amount};
const obligation=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('worker'),workerPayloadMax:natural,workerCipherMax:natural,rowDescriptorCipherMax:natural,
  remainingOwnerStops:natural,eachStopRequestCipherMax:natural,eachStopReceiptCipherMax:natural,closeHeadroom:amount}).strict(),
 z.object({...common,kind:z.literal('pending-close'),rowCipherMax:natural,rowDescriptorCipherMax:natural,requestDescriptorCipherMax:natural,receiptCipherMax:natural}).strict(),
 z.object({...common,kind:z.literal('pending-seal'),normalizedIntentCipherBytes:natural,commit:amount,notPerformed:amount}).strict(),
]);
export const completionResultSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('sized'),qualification:z.literal('unqualified'),originalToken:z.string().min(1).max(2048),
  occupancyScope:z.literal('history-objects+semantic-service-records+all-receipts'),current:amount,obligations:z.array(obligation),
  remainingGrowth:amount,maximumSingleTransitionOverlap:amount,liveness:z.literal('not-qualified')}).strict(),
 z.object({kind:z.literal('unsupported-completion'),qualification:z.literal('unqualified'),originalToken:z.string().min(1).max(2048),identity,
  reason:z.enum(['worker-events-exhausted','worker-revision-exhausted','row-descriptor-revision-exhausted','request-descriptor-revision-exhausted','seal-row-descriptor-revision-exhausted'])}).strict(),
]);

/** Test allowance only. Inherited full graph verification is not performed by
 * this pure helper. New work counters never claim total verifier/physical cost. */
export const completionFixtureLimits=Object.freeze({qualification:'unqualified' as const,entries:16384,bytes:16*1024*1024,queries:4096});
