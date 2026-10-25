import {verifyFeedLocalGraph,type Ledger,type FeedLocalGraph} from '../../packages/domain/news-feed-successor-journal.js';
import {feedWorkerOriginal as legacyOriginal,terminal,same} from '../../packages/domain/news-feed-worker.js';
import {feedWorkerOriginal as adaptiveOriginal} from '../../packages/domain/news-feed-adaptive-worker.js';
import {hasFeedSemanticReceipt,type SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import {workerInputHash,workerNativeIdentity} from './worker-plugin/identity.js';

export const feedServicePrefix='news:semantic-';
export const isFeedReceipt=hasFeedSemanticReceipt;
export const verifyFeedStoreLedger=(ledger:Ledger)=>verifyFeedLocalGraph(ledger,workerInputHash,workerNativeIdentity);

/** The complete successor graph verifies derivation. This additionally preserves
 * every established original across a write; a valid replacement is not history. */
export function assertFeedStoreTransition(before:SemanticRow|undefined,after:SemanticRow){
 if(!after.id.startsWith(feedServicePrefix)||!Number.isSafeInteger(after.revision)||after.revision<1||
  (after.value as {revision?:unknown})?.revision!==after.revision)throw new Error('Invalid Feed row revision');
 if(!before){if(after.revision!==1)throw new Error('A Feed original must begin at revision one');return;}
 if(after.id!==before.id||after.revision!==before.revision+1)throw new Error('Feed predecessor revision changed');
 const worker=before.id.startsWith('news:semantic-worker:')||before.id.startsWith('news:semantic-adaptive-worker:');
 if(!worker)throw new Error('An immutable Feed original cannot be overwritten');
 const prior=before.value as any,next=after.value as any;
 if(terminal(prior))throw new Error('A terminal Feed original is immutable');
 if(prior.format!==next.format||!same(prior.format===3?adaptiveOriginal(prior):legacyOriginal(prior),
  next.format===3?adaptiveOriginal(next):legacyOriginal(next)))throw new Error('Feed original identity changed');
 for(const name of ['events','ownerStops'] as const){
  if(!Array.isArray(next[name])||!Array.isArray(prior[name])||next[name].length<prior[name].length||
   !same(next[name].slice(0,prior[name].length),prior[name]))throw new Error('Feed original history is not append-only');
 }
 for(const name of ['hostId','runtimeVersion','runId','sessionKey','dispatchAt','originalReceipt'] as const)
  if(prior[name]!==undefined&&!same(prior[name],next[name]))throw new Error('Established Feed native identity changed');
 if(prior.stop){
  if(!next.stop)throw new Error('Original Feed Stop was removed');
  for(const name of ['reason','requestId','requestedAt','attemptedAt'] as const)
   if(prior.stop[name]!==undefined&&!same(prior.stop[name],next.stop[name]))throw new Error('Original Feed Stop identity changed');
  if(prior.stop.abort?.attemptedAt!==undefined&&prior.stop.abort.attemptedAt!==next.stop.abort?.attemptedAt)
   throw new Error('Original Feed abort identity changed');
 }
}

/** Keep original semantic receipts and exact saved-preference dependencies. The
 * forthcoming control-proof graph supplies every intervening saved receipt too. */
export function protectedFeedReceiptIds(graph:FeedLocalGraph){
 const ids=new Set<string>([...graph.originalRequests.keys(),...graph.expected.keys()]);
 const keep=(receipt:any)=>{if(receipt?.requestId)ids.add(receipt.requestId);};
 for(const worker of graph.workers.values())if(worker.format===3)keep((worker as any).capture.source.preferences.latestMutation);
 for(const review of graph.reviews.values())keep((review.record as any).preferences?.latestMutation);
 for(const mutation of graph.mutations.values()){
  keep(mutation.before.preferences.latestMutation);if('preferencesAfter' in mutation)keep(mutation.preferencesAfter.latestMutation);
 }
 const controls=(graph as FeedLocalGraph&{protectedControlReceiptIds?:ReadonlySet<string>}).protectedControlReceiptIds;
 if(controls)for(const id of controls)ids.add(id);
 return ids;
}
