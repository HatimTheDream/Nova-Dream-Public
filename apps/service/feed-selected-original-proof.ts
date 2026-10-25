// Guarded access only. Proof issuance and first-reader binding are private to
// the maintained actual owner, which constructs every projected source itself.
export {assertSelectedOriginalState,readSelectedOriginal,isSelectedOriginalReader,type SelectedOriginalProof} from './feed-history-completion-reader.js';
