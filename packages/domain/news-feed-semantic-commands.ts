import {z} from 'zod';

// These command shapes are extracted unchanged from the reviewed worker/journal.
// Their owners must import/re-export this module at integration, never maintain
// separate definitions. No worker, native evidence or Store code enters clients.
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const commandSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('interpret'),requestId:uuid,epoch:uuid,expectedRevision:z.number().int().positive()}).strict(),
 z.object({kind:z.literal('classify'),requestId:uuid,epoch:uuid,expectedRevision:z.number().int().positive(),
  reviewId:uuid,storyId:digest,storyRevision:z.number().int().positive(),sourceDigest:digest}).strict(),
]);
export type Command=z.infer<typeof commandSchema>;
export const ownerStopCommandSchema=z.object({requestId:uuid,epoch:uuid,id:uuid}).strict();
export type OwnerStopCommand=z.infer<typeof ownerStopCommandSchema>;
export const feedReviewCommandSchema=z.object({requestId:uuid,epoch:uuid,operationId:uuid,expectedRevision:z.number().int().positive(),
 briefSha256:digest,planSha256:digest}).strict();
export type FeedReviewCommand=z.infer<typeof feedReviewCommandSchema>;

export const feedSemanticRequestSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('start'),command:commandSchema}).strict(),
 z.object({kind:z.literal('stop'),command:ownerStopCommandSchema}).strict(),
 z.object({kind:z.literal('accept'),command:feedReviewCommandSchema}).strict(),
]);
export type FeedSemanticRequest=z.infer<typeof feedSemanticRequestSchema>;
const admissionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('feed-semantic-worker'),format:z.literal(2),id:uuid,epoch:uuid,inputHash:digest,originalSha256:digest}).strict(),
 z.object({type:z.literal('feed-semantic-stop'),format:z.literal(2),requestId:uuid,epoch:uuid,id:uuid,at:z.number().int().positive()}).strict(),
 z.object({type:z.literal('feed-semantic-review'),format:z.literal(2),id:uuid,epoch:uuid,operationId:uuid,planSha256:digest,recordSha256:digest}).strict(),
]);
/** Proposed authenticated readback envelope. Confirmed means original local
 * admission only, never a finished model reply, confirmed native stop, or a
 * current eligible story. Missing receipt remains unknown, not rejected. */
export const feedSemanticReceiptSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unknown'),request:feedSemanticRequestSchema}).strict(),
 z.object({state:z.literal('confirmed'),request:feedSemanticRequestSchema,admission:admissionSchema}).strict(),
]);
export type FeedSemanticReceipt=z.infer<typeof feedSemanticReceiptSchema>;
