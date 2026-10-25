import {makeControlProof,resolveControlBaseline} from '../../packages/domain/news-feed-adaptive-controls.js';
import {requireCurrentAdaptiveSource} from '../../packages/domain/news-feed-adaptive-graph.js';
import {validateAdaptiveSource,type AdaptiveSource,type PreferenceCheckpoint} from '../../packages/domain/news-feed-adaptive-capture.js';
import type {FeedAdaptiveContext} from '../../packages/domain/news-feed-adaptive.js';
import type {FeedAdaptiveSelection} from '../../packages/domain/news-feed-adaptive-selection.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';

/** Internal only: the caller supplies an already verified graph and these exact
 * authoritative inputs from ONE enclosing Store snapshot. No cache, Store write,
 * activity collection or caller authorization occurs here. Historical corruption
 * must fail graph verification before calling this optional current projection. */
export function projectAdaptiveControlSource(graph:FeedReadGraph,current:{epoch:string;deviceId:string;preferences:PreferenceCheckpoint;
 activity:FeedAdaptiveContext['activity'];selection:FeedAdaptiveSelection;at:number},hash:(text:string)=>string):
 {usable:true;source:AdaptiveSource}|{usable:false;reason:'current-control-projection-unavailable'}{
 try{
  const mutations=[...graph.mutations.values()].filter(row=>row.deviceId===current.deviceId&&row.command.epoch===current.epoch),parents=new Set(mutations.map(row=>row.before.learningHead));
  const heads=mutations.filter(row=>!parents.has(row.id));if(heads.length>1)throw new Error('Current owner graph forked');
  const head=heads[0],context={epoch:current.epoch,deviceId:current.deviceId,profile:structuredClone(current.preferences.profile),control:structuredClone(current.preferences.control),
   activity:structuredClone(current.activity),learning:{revision:1,interests:[],suppressed:[]} as FeedAdaptiveContext['learning']};
  let source:AdaptiveSource={context,selection:structuredClone(current.selection),preferences:structuredClone(current.preferences),learningHead:head?.id??null};
  if(head){const baseline=resolveControlBaseline(graph,current.deviceId,current.epoch,head.id,hash),{proof,projection}=makeControlProof(baseline,current.preferences,[...graph.receipts.values()],hash);
   source={...source,context:{...context,learning:projection.learning},controlProof:proof};}
  validateAdaptiveSource(source,current.at,hash);requireCurrentAdaptiveSource(graph,source,current.deviceId,current.epoch,current.at,hash);
  return {usable:true,source};
 }catch{return {usable:false,reason:'current-control-projection-unavailable'};}
}
