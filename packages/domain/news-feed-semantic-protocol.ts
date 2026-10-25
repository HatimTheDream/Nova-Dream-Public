import {z} from 'zod';
import {commandSchema,ownerStopCommandSchema,feedReviewCommandSchema} from './news-feed-semantic-commands.js';

// Explicit successor. The legacy definitions remain unchanged for recovery.
const id=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const feedInitialExpectationSchema=z.object({preparedAt:integer,deadlineAt:integer,contractVersion:z.literal('adaptive-2'),
 captureSha256:sha,modelInputSha256:sha,nativePolicySha256:sha}).strict();
export type FeedInitialExpectation=z.infer<typeof feedInitialExpectationSchema>;
export const feedAdaptiveBasisSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('accepted'),reviewId:id,originalProofSha256:sha}).strict(),
 z.object({kind:z.literal('empty-written'),preferenceProofSha256:sha}).strict(),
]);
const common={format:z.literal(3),requestId:id,epoch:id,expectedRevision:integer,expectation:feedInitialExpectationSchema};
export const feedStartV3Schema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('interpret')}).strict(),
 z.object({...common,kind:z.literal('learn'),basis:feedAdaptiveBasisSchema}).strict(),
 z.object({...common,kind:z.literal('classify'),basis:feedAdaptiveBasisSchema,
  story:z.object({id:sha,revision:integer,sourceId:z.string().min(1).max(200),sourceDigest:sha}).strict()}).strict(),
]);
export type FeedStartV3=z.infer<typeof feedStartV3Schema>;
const preparation={format:z.literal(3),requestId:id,epoch:id};
export const feedStartPreparationSchema=z.discriminatedUnion('kind',[
 z.object({...preparation,kind:z.literal('interpret')}).strict(),
 z.object({...preparation,kind:z.literal('learn'),basis:feedAdaptiveBasisSchema}).strict(),
 z.object({...preparation,kind:z.literal('classify'),basis:feedAdaptiveBasisSchema,
  story:z.object({id:sha,revision:integer,sourceId:z.string().min(1).max(200),sourceDigest:sha}).strict()}).strict(),
]);
export type FeedStartPreparation=z.infer<typeof feedStartPreparationSchema>;
export const feedRecoverableStartSchema=z.union([feedStartV3Schema,commandSchema]);
export const feedStopV3Schema=ownerStopCommandSchema.extend({format:z.literal(3)}).strict();
export const feedRecoverableStopSchema=z.union([feedStopV3Schema,ownerStopCommandSchema]);
export const feedCloseOriginalSchema=z.object({format:z.literal(3),requestId:id,epoch:id,original:feedRecoverableStartSchema}).strict()
 .superRefine((value,context)=>{if(value.epoch!==value.original.epoch||value.requestId===value.original.requestId)
  context.addIssue({code:'custom',message:'Close must retain a distinct request and the original epoch'});});
export type FeedCloseOriginal=z.infer<typeof feedCloseOriginalSchema>;
export const feedProtocolRequestSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('start'),command:feedRecoverableStartSchema}).strict(),
 z.object({kind:z.literal('stop'),command:feedRecoverableStopSchema}).strict(),
 z.object({kind:z.literal('accept'),command:feedReviewCommandSchema}).strict(),
 z.object({kind:z.literal('close'),command:feedCloseOriginalSchema}).strict(),
]);
export type FeedProtocolRequest=z.infer<typeof feedProtocolRequestSchema>;
const localAdmission={type:z.literal('feed-semantic-local'),format:z.literal(3),id,epoch:id,recordSha256:sha,requestSha256:sha};
export const feedLocalAdmissionSchema=z.discriminatedUnion('kind',[
 z.object({...localAdmission,kind:z.literal('closed-before-admission')}).strict(),
 z.object({...localAdmission,kind:z.literal('refused-before-admission')}).strict(),
 z.object({...localAdmission,kind:z.literal('stop-no-effect-terminal'),targetId:id,terminalSha256:sha}).strict(),
 z.object({...localAdmission,kind:z.literal('close-ack'),outcome:z.enum(['closed-before-admission','already-refused','already-admitted']),
  originalRequestId:id,originalRequestSha256:sha,originalReceiptSha256:sha}).strict(),
]);
export type FeedLocalAdmission=z.infer<typeof feedLocalAdmissionSchema>;
export const feedLocalReadbackSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unknown'),request:feedProtocolRequestSchema}).strict(),
 z.object({state:z.literal('confirmed'),request:feedProtocolRequestSchema,admission:feedLocalAdmissionSchema,historical:z.boolean()}).strict(),
]);
export type FeedProtocolReadback={state:'unknown';request:FeedProtocolRequest}|{state:'confirmed';request:FeedProtocolRequest;
 admission:unknown;historical:boolean};
export const feedProtocolLimits={deadlineMs:180000,preparationAgeMs:180000,records:512,bytes:8*1024*1024,historyRows:50,historyBytes:131072,
 localRecordBytes:16384,localReceiptBytes:4096,maxOwnerStops:16} as const;
