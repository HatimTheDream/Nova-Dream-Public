import type {SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import type {HistoryObjectKind} from '../../packages/domain/news-feed-history-storage.js';
import {feedWorkerPrefix as legacyPrefix,type FeedWorkerSaved as LegacyWorker,terminal as legacyTerminal} from '../../packages/domain/news-feed-worker.js';
import {feedWorkerPrefix as adaptivePrefix,type FeedWorkerSaved as AdaptiveWorker,terminal as adaptiveTerminal} from '../../packages/domain/news-feed-adaptive-worker.js';
import {feedLocalPrefix,type FeedLocalRecord} from '../../packages/domain/news-feed-successor-journal.js';
import type {MutationPlanBudget} from './feed-history-projected-inventory.js';
import type {CompletionReader} from './feed-completion-reader.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {deriveFeedCompletionEnvelope} from './feed-completion-envelope.js';
import type {CompletionFacts,CompletionResult,CompletionWorkerFact,CompletionCloseFact,CompletionSealFact,CompletionObjectFact,CompletionReceiptFact} from './feed-completion-contract.js';
function need(condition:unknown,message:string):asserts condition{if(!condition)throw Error(message);}

/** One domain fact selection/join path for completely verified actual or final
 * projected data. The reader owns ciphertext and lifetime, never this helper.
 * All assembler/pure/publication work uses that same supplied N1 budget. */
export function assembleCompletionEnvelope(reader:CompletionReader,budget:MutationPlanBudget):CompletionResult{
 return budget.checked(()=>{
  reader.assertBudget(budget);reader.guard();
  const {schema,originalToken,guard,object,activeRow,receipt,rowFact,objectFact,receiptFact,archivedRow,rowKeys,objectKeys}=reader;
  const current=reader.current();
  const slots=(count=1,bytes=0)=>{for(let i=0;i<count;i++)budget.entry();budget.reserveBytes(bytes);};
 // Valid UTF8 byte order equals Unicode scalar order. Avoid allocating two
 // Buffer/text roundtrips for every comparison during a copied key sort.
 const compareKeys=(a:string,b:string)=>{let i=0,j=0;while(i<a.length&&j<b.length){const x=a.codePointAt(i)!,y=b.codePointAt(j)!;if(x!==y)return x-y;i+=x>0xffff?2:1;j+=y>0xffff?2:1;}return a.length-i-(b.length-j);};
   const requiredObject=(kind:HistoryObjectKind,id:string)=>{const value=object(kind,id);need(value&&value.kind===kind&&value.key===id,'Completion required catalogue predecessor missing');return objectFact(value);};
   const requiredReceipt=(id:string)=>{const value=receipt(id);need(value&&value.requestId===id,'Completion required receipt missing');return receiptFact(value);};
   const requiredRow=(id:string)=>{const value=activeRow(id);need(value&&value.id===id,'Completion required active predecessor missing');return rowFact(value);};
   slots(9,128);const workers:CompletionWorkerFact[]=[],pendingCloses:CompletionCloseFact[]=[],pendingSeals:CompletionSealFact[]=[];
   for(const id of rowKeys()){const row=activeRow(id);need(row,'Completion enumerated row missing');
    if(row.id.startsWith(legacyPrefix)||row.id.startsWith(adaptivePrefix)){
     // The complete maintained verifier above established the exact domain type.
     const value=row.value as LegacyWorker|AdaptiveWorker;
     if(value.format===3?adaptiveTerminal(value):legacyTerminal(value))continue;
     const actual=rowFact(row),descriptor=requiredObject('row',row.id),originalReceipt=requiredReceipt(value.command.requestId);
     slots(4,64);workers.push({kind:'worker',row:actual,descriptor,originalReceipt});
    }else if(row.id.startsWith(feedLocalPrefix)){
     const value=row.value as FeedLocalRecord;if(value.kind!=='closed-before-admission')continue;
     const pending=object('request',value.close.requestId);need(pending?.kind==='request','Completion Close descriptor missing');
     if(pending.value.status!=='pending-close')continue;
     slots(5,96);pendingCloses.push({kind:'pending-close',fence:rowFact(row),descriptor:requiredObject('row',row.id),originalReceipt:requiredReceipt(value.id),pendingRequest:objectFact(pending)});
    }
   }
   // A prior Close ACK can be archived. Resolve only exact matching descriptors;
   // complete catalogue traversal establishes absence without copying a graph.
   if(workers.length)for(const id of objectKeys('row')){const descriptor=object('row',id);need(descriptor,'Completion enumerated row descriptor missing');
    need(descriptor.kind==='row','Completion row inventory changed');if(descriptor.value.kind!=='local')continue;
    for(const worker of workers){const value=worker.row.row.value as LegacyWorker|AdaptiveWorker;
     if(worker.closeAcknowledgement||!descriptor.value.edges.some(edge=>edge.kind==='original'&&edge.role==='close-original'&&edge.requestId===value.command.requestId))continue;
     let ack:SemanticRow|undefined;
     if(descriptor.value.custody.kind==='active')ack=activeRow(descriptor.key);
     else{
      ack=archivedRow(descriptor);
     }
     need(ack&&ack.id===descriptor.key&&ack.revision===descriptor.value.revision,'Completion ACK custody changed');
     const local=ack.value as FeedLocalRecord;need(local.kind==='close-ack','Completion ACK edge changed');
     slots(3,64);worker.closeAcknowledgement={row:budget.copy(ack),descriptor:objectFact(descriptor),receipt:requiredReceipt(local.id)};
    }
   }
   if(schema===62)for(const id of objectKeys('intent')){const intent=object('intent',id);need(intent,'Completion enumerated intent missing');
    need(intent.kind==='intent','Completion intent inventory changed');if(object('outcome',intent.key))continue;
    slots(10,160);const selected:CompletionSealFact['selected']=[],dependencies:SemanticRow[]=[],requests:CompletionObjectFact[]=[],receipts:CompletionReceiptFact[]=[],requestKeys=new Set<string>(),receiptKeys=new Set<string>(),selectedKeys=new Set<string>();
    const add=(set:Set<string>,id:string)=>{if(set.has(id))return;slots();budget.bytes(id);set.add(id);};
    for(const original of intent.value.rows){const row=requiredRow(original.id),descriptor=requiredObject('row',original.id);need(descriptor.object.kind==='row','Completion seal row catalogue changed');
     slots(3,48);selected.push({row,descriptor});
     add(selectedKeys,original.id);
     for(const id of descriptor.object.value.requests)add(requestKeys,id);
     for(const edge of descriptor.object.value.edges)if(edge.kind==='receipt')add(receiptKeys,edge.requestId);
    }
    for(const protectedRow of intent.value.protection.rows){if(selectedKeys.has(protectedRow.id))continue;
     const d=requiredObject('row',protectedRow.id);need(d.object.kind==='row','Completion protected row descriptor changed');
     let row:SemanticRow|undefined;
     if(d.object.value.custody.kind==='active')row=activeRow(protectedRow.id);
     else row=archivedRow(d.object);
     need(row&&row.id===protectedRow.id&&row.revision===d.object.value.revision,'Completion protected row custody changed');slots();dependencies.push(row);
    }
    slots(requestKeys.size+receiptKeys.size+2,4);const ordered=[...requestKeys].sort(compareKeys);
    for(const id of ordered){const value=requiredObject('request',id);need(value.object.kind==='request','Completion seal request changed');slots();requests.push(value);if(value.object.value.status==='admitted')add(receiptKeys,id);}
    slots(receiptKeys.size+1,2);for(const id of [...receiptKeys].sort(compareKeys)){slots();receipts.push(requiredReceipt(id));}
    slots(6,112);pendingSeals.push({kind:'pending-seal',intent:objectFact(intent),selected,dependencies,requests,receipts});
   }
   guard();slots(7,128);const facts:CompletionFacts={format:1,schema,originalToken,current,workers,pendingCloses,pendingSeals};
   const result=deriveFeedCompletionEnvelope(facts,budget);guard();historyJsonBytes(result,budget.limits.bytes);
   const immutable=budget.copy(result);guard();return immutable;
 });
}
