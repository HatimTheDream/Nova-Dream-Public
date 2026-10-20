import type { Draft, Entity } from '../../../packages/domain/contracts';
import { File } from './icons';

/** A saved original is readable without creating a draft owner or running a command. */
export function SavedDraftArticle({ draft, append, back, backLabel = 'Back to my draft' }: {
  draft: Entity<Draft>; append?: (value: Draft) => void; back?: () => void; backLabel?: string;
}) {
  return <article className="draft-preview">
    <span className="eyebrow">Saved draft · read only</span><h2>{draft.value.title}</h2>
    <p className="metadata">Saved revision {draft.revision}</p>
    <p className="preserve-lines">{draft.value.text || 'This draft contains attachments.'}</p>
    {draft.value.attachments.map(file => <a className="source-link" key={file.id} href={`/api/attachments/${encodeURIComponent(file.id)}`}><File size={16}/>{file.name}</a>)}
    {append && <button onClick={() => append(draft.value)}>Append to my draft</button>}
    {back && <button className="quiet" onClick={back}>{backLabel}</button>}
  </article>;
}
