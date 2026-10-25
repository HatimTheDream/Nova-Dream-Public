import { useEffect, useRef, useState } from 'react';
import type { HomeItemValue } from '../../../packages/domain/home-library';
import { libraryPortableUrls, type LibraryExportQuery, type LibraryPortable } from '../../../packages/domain/home-library-portable';
import { captureResultMatches } from '../../../packages/domain/home-library-view';
import type { HomeLibraryController } from './HomeLibrary';
import { LibraryTransferDraftOwner, type LibraryTransferScope, type TransferRow } from './library-transfer-draft';
import { downloadLibraryFile, exportLibraryFile, readLibraryInput } from './library-transfer-file';
import { draftBrowserStorage } from './draft-browser-storage';
import { registerHomeDraftNavigation } from './home-draft-navigation';
import { Dialog } from './ui';
import './library-transfer.css';

export type LibraryTransferRequest = LibraryTransferScope & { nonce: string } & (
 { kind: 'import' } | { kind: 'export'; query: LibraryExportQuery; current: () => boolean }
);
const itemValue = (item: Extract<LibraryPortable['entries'][number], { status: 'portable' }>['item']): HomeItemValue =>
 item.kind === 'note' ? { kind: 'note', title: item.title, body: item.body, archived: false } :
  { kind: 'link', title: item.title, body: item.body, url: item.url, archived: false };
