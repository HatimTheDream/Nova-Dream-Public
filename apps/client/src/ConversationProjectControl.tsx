import { assistantSpace } from '../../../packages/domain/assistant-space';
import type { Conversation } from '../../../packages/domain/assistant';
import type { Draft, Snapshot } from '../../../packages/domain/contracts';
import { ComposerMenu } from './ComposerMenu';
import { Check, Folder, Settings2 } from './icons';

export function ConversationProjectControl({ snapshot, draft, conversation, blocked, choose, settings, edit }: { snapshot: Snapshot; draft: Draft; conversation?: Conversation; blocked: boolean; choose: (id: string | null) => void; settings: () => void; edit: (id: string) => void }) {
  const projectId = conversation?.projectId ?? draft.projectId, project = snapshot.projects.find(p => p.id === projectId);
  if (conversation && !projectId && assistantSpace(conversation) === 'work') return null;
  return <ComposerMenu label={project ? `Project: ${project.value.name}` : 'Choose project'} className="conversation-project-control" placement="below" icon={<Folder size={16}/>} text={project?.value.name ?? (projectId ? 'Project unavailable' : 'Choose project')}>
    {close => <>{conversation ? <>{project && <button onClick={() => { close(); edit(project.id); }}><Settings2 size={16}/>Project settings</button>}{assistantSpace(conversation) === 'chat' && <button disabled={blocked} onClick={() => { close(); settings(); }}>Move to a project…</button>}</> : <><button disabled={blocked} onClick={() => { close(); choose(null); }}>No project{!projectId && <Check size={16}/>}</button>{snapshot.projects.filter(p => assistantSpace(p.value) === assistantSpace(draft)).map(p => <button key={p.id} disabled={blocked} onClick={() => { close(); choose(p.id); }}><Folder size={16}/><span className="preserve-case">{p.value.name}</span>{projectId === p.id && <Check size={16}/>}</button>)}{project && <button onClick={() => { close(); edit(project.id); }}><Settings2 size={16}/>Project settings</button>}</>}</>}</ComposerMenu>;
}
