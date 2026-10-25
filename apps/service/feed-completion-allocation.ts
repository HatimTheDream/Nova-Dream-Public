import {MutationPlanBudget,mutationNeed as need} from './feed-history-projected-inventory.js';

/** Logical child-work allowances, never heap/RSS or filesystem estimates.
 * Description/Close producers duplicate bounded original fields and at most17
 * request/receipt descriptors (8 edges). Eight input representations plus64KiB
 * cover that metadata. Codec candidate construction uses selected projection,
 * manifest/row JSON, escaped exact payload, both identity/compressed envelopes,
 * canonical/hash copies and up to8 size-fixpoint passes per envelope. We reserve
 * 256 input-byte equivalents plus1MiB metadata and32 input-container equivalents
 * plus2048 wrappers BEFORE invocation. This deliberately overcounts small input;
 * a large valid child can refuse under the unchanged test allowance. Existing
 * codec row/request/depth/decoded/stored bounds independently remain in force.
 * These are cumulative allowances, with no refund/reset or automatic increase. */
const policies=Object.freeze({
 descriptor:Object.freeze({byteCopies:8,extraBytes:65536,containerCopies:8,extraContainers:256}),
 close:Object.freeze({byteCopies:8,extraBytes:65536,containerCopies:8,extraContainers:256}),
 codec:Object.freeze({byteCopies:256,extraBytes:1048576,containerCopies:32,extraContainers:2048}),
});
export function completionChild<T>(budget:MutationPlanBudget,kind:keyof typeof policies,input:unknown,produce:()=>T):T{
 return budget.checked(()=>{
  const policy=policies[kind];need(policy,'Unknown completion allocation child');
  const bytes=budget.bytes(input);budget.entry();const pending:unknown[]=[input];let containers=0;
  while(pending.length){const value=pending.pop();if(value!==null&&typeof value==='object'){
   containers++;need(Number.isSafeInteger(containers),'Completion child container overflow');
   for(const key in value)if(Object.hasOwn(value,key)){const child=(value as Record<string,unknown>)[key];if(child!==null&&typeof child==='object'){budget.entry();pending.push(child);}}
  }}
  const reservedBytes=bytes*policy.byteCopies+policy.extraBytes,reservedContainers=containers*policy.containerCopies+policy.extraContainers;
  need(Number.isSafeInteger(reservedBytes)&&Number.isSafeInteger(reservedContainers),'Completion child allowance overflow');
  budget.reserveBytes(reservedBytes);for(let n=0;n<reservedContainers;n++)budget.entry();
  const result=produce();budget.bytes(result);return result;
 });
}
