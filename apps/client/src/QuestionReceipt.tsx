import type { AssistantQuestion } from '../../../packages/domain/questions';
import './question-receipt.css';

export function QuestionReceipt({ item, compact = false }: { item: AssistantQuestion; compact?: boolean }) {
  const { snapshot } = item;
  // Uncertain decisions stay with the actionable question until the native receipt confirms them.
  if (item.action && item.action.state !== 'confirmed') return null;
  if (snapshot.status === 'cancelled' || snapshot.status === 'expired') {
    return <p className="question-receipt-status">Question {snapshot.status}</p>;
  }
  if (snapshot.status !== 'answered') return null;

  return <article className={`chat-message message-user message-text question-receipt${compact ? ' question-receipt-compact' : ''}`} aria-label="Your answers">
    {snapshot.questions.map(question => {
      const secret = question.isSecret || !!question.secretStore;
      const answers = snapshot.answers?.answers[question.questionId];
      return <div className="question-receipt-item" key={question.questionId}>
        <details className="question-receipt-question">
          <summary>
            <span className="question-receipt-label">{question.question}</span>
          </summary>
        </details>
        <div className="question-receipt-answers">
          {secret ? <p className="question-receipt-answer">Secret stored. Its value is hidden.</p>
            : answers?.length ? answers.map((answer, index) => <p className="question-receipt-answer" key={index}>{answer}</p>)
              : <p className="question-receipt-unavailable">Answer unavailable</p>}
        </div>
      </div>;
    })}
  </article>;
}
