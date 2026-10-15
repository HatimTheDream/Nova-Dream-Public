import { useEffect, useRef, useState } from 'react';
import type { AssistantOperation, Conversation } from '../../../packages/domain/assistant';
import type { HomeFeedTarget } from '../../../packages/domain/home-feed';
import { HomeSpace, type HomeSpaceProps } from './HomeSpace';
import { HomeLibrary, useHomeLibrary, type HomeSourceActions } from './HomeLibrary';
import { HomeIdeas } from './HomeIdeas';
import { HomeFeed } from './HomeFeed';
import { BriefingCard } from './BriefingCard';
import { HomeAppointmentWidget } from './HomeAppointmentWidget';
import { ArrowLeft } from './icons';
import { readLocal, saveLocal } from './api';
import './home-library.css';

type View = 'library' | 'ideas' | 'feed';
type Props = HomeSpaceProps & HomeSourceActions & {
 openDraft?: (id: string) => void; openConversation?: (conversation: Conversation) => void;
 operations?: AssistantOperation[]; conversations?: Conversation[]; activityRead?: 'loading' | 'ready' | 'error';
 openFeedTarget?: (target: HomeFeedTarget) => void;
};
export function Home(props: Props) {
 const key = `e3:home-view:${props.snapshot.deviceId}`, kept = readLocal<string>(key);
 const [view, setView] = useState<View>(() => ['library', 'ideas', 'feed'].includes(kept ?? '') ? kept as View : 'library'), [widgets, setWidgets] = useState(false), [now, setNow] = useState(Date.now());
 const controller = useHomeLibrary(props.snapshot), tabs = useRef(new Map<View, HTMLButtonElement>());
 useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000);return () => clearInterval(timer); }, []);
 const select = (next: View) => { setView(next);setWidgets(false);saveLocal(key, next); };
 return <main className="home-page home-quiet home-approved page-scroll" aria-label="Home" data-reorder-scroll>
  <nav className="home-view-tabs" role="tablist" aria-label="Home Views" onKeyDown={e => { const ids: View[] = ['library', 'ideas', 'feed'], index = ids.indexOf(view), next = e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[2] : e.key === 'ArrowRight' ? ids[(index + 1) % 3] : e.key === 'ArrowLeft' ? ids[(index + 2) % 3] : null;if (next) { e.preventDefault();select(next);tabs.current.get(next)?.focus(); } }}>{(['library', 'ideas', 'feed'] as const).map(id => <button key={id} type="button" id={`home-tab-${id}`} role="tab" aria-selected={view === id} aria-controls={`home-panel-${id}`} tabIndex={view === id ? 0 : -1} ref={node => { if (node) tabs.current.set(id, node);else tabs.current.delete(id); }} onClick={() => select(id)}>{id[0].toUpperCase() + id.slice(1)}</button>)}</nav>
  <div id="home-panel-library" role="tabpanel" aria-labelledby="home-tab-library" hidden={view !== 'library'}>{widgets ? <><button className="text-button" onClick={() => setWidgets(false)}><ArrowLeft size={16}/>Library</button><section className="home-kept-overview"><h1>Today And Widgets</h1><BriefingCard snapshot={props.snapshot} timezone={props.layout.timezone} appIcon={props.layout.appIcon} editTask={props.editTask} complete={props.complete} openAssistant={() => props.open('assistant')} openDraft={props.openDraft} openTasks={() => props.open('tasks')}><HomeAppointmentWidget epoch={props.snapshot.epoch} deviceId={props.snapshot.deviceId} timezone={props.layout.timezone} now={now} size="compact" openCalendar={() => props.open('calendar')}/></BriefingCard></section><HomeSpace {...props}/></> : <HomeLibrary snapshot={props.snapshot} controller={controller} openWidgets={() => setWidgets(true)} onAssistantHandoff={props.onAssistantHandoff} openResource={props.openResource}/>}</div>
  <div id="home-panel-ideas" role="tabpanel" aria-labelledby="home-tab-ideas" hidden={view !== 'ideas'}>{view === 'ideas' && <HomeIdeas snapshot={props.snapshot} controller={controller} onAssistantHandoff={props.onAssistantHandoff}/>}</div>
  <div id="home-panel-feed" role="tabpanel" aria-labelledby="home-tab-feed" hidden={view !== 'feed'}>{view === 'feed' && <HomeFeed snapshot={props.snapshot} onAssistantHandoff={props.onAssistantHandoff} openFeedTarget={props.openFeedTarget}/>}</div>
 </main>;
}
