import type {FeedLocalGraph} from './news-feed-successor-journal.js';

/** Complete semantic data only. This is never a write/admission capacity proof.
 * Concrete methods and iterators belong to one synchronous Store read scope. */
type ReadMap<K extends keyof FeedLocalGraph>=FeedLocalGraph[K] extends Map<infer I,infer V>?ReadonlyMap<I,V>:never;
export type FeedReadGraph={
 workers:ReadMap<'workers'>;reviews:ReadMap<'reviews'>;
 adaptiveWorkers:ReadMap<'adaptiveWorkers'>;adaptiveReviews:ReadMap<'adaptiveReviews'>;
 learning:ReadMap<'learning'>;controls:ReadMap<'controls'>;mutations:ReadMap<'mutations'>;
 locals:ReadMap<'locals'>;originalRequests:ReadMap<'originalRequests'>;
 reservedCloseCommands:ReadMap<'reservedCloseCommands'>;receipts:ReadMap<'receipts'>;
 readonly active:{readonly rows:number;readonly bytes:number;readonly reserved:{readonly rows:number;readonly bytes:number}};
};
export type FeedReadProjectionLimits={qualification:'unqualified';entries:number;bytes:number;copies:number;copyBytes:number};
/** Finite source-review projection budget, not a new active storage allowance or
 * measured physical memory/capacity qualification. Exhaustion refuses whole read. */
export const feedReadProjectionLimits:FeedReadProjectionLimits=Object.freeze({qualification:'unqualified',entries:100000,bytes:64*1024*1024,copies:100000,copyBytes:64*1024*1024});
