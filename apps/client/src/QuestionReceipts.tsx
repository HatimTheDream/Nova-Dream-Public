import type { AssistantQuestion } from '../../../packages/domain/questions';
import { QuestionReceipt } from './QuestionReceipt';

export function QuestionReceipts({ items }: { items?: AssistantQuestion[] }) {
  if (!items?.length) return null;
  return <div className="question-receipts">
    {items.map(item => <QuestionReceipt key={item.id} item={item}/>)}
  </div>;
}
