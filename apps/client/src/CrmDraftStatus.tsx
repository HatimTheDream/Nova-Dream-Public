import type { CrmKind } from './crm-draft-client';
import type { useCrmDraft } from './useCrmDraft';

export function CrmDraftStatus<K extends CrmKind>({ form }: { form: ReturnType<typeof useCrmDraft<K>> }) {
  return <>
    {form.error && <p className="field-error" role="alert">{form.error}</p>}
    {form.legacy && !form.editor.invalid && <div className="notice warning"><div>
      <p>{form.pending ? 'This earlier draft includes an original save. Checking it uses that same request.' : 'This earlier draft has no workspace identity. Using it here keeps the complete original in this browser and does not save to the host.'}</p>
      <button type="button" disabled={form.busy || form.pending && form.editor.journal.epoch !== form.editor.scope.epoch} onClick={form.adoptLegacy}>{form.pending ? 'Keep Original Save For This Workspace' : 'Use This Writing In This Workspace'}</button>
    </div></div>}
    {form.editor.invalid && form.original && <details><summary>Original Kept Writing</summary><pre>{form.original}</pre></details>}
    {form.legacyOriginal && <details><summary>Earlier Original Writing</summary><pre>{form.legacyOriginal}</pre></details>}
    {(form.rejected || form.changed && !form.pending) && !form.blocked && <div className="notice warning"><div>
      <p>Your edits are kept. Review the current saved version before making another save.</p>
      <button type="button" disabled={form.busy || form.reviewing} onClick={() => void form.review()}>{form.reviewing ? 'Loading Saved Version…' : 'Review Saved Version'}</button>
      {form.reviewed && <>
        {form.reviewed.record ? <><p>Saved version {form.reviewed.record.revision}</p><pre>{JSON.stringify(form.reviewed.record.value, null, 2)}</pre></> : <p>The original saved record is unavailable. Existing saved writing cannot be recreated automatically.</p>}
        <button type="button" disabled={form.busy || !form.reviewed.record && form.editor.journal.revision > 0} onClick={form.acceptReview}>Keep My Edits For This Version</button>
      </>}
    </div></div>}
    {!form.blocked && form.error && <button type="button" disabled={form.busy} onClick={form.retain}>Retry Keeping Writing</button>}
    <p className="metadata">{form.pending ? form.rejected ? 'Original save refused · writing kept' : 'Original save awaiting confirmation' : form.editor.journal.dirty ? form.editor.kept ? 'Edits kept in this browser' : 'Edits remain open in this window' : 'Saved writing is unchanged'}</p>
  </>;
}
