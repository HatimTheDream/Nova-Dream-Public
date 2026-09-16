import { initializeInboxSession, useInboxSessionStore } from './dreamclaw/services/inbox/inboxSession';
import { AccountSetup } from './AccountSetup';
import { MailContactDialog } from './MailContactDialog';
import type { MailContactPrepare } from '../../../packages/domain/mail-contact';
import { X } from './icons';
import { createInboxSource } from './dreamclaw/inbox-source';
import {createInboxFollowups} from './dreamclaw/inbox-followups';
import {nextFollowupProposal} from './dreamclaw/inbox-followups';
import {keepCalendarTarget} from './calendar-target';
import {createInboxFileJournal} from './dreamclaw/inbox-file-journal';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AccountsState } from '../../../packages/domain/accounts';
import type { Snapshot } from '../../../packages/domain/contracts';
import { readLocal, request, saveLocal } from './api';
import { calendarWindowIdentity } from './calendar-window';
import InboxPage from './dreamclaw/pages/Inbox';
import { createInboxMailApi, installInboxMailApi, getInboxMailApi, subscribeInboxMailScope } from './dreamclaw/inbox-transport';
import { createInboxWriting, InboxHostProvider, inboxFiles, type InboxHost, type InboxNotice } from './dreamclaw/inbox-host';
import { createInboxTriageJournal } from './dreamclaw/inbox-triage-journal';
import type { MailTriagePlan } from '../../../packages/domain/mail-triage';
import { createInboxDeliveryJournal } from './dreamclaw/inbox-delivery-journal';
import { DEFAULT_SETTINGS } from './dreamclaw/pages/Calendar/calendarTypes';
import type { PageViewState } from './dreamclaw/types/missionControl';
import './dreamclaw/styles.css';
import './dreamclaw/inbox.css';
import { inboxLoadingPercent, prepareRecentMessages, type InboxStartupProgress } from './inbox-startup-progress';

import { ModuleLoading } from './ModuleLoading';

