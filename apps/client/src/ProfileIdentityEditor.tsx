import { useEffect, useRef, useState } from 'react';
import { canonical, type Entity, type Snapshot } from '../../../packages/domain/contracts';
import type { PersonalProfile } from '../../../packages/domain/workspace-records';
import { commit, fetchSnapshot } from './api';
import { draftBrowserStorage } from './draft-browser-storage';
import { ProfileIdentityDraft } from './profile-identity-client';
import { RecordFields } from './RecordFields';
import { registerRecordDraftNavigation } from './record-draft-navigation';
import { retainedWindowId } from './useWorkspace';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import { Dialog } from './ui';
import './profile-identity.css';

export type ProfileIdentitySection = 'identity' | 'look';
export function ProfileIdentityEditor({ snapshot, entity, initialSection, refresh, close, owns = () => true }: {
  snapshot: Snapshot; entity?: Entity<PersonalProfile>; initialSection: ProfileIdentitySection;
  refresh: () => Promise<void>; close: () => void; owns?: () => boolean;
}) {
  const [, redraw] = useState(0), scope = `${snapshot.epoch}:${snapshot.deviceId}`;
  const owner = useRef({ scope, owns }); owner.current = { scope, owns };
  const [draft] = useState(() => new ProfileIdentityDraft(draftBrowserStorage,
    { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId }, entity,
    command => commit<PersonalProfile>(command), () => redraw(value => value + 1),
    () => owner.current.scope === scope && owner.current.owns()));
  const [section, setSection] = useState(initialSection), [notice, setNotice] = useState('');
  const sectionOwner = useRef(section); sectionOwner.current = section;
  const [reviewed, setReviewed] = useState<{ entity?: Entity<PersonalProfile>; epoch: string }>();
  const [reviewing, setReviewing] = useState(false), [reviewError, setReviewError] = useState('');
  const reviewFlight = useRef(false), fields = useRef<HTMLDivElement>(null);
  const current = () => draft.active && owner.current.scope === `${draft.scope.epoch}:${draft.scope.deviceId}` && owner.current.owns();
  useEffect(() => {
    const unregister = registerRecordDraftNavigation(() => draft.retain());
    const leave = (event: BeforeUnloadEvent) => { if (!draft.retain()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => { draft.retire(); unregister(); window.removeEventListener('beforeunload', leave); };
  }, [draft]);
  useEffect(() => { draft.observe(entity, snapshot.epoch); }, [draft, entity, snapshot.epoch]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => fields.current?.querySelector<HTMLElement>('[data-profile-section]:not([hidden]) input, [data-profile-section]:not([hidden]) textarea, [data-profile-section]:not([hidden]) button')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const keepAndClose = () => { if (current() && draft.retain()) close(); };
  const chooseSection = (next: ProfileIdentitySection) => { if (current() && draft.retain()) { sectionOwner.current = next; setSection(next); } };
  const refreshSaved = async (result: Entity<PersonalProfile> | undefined, fullSave = false) => {
    if (!result || !current()) return;
    setNotice(fullSave ? 'Profile saved.' : 'Saved. Your other unfinished profile writing stays kept.');
    try { await refresh(); } catch { if (current()) setNotice('Saved. Refresh the workspace to see the latest profile.'); return; }
    if (fullSave && current() && draft.canCloseSaved && draft.retain()) close();
  };
  const saveProfile = async () => {
    if (sectionOwner.current !== 'identity' || !current()) return;
    await refreshSaved(await draft.saveProfile(), true);
  };
  const saveLook = async (appearance: PersonalProfile['appearance']) => {
    if (sectionOwner.current !== 'look' || !current()) return;
    const hadSavedProfile = !!draft.saved, result = await draft.saveLook(appearance);
    if (!current()) return;
    if (result) await refreshSaved(result);
    else if (!hadSavedProfile && !draft.error && draft.kept && canonical(draft.journal.value.appearance) === canonical(appearance))
      setNotice('Look kept in this draft. Add your name in Profile, then Save Profile.');
  };
  const review = async () => {
    if (!current() || reviewFlight.current || !draft.canReview) return;
    reviewFlight.current = true; setReviewing(true); setReviewError('');
    try {
      const fresh = await fetchSnapshot();
      if (!current()) return;
      if (fresh.epoch !== draft.scope.epoch || fresh.deviceId !== draft.scope.deviceId) throw Error('The workspace changed. Your original profile writing remains kept.');
      const saved = fresh.records?.profile.find(value => value.id === 'profile:owner');
      if (!draft.observe(saved, fresh.epoch)) throw Error(draft.error || 'The saved profile could not be reviewed.');
      setReviewed({ entity: saved, epoch: fresh.epoch });
    } catch (error) { if (current()) setReviewError(error instanceof Error ? error.message : 'The saved profile is unavailable.'); }
    finally { reviewFlight.current = false; if (current()) setReviewing(false); }
  };
  const adopt = (keepWriting: boolean) => {
    if (!current() || reviewFlight.current || !reviewed || !draft.canReview) return;
    if (draft.review(reviewed.entity, reviewed.epoch, keepWriting)) {
      setReviewed(undefined); setNotice(keepWriting ? 'Your writing is kept against the reviewed saved version. Save when ready.' : 'Using the reviewed saved profile.');
    }
  };
  const pending = draft.pending, disabled = draft.blocked || draft.busy || !!pending;
  return <Dialog title={section === 'identity' ? 'Edit Profile' : 'Edit Look'} close={keepAndClose}>
    <div className="profile-identity-editor">
      <div className="profile-identity-sections" role="group" aria-label="Profile editor sections">
        <button type="button" aria-pressed={section === 'identity'} onClick={() => chooseSection('identity')}>Profile</button>
        <button type="button" aria-pressed={section === 'look'} onClick={() => chooseSection('look')}>Look</button>
      </div>
      <p className="metadata">This identity belongs to the shared workspace. Profile writing and your look stay together in one kept draft.</p>
      {draft.error && <p className="notice warning" role="alert">{draft.error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {!pending && draft.journal.dirty && !draft.blocked && <p className="metadata">{draft.kept ? 'Your unfinished profile is kept in this browser.' : 'Keep this window open until your writing can be kept.'}</p>}
      {!pending && !draft.kept && !!draft.error && !draft.blocked && <button type="button" onClick={() => { if (draft.retain()) setNotice('Your writing is kept in this browser.'); }}>Retry Keeping Writing</button>}
      {pending && <div className="notice">
        <p>{draft.hasConfirmedResult ? 'Your save is confirmed on the host. Keeping its confirmation in this browser needs another try.' :
          draft.journal.conflict ? 'The original save was refused. Review the saved profile before choosing what to keep.' : 'The original save is awaiting confirmation. Your writing and request remain kept.'}</p>
        {!draft.journal.conflict && <button type="button" disabled={draft.busy || draft.blocked}
          onClick={() => void draft.checkOriginal(pending.requestId).then(result => refreshSaved(result))}>
          {draft.hasConfirmedResult ? 'Retry Keeping Confirmed Save' : 'Check Original Save'}
        </button>}
      </div>}
      {draft.changed && !pending && <p className="notice">The saved profile changed. Review it before saving your kept writing.</p>}
      <form noValidate onSubmit={event => { event.preventDefault(); void saveProfile(); }}>
        <fieldset disabled={disabled} className="profile-identity-fields"><div ref={fields}>
          <RecordFields kind="profile" profileSection={section} value={draft.journal.value} snapshot={snapshot}
            change={value => { setNotice(''); draft.change(value as PersonalProfile); }}
            appearanceControls={{
              savedValue: draft.saved?.value.appearance ?? null, onSaveLook: saveLook,
              onCancelLook: () => { if (current() && sectionOwner.current === 'look' && draft.cancelLook()) setNotice('Saved look restored in this draft. Your other writing stays kept.'); },
              saveDisabled: disabled || !!draft.journal.conflict || draft.changed, saving: draft.busy,
              saveLabel: draft.saved ? 'Save Look' : 'Use Look',
              preferenceKey: `e3:creator-locks:${snapshot.epoch}:${snapshot.deviceId}:profile:profile:owner`,
            }}/>
        </div></fieldset>
        <div className="profile-identity-actions">
          {section === 'identity' && <button className="primary" type="submit" disabled={disabled || !!draft.journal.conflict || draft.changed || !draft.journal.dirty}>Save Profile</button>}
          <button type="button" onClick={keepAndClose}>Keep &amp; Close</button>
          <button type="button" disabled={!draft.canReview || reviewing} onClick={() => void review()}>{reviewing ? 'Reading Saved Profile…' : 'Review Saved Profile'}</button>
        </div>
      </form>
      {reviewError && <p className="notice warning" role="alert">{reviewError}</p>}
      {reviewed && <section className="profile-identity-review" aria-label="Reviewed saved profile">
        <h3>{reviewed.entity ? `Saved profile · version ${reviewed.entity.revision}` : 'No saved profile yet'}</h3>
        {reviewed.entity && <div className="profile-identity-review-copy">
          <SquareLynx appearance={reviewed.entity.value.appearance} size="profile" accessibility={{ mode: 'informative', label: 'Reviewed saved look' }}/>
          <div><strong>{reviewed.entity.value.name}</strong>{reviewed.entity.value.position && <p>{reviewed.entity.value.position}</p>}<p className="profile-identity-about">{reviewed.entity.value.about}</p></div>
        </div>}
        <div className="button-row"><button type="button" disabled={reviewing || !draft.canReview} onClick={() => adopt(true)}>Keep My Edits</button>
          <button type="button" disabled={reviewing || !draft.canReview} onClick={() => adopt(false)}>Use Saved Profile</button></div>
      </section>}
    </div>
  </Dialog>;
}
