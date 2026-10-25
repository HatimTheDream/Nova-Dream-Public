import type {NewsFeed} from './news-feed.js';
import type {FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import type {AdaptiveAuthority,PreferenceCheckpoint} from '../../packages/domain/news-feed-adaptive-capture.js';
import {projectAdaptiveControlSource} from './feed-adaptive-control-source.js';
import {workerInputHash as hash} from './worker-plugin/identity.js';
import {canonical} from '../../packages/domain/contracts.js';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function need(yes:unknown,message:string):asserts yes{if(!yes)throw new Error(message);}
/** Pure same-snapshot core. The service caller has already verified the complete
 * graph and current owner; this function performs no Store, auth or native work. */
export function projectFeedAdaptiveCurrent(owner:Pick<FeedAdaptiveOwner,'deviceId'|'epoch'>,graph:FeedReadGraph,preferences:PreferenceCheckpoint,
 raw:ReturnType<NewsFeed['internalAdaptiveSourceSnapshot']>){
 const writing:AdaptiveAuthority['writing']={scope:'writing',context:{epoch:owner.epoch,deviceId:owner.deviceId,profile:structuredClone(preferences.profile)},preferences:structuredClone(preferences)};
 let source:AdaptiveAuthority['source']=null;
 if(raw.usable){const snapshot=raw.snapshot;
  need(snapshot.epoch===owner.epoch&&snapshot.deviceId===owner.deviceId&&same(snapshot.profile,preferences.profile)&&same(snapshot.control,preferences.control),
   'Raw source does not share current saved preferences');
  const projected=projectAdaptiveControlSource(graph,{epoch:owner.epoch,deviceId:owner.deviceId,preferences,activity:snapshot.activity,selection:snapshot.selection,at:snapshot.at},hash);
  if(projected.usable)source=projected.source;
 }
 return structuredClone({deviceId:owner.deviceId,epoch:owner.epoch,writing,source});
}

