import type { AssistantOperation, Conversation } from '../../../packages/domain/assistant';
import type { AssistantController } from './useAssistant';
import { QuestionCard } from './QuestionCard';
import { confirmedQuestion } from './question-transcript';
import type { AssistantQuestion } from '../../../packages/domain/questions';
import { ApprovalCard } from './ApprovalTray';
import { formatSaved } from './ui';

export function AssistantRunHistory({ operations, controller, conversation, epoch, openSources, returnToQuestion }: { operations: AssistantOperation[]; controller: AssistantController; conversation?: Conversation; epoch: string; openSources: (operationId: string) => void; returnToQuestion: (id: string) => void }) {
  return <>{operations.map(op => <details key={op.id}><summary>{op.steerTarget ? 'Direction' : 'Reply'} · {op.state} · {formatSaved(op.createdAt)}</summary><p className="preserve-lines">{op.input}</p>{op.error && <p className="field-error">{op.error}</p>}<button onClick={() => openSources(op.id)}>View captured sources</button>{!['completed', 'failed', 'cancelled'].includes(op.state) && <button onClick={() => void controller.checkStatus(op.conversationId)}>Check status</button>}</details>)}{controller.questions?.items.filter(item => item.conversationId === conversation?.id).map(item => <details key={item.id}><summary>Question · {item.snapshot.status}</summary>{questionOwnedByConversation(item, conversation) ? <div className="history-question-summary">{item.snapshot.questions.map(question => <p className="preserve-lines" key={question.questionId}>{question.question}</p>)}<p className="metadata">{item.action?.message ?? (item.availability === 'missing' ? 'This question needs a status check.' : 'Answer and review this request in the conversation.')}</p><button onClick={() => returnToQuestion(item.id)}>Return To Question</button></div> : <QuestionCard item={item} epoch={epoch} ready={controller.questions?.state === 'ready'} refresh={controller.refresh} readOnly={!!conversation?.archived}/>}</details>)}{controller.approvals?.items.filter(item => item.conversationId === conversation?.id).map(item => <details key={item.id}><summary>Approval · {item.snapshot.status}</summary><ApprovalCard item={item} epoch={epoch} ready={controller.approvals?.state === 'ready'} refresh={controller.refresh} readOnly={!!conversation?.archived}/></details>)}</>;
}

// A retained History tab must not mount another writer for the tray's journal.
// Historical requests absent from that tray keep their original recovery UI.
export const questionOwnedByConversation = (item: AssistantQuestion, conversation?: Conversation) => !!conversation && !conversation.archived && item.conversationId === conversation.id && !item.dismissed && !confirmedQuestion(item);

export function focusConversationQuestion(id: string, root: Pick<Document, 'querySelectorAll'> = document) {
  const card = Array.from(root.querySelectorAll<HTMLElement>('.approval-tray [data-question-id]')).find(node => node.dataset.questionId === id);
  if (!card) return false;
  for (let ancestor = card.parentElement; ancestor && !ancestor.classList.contains('composer-region'); ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
  }
  const control = card.querySelector<HTMLElement>('textarea:not(:disabled),input:not(:disabled),button:not(:disabled),[tabindex="0"]');
  if (control) control.focus();
  else { card.tabIndex = -1; card.focus(); }
  card.scrollIntoView({ block: 'nearest' });
  return true;
}
