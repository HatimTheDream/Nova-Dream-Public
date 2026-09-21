import { useLayoutEffect, useRef, useState } from 'react';
import type { Conversation, ConversationChanges } from '../../../packages/domain/assistant';
import type { MessagePin } from '../../../packages/domain/message-pins';
import type { Snapshot } from '../../../packages/domain/contracts';
import { ConversationQuickActions } from './ConversationQuickActions';
import { ComposerMenu } from './ComposerMenu';
import { VersionList } from './ConversationVersions';
import { relatedConversations } from './conversation-versions';
import { PinnedMessageList } from './PinnedMessages';
import { MoreHorizontal, ViewList, PanelRight, Settings2, ArrowLeft, ArrowRight, Download, History, Pin, File, UserRound, Queue } from './icons';
import { ConversationSummary, type ConversationSummaryProps } from './ConversationSummary';

type Props = { blocked: boolean; edit: (changes: ConversationChanges) => Promise<unknown>; copyMessages?: () => Promise<void>; projects: Snapshot['projects']; conversation?: Conversation; conversations: Conversation[]; pins: MessagePin[]; openVersion: (c: Conversation) => void; openPin: (pin: MessagePin) => void; removePin: (pin: MessagePin) => Promise<void>; settings: () => void; sources?: () => void; memory: () => void; runs?: () => void; technical?: () => void; exportDraft: () => void; queue?: () => void; summary: ConversationSummaryProps; panelOpen: boolean; togglePanel: () => void };
function ConversationMenuContent({ close, compact, ...props }: Props & { close: () => void; compact: boolean }) {
  const { conversation, conversations, pins, openVersion, openPin, removePin, settings, sources, memory, runs, technical, exportDraft, queue } = props;
  const [page, setPage] = useState<'actions' | 'settings' | 'branches' | 'pins' | 'summary'>('actions');
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }, [page]);
  const action = (run: () => void) => { close(); run(); };
  const branches = conversation && relatedConversations(conversation, conversations).length > 1 && <button onClick={() => setPage('branches')}><History size={17}/>Conversation branches<ArrowRight className="menu-row-arrow" size={15}/></button>;
  const compactTools = compact && <><button onClick={() => setPage('summary')}><ViewList size={17}/>Conversation summary</button><button onClick={() => action(props.togglePanel)}><PanelRight size={17}/>{props.panelOpen ? 'Close side panel' : 'Open side panel'}</button></>;
  const utilities = <>
    {sources && <button onClick={() => action(sources)}><File size={17}/>Message context</button>}
    <button onClick={() => action(memory)}><UserRound size={17}/>Saved memories</button>
    <button onClick={() => action(exportDraft)}><Download size={17}/>Export draft</button>
    {queue && <button onClick={() => action(queue)}><Queue size={17}/>Message queue</button>}
    {runs && <button onClick={() => action(runs)}><History size={17}/>Run history</button>}
    {!!pins.length && <button onClick={() => setPage('pins')}><Pin size={17}/>Pinned messages<ArrowRight className="menu-row-arrow" size={15}/></button>}
    {technical && <button onClick={() => action(technical)}><Settings2 size={17}/>Technical details</button>}
  </>;
  return <div ref={menu} className="conversation-action-menu" onKeyDown={event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(button => button.getClientRects().length);
    const index = buttons.indexOf(event.target); if (index < 0) return;
    event.preventDefault(); buttons[(index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }}>
    {page === 'actions' ? conversation ? <ConversationQuickActions conversation={conversation} blocked={props.blocked} edit={props.edit} copyMessages={props.copyMessages} projects={props.projects} close={close}>{branches}{compactTools}<hr/><button onClick={() => setPage('settings')}><Settings2 size={17}/>Settings<ArrowRight className="menu-row-arrow" size={15}/></button></ConversationQuickActions> : <>{compactTools}{utilities}</> : <><button onClick={() => setPage(page === 'pins' ? 'settings' : 'actions')}><ArrowLeft size={17}/>Back</button><hr/>{page === 'settings' ? <><button onClick={() => action(settings)}><Settings2 size={17}/>Conversation settings</button>{utilities}</> : page === 'summary' ? <ConversationSummary {...props.summary} openFile={(file, output) => action(() => props.summary.openFile(file, output))} openFiles={() => action(props.summary.openFiles)} addFiles={props.summary.addFiles ? () => action(props.summary.addFiles!) : undefined} changes={props.summary.changes ? () => action(props.summary.changes!) : undefined} projectSettings={props.summary.projectSettings ? () => action(props.summary.projectSettings!) : undefined}/> : page === 'branches' && conversation ? <VersionList conversation={conversation} conversations={conversations} open={item => action(() => openVersion(item))}/> : <PinnedMessageList pins={pins} open={pin => action(() => openPin(pin))} remove={removePin}/>}</>}
  </div>;
}
export function ConversationHeaderTools(props: Props) {
  const { summary, panelOpen, togglePanel } = props;
  const root = useRef<HTMLDivElement>(null), [compact, setCompact] = useState(false);
  useLayoutEffect(() => { const header = root.current?.parentElement; if (!header) return; const fit = () => setCompact(header.clientWidth <= 560); fit(); const observer = new ResizeObserver(fit); observer.observe(header); return () => observer.disconnect(); }, []);
  return <div className="conversation-header-actions" ref={root}>
    <ComposerMenu label="Conversation menu" icon={<MoreHorizontal size={20}/>} placement="below" align="right">{close => <ConversationMenuContent {...props} compact={compact} close={close}/>}</ComposerMenu>
    {!compact && <><ComposerMenu label="Toggle summary" panelLabel="Conversation summary" pinned className="conversation-summary-toggle" icon={<ViewList size={19}/>} placement="below" align="right">{close => <ConversationSummary {...summary} openFile={(file, output) => { close(); summary.openFile(file, output); }} openFiles={() => { close(); summary.openFiles(); }} addFiles={summary.addFiles ? () => { close(); summary.addFiles!(); } : undefined} changes={summary.changes ? () => { close(); summary.changes!(); } : undefined} projectSettings={summary.projectSettings ? () => { close(); summary.projectSettings!(); } : undefined}/>}</ComposerMenu>
    <button className="icon-button" aria-label="Toggle side panel" title="Toggle side panel" aria-expanded={panelOpen} onClick={togglePanel}><PanelRight size={19}/></button></>}
  </div>;
}
