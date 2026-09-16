import { useEffect, useRef, useState } from 'react';
import type { Attachment, Snapshot } from '../../../packages/domain/contracts';
import { request, stagedFile, type PendingFile } from './api';

export function useAttachments<T extends { attachments: Attachment[] }>(snapshot: Snapshot, draft: T, change: (updater: (value: T) => T) => boolean, draftId = `draft:${snapshot.deviceId}`, label = 'draft', options: { endpoint?: string; single?: boolean } = {}) {
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [staging, setStaging] = useState(false), reading = useRef(false);
  const [recovering, setRecovering] = useState(true);
  const uploading = useRef(new Set<string>()), mounted = useRef(true);
  const removalRevision = label === 'draft' ? snapshot.draftRemovals?.find(item => item.draftId === draftId)?.revision ?? 0 : 0;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latest = useRef({ snapshot, draft, change, draftId, removalRevision }); latest.current = { snapshot, draft, change, draftId, removalRevision };
  const checkRemoval = (file: PendingFile) => { if ((file.draftRemovalRevision ?? 0) < latest.current.removalRevision) throw new Error('This file belonged to a removed draft. Remove the staged copy and choose the file again to use it in new writing.'); };
  const upload = async (file: PendingFile) => {
    if (uploading.current.has(file.id)) return;
    uploading.current.add(file.id); setErrors(errors => ({ ...errors, [file.id]: '' }));
    try {
      if ((file.draftId ?? `draft:${file.deviceId}`) !== latest.current.draftId) throw new Error(`This staged attachment belongs to another ${label}. Return there to finish uploading.`);
      if (file.epoch !== latest.current.snapshot.epoch) throw new Error('The host changed. Remove and choose this file again after reviewing the recovered workspace.');
      checkRemoval(file);
      const metadata = await request<Attachment>(options.endpoint ?? 'attachments', { requestId: file.id, epoch: file.epoch, name: file.name, base64: file.base64 });
      if (!mounted.current || (file.draftId ?? `draft:${file.deviceId}`) !== latest.current.draftId || file.deviceId !== latest.current.snapshot.deviceId || file.epoch !== latest.current.snapshot.epoch) throw new Error(`The upload is kept. Reopen this ${label} to finish linking it.`);
      checkRemoval(file);
      if (!latest.current.change(value => ({ ...value, attachments: options.single ? [metadata] : value.attachments.some(a => a.id === metadata.id) ? value.attachments : [...value.attachments, metadata] }))) throw new Error(`Uploaded bytes are safe on the host, but this browser cannot save the ${label} link. Free browser storage, then retry.`);
      await stagedFile('delete', file.id); setPending(files => files.filter(f => f.id !== file.id));
    } catch (error) { setErrors(errors => ({ ...errors, [file.id]: error instanceof Error && error.message ? error.message : 'Upload paused. Your file is kept on this device.' })); }
    finally { uploading.current.delete(file.id); }
  };
  useEffect(() => { let alive = true; setRecovering(true); void stagedFile('list').then(files => { if (!alive) return; const own = files.filter(file => file.deviceId === snapshot.deviceId && (file.draftId ?? `draft:${file.deviceId}`) === draftId); setPending(own); for (const file of own) void upload(file); }).catch(() => setNotice('Attachment recovery storage is unavailable in this browser.')).finally(() => { if (alive) setRecovering(false); }); return () => { alive = false; }; }, [snapshot.deviceId, draftId, removalRevision]);
  const add = async (files: FileList | null) => {
    if (!files || reading.current) return;
    setNotice('');
    if ((options.single ? 0 : draft.attachments.length) + pending.length + files.length > (options.single ? 1 : 10)) { setNotice(options.single ? 'Finish or remove the pending photo first.' : `This ${label} can keep up to 10 attachments.`); return; }
    const draftRemovalRevision = removalRevision;
    reading.current = true; setStaging(true);
    try {
    for (const file of Array.from(files)) {
      if (file.size > 8 * 1024 * 1024) { setNotice(`${file.name} exceeds the 8 MB limit.`); continue; }
      const base64 = await new Promise<string>((accept, reject) => { const reader = new FileReader(); reader.onload = () => accept(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const item = { draftId, draftRemovalRevision, id: crypto.randomUUID(), epoch: snapshot.epoch, deviceId: snapshot.deviceId, name: file.name, base64 };
      try { await stagedFile('put', item); setPending(items => [...items, item]); void upload(item); } catch { setNotice(`This browser could not keep ${file.name}. Free storage and choose it again. The existing draft is unchanged.`); }
    }
    } catch { setNotice('This file could not be read. Choose it again.'); }
    finally { reading.current = false; setStaging(false); }
  };
  const remove = async (id: string) => {
    if (uploading.current.has(id)) { setNotice('Wait for this upload to settle before removing it.'); return; }
    try { await stagedFile('delete', id); setPending(files => files.filter(file => file.id !== id)); } catch { setNotice('Could not remove this staged file. Try again.'); }
  };
  return { pending, staging: staging || recovering, errors, notice, add, retry: upload, remove };
}
