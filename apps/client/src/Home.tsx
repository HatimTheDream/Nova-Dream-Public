import { useEffect, useState } from 'react';
import type { AssistantOperation, Conversation } from '../../../packages/domain/assistant';
import { HomeSpace, type HomeSpaceProps } from './HomeSpace';
import { BriefingCard } from './BriefingCard';
import { HomeAppointmentWidget } from './HomeAppointmentWidget';
import { Folder, ArrowRight, Plus, MessageSquare } from './icons';

type Props = HomeSpaceProps & {
  openDraft?: (id: string) => void;
  openConversation?: (conversation: Conversation) => void;
  operations?: AssistantOperation[];
  conversations?: Conversation[];
  activityRead?: 'loading' | 'ready' | 'error';
};

export function Home(props: Props) {
  const { snapshot, layout, newTask, open, editTask, complete, openDraft, openConversation, operations = [], conversations = [], activityRead = 'loading' } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const [view, setView] = useState<'today' | 'space'>('today');
  const [spaceOpened, setSpaceOpened] = useState(false);
  const selectView = (next: 'today' | 'space') => { if (next === 'space') setSpaceOpened(true); setView(next); };
  const activity = operations.filter(op => op.epoch === snapshot.epoch && ['prepared', 'dispatching', 'accepted', 'running', 'unknown'].includes(op.state)
    && conversations.some(c => c.id === op.conversationId && !c.deleted)).slice(0, 3);
  const labels = { prepared: 'Preparing', dispatching: 'Starting', accepted: 'Accepted', running: 'Working', unknown: 'Status needs checking' };
  return <main className="home-page home-quiet page-scroll" aria-label="Home" data-reorder-scroll>
    <div className="home-view-bar">
      <div className="home-view-tabs" role="tablist" aria-label="Home views" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'today' : event.key === 'End' ? 'space' : view === 'today' ? 'space' : 'today';
        selectView(next); document.getElementById(`home-tab-${next}`)?.focus();
      }}>
        {(['today', 'space'] as const).map(id => <button key={id} id={`home-tab-${id}`} role="tab" aria-selected={view === id} aria-controls={`home-panel-${id}`} tabIndex={view === id ? 0 : -1} onClick={() => selectView(id)}>{id === 'today' ? 'Today' : 'My space'}</button>)}
      </div>
      <button className="home-capture" onClick={() => newTask()}><Plus size={18}/>Add task</button>
    </div>
    <div id="home-panel-today" role="tabpanel" aria-labelledby="home-tab-today" hidden={view !== 'today'}>
      <BriefingCard key={`${snapshot.epoch}:${snapshot.deviceId}`} snapshot={snapshot} timezone={layout.timezone} appIcon={layout.appIcon} editTask={editTask} complete={complete} openAssistant={() => open('assistant')} openDraft={openDraft} openTasks={() => open('tasks')}>
        <section className="home-agenda" aria-label="Coming up">
          <HomeAppointmentWidget epoch={snapshot.epoch} deviceId={snapshot.deviceId} timezone={layout.timezone} now={now} size="compact" openCalendar={() => open('calendar')}/>
        </section>
      </BriefingCard>
      <section className="home-activity quiet-section" aria-labelledby="home-activity-title">
        <h2 id="home-activity-title">Nova activity</h2>
        {activityRead !== 'ready' && <p className="metadata" role="status">{activityRead === 'loading' ? 'Checking Assistant activity…' : 'Activity could not be refreshed. Open Assistant to check.'}</p>}
        {activity.map(op => {
          const conversation = conversations.find(c => c.id === op.conversationId)!;
          return <div className="quiet-work-row" key={op.id}>
            <span className="quiet-row-icon" aria-hidden="true"><MessageSquare size={22}/></span>
            <div className="quiet-row-copy"><strong>{conversation.title || 'Assistant conversation'}</strong><p>{op.cancelRequested ? 'Stop requested · awaiting confirmation' : labels[op.state as keyof typeof labels]}{activityRead !== 'ready' ? ' · Last known state' : ''}</p></div>
            <button onClick={() => openConversation ? openConversation(conversation) : open('assistant')}>Open activity</button>
          </div>;
        })}
        {!activity.length && <div className="quiet-work-row"><div className="quiet-row-copy"><p>{activityRead === 'ready' ? 'No active replies in the loaded Assistant activity.' : 'Your saved conversations remain in Assistant.'}</p></div><button onClick={() => open('assistant')}>Open Assistant</button></div>}
      </section>
      <section className="home-space-entry" aria-labelledby="home-space-title">
        <h2 id="home-space-title">My space</h2>
        <button className="home-space-link" onClick={() => { selectView('space'); document.getElementById('home-tab-space')?.focus(); }}>
          <span className="quiet-row-icon" aria-hidden="true"><Folder size={23}/></span>
          <span className="home-space-copy"><strong>My space</strong><small>Notes, links, and saved things.</small></span>
          <span className="home-space-open" aria-hidden="true"><ArrowRight size={20}/></span>
        </button>
      </section>
    </div>
    <div id="home-panel-space" role="tabpanel" aria-labelledby="home-tab-space" hidden={view !== 'space'}>
      {spaceOpened && <HomeSpace {...props}/>}
    </div>
  </main>;
}
