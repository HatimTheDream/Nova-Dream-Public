import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {feedCommandSchema,type FeedStory} from '../../packages/domain/news-feed.js';
import {Fault,type Store} from './store.js';
import type {NewsFeed} from './news-feed.js';
import type {FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import type {FeedCurrentPermissionResolver} from './feed-adaptive-current-source.js';
import type {FeedAdaptiveView} from './feed-adaptive-view.js';
const uuid=z.string().uuid(),permissionSchema=z.object({read:z.boolean(),write:z.boolean()}).strict();
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Server-owned original reading admission. Eligibility is rederived inside
 * news.command's transaction before its new receipt/event has been committed.
 * Browser display proofs and current native readiness grant no authority. */
export class FeedAdaptiveReading{
 constructor(private store:Store,private news:Pick<NewsFeed,'internalReadingCommand'|'receipt'>,
  private view:Pick<FeedAdaptiveView,'readingEligible'>,private permissions:FeedCurrentPermissionResolver){}
 private owner(input:FeedAdaptiveOwner){if(typeof input?.authorize!=='function')throw Error('Original authenticated Feed request required');
  return Object.freeze({deviceId:uuid.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:input.authorize.bind(input)});}
 private guard(owner:FeedAdaptiveOwner,write:boolean){
  const result:unknown=owner.authorize();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw Error('Original authorization must be synchronous');}
  const raw:unknown=this.permissions(owner);if(raw&&typeof(raw as any).then==='function'){void Promise.resolve(raw).catch(()=>{});throw Error('Current permissions must be synchronous');}
  const value=permissionSchema.parse(raw);if(!same(value,raw)||!value.read||write&&!value.write||owner.epoch!==this.store.epoch)throw new Fault(403,'feed_reading_authority','The original reading access changed. Its request is kept.');
 }
 private input(raw:unknown){const command=feedCommandSchema.parse(raw);if(command.type!=='reading')throw new Fault(400,'news_reading_command','Use the exact original reading command.');return command;}
 receipt(input:FeedAdaptiveOwner,raw:unknown){const owner=this.owner(input);this.guard(owner,false);
  try{const command=this.input(raw);if(command.epoch!==owner.epoch)throw new Fault(409,'epoch_changed','The workspace changed. Keep the original reading request.');return this.news.receipt(owner.deviceId,command);}finally{this.guard(owner,false);}
 }
 command(input:FeedAdaptiveOwner,raw:unknown){const owner=this.owner(input);this.guard(owner,true);
  try{const command=this.input(raw);if(command.epoch!==owner.epoch)throw new Fault(409,'epoch_changed','The workspace changed. Keep the original reading request.');
   return this.news.internalReadingCommand(owner.deviceId,command,{authorize:()=>this.guard(owner,true),eligible:(story:FeedStory)=>{
    this.guard(owner,true);const eligible=this.view.readingEligible(owner,story);this.guard(owner,true);return eligible;
   }});
  }finally{this.guard(owner,true);}
 }
}
