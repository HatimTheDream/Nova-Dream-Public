import {feedTopicKey,type FeedProfile,type FeedLearningControl} from './news-feed.js';

/** The existing literal evidence policy, isolated for the versioned semantic
 * route. The legacy implementation remains byte-identical; parity is tested. */
export const feedStrengthPolicy={day:86400000,maximumAgeDays:90,halfLifeDays:30,minimumSources:2,minimumScore:4,maximumSupports:8,
 weights:{open:0,return:1,save:3,pursue:4}} as const;
export type StrengthEvidence={id:string;eventId:string;source:'reading'|'library'|'ideas';sourceId:string;at:string;
 action:keyof typeof feedStrengthPolicy.weights;available:boolean};
export function permittedStrengthEvidence(profile:FeedProfile,control:FeedLearningControl,row:StrengthEvidence,now:number){
 const at=Date.parse(row.at),policy=feedStrengthPolicy;
 return Number.isFinite(now)&&profile.settings.learning.allowed.includes(row.source)&&row.available&&Number.isFinite(at)&&at<=now&&
  (!control.resetAt||at>Date.parse(control.resetAt))&&now-at<=policy.maximumAgeDays*policy.day&&policy.weights[row.action]>0;
}
export function feedEvidenceStrength<T extends StrengthEvidence>(rows:T[],now:number,beforeCompare?:(left:string,right:string)=>void):{score:number;evidence:T[]}|undefined{
 if(!Number.isFinite(now))return;
 const policy=feedStrengthPolicy,bySource=new Map<string,T>();
 for(const row of rows){const at=Date.parse(row.at);if(!Number.isFinite(at)||at>now||now-at>policy.maximumAgeDays*policy.day||!policy.weights[row.action])continue;
  const key=row.source+':'+row.sourceId,old=bySource.get(key);
  if(!old||policy.weights[row.action]>policy.weights[old.action]||policy.weights[row.action]===policy.weights[old.action]&&row.at>old.at)bySource.set(key,row);}
 const byEvent=new Map<string,T>();for(const row of bySource.values()){const old=byEvent.get(row.eventId);
  if(!old||policy.weights[row.action]>policy.weights[old.action])byEvent.set(row.eventId,row);}
 // Optional accounting is invoked before each unchanged native comparator.
 // It supplies no data, ranking rule or authority, and ordinary callers omit it.
 const evidence=[...byEvent.values()].sort((a,b)=>{
  beforeCompare?.(b.at,a.at);const order=b.at.localeCompare(a.at);if(order)return order;
  beforeCompare?.(a.id,b.id);return a.id.localeCompare(b.id);
 }).slice(0,policy.maximumSupports);
 if(evidence.length<policy.minimumSources)return;
 const score=evidence.reduce((sum,row)=>sum+policy.weights[row.action]*Math.pow(0.5,(now-Date.parse(row.at))/(policy.halfLifeDays*policy.day)),0);
 return score>=policy.minimumScore?{score,evidence}:undefined;
}
export const sameFeedTopic=(a:string,b:string)=>feedTopicKey(a)===feedTopicKey(b);
