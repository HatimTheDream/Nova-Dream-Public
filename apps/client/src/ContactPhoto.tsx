import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { Contact, RecordValue } from '../../../packages/domain/workspace-records';
import { contactInitials } from '../../../packages/domain/contacts';
import { useAttachments } from './useAttachments';
import { retainedWindowId } from './useWorkspace';
import { Image, X } from './icons';

export function ContactAvatar({ value, large = false }: { value: Contact; large?: boolean }) {
  const [failed, setFailed] = useState<string>();
  const photo = value.photo;
  return <span className={`contact-avatar${large ? ' large' : ''}`} aria-hidden="true">{photo && failed !== photo.id ? <img src={`/api/attachments/${encodeURIComponent(photo.id)}?preview=1`} alt="" onError={() => setFailed(photo.id)}/> : contactInitials(value.name)}</span>;
}

export function ContactPhoto({ id, value, snapshot, change, pendingChanged }: { id: string; value: Contact; snapshot: Snapshot; change(update: (value: RecordValue) => RecordValue): boolean; pendingChanged(value: boolean): void }) {
  const input = useRef<HTMLInputElement>(null);
  const uploads = useAttachments(snapshot, { attachments: value.photo ? [value.photo] : [] }, update => change(previous => ({ ...previous, photo: update({ attachments: (previous as Contact).photo ? [(previous as Contact).photo!] : [] }).attachments[0] ?? null })), `contact-photo:${id}:${retainedWindowId}`, 'contact photo', { endpoint: 'contacts/photo', single: true });
  const pending = uploads.staging || uploads.pending.length > 0;
  useEffect(() => { pendingChanged(pending); }, [pending, pendingChanged]);
  return <section className="contact-photo-editor" aria-label="Profile photo"><div className="button-row"><ContactAvatar value={value} large/><button type="button" disabled={pending} onClick={() => input.current?.click()}><Image size={17}/>{value.photo ? 'Change photo' : 'Add photo'}</button>{value.photo && <button type="button" className="icon-button" aria-label="Remove photo" title="Remove photo" disabled={pending} onClick={() => change(previous => ({ ...previous, photo: null }))}><X size={17}/></button>}</div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Choose profile photo" onChange={event => { void uploads.add(event.target.files); event.target.value = ''; }}/>
    {uploads.pending.map(file => <div className="upload" key={file.id}><span>{uploads.errors[file.id] || 'Preparing photo…'}</span>{uploads.errors[file.id] && <button type="button" onClick={() => void uploads.retry(file)}>Retry</button>}<button type="button" aria-label="Remove pending photo" onClick={() => void uploads.remove(file.id)}><X size={17}/></button></div>)}
    {uploads.notice && <p role="status" className="field-error">{uploads.notice}</p>}
  </section>;
}