export function LibraryTransfer({ scope, controller, request, acceptText, showPaste }: {
 scope: LibraryTransferScope; controller: HomeLibraryController; request?: LibraryTransferRequest;
 acceptText: (text: string, replace: boolean) => boolean; showPaste: () => void;
}) {
 const scopeKey = `${scope.deviceId}:${scope.epoch}:${scope.windowId}`;
 const life = useRef({ active: true, scope: scopeKey, sequence: 0 });life.current.scope = scopeKey;
 const [owner] = useState(() => new LibraryTransferDraftOwner(draftBrowserStorage, scope, () => life.current.active && life.current.scope === scopeKey));
 const [, repaint] = useState(0), [visible, setVisible] = useState<'import' | 'export'>(), [message, setMessage] = useState('');
 const [format, setFormat] = useState<'nova-json' | 'url-text'>('nova-json'), [document, setDocument] = useState<LibraryPortable>();
 const [reading, setReading] = useState(false), [replaceText, setReplaceText] = useState(false), [exportRequest, setExportRequest] = useState<Extract<LibraryTransferRequest, { kind: 'export' }>>();
 const [exported, setExported] = useState<LibraryPortable>(), abort = useRef<AbortController | undefined>(undefined), seen = useRef<string | undefined>(undefined);
 const current = () => life.current.active && life.current.scope === scopeKey;
 const redraw = () => { if (current()) repaint(value => value + 1); };
 const stopRead = () => { life.current.sequence++;abort.current?.abort();abort.current = undefined;setReading(false); };
 useEffect(() => {
  life.current.active = true;
  const release = registerHomeDraftNavigation(() => {
   if (!owner.value) return true;
   const kept = owner.keep();if (!kept) { setVisible('import');redraw(); }return kept;
  });
  return () => { life.current.active = false;life.current.sequence++;abort.current?.abort();release(); };
 }, [owner]);
 useEffect(() => {
  if (!request || seen.current === request.nonce || request.deviceId !== scope.deviceId || request.epoch !== scope.epoch || request.windowId !== scope.windowId) return;
  seen.current = request.nonce;stopRead();setMessage('');setExported(undefined);setVisible(request.kind);
  if (request.kind === 'export') setExportRequest(request);
 }, [request?.nonce, owner]);
 const acknowledge = () => {
  const saved = controller.lastSave;
  if (saved?.command.type === 'items-capture' && owner.value && captureResultMatches(saved.command, saved.result)) owner.acknowledge(saved.command, saved.result);
 };
 useEffect(() => { acknowledge();redraw(); }, [controller.lastSave, owner]);
 const close = () => { if (!current() || owner.value && !owner.keep()) { redraw();return; }stopRead();setVisible(undefined); };
 const blocked = controller.busy || !!controller.pending || !!controller.journalError, draft = owner.value;
 const chooseFile = async (file: File | undefined) => {
  if (!file || !current() || blocked || owner.invalid) return;
  stopRead();const ticket = ++life.current.sequence;setReading(true);setMessage('');
  try {
   const input = await readLibraryInput(file, format);
   if (!current() || ticket !== life.current.sequence) return;
   const parsed = 'document' in input ? input.document : undefined;
   const entries = parsed?.entries ?? [];
   owner.begin({ file: { name: input.name, sha256: input.sha256, format, entries: entries.length,
    unsupported: entries.filter(row => row.status !== 'portable').length,
    archived: entries.filter(row => row.status === 'portable' && row.item.archived).length },
    rows: [], destination: null, ...('text' in input ? { text: input.text } : {}) });
   if (owner.value?.file.sha256 === input.sha256 && owner.value.file.format === format) setDocument(parsed);
   redraw();
  } catch (reason) { if (current() && ticket === life.current.sequence) setMessage(reason instanceof Error ? reason.message : 'The file could not be read. Its original bytes are unchanged.'); }
  finally { if (current() && ticket === life.current.sequence) setReading(false); }
 };
 const select = (position: number, selected: boolean) => {
  if (blocked || !current()) return;
  const entry = document?.entries.find(row => row.position === position), existing = owner.value?.rows.find(row => row.position === position);
  if (existing?.confirmation) return;
  if (!existing && (!entry || entry.status !== 'portable' || entry.item.archived)) return;
  owner.change(value => ({ ...value, rows: existing ? value.rows.map(row => row.position === position ? { ...row, selected } : row) :
   [...value.rows, { position, selected, id: `library:${crypto.randomUUID()}`, rowId: crypto.randomUUID(), value: itemValue((entry as Extract<typeof entry, { status: 'portable' }>).item) }].sort((a, b) => a.position - b.position) }));
  redraw();
 };
 const edit = (position: number, patch: Partial<HomeItemValue>) => {
  if (!current() || blocked) return;
  owner.change(value => ({ ...value, rows: value.rows.map(row => row.position === position ? { ...row, value: { ...row.value, ...patch } as HomeItemValue } : row) }));redraw();
 };
 const destination = controller.state?.collections.find(row => row.id === draft?.destination?.id && !row.archived);
 const outdated = !!draft?.destination && (!destination || destination.revision !== draft.destination.expectedRevision);
 const save = async () => {
  if (!current()) return;
  acknowledge();
  if (blocked || !destination || !owner.value?.destination || destination.revision !== owner.value.destination.expectedRevision) { redraw();return; }
  const command = owner.command(crypto.randomUUID());redraw();if (!command) return;
  const result = await controller.run(command);
  if (!current()) return;
  if (result) owner.acknowledge(command, result);redraw();
 };
 const fetchExport = async () => {
  if (!current() || !exportRequest || !exportRequest.current()) { setMessage('This collection or selection changed. Close and choose the exact export again.');return; }
  stopRead();const ticket = ++life.current.sequence, control = new AbortController();abort.current = control;setReading(true);setMessage('');
  try {
   const file = await exportLibraryFile(exportRequest.query, control.signal);
   if (!current() || ticket !== life.current.sequence) return;
   if (!exportRequest.current()) throw Error('The collection or selection changed during export. Close and choose it again.');
   setExported(file);
  } catch (reason) { if (current() && ticket === life.current.sequence) setMessage(reason instanceof Error ? reason.message : 'Export could not be prepared.'); }
  finally { if (current() && ticket === life.current.sequence) setReading(false); }
 };
 const download = (urls: boolean) => {
  if (!current() || !exported || !exportRequest?.current()) { setMessage('The selected collection changed. Prepare a new exact export.');return; }
  try { downloadLibraryFile(exported, urls ? libraryPortableUrls(exported).text : undefined);setMessage('File handed to this browser for download. Your saved Library is unchanged.'); }
  catch (reason) { setMessage(reason instanceof Error ? reason.message : 'The browser could not download this file.'); }
 };
 const selectedCount = draft?.rows.filter(row => row.selected && !row.confirmation).length ?? 0;
 const exportedLinks = exported?.entries.filter(row => row.status === 'portable' && row.item.kind === 'link').length ?? 0;
 const retainedRow = (row: TransferRow) => <section key={row.position} className="library-transfer-row">
  <label className="check-label"><input type="checkbox" checked={row.selected} disabled={blocked || !!row.confirmation} onChange={event => select(row.position, event.target.checked)}/><span>Include source {row.position + 1}</span></label>
  <label>Title<input maxLength={150} value={row.value.title} disabled={blocked} onChange={event => edit(row.position, { title: event.target.value })}/></label>
  {row.value.kind === 'link' && <label>Address<input maxLength={2048} value={row.value.url} disabled={blocked} onChange={event => edit(row.position, { url: event.target.value })}/></label>}
  <label>{row.value.kind === 'note' ? 'Note' : 'Link notes'}<textarea rows={4} maxLength={row.value.kind === 'note' ? 100000 : 10000} value={row.value.body} disabled={blocked} onChange={event => edit(row.position, { body: event.target.value })}/></label>
  {row.confirmation && <div className="notice"><span>{row.confirmation.disposition === 'created-and-added' ? 'Saved as a new Library source.' : 'Duplicate link skipped. This imported title and writing were not saved over the existing link.'}{owner.hasNewerWriting(row) ? ' Your newer review writing is still kept here.' : ''}</span><button type="button" disabled={blocked} onClick={() => { owner.anotherCopy(row.position, `library:${crypto.randomUUID()}`, crypto.randomUUID());redraw(); }}>Review Another Copy</button></div>}
 </section>;
 return <>
  {owner.invalid && <p className="notice warning" role="alert">{owner.error}</p>}
  {draft && visible !== 'import' && <button className="compact-action compact-utility" onClick={() => { setVisible('import');setMessage(''); }}>Resume Import Review</button>}
  {visible === 'export' && <Dialog title="Export Library Collection" close={close}>
   <div className="library-transfer"><p>Download exact saved versions from this collection. Dream-only sources stay as reference descriptions; missing saved versions are marked unavailable.</p>
    <p className="metadata">Nova Library JSON · up to 16 MiB · original order and full note text. URL text contains only saved link addresses.</p>
    <button className="primary" disabled={reading} onClick={() => void fetchExport()}>{reading ? 'Preparing exact file…' : 'Prepare Export'}</button>
    {exported && <><p role="status">{exported.entries.length} references · {exported.entries.filter(row => row.status === 'portable').length} portable notes or links · {exported.entries.filter(row => row.status !== 'portable').length} reference descriptions or unavailable versions.</p>
     <div className="compact-actions"><button onClick={() => download(false)}>Download Nova JSON</button><button onClick={() => download(true)}>Download URL Text</button></div>
     <p className="metadata">URL text includes {exportedLinks} {exportedLinks === 1 ? 'link address' : 'link addresses'}. Other entries are excluded from that text file.</p></>}
    {message && <p role="status">{message}</p>}
   </div>
  </Dialog>}
  {visible === 'import' && <Dialog title="Import Library File" close={close}>
   <div className="library-transfer"><p>Review a Nova Library JSON file or UTF-8 URL text. Nothing is saved to Library until you choose and confirm it.</p>
    {owner.error && <p className="field-error" role="alert">{owner.error}</p>}{message && <p role="status">{message}</p>}
    {!owner.invalid && <><label>File format<select value={format} disabled={reading || blocked} onChange={event => setFormat(event.target.value as typeof format)}><option value="nova-json">Nova Library JSON</option><option value="url-text">URL text</option></select></label>
     <label>{draft ? 'Reselect the same original file to review more entries' : 'Choose a file'}<input type="file" accept={format === 'nova-json' ? '.json,application/json' : '.txt,text/plain'} disabled={reading || blocked} onChange={event => { void chooseFile(event.target.files?.[0]);event.target.value = ''; }}/></label></>}
    {reading && <p role="status">Reading the bounded file…</p>}
    {draft && <><p className="preserve-case">{draft.file.name}</p>
     {draft.file.format === 'url-text' ? <><pre className="library-transfer-text">{draft.text}</pre><label className="check-label"><input type="checkbox" checked={replaceText} onChange={event => setReplaceText(event.target.checked)}/>Replace the text currently kept in Paste Links</label><button disabled={blocked || !draft.text} onClick={() => { if (!current() || !owner.keep() || !acceptText(draft.text!, replaceText)) { setMessage('Paste Links kept its existing writing. Review the replacement choice or free browser storage.');redraw();return; }if (owner.discard()) { setVisible(undefined);showPaste(); }else setMessage('The text is kept in Paste Links. Retry clearing this import review locally.');redraw(); }}>Review In Paste Links</button><p className="metadata">This opens the existing link review. It does not save links or change their original command.</p></> :
      <><p className="metadata">{draft.file.entries} entries · {draft.file.unsupported} reference-only or unavailable · {draft.file.archived} archived sources kept only in the file. Review at most 20 rows per save; selected writing stays on this device.</p>
       {document && <div className="library-transfer-entries" role="group" aria-label="File entries">{document.entries.map(entry => {
        const kept = draft.rows.find(row => row.position === entry.position), portable = entry.status === 'portable';
        return <label className="check-label" key={entry.position}><input type="checkbox" disabled={blocked || !portable || portable && entry.item.archived || !!kept?.confirmation} checked={!!kept?.selected} onChange={event => select(entry.position, event.target.checked)}/><span>{portable ? entry.item.title : `${entry.reference.kind} reference`}<small>{!portable ? entry.status === 'unavailable' ? 'Saved version unavailable; not imported' : 'Dream-only reference; not imported' : entry.item.archived ? 'Archived source; not imported' : kept?.confirmation ? 'Reviewed save outcome kept below' : entry.item.kind}</small></span></label>;
       })}</div>}
       {!document && <p className="metadata">Your selected writing is kept below. Reselect this exact original file to review additional entries.</p>}
       {draft.rows.map(retainedRow)}
       <label>Save into collection<select value={draft.destination?.id ?? ''} disabled={blocked} onChange={event => {
        const chosen = controller.state?.collections.find(row => row.id === event.target.value && !row.archived);
        owner.change(value => ({ ...value, destination: chosen ? { id: chosen.id, expectedRevision: chosen.revision } : null }));redraw();
       }}><option value="">Choose an existing collection</option>{controller.state?.collections.filter(row => !row.archived).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
       {outdated && <div className="notice"><span>The destination changed. Your complete review is kept.</span><button disabled={blocked || !destination} onClick={() => { if (destination) owner.change(value => ({ ...value, destination: { id: destination.id, expectedRevision: destination.revision } }));redraw(); }}>Use Current Collection</button></div>}
       <p className="metadata">Imports create new sources and preserve their order. Existing matching links are skipped without replacing their notes. Undo removes the new memberships; created sources remain in Library.</p>
       <button className="primary" disabled={blocked || outdated || !destination || !draft.rows.some(row => row.selected && !row.confirmation)} onClick={() => void save()}>Save {selectedCount} Selected {selectedCount === 1 ? 'Source' : 'Sources'}</button>
      </>}
     <div className="compact-actions"><button onClick={close}>Keep For Later</button><button disabled={blocked} onClick={() => { if (confirm('Discard this import review and its unsaved writing? The original file and saved Library sources remain.')) { if (owner.discard()) { setDocument(undefined);setMessage('Import review discarded.'); }redraw(); } }}>Discard Import Review</button><button onClick={() => { owner.keep();redraw(); }}>Retry Keeping Review</button></div>
    </>}
    {(controller.error || controller.journalError) && <p role="alert">{controller.error || controller.journalError}</p>}
    {controller.pending && <div className="notice"><span>The original Library request is kept. No new save can replace it.</span><button disabled={controller.busy} onClick={() => void controller.run(controller.pending!)}>Check Original Save</button></div>}
   </div>
  </Dialog>}
 </>;
}
