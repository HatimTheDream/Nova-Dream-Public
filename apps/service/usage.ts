import type { AssistantTransport } from './gateway.js';
import type { UsageState } from '../../packages/domain/usage.js';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown) => Array.isArray(v) ? v : [];
const text = (v: unknown, fallback: string) => typeof v === 'string' && v.trim() ? v.slice(0,120) : fallback;
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const emptyActivity = (): UsageState['activity'] => ({ tokens:null,input:null,output:null,cacheRead:null,daily:[],status:'unavailable' });
/** Project only documented usage fields. Never forward provider errors, keys or profiles. */
export function projectUsage(quota: unknown, activity: unknown, now: number): UsageState {
  const q=object(quota), a=object(activity), totals=object(a.totals), cache=object(a.cacheStatus);
  const providers=list(q.providers).slice(0,20).map(value=>{
    const p=object(value), unavailable=typeof p.error==='string' && !!p.error;
    return {provider:text(p.provider,'unknown'),name:text(p.displayName,text(p.provider,'AI provider')),plan:typeof p.plan==='string'?p.plan.slice(0,120):null,unavailable,
      windows:unavailable?[]:list(p.windows).slice(0,20).map(value=>{const w=object(value),used=number(w.usedPercent);return {label:text(w.label,'Allowance'),usedPercent:used===null?null:Math.min(100,used),resetAt:number(w.resetAt)};}),
      credits:unavailable?null:number(list(p.billing).map(object).find(b=>b.type==='balance'&&b.unit==='credits')?.amount)};
  });
  const daily=list(a.daily).slice(-7).map(object).filter(d=>typeof d.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)).map(d=>({date:d.date as string,tokens:number(d.totalTokens)}));
  return {checkedAt:now,reportedAt:number(q.updatedAt),state:q.refreshing===true?'refreshing':Array.isArray(q.providers)?'ready':'unavailable',providers,
    activity:!('totals' in a)?emptyActivity():{tokens:number(totals.totalTokens),input:number(totals.input),output:number(totals.output),cacheRead:number(totals.cacheRead),daily,status:cache.status && cache.status!=='fresh'?'partial':'ready'}};
}

/** Coalesced, read-only provider status using Nova's existing host connection. */
export class AssistantUsage {
  private cache?: {generation:string|undefined; expires:number; value:UsageState};
  private pending?: {generation:string|undefined; promise:Promise<UsageState>};
  constructor(private gateway:AssistantTransport,private now=Date.now){}
  async read():Promise<UsageState>{
    const state=this.gateway.status(),generation=state.generation;
    if(state.state!=='ready'){this.cache=undefined;return projectUsage(undefined,undefined,this.now());}
    if(this.pending && this.pending.generation===generation)return this.pending.promise;
    if(this.cache && this.cache.generation===generation&&this.cache.expires>this.now())return this.cache.value;
    const reading=(async()=>{
      const [q,a]=await Promise.allSettled([
        state.methods.includes('usage.status')?this.gateway.request('usage.status',{}):Promise.reject(),
        state.methods.includes('usage.cost')?this.gateway.request('usage.cost',{days:7,agentScope:'all'}):Promise.reject(),
      ]);
      const current=this.gateway.status();
      if(current.state!=='ready'||current.generation!==generation)return projectUsage(undefined,undefined,this.now());
      const value=projectUsage(q.status==='fulfilled'?q.value:undefined,a.status==='fulfilled'?a.value:undefined,this.now());
      this.cache={generation,expires:this.now()+30000,value};return value;
    })();
    this.pending={generation,promise:reading};try{return await reading;}finally{if(this.pending?.promise===reading)this.pending=undefined;}
  }
}
