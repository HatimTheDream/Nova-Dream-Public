import type { Conversation } from '../../../packages/domain/assistant';
import { ComposerMenu } from './ComposerMenu';
import { Check, History } from './icons';
import { relatedConversations } from './conversation-versions';

export function ConversationVersions({ conversation, conversations, open }: { conversation: Conversation; conversations: Conversation[]; open: (conversation: Conversation) => void }) {
  const versions = relatedConversations(conversation, conversations);
  if (versions.length < 2) return null;
  return <ComposerMenu className="conversation-versions" label="Conversation versions" icon={<History size={17}/>} text={<span>{versions.findIndex(c => c.id === conversation.id) + 1} / {versions.length}</span>} align="right" placement="below">{close => <VersionList conversation={conversation} conversations={conversations} open={item => { close(); open(item); }}/>}</ComposerMenu>;
}
export function VersionList({ conversation, conversations, open }: { conversation: Conversation; conversations: Conversation[]; open: (conversation: Conversation) => void }) {
  const versions = relatedConversations(conversation, conversations);
  return <><span className="eyebrow">Conversation versions</span>{versions.map(item => <button key={item.id} aria-current={item.id === conversation.id ? 'true' : undefined} disabled={item.deleted || item.state !== 'ready'} onClick={() => { if (item.id !== conversation.id) open(item); }}><span>{!item.forkSource ? 'Original' : item.forkSource.purpose === 'edit' ? 'Edited message' : item.forkSource.purpose === 'retry' ? 'Alternate response' : 'Branch'}<small>{item.title}{item.deleted ? ' · Deleted' : item.archived ? ' · Archive' : item.state !== 'ready' ? ' · Needs status check' : ''}</small></span>{item.id === conversation.id && <Check size={16}/>}</button>)}{versions[0]?.forkSource && <p className="metadata">The earlier history for this branch is unavailable.</p>}<p className="metadata">Each version keeps its own messages and draft.</p></>;
}
