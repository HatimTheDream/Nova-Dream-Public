import {z} from 'zod';
import {historyRowIndexSchema} from './news-feed-history-graph.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commitment=z.object({id:z.string().min(1).max(2048),revision:positive,rowSha256:sha,jsonSha256:sha}).strict();
export const historySealContracts=Object.freeze({codec:'feed-history-correspondence-2',graph:'complete-history-store-62-seal-1'});
/** Explicit schema62 successor. These are durable originals, never a lease or
 * evidence of owner/native quiescence. Limits are checked before parsing. */
export const historySealIntentSchema=z.object({format:z.literal(1),id:uuid,segmentId:uuid,workspaceEpoch:uuid,
 createdAt:positive,deadlineAt:positive,sourceTokenSha256:sha,limitsSha256:sha,
 contracts:z.object({codec:z.literal('feed-history-correspondence-2'),graph:z.literal('complete-history-store-62-seal-1')}).strict(),
 rows:z.array(commitment.extend({descriptor:historyRowIndexSchema}).strict()).min(1).max(50),
 protection:z.object({rows:z.array(commitment),receipts:z.array(z.object({id:z.string().min(1).max(2048),sha256:sha}).strict()),
  objects:z.array(z.object({kind:z.enum(['span','revision']),key:z.string().min(1).max(2048),sha256:sha}).strict())}).strict(),
 wireSha256:sha,catalogueSha256:sha,
 reservation:z.object({addedObjects:positive,encodedBytes:positive,encryptedBytes:positive}).strict(),
}).strict();
export type HistorySealIntent=z.infer<typeof historySealIntentSchema>;
export const historySealOutcomeSchema=z.discriminatedUnion('state',[
 z.object({format:z.literal(1),id:uuid,intentSha256:sha,state:z.literal('completed'),at:positive,segmentId:uuid,wireSha256:sha,catalogueSha256:sha}).strict(),
 z.object({format:z.literal(1),id:uuid,intentSha256:sha,state:z.literal('not-performed'),at:positive,reason:z.enum(['expired','explicit-close'])}).strict(),
]);
export type HistorySealOutcome=z.infer<typeof historySealOutcomeSchema>;
