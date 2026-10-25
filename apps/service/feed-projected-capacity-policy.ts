import {z} from 'zod';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import type {CompletionAmount,CompletionResult} from './feed-completion-contract.js';
import type {ProducerFacts} from './feed-automatic-producer-store.js';

/** The producer and semantic transitions have separate Store transactions.
 * Growth adds; their single-transition temporary overlap is componentwise max. */
export function combineProducerCompletion(result:CompletionResult,producer:ProducerFacts,budget:MutationPlanBudget):CompletionResult{
 if(result.kind!=='sized')return result;
 for(let i=0;i<3;i++)budget.entry();budget.reserveBytes(384);
 return Object.freeze({...result,remainingGrowth:Object.freeze({entries:capacitySum(result.remainingGrowth.entries,producer.remainingGrowth.entries),
  ciphertextBytes:capacitySum(result.remainingGrowth.ciphertextBytes,producer.remainingGrowth.ciphertextBytes)}),
  maximumSingleTransitionOverlap:Object.freeze({entries:Math.max(result.maximumSingleTransitionOverlap.entries,producer.maximumSingleTransitionOverlap.entries),
   ciphertextBytes:Math.max(result.maximumSingleTransitionOverlap.ciphertextBytes,producer.maximumSingleTransitionOverlap.ciphertextBytes)})});
}

const natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount=z.object({entries:natural,ciphertextBytes:natural}).strict();
export const projectedCapacityPolicySchema=z.object({qualification:z.literal('unqualified'),durable:amount,
 transientCiphertextBytes:natural}).strict();
export type ProjectedCapacityPolicy=z.infer<typeof projectedCapacityPolicySchema>;
export type ProjectedCapacityFootprint=Readonly<{current:CompletionAmount;projected:CompletionAmount;newEntries:number;outgoingCiphertextBytes:number}>;
const footprintSchema=z.object({current:amount,projected:amount,newEntries:natural,outgoingCiphertextBytes:natural}).strict();
export function capacitySum(...values:number[]):number{
 let result=0;for(const value of values){if(!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(result+value))throw Error('Capacity arithmetic overflow');result+=value;}return result;
}
export function capacityReplace(current:number,previous:number,next:number):number{
 if(!Number.isSafeInteger(current)||!Number.isSafeInteger(previous)||!Number.isSafeInteger(next)||previous<0||next<0||current<previous)throw Error('Capacity predecessor arithmetic');
 return capacitySum(current-previous,next);
}
/** Logical payload admission only. Rows count durable entries; replacements
 * remain bounded by the sequence's separate copy allowance. No disk/WAL claim. */
export function assertProjectedCapacity(policy:ProjectedCapacityPolicy,raw:ProjectedCapacityFootprint,result:CompletionResult,budget:MutationPlanBudget){
 return budget.checked(()=>{
  // Fixed-size metadata is reserved before Zod creates its parsed wrappers.
  for(let i=0;i<16;i++)budget.entry();budget.bytes(policy);budget.bytes(raw);budget.reserveBytes(2048);
  const p=projectedCapacityPolicySchema.parse(policy),f=footprintSchema.parse(raw);
  if(result.kind!=='sized'||result.qualification!=='unqualified')throw Error('Completion debt is unsupported');
  const g=amount.parse(result.remainingGrowth),m=amount.parse(result.maximumSingleTransitionOverlap);
  const durableBytes=capacitySum(f.projected.ciphertextBytes,g.ciphertextBytes);
  const futureOverlapBytes=capacitySum(durableBytes,m.ciphertextBytes);
  const batchOverlapBytes=capacitySum(f.current.ciphertextBytes,f.outgoingCiphertextBytes,g.ciphertextBytes);
  const durableEntries=capacitySum(f.current.entries,f.newEntries,g.entries);
  if(durableBytes>p.durable.ciphertextBytes||durableEntries>p.durable.entries)throw Error('Projected durable completion capacity');
  if(futureOverlapBytes>p.transientCiphertextBytes||batchOverlapBytes>p.transientCiphertextBytes)throw Error('Projected transient completion capacity');
  return Object.freeze({durableBytes,futureOverlapBytes,batchOverlapBytes,durableEntries,qualification:'unqualified' as const});
 });
}
