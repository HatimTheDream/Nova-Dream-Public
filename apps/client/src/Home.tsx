import { useEffect, useRef, useState } from 'react';
import type { AssistantOperation, Conversation } from '../../../packages/domain/assistant';
import type { HomeFeedTarget } from '../../../packages/domain/home-feed';
import type { HomeSpaceProps } from './HomeSpace';
import { HomeLibrary, useHomeLibrary, type HomeSourceActions } from './HomeLibrary';
import { HomeIdeas } from './HomeIdeas';
import { HomeFeed } from './HomeFeed';
import { HomeToday, type HomeTaskActions } from './HomeToday';
import { mayLeaveHomeDraft } from './home-draft-navigation';
import { readLocal, saveLocal } from './api';
import './home-library.css';

type View = 'today' | 'library' | 'ideas' | 'feed';
const views: View[] = ['today', 'library', 'ideas', 'feed'];
type Props = HomeSpaceProps & HomeSourceActions & {
 openDraft?: (id: string) => void; openConversation?: (conversation: Conversation) => void;
 operations?: AssistantOperation[]; conversations?: Conversation[]; activityRead?: 'loading' | 'ready' | 'error';
 openFeedTarget?: (target: HomeFeedTarget) => void;
 taskActions?: HomeTaskActions;
};
export function Home(props: Props) {
 const key = `e3:home-view:${props.snapshot.deviceId}`, scope = `${props.snapshot.epoch}:${props.snapshot.deviceId}`;
 const restore = () => { const kept = readLocal<string>(key);return { scope, view: views.includes(kept as View) ? kept as View : 'library' as View }; };
 const [kept, setKept] = useState(restore), [error, setError] = useState('');
 const view = kept.scope === scope ? kept.view : restore().view;
 const owner = useRef({ scope, mounted: true });owner.current.scope = scope;
 const controller = useHomeLibrary(props.snapshot), tabs = useRef(new Map<View, HTMLButtonElement>());
 useEffect(() => { owner.current.mounted = true;return () => { owner.current.mounted = false; }; }, [scope]);
 useEffect(() => { if (kept.scope !== scope) { setKept(restore());setError(''); } }, [scope, kept.scope]);
 const current = () => owner.current.mounted && owner.current.scope === scope;
 const select = (next: View) => {
  if (!current() || !mayLeaveHomeDraft()) return false;
  if (!saveLocal(key, next)) { setError('Free browser storage before changing Home views. Your current view and writing stay open.');return false; }
  setKept({ scope, view: next });setError('');return true;
 };
 const leave = (next: () => void) => { if (current() && mayLeaveHomeDraft()) next(); };
 const handoff: HomeSourceActions['onAssistantHandoff'] = props.onAssistantHandoff ? async incoming => {
  if (!current() || !mayLeaveHomeDraft()) throw Error('Keep the current Home writing before opening Assistant.');
  await props.onAssistantHandoff!(incoming);
 } : undefined;
 return <main className="home-page home-quiet home-approved page-scroll" aria-label="Home" data-reorder-scroll>
  <nav className="home-view-tabs" role="tablist" aria-label="Home Views" onKeyDown={e => { const index = views.indexOf(view), next = e.key === 'Home' ? views[0] : e.key === 'End' ? views.at(-1) : e.key === 'ArrowRight' ? views[(index + 1) % views.length] : e.key === 'ArrowLeft' ? views[(index + views.length - 1) % views.length] : null;if (next) { e.preventDefault();if (select(next)) tabs.current.get(next)?.focus(); } }}>{views.map(id => <button className="compact-action" key={id} type="button" id={`home-tab-${id}`} role="tab" aria-selected={view === id} aria-controls={`home-panel-${id}`} tabIndex={view === id ? 0 : -1} ref={node => { if (node) tabs.current.set(id, node);else tabs.current.delete(id); }} onClick={() => select(id)}>{id[0].toUpperCase() + id.slice(1)}</button>)}</nav>
  {error && <p role="alert">{error}</p>}
  <div id="home-panel-today" role="tabpanel" aria-labelledby="home-tab-today" hidden={view !== 'today'}><HomeToday snapshot={props.snapshot} actions={props.taskActions} editTask={task => leave(() => props.editTask(task))} openTasks={() => leave(() => props.open('tasks'))} openLibrary={() => select('library')} openIdeas={() => select('ideas')}/></div>
  <div id="home-panel-library" role="tabpanel" aria-labelledby="home-tab-library" hidden={view !== 'library'}><HomeLibrary snapshot={props.snapshot} controller={controller} onAssistantHandoff={handoff} openResource={props.openResource ? reference => leave(() => props.openResource!(reference)) : undefined}/></div>
  <div id="home-panel-ideas" role="tabpanel" aria-labelledby="home-tab-ideas" hidden={view !== 'ideas'}>{view === 'ideas' && <HomeIdeas snapshot={props.snapshot} controller={controller} onAssistantHandoff={handoff} {...{ openDraft: props.openDraft ? (id: string) => leave(() => props.openDraft!(id)) : undefined }}/>}</div>
  <div id="home-panel-feed" role="tabpanel" aria-labelledby="home-tab-feed" hidden={view !== 'feed'}>{view === 'feed' && <HomeFeed snapshot={props.snapshot} onAssistantHandoff={handoff} openFeedTarget={props.openFeedTarget ? target => leave(() => props.openFeedTarget!(target)) : undefined}/>}</div>
 </main>;
}
