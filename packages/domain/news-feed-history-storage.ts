import {z} from 'zod';
import {historySealIntentSchema,historySealOutcomeSchema} from './news-feed-history-seal.js';
import {historyRowIndexSchema,historyRequestIndexSchema,historyChildIndexSchema,historyHeadIndexSchema,historyStopIndexSchema,
 historyControlSpanSchema,historyControlRevisionSchema,historyVerificationLimitsSchema} from './news-feed-history-graph.js';

export const historyStorageSchema=61 as const;
export const historyObjectKinds=['segment','row','request','child','head','stop','span','revision','operation'] as const;
export type HistoryObjectKind=typeof historyObjectKinds[number]|'intent'|'outcome';
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),key=z.string().min(1).max(2048),uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const historySegmentObjectSchema=z.object({format:z.literal(1),id:uuid,operationId:uuid,wire:z.string().min(1),wireSha256:sha,
 receiptIds:z.array(uuid).max(1000)}).strict();
/** Immutable selected custody facts only. Later current heads/children are not
 * historic seal-time facts and never enter this commitment. */
export const historySealingOperationSchema=z.object({format:z.literal(1),id:uuid,segmentId:uuid,wireSha256:sha,
 rows:z.array(historyRowIndexSchema).min(1).max(50),requests:z.array(historyRequestIndexSchema).max(850),catalogueSha256:sha}).strict();
const outer={format:z.literal(1),key,rangeKey:key.nullable(),revision:positive};
export const historyStoredObjectSchema=z.discriminatedUnion('kind',[
 z.object({...outer,kind:z.literal('segment'),value:historySegmentObjectSchema}).strict(),
 z.object({...outer,kind:z.literal('row'),value:historyRowIndexSchema}).strict(),
 z.object({...outer,kind:z.literal('request'),value:historyRequestIndexSchema}).strict(),
 z.object({...outer,kind:z.literal('child'),value:historyChildIndexSchema}).strict(),
 z.object({...outer,kind:z.literal('head'),value:historyHeadIndexSchema}).strict(),
 z.object({...outer,kind:z.literal('stop'),value:historyStopIndexSchema}).strict(),
 z.object({...outer,kind:z.literal('span'),value:historyControlSpanSchema}).strict(),
 z.object({...outer,kind:z.literal('revision'),value:historyControlRevisionSchema}).strict(),
 z.object({...outer,kind:z.literal('operation'),value:historySealingOperationSchema}).strict(),
]);
export const historyStoredObject62Schema=z.union([historyStoredObjectSchema,
 z.object({...outer,kind:z.literal('intent'),value:historySealIntentSchema}).strict(),
 z.object({...outer,kind:z.literal('outcome'),value:historySealOutcomeSchema}).strict(),
 z.object({...outer,kind:z.literal('operation'),value:historySealingOperationSchema.extend({intentSha256:sha}).strict()}).strict(),
]);
export type HistoryStoredObject=z.infer<typeof historyStoredObject62Schema>;
export const historyStoreLimitsSchema=z.object({qualification:z.literal('unqualified'),graph:historyVerificationLimitsSchema,
 objects:positive,objectBytes:positive,inputBytes:positive,encryptedBytes:positive}).strict();
export type HistoryStoreLimits=z.infer<typeof historyStoreLimitsSchema>;
export const historyStorageAad=(kind:HistoryObjectKind,key:string)=>`feed-history:1:${kind}:${key}`;
export const historyInventorySchema=z.object({format:z.literal(1),objects:z.array(historyStoredObjectSchema)}).strict();
export const historyInventory62Schema=z.object({format:z.literal(1),objects:z.array(historyStoredObject62Schema)}).strict();
export const sealObject=(kind:HistoryStoredObject['kind'],value:any):HistoryStoredObject=>({format:1,kind,key:kind==='request'?value.requestId:['row','segment','operation','span','intent','outcome'].includes(kind)?value.id:value.key,rangeKey:kind==='stop'?value.targetId:null,revision:1,value} as HistoryStoredObject);
