import {z} from 'zod';
import {feedProtocolRequestSchema} from './news-feed-semantic-protocol.js';
export {feedStartV3Schema,feedStopV3Schema,feedCloseOriginalSchema} from './news-feed-semantic-protocol.js';
export type {FeedStartV3} from './news-feed-semantic-protocol.js';
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const adaptiveReviewCommandSchema=z.object({format:z.literal(3),requestId:uuid,epoch:uuid,operationId:uuid,expectedRevision:positive,
 briefSha256:sha,planSha256:sha,terminalSha256:sha}).strict();
export const adaptiveApplyCommandSchema=z.object({format:z.literal(3),requestId:uuid,epoch:uuid,operationId:uuid,expectedLearningRevision:positive,
 terminalSha256:sha,captureSha256:sha}).strict();
export type AdaptiveReviewCommand=z.infer<typeof adaptiveReviewCommandSchema>;
export type AdaptiveApplyCommand=z.infer<typeof adaptiveApplyCommandSchema>;
const common={format:z.literal(3),id:uuid,epoch:uuid,requestSha256:sha};
export const adaptiveAdmissionSchema=z.discriminatedUnion('type',[
 z.object({...common,type:z.literal('feed-semantic-worker'),inputHash:sha,originalSha256:sha}).strict(),
 z.object({...common,type:z.literal('feed-semantic-stop'),operationId:uuid,at:positive}).strict(),
 z.object({...common,type:z.literal('feed-semantic-review'),operationId:uuid,planSha256:sha,recordSha256:sha}).strict(),
 z.object({...common,type:z.literal('feed-semantic-learning'),operationId:uuid,learningRevision:positive,recordSha256:sha}).strict(),
]);
export type AdaptiveAdmission=z.infer<typeof adaptiveAdmissionSchema>;
export const adaptiveReviewIntent=(command:AdaptiveReviewCommand)=>({type:'feed-semantic-review',command});
export const adaptiveApplyIntent=(command:AdaptiveApplyCommand)=>({type:'feed-semantic-learning',command});
export const adaptiveProtocolRequestSchema=z.union([feedProtocolRequestSchema,
 z.object({kind:z.literal('accept'),command:adaptiveReviewCommandSchema}).strict(),
 z.object({kind:z.literal('apply-learning'),command:adaptiveApplyCommandSchema}).strict(),
]);
export type AdaptiveProtocolRequest=z.infer<typeof adaptiveProtocolRequestSchema>;
