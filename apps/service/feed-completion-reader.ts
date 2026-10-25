import type {HistoryObjectKind,HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import type {CompletionAmount,CompletionRowFact,CompletionObjectFact,CompletionReceiptFact} from './feed-completion-contract.js';
import type {MutationPlanBudget} from './feed-history-projected-inventory.js';
import type {SelectedOriginalFact} from '../../packages/domain/news-feed-selected-originals.js';

export type CompletionRowDescriptor=Extract<HistoryStoredObject,{kind:'row'}>;

/** Internal synchronous data port, never a public proof or permission.
 * Its owner has verified the complete actual/projected inventory in the same
 * lexical snapshot. Every method and cursor is bounded by the one supplied N1
 * budget and expires with that owner. Keys are complete and UTF8 BINARY sorted.
 * Facts join exact actual ciphertext or exact prepared successor bytes; a length
 * supplied by a caller is never sufficient. Actual fact methods accept only the
 * unchanged frozen values returned by that actual reader. Projected methods
 * must separately bind their prepared values and preserve actual references.
 * Archived rows use an unchanged authenticated descriptor and segment, not a
 * caller-provided wire or an invented standalone active ciphertext length. */
export type CompletionReader=Readonly<{
 schema:61|62;
 originalToken:string;
 guard:()=>void;
 assertBudget:(budget:MutationPlanBudget)=>void;
 current:()=>CompletionAmount;
 rowKeys:()=>IterableIterator<string>;
 objectKeys:(kind:HistoryObjectKind)=>IterableIterator<string>;
 object:(kind:HistoryObjectKind,id:string)=>HistoryStoredObject|undefined;
 activeRow:(id:string)=>SemanticRow|undefined;
 receipt:(id:string)=>SemanticReceipt|undefined;
 rowFact:(row:SemanticRow)=>CompletionRowFact;
 objectFact:(object:HistoryStoredObject)=>CompletionObjectFact;
 receiptFact:(receipt:SemanticReceipt)=>CompletionReceiptFact;
 archivedRow:(descriptor:CompletionRowDescriptor)=>SemanticRow;
 /** Available only on the maintained complete selected-proof route. Copied
  * custody states cannot be used as its private proof owner. */
 selectedState?:(state:object|undefined)=>void;
 selectedOriginal?:(state:object|undefined,slot:0|1)=>SelectedOriginalFact|undefined;
}>;