type Props = { prepare?: boolean; snapshot: Snapshot; openSettings(): void; openCalendar(): void; openContact(id: string): void; refresh(): Promise<void> };
// The original Inbox session deliberately survives leaving its route. Recheck
// account authority before showing it again; only a changed scope invalidates it.
let retainedScope: { key: string; dispose(): void } | undefined;
function acceptMailScope(snapshot: Snapshot, accounts: AccountsState) {
  const fingerprint = JSON.stringify([snapshot.epoch, snapshot.deviceId, accounts.clients, accounts.accounts]);
  if (retainedScope?.key !== fingerprint) {
    retainedScope?.dispose();
    retainedScope = { key: fingerprint, dispose: installInboxMailApi(createInboxMailApi({ epoch: snapshot.epoch, deviceId: snapshot.deviceId, accounts })) };
  }
  return fingerprint;
}
// Preparation starts on the Inbox route and survives navigation away. Reopening
// attaches to the same work instead of starting a second preparation pass.
let startup: { key: string; work: Promise<AccountsState>; progress: InboxStartupProgress; report?: (progress: InboxStartupProgress) => void; settled: boolean } | undefined;
export function prepareInboxStartup(snapshot: Snapshot, report?: (progress: InboxStartupProgress) => void): Promise<AccountsState> {
  const key = `${snapshot.epoch}:${snapshot.deviceId}`;
  if (startup?.key === key && startup.settled && startup.progress.phase === 'ready') {
    const prepared = startup;
    return request<AccountsState>('accounts').then(accounts => {
      const scope = retainedScope?.key;
      if (acceptMailScope(snapshot, accounts) !== scope) {
        if (startup === prepared) startup = undefined;
        return prepareInboxStartup(snapshot, report);
      }
      report?.(prepared.progress);
      return accounts;
    });
  }
  if (startup?.key === key && !startup.settled) {
    if (report) { report(startup.progress); if (!startup.settled) startup.report = report; }
    return startup.work;
  }
  const state = { key, work: Promise.resolve(undefined as unknown as AccountsState), progress: { phase: 'accounts', completed: 0 } as InboxStartupProgress, report, settled: false };
  startup = state;
  const publish = (progress: InboxStartupProgress) => { state.progress = progress; state.report?.(progress); };
  publish(state.progress);
  const work = (async () => {
    const accounts = await request<AccountsState>('accounts'); acceptMailScope(snapshot, accounts);
    const api = getInboxMailApi()!;
    const mailAccounts = accounts.accounts.filter(account => account.capabilities.mailRead && ['connected', 'refreshing'].includes(account.state));
    const firstPagesReady = () => {
      const completed = mailAccounts.filter(account => {
      const page = useInboxSessionStore.getState().folders.inbox.snapshots.find(page => page.account.accountId === account.id);
      return page && (page.threads.length > 0 || ['complete', 'paused', 'error'].includes(page.indexStatus || ''));
      }).length;
      publish({ phase: 'mailboxes', completed, total: mailAccounts.length });
      return completed === mailAccounts.length;
    };
    publish({ phase: 'mailboxes', completed: 0, total: mailAccounts.length });
    const observeInitialization = useInboxSessionStore.subscribe(firstPagesReady);
    try { await initializeInboxSession(); api.assertCurrent(); } finally { observeInitialization(); }
    if (!firstPagesReady()) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); unsubscribe(); unsubscribeScope(); resolve(); };
      const unsubscribe = useInboxSessionStore.subscribe(() => { if (firstPagesReady()) finish(); });
      const unsubscribeScope = subscribeInboxMailScope(finish);
      const timer = setTimeout(finish, 30000);
    });
    api.assertCurrent();
    const recent = useInboxSessionStore.getState().folders.inbox.snapshots.flatMap(snapshot => snapshot.threads.map(thread => ({ thread, account: snapshot.account })))
      .sort((a, b) => (Date.parse(b.thread.date || '') || 0) - (Date.parse(a.thread.date || '') || 0)).slice(0, 25);
    await prepareRecentMessages(recent, async ({ account, thread }) => {
        api.assertCurrent();
        await api.preloadThread({ provider: account.provider === 'gmail' ? 'google' : 'microsoft', accountId: account.accountId, threadId: thread.id, messageId: thread.sourceMessageId }).catch(() => { api.assertCurrent(); });
    }, publish);
    publish({ phase: 'ready', completed: recent.length, total: recent.length });
    return accounts;
  })();
  state.work = work.finally(() => { state.settled = true; state.report = undefined; }); return state.work;
}
// Route changes must also preserve writing that could not fit in browser storage.
const retainedWriting = new Map<string, ReturnType<typeof createInboxWriting>>();
const retainedTriage = new Map<string, ReturnType<typeof createInboxTriageJournal>>();
const retainedFileJournals = new Map<string, ReturnType<typeof createInboxFileJournal>>();
const retainedSources = new Map<string, ReturnType<typeof createInboxSource>>();
const retainedFollowups = new Map<string, ReturnType<typeof createInboxFollowups>>();
const retainedDelivery = new Map<string, ReturnType<typeof createInboxDeliveryJournal>>();
export default function OriginalInbox(props: Props) {
  const [identity, setIdentity] = useState<{ id: string; previous?: string }>();
  const [accounts, setAccounts] = useState<AccountsState>();
  const [progress, setProgress] = useState<InboxStartupProgress>({ phase: 'accounts', completed: 0 });
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, first = 0, second = 0;
    setError('');
    void Promise.all([calendarWindowIdentity(), props.prepare === false ? Promise.resolve(undefined) : prepareInboxStartup(props.snapshot, value => { if (active) setProgress(value); })]).then(([identity, accounts]) => {
      if (!active) return;
      setIdentity(identity); setAccounts(accounts);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { if (active) setReady(true); }); });
    }).catch(() => { if (active) setError('Your mail needs a moment. Try again when your connection is ready.'); });
    return () => { active = false; cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [props.snapshot.deviceId, props.snapshot.epoch, props.prepare, attempt]);
  return ready && identity ? <ConnectedInbox key={`${props.snapshot.deviceId}:${props.snapshot.epoch}:${identity.id}`} {...props} identity={identity} initialAccounts={accounts}/> : <ModuleLoading module="Inbox" percent={inboxLoadingPercent(progress)} error={error} retry={() => setAttempt(value => value + 1)}/>;
}
function ConnectedInbox({ snapshot, openSettings, openCalendar, openContact, refresh, identity, initialAccounts }: Props & { identity: { id: string; previous?: string }; initialAccounts?: AccountsState }) {
  const [contactInput, setContactInput] = useState<MailContactPrepare>();
  const [source] = useState(() => {
    const key=`${snapshot.epoch}:${snapshot.deviceId}:${identity.id}`;
    let controller=retainedSources.get(key);
    if(!controller){controller=createInboxSource({epoch:snapshot.epoch,deviceId:snapshot.deviceId,windowId:identity.id,previousWindowId:identity.previous});retainedSources.set(key,controller);}return controller;
  });
  useEffect(() => { source.acceptStoredTarget(); const change=()=>source.acceptStoredTarget(); window.addEventListener('e3:inbox-target',change); return ()=>window.removeEventListener('e3:inbox-target',change); }, [source]);
  const [followups] = useState(() => {
    const key=`${snapshot.epoch}:${snapshot.deviceId}:${identity.id}`;
    let journal=retainedFollowups.get(key);
    if(!journal){journal=createInboxFollowups({epoch:snapshot.epoch,deviceId:snapshot.deviceId,windowId:identity.id,previousWindowId:identity.previous});retainedFollowups.set(key,journal);}return journal;
  });
  const followupState=useStore(followups.store,state=>state);
  const [scopeVersion, setScopeVersion] = useState(() => initialAccounts ? retainedScope?.key ?? '' : ''), [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState<InboxNotice>();
  const [portal] = useState(() => { const element = document.createElement('div'); element.className = 'dreamclaw-module dc-inbox-portals'; return element; });
  const [writing] = useState(() => {
    const key = `${snapshot.deviceId}:${identity.id}`;
    let store = retainedWriting.get(key);
    if (!store) { store = createInboxWriting(snapshot.deviceId, identity.id, identity.previous); retainedWriting.set(key, store); }
    return store;
  });
  const storageError = useStore(writing, state => state.storageError);
  const [delivery] = useState(() => {
    const key = `${snapshot.epoch}:${snapshot.deviceId}:${identity.id}`;
    let journal = retainedDelivery.get(key);
    if (!journal) { journal = createInboxDeliveryJournal({ epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: identity.id, previousWindowId: identity.previous }); retainedDelivery.set(key, journal); }
    return journal;
  });
  const [files] = useState(() => {
    const key = `${snapshot.epoch}:${snapshot.deviceId}:${identity.id}`;
    let journal=retainedFileJournals.get(key);
    if(!journal){journal=createInboxFileJournal({epoch:snapshot.epoch,deviceId:snapshot.deviceId,windowId:identity.id,previousWindowId:identity.previous});retainedFileJournals.set(key,journal);}
    return journal;
  });
  const fileStorageError=useStore(files.store,state=>state.storageError);
  const [triage] = useState(() => {
    const key = `${snapshot.epoch}:${snapshot.deviceId}:${identity.id}`;
    let journal = retainedTriage.get(key);
    if (!journal) { journal = createInboxTriageJournal({ epoch:snapshot.epoch, deviceId:snapshot.deviceId, windowId:identity.id, previousWindowId:identity.previous }); retainedTriage.set(key,journal); }
    return journal;
  });
  const triageState = useStore(triage.store, state => state);
  const accountState = useRef<AccountsState | undefined>(initialAccounts);
  const displayedReadJob=useRef<Promise<unknown>|undefined>(undefined);
  const [showKeptWorkspace, setShowKeptWorkspace] = useState(false);
  const actionResult = (plan:MailTriagePlan) => ({plan,status:plan.status,message:plan.resultMessage??plan.summary,receipt:plan.receipt,errors:plan.errors});
  const deliveryStorageError = useStore(delivery.store, state => state.storageError);
  const live = useRef({ openSettings, openCalendar, snapshot, openContact, refresh }); live.current = { openSettings, openCalendar, snapshot, openContact, refresh };
  const preferencePrefix = `e3:original-inbox:${snapshot.deviceId}:${identity.id}:`;
  const [host] = useState<Omit<InboxHost, 'scopeVersion'>>(() => ({
    openContact(source, messageId) {
      const account = accountState.current?.accounts.find(item => item.id === source.accountId && item.provider === source.provider);
      if (!account) { setNotice({ severity: 'error', title: 'Refresh this mail account', body: 'Your writing remains in Inbox.' }); return; }
      setContactInput({ epoch: live.current.snapshot.epoch, source, messageId, generation: account.generation });
    },
    portal, writing, delivery, files, triage, followups, source, epoch: snapshot.epoch, searchParams: new URLSearchParams(), view: readLocal<PageViewState>(preferencePrefix + 'view') ?? {},
    patchPageView(_page, patch) { saveLocal(preferencePrefix + 'view', { ...readLocal<PageViewState>(preferencePrefix + 'view'), ...patch }); },
    preferences: {
      getItem(key) { try { return localStorage.getItem(preferencePrefix + key); } catch { return null; } },
      setItem(key, value) { try { localStorage.setItem(preferencePrefix + key, value); } catch { setNotice({ title: 'View kept in this window', body: 'Browser storage is full. Keep Inbox open to preserve these view changes.' }); } },
    },
    calendarSettings: DEFAULT_SETTINGS,
    async addCalendarEvent(data,context) {
      const account=accountState.current?.accounts.find(a=>a.id===context.source.accountId);
      if(!account)throw new Error('Refresh this mail account before scheduling its follow-up.');
      return followups.schedule({...context,generation:account.generation,title:data.title,notes:(data.notes??'').slice(0,10000),timezone:live.current.snapshot.layout.value.timezone,reminderMinutes:data.reminderMinutes,deliveryChannel:data.deliveryChannel});
    },
    openCalendar(eventId) { try{keepCalendarTarget(snapshot.deviceId,identity.id,eventId);live.current.openCalendar();}catch(error){setNotice({severity:'error',title:'Calendar could not open',body:error instanceof Error?error.message:'Your saved event remains in Calendar.'});} },
    addNotification: setNotice,
    openSettings() { live.current.openSettings(); },
    api: { file: inboxFiles,
      async markDisplayed(input) {
        const api=getInboxMailApi();api?.assertCurrent();
        const account=accountState.current?.accounts.find(account=>account.id===input.accountId&&account.generation===input.generation);
        if(!api||!account?.capabilities.mailModify)throw new Error('Read status could not be saved. Refresh this account’s permissions.');
        const {messageIds,...target}=input;
        const previous=displayedReadJob.current;
        const job=(async()=>{
          await previous?.catch(()=>{});api.assertCurrent();
          const result=await triage.displayed({target,messageIds});
          api.assertCurrent();
          await api.mailIndex?.getSnapshot({provider:input.provider,accountId:input.accountId});
          if(result.plan&&result.plan.status!=='completed') {
            const outcome=result.plan.outcomes.find(item=>item.state==='uncertain')??result.plan.outcomes.find(item=>item.state==='failed');
            throw new Error(outcome?.detail||'Read status was not confirmed. Use Mark read to check or try again.');
          }
        })();
        displayedReadJob.current=job;
        await job;
      }, mailAssistant: {
      async senderState() { return {canManage:false}; },
      async prepareSelection(input) {
        // A deliberate toolbar/bulk action follows any read update already sent
        // by this opening, so Mark unread cannot be overtaken by that update.
        await displayedReadJob.current?.catch(()=>{});
        const targets = input.targets.map(target => {
          const account = accountState.current?.accounts.find(a => a.id === target.accountId);
          if (!account || !['gmail','microsoft'].includes(target.provider)) throw new Error('This mail account changed. Refresh Inbox before reviewing it.');
          return {...target,provider:target.provider as 'gmail'|'microsoft',generation:account.generation};
        });
        const action = input.action;
        if (action==='unsubscribe'||action==='block-sender'||action==='unblock-sender') throw new Error('The original sender actions are still being connected. No mail was changed.');
        return {success:true,plan:await triage.prepare({...input,action,targets})};
      },
      async apply(input) { return actionResult(await triage.act(input.planId,'apply',input.digest)); },
      async undo(input) { return actionResult(await triage.act(input.receiptId,'undo',input.digest)); },
      async cancel(input) { return actionResult(await triage.act(input.planId,'cancel',input.digest)); },
      async acknowledge(input) { return actionResult(await triage.act(input.planId,'acknowledge',input.digest)); },
      async check(input) { return actionResult(await triage.checkPlan(input.planId)); },
    } },
  }));
  useEffect(() => { document.body.append(portal); return () => portal.remove(); }, [portal]);
  useEffect(() => {
    let active = true, running = false, previous = '';
    const refresh = async () => {
      if (running) return; running = true;
      try {
        const accounts = await request<AccountsState>('accounts'); if (!active) return; accountState.current=accounts;
        const fingerprint = acceptMailScope(snapshot, accounts);
        if (fingerprint !== previous) { previous = fingerprint; setScopeVersion(fingerprint); }
        setConnectionError('');
      } catch (error) { if (active) setConnectionError(error instanceof Error ? error.message : 'The mail host is unavailable. Your writing is kept.'); }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [snapshot.epoch, snapshot.deviceId]);
  return <InboxHostProvider host={{ ...host, scopeVersion }}>
    {contactInput && <MailContactDialog key={JSON.stringify(contactInput)} input={contactInput} journalKey={`e3:mail-contact:${snapshot.epoch}:${snapshot.deviceId}:${identity.id}:${JSON.stringify([contactInput.source, contactInput.messageId])}`} previousJournalKey={identity.previous ? `e3:mail-contact:${snapshot.epoch}:${snapshot.deviceId}:${identity.previous}:${JSON.stringify([contactInput.source, contactInput.messageId])}` : undefined} close={() => setContactInput(undefined)} refresh={refresh} opened={id => { setContactInput(undefined); openContact(id); }}/>}
    <div className="dreamclaw-module dc-inbox-module">
    {(connectionError || storageError || deliveryStorageError || fileStorageError || triageState.storageError || followupState.storageError) && <div className="inbox-host-notice" role="alert">{connectionError || 'Browser storage is full. Keep this window open to preserve your writing and mail status.'}</div>}
    {notice && <div className="inbox-host-notice" role={notice.severity === 'error' ? 'alert' : 'status'}><span><strong>{notice.title}</strong> {notice.body}</span><button onClick={() => setNotice(undefined)} aria-label="Dismiss Inbox notice"><X size={18}/></button></div>}
    {Object.keys(followupState.records).length>0 && <details className="inbox-followup-history">
      <summary>Calendar follow-ups · {Object.keys(followupState.records).length}{Object.values(followupState.records).some(record=>record.pending)?' · check saved status':''}</summary>
      <ul>{Object.entries(followupState.records).reverse().map(([key,record])=>{const proposal=nextFollowupProposal(record);return <li key={key}>
        <div><strong>{record.result?.event.value.title??record.command.title}</strong><p>{record.error || (record.pending?'Saving needs confirmation. Check the original request.':`${record.result?.event.value.start.date} · ${record.result?.event.value.start.time} · ${record.result?.event.value.timezone}`)}</p>{record.result?.event.value.reminderMinutes? <p>Review reminder status in Calendar or the bell menu. Device display is tracked separately.</p>:null}</div>
        <div>{record.result&&<button onClick={()=>host.openCalendar(record.result!.event.id)}>Open in Calendar</button>}
        <button disabled={followupState.busy[key]} onClick={()=>void Promise.resolve().then(()=>followups.retry(key)).catch(()=>{})}>{followupState.busy[key]?'Checking…':record.pending?'Check saved status':'Refresh status'}</button>
        {!record.pending&&<button disabled={followupState.busy[key]} onClick={()=>{try{followups.forget(key);}catch{}}}>Hide from this list</button>}
        {record.result&&!record.pending&&<button disabled={followupState.busy[key]} onClick={()=>{const account=accountState.current?.accounts.find(a=>a.id===record.command.source.accountId);if(!account){setNotice({severity:'error',title:'Refresh this mail account',body:'Your saved follow-up remains in Calendar.'});return;}void Promise.resolve().then(()=>followups.schedule({...proposal,generation:account.generation,after:{eventId:record.result!.event.id,revision:record.result!.event.revision}})).catch(()=>{});}}>Schedule another · {new Intl.DateTimeFormat(undefined,{timeZone:proposal.timezone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(proposal.startAt))}</button>}</div>
      </li>})}</ul>
    </details>}
    {scopeVersion ? !accountState.current?.accounts.some(account => account.state !== 'disconnected' && account.capabilities.mailRead) && !showKeptWorkspace ? <div className="inbox-setup-screen"><AccountSetup openSettings={openSettings}/><button className="text-button" onClick={() => setShowKeptWorkspace(true)}>Open kept mail workspace</button></div> : <InboxPage/> : <ModuleLoading module="Inbox" error={connectionError}/>}
  </div></InboxHostProvider>;
}
