import {canonical} from '../../packages/domain/contracts.js';
import {feedProfileSchema,feedStorySchema,feedHardFilter,type FeedSavedState,type FeedSourceCache,type FeedStory} from '../../packages/domain/news-feed.js';
import {canonicalNewsUrl,newsDigest} from './news-feed-parser.js';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export const feedCacheByteLimit=8*1024*1024;
/** Pure enabled-cache index. Every story retains the same per-ID uniqueness,
 * exact source/preview and hard-denial checks as the original single read.
 * Invalid global cache structure refuses the inventory; one invalid target is
 * omitted without inventing a replacement from duplicate occurrences. */
export function currentFeedStoryInventory(saved:FeedSavedState,raw:FeedSourceCache[]):Map<string,{story:FeedStory;hidden:string[]}>|undefined{
 try{
  const profile=feedProfileSchema.parse(saved.profile);
  if(!same(profile,saved.profile)||!Array.isArray(saved.hidden)||saved.hidden.some(value=>typeof value!=='string')||
   !Array.isArray(raw)||new TextEncoder().encode(JSON.stringify(raw)).byteLength>feedCacheByteLimit)return;
  const caches:FeedSourceCache[]=[];
  for(const source of profile.settings.sources.filter(value=>value.enabled)){
   const matches=raw.filter(row=>row.source.id===source.id);if(matches.length>1)return;
   if(matches[0]&&same(matches[0].source,source))caches.push(matches[0]);
  }
  const groups=new Map<string,{story:FeedStory;cache:FeedSourceCache}[]>();
  for(const cache of caches)for(const story of cache.stories){const id=story.id;if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))continue;
   groups.set(id,[...(groups.get(id)??[]),{story,cache}]);}
  const index=new Map<string,{story:FeedStory;hidden:string[]}>();
  for(const [id,rows] of groups){if(rows.length!==1)continue;
   try{const {cache}=rows[0]!,story=feedStorySchema.parse(rows[0]!.story);
    if(!same(story,rows[0]!.story)||story.sourceId!==cache.source.id||story.sourceDigest!==cache.sourceDigest||
     story.publisherId!==new URL(cache.source.url).hostname||story.id!==newsDigest(story.canonicalUrl)||canonicalNewsUrl(story.canonicalUrl)!==story.canonicalUrl||
     feedHardFilter(profile,story,{hidden:saved.hidden}))continue;
    index.set(id,structuredClone({story,hidden:saved.hidden}));
   }catch{/* This exact target remains unavailable, just as its original read. */}
  }
  return index;
 }catch{return;}
}
