import {createHash} from 'node:crypto';
import {canonical} from '../../packages/domain/contracts.js';
import type {IdeaEntry,IdeaPursuit,IdeaRun} from '../../packages/domain/idea-pursuits.js';
import type {Store} from './store.js';
import type {FeedSavedState} from '../../packages/domain/news-feed.js';

export const ideaActivityPrefix='home:ideas:activity:';
export type IdeaActivity={pursuitId:string;entryId:string;operationId:string;at:string;authoredSha256:string};
export function authoredIdea(entry:IdeaEntry){
 const directions=entry.handoff.authoredDirections??'',question=entry.question??'';
 return {text:[directions,question].filter(value=>value.trim()).join('\n\n'),
  hash:createHash('sha256').update(canonical({entryId:entry.id,directions,question})).digest('hex')};
}
/** Only a fresh, explicitly submitted original operation creates this index.
 * No conversation text or captured source body is copied into the signal. */
export function ideaActivityIndex(store:Store,run:IdeaRun,input:string){
 const learning=store.internalRead<FeedSavedState>('home:news:state')?.profile.settings.learning;
 if(!learning?.enabled||learning.paused||learning.instructionsOnly||!learning.allowed.includes('ideas'))return [];
 const entry=store.internalRead<IdeaEntry>('home:ideas:entry:'+run.entryId),pursuit=store.internalRead<IdeaPursuit>('home:ideas:pursuit:'+run.pursuitId);
 if(!entry||!pursuit||entry.pursuitId!==pursuit.id||entry.epoch!==store.epoch||pursuit.epoch!==store.epoch)return [];
 const at=Date.parse(run.createdAt),authored=authoredIdea(entry);
 if(!Number.isFinite(at)||at<0||at>9999999999999||!authored.text.trim())return [];
 if([entry.handoff.authoredDirections,entry.question].some(text=>text?.trim()&&!input.includes(text.trim())))return [];
 const value:IdeaActivity={pursuitId:run.pursuitId,entryId:run.entryId,operationId:run.operationId,at:run.createdAt,authoredSha256:authored.hash};
 return [{id:ideaActivityPrefix+(9999999999999-at).toString().padStart(13,'0')+':'+run.operationId,value}];
}
