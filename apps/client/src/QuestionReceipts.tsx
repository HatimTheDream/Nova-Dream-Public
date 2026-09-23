import type { AssistantQuestion } from '../../../packages/domain/questions';
import { QuestionReceipt } from './QuestionReceipt';
import { CircleHelp } from './icons';

export function QuestionReceipts({ items }: { items?: AssistantQuestion[] }) {
  if (!items?.length) return null;
  const count = items.reduce((total, item) => total + item.snapshot.questions.length, 0);
  // Codex keeps a completed question series behind its quiet activity line;
  // a single answer can remain an ordinary compact reply in the conversation.
  if (count === 1) return <div className="question-receipts"><QuestionReceipt item={items[0]}/></div>;
  return <details className="question-receipts">
    <summary className="question-receipts-summary"><CircleHelp size={16}/><span>Asked {count} questions</span></summary>
    {items.map(item => <QuestionReceipt key={item.id} item={item}/>)}
  </details>;
}
