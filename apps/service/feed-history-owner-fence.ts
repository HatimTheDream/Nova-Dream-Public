/** Maintained source adapter contract. Real owner composition must wrap every
 * entry and retain raw work until its final mutation. A synthetic registry is
 * useful for isolated tests, but is never native/restart qualification. */
export const feedHistoryOwnerRoles=['legacy-authority','legacy-worker','adaptive-authority','adaptive-worker','private-admission'] as const;
export type FeedHistoryOwnerRole=typeof feedHistoryOwnerRoles[number];
export type FeedHistoryWorkKind='preparation'|'ticket'|'job'|'callback'|'run'|'read'|'abort'|'admission';
export type FeedHistoryLease=Readonly<{kind:'feed-history-maintenance-lease'}>;
type LeaseState={owner:object;generation:number;selected:string[];released:boolean};
const leases=new WeakMap<object,LeaseState>();
export class FeedHistoryOwnerFence {
 private roles=new Set<FeedHistoryOwnerRole>(); private work=new Set<object>(); private sealed=false; private generation=0; private held?:FeedHistoryLease;
 private reconciled=false;
 constructor(private readonly store:object){}
 register(role:FeedHistoryOwnerRole){if(this.sealed||this.roles.has(role)||!feedHistoryOwnerRoles.includes(role))throw Error('Feed owner registry is sealed, duplicated or unknown');this.roles.add(role);
  return Object.freeze({enter:(kind:FeedHistoryWorkKind)=>this.enter(role,kind)});}
 sealAfterRetainedReconciliation(){if(this.sealed||feedHistoryOwnerRoles.some(r=>!this.roles.has(r)))throw Error('Complete Feed owner registration required');this.sealed=true;this.reconciled=true;}
 private enter(role:FeedHistoryOwnerRole,kind:FeedHistoryWorkKind){if(!this.roles.has(role)||this.held)throw Error('Feed maintenance entry gate is held');
  if(!['preparation','ticket','job','callback','run','read','abort','admission'].includes(kind))throw Error('Unsupported Feed raw work');
  const token={role,kind};this.work.add(token);this.generation++;let ended=false;
  return Object.freeze({finish:()=>{if(ended)throw Error('Feed work already settled');ended=true;this.work.delete(token);this.generation++;}});}
 acquire(selected:string[]):FeedHistoryLease{
  if(!this.sealed||!this.reconciled||this.held||this.work.size||!selected.length||selected.length>50||selected.some(id=>typeof id!=='string'||!id.length||id.length>300)||new Set(selected).size!==selected.length)throw Error('Feed registered owner work is not quiescent or selection is unsupported');
  // One synchronous registry owns all entry gates; no partially acquired owner
  // gates can escape. Queue/callback entry calls enter again before mutation.
  const lease=Object.freeze({kind:'feed-history-maintenance-lease' as const});this.held=lease;
  leases.set(lease,{owner:this.store,generation:this.generation,selected:[...selected],released:false});return lease;
 }
 assert(lease:FeedHistoryLease,store:object,selected:string[]){const state=leases.get(lease);
  if(!state||state.owner!==store||this.store!==store||state.released||this.held!==lease||state.generation!==this.generation||this.work.size||selected.length!==state.selected.length||selected.some((id,i)=>id!==state.selected[i]))throw Error('Exact same-Store Feed maintenance lease unavailable');}
 release(lease:FeedHistoryLease){const state=leases.get(lease);if(!state||this.held!==lease||state.owner!==this.store||state.released)throw Error('Feed maintenance lease is not owned');state.released=true;this.held=undefined;}
 get blockers(){return {registered:this.roles.size,sealed:this.sealed,reconciled:this.reconciled,rawWork:this.work.size,maintenance:!!this.held};}
}
