import { useState } from 'react';
import { useStore } from 'zustand';
import { ChevronDown } from './components/icons';
import { useInboxHost } from './inbox-host';

const titles = {
  preparing: 'Preparing your message', prepared: 'Review your message', running: 'Waiting for the provider',
  saved: 'Draft saved', accepted: 'Message accepted for sending', uncertain: 'Mail result needs checking',
  interrupted: 'Draft needs attention', failed: 'Mail action stopped', cancelled: 'Review cancelled',
};
/** Disclosure within the original composer, without replacing its writing UI. */
export function InboxDeliveryCard({ source }: { source: string }) {
  const { delivery } = useInboxHost();
  const record = useStore(delivery.store, state => state.records[source]);
  const busy = useStore(delivery.store, state => !!state.busy[source]);
  const [error, setError] = useState('');
  if (!record) return null;
  const review = record.review;
  const act = async (run: () => unknown | Promise<unknown>) => { setError(''); try { await run(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Mail status is unavailable. Your writing is kept.'); } };
  const expected = review?.digest ? { id: review.id, revision: review.revision, digest: review.digest } : undefined;
  const confirmable = expected && !record.pending && !review?.superseded && (review?.state === 'prepared' || review?.state === 'interrupted');
  return <section className="dc-mail-delivery" aria-label="Saved mail operation" aria-busy={busy}>
    <strong role="status">{busy&&record.pending==='confirm' ? 'Waiting for the provider' : record.pending==='open' ? 'Opening provider draft' : review?.superseded ? 'Draft opened elsewhere' : record.editing ? 'Editing saved draft' : review ? titles[review.state] : 'Mail review pending'}</strong>
    <p hidden={!!record.editing || !!review?.superseded}>{record.editing ? 'Your changes stay here until you review and save or send this draft.' : busy&&record.pending ? 'Checking the original request. Your message stays here while the provider responds.' : review?.detail || (record.pending ? 'The last request has not been confirmed. Your message and original request are kept.' : 'Check the account, recipients and complete message before continuing.')}</p>
    {(error || record.error) && !review?.superseded && <p role="alert">{error || record.error}</p>}
    {review?.superseded && <p role="status">Another message has opened this provider draft. Your writing stays here; return to that message or reopen Drafts to continue.</p>}
    {review?.draft?.changed && review.state === 'prepared' && !record.editing && <details className="dc-mail-draft-conflict" open>
      <summary>Saved draft changed <ChevronDown size={14} aria-hidden="true"/></summary>
      <p>The provider draft has changed since the last saved version. Compare it with your proposed message below before replacing or sending it.</p>
      <dl><dt>From</dt><dd>{review.draft.from}</dd><dt>To</dt><dd>{review.draft.to.join(', ') || 'None'}</dd>
        {!!review.draft.cc.length && <><dt>Cc</dt><dd>{review.draft.cc.join(', ')}</dd></>}
        {!!review.draft.bcc.length && <><dt>Bcc</dt><dd>{review.draft.bcc.join(', ')}</dd></>}
        <dt>Subject</dt><dd>{review.draft.subject}</dd>
      </dl>
      <pre tabIndex={0} aria-label="Current provider draft text">{review.draft.bodyText}</pre>
      <p>{review.draft.attachments.length ? `Current files: ${review.draft.attachments.map(file=>file.name).join(', ')}` : 'No files in the current provider draft.'}</p>
    </details>}
    {review && <details open={review.state === 'prepared'}>
      <summary>Message details <ChevronDown size={14} aria-hidden="true"/></summary>
      <dl><dt>From</dt><dd>{review.message.from}</dd><dt>To</dt><dd>{review.message.to.join(', ') || 'None'}</dd>
        {!!review.message.cc.length && <><dt>Cc</dt><dd>{review.message.cc.join(', ')}</dd></>}
        {!!review.message.bcc.length && <><dt>Bcc</dt><dd>{review.message.bcc.join(', ')}</dd></>}
        <dt>Subject</dt><dd>{review.message.subject || 'No subject'}</dd>
        {review.source && <><dt>Reply to</dt><dd>{review.source.from} · {review.source.subject}</dd></>}
      </dl>
      <pre tabIndex={0} aria-label="Complete message text">{review.message.bodyText}</pre>
      {!review.message.attachments.length && <p>No files attached.</p>}
      {review.draft&&<p>Previously saved files: {review.draft.attachments.map(file=>file.name).join(', ')||'None'}</p>}
      {!!review.message.attachments.length && <ul>{review.message.attachments.map((file, index) => <li key={`${file.sha256}:${index}`}>{file.name} · {file.bytes.toLocaleString()} bytes</li>)}</ul>}
    </details>}
    <div className="dc-mail-delivery-actions">
      {confirmable && <>
        <button type="button" disabled={busy} className="dc-mail-delivery-confirm" onClick={() => void act(() => delivery.confirm(source, expected, 'confirm'))}>{review?.mode === 'send' ? review.previousOperationId ? 'Send this draft' : 'Send this message' : review?.state === 'interrupted' ? 'Continue saving draft' : review?.previousOperationId ? review.draft?.changed ? 'Replace saved draft' : 'Update this draft' : 'Save this draft'}</button>
        <button type="button" disabled={busy} onClick={() => void act(async () => { const result = await delivery.confirm(source, expected, 'cancel'); if (result.review?.state === 'cancelled') delivery.release(source, result.review.id); })}>Keep editing</button>
      </>}
      {record.pending && !busy && <button type="button" disabled={busy} onClick={() => void act(() => delivery.retry(source))}>Retry original request</button>}
      {review && (review.superseded || record.pending || ['uncertain', 'interrupted', 'running', 'preparing'].includes(review.state)) && <button type="button" disabled={busy} onClick={() => void act(() => delivery.check(source))}>Check status</button>}
      {!review && !record.opening && <button type="button" disabled={busy} onClick={() => void act(() => delivery.discardPreparation(source))}>Keep editing</button>}
      {review && !review.superseded && !record.pending && !record.editing && (review.state==='saved'||review.canEditDraft) && <button type="button" disabled={busy} onClick={() => void act(() => delivery.editSaved(source))}>Edit saved draft</button>}
      {review && ['accepted', 'failed', 'cancelled'].includes(review.state) && !record.pending && <button type="button" disabled={busy} onClick={() => void act(() => delivery.release(source, review.id))}>{review.state === 'accepted' ? 'Use this writing for another message' : 'Keep editing'}</button>}
    </div>
    {review?.state === 'saved' && !record.editing && !review.superseded && <p>Your draft is saved in {review.provider === 'google' ? 'Gmail' : 'Outlook'}. Your writing is also kept here.</p>}
  </section>;
}
