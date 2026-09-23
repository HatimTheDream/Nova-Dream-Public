import { ComposerMenu } from '../ComposerMenu';
import { Ban, Flag, FlagOff, MoreHorizontal, Pin, PinOff, ReplyAll, Trash2, Unblock, Unsubscribe } from './components/icons';

type ThreadActions = {
  pinned: boolean;
  flagged: boolean;
  canModify: boolean;
  busy: boolean;
  inTrash: boolean;
  onPin(): void;
  onFlag(): void;
  onDelete(): void;
};

/** Nova uses one flag; the reviewed mail service maps it to each provider. */
export function InboxRowActions({ pinned, flagged, canModify, busy, inTrash, onPin, onFlag, onDelete }: ThreadActions) {
  return <div className="dc-mail-row-actions" aria-label="Conversation actions">
    <button type="button" onClick={onFlag} disabled={!canModify || busy} data-mail-flag={flagged ? 'active' : 'available'} aria-pressed={flagged} aria-label={flagged ? 'Remove flag' : 'Flag thread'} title={flagged ? 'Remove flag' : 'Flag thread'}><Flag size={14} /></button>
    <button type="button" onClick={onPin} data-pinned={pinned ? 'true' : 'false'} aria-pressed={pinned} aria-label={pinned ? 'Unpin thread' : 'Pin thread'} title={pinned ? 'Unpin thread' : 'Pin thread'}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
    <button type="button" onClick={onDelete} disabled={!canModify || busy || inTrash} aria-label="Delete thread" title={inTrash ? 'Already in Trash' : 'Move to Trash'}><Trash2 size={14} /></button>
  </div>;
}

type Props = ThreadActions & {
  canReply: boolean;
  onReplyAll(): void;
  sender: { loading: boolean; canManage?: boolean; blocked?: boolean; error?: string };
  onSender(action: 'unsubscribe' | 'block-sender' | 'unblock-sender'): void;
};

export function InboxThreadMenu({ pinned, flagged, canModify, busy, inTrash, onPin, onFlag, onDelete, canReply, onReplyAll, sender, onSender }: Props) {
  return <ComposerMenu label="More actions" panelLabel="Email actions" kind="menu" placement="below" align="right" icon={<MoreHorizontal size={16} />} className="dc-inbox-thread-menu">{close => <div className="dc-inbox-action-menu">
    <button role="menuitem" type="button" onClick={() => { onPin(); close(); }}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}<span>{pinned ? 'Unpin thread' : 'Pin thread'}</span></button>
    <button role="menuitem" type="button" disabled={!canModify || busy} onClick={() => { onFlag(); close(); }}>{flagged ? <FlagOff size={16} /> : <Flag size={16} />}<span>{flagged ? 'Remove flag' : 'Flag thread'}</span></button>
    <button role="menuitem" type="button" disabled={!canReply} onClick={() => { onReplyAll(); close(); }}><ReplyAll size={16} /><span>Reply all</span></button>
    <button role="menuitem" type="button" disabled={!canModify || busy || inTrash} onClick={() => { onDelete(); close(); }}><Trash2 size={16} /><span>Move to Trash</span></button>
    {sender.canManage === true ? <>
      <hr />
      <button role="menuitem" type="button" disabled={busy || sender.loading} onClick={() => { onSender('unsubscribe'); close(); }}><Unsubscribe size={16} /><span>Unsubscribe from sender</span></button>
      <button role="menuitem" type="button" disabled={busy || sender.loading} onClick={() => { onSender(sender.blocked ? 'unblock-sender' : 'block-sender'); close(); }}>{sender.blocked ? <Unblock size={16} /> : <Ban size={16} />}<span>{sender.blocked ? 'Unblock sender' : 'Block future mail'}</span></button>
    </> : <p>{sender.loading ? 'Checking sender actions…' : 'Unsubscribe and sender blocking aren’t available for this connection yet.'}</p>}
    {!canModify && <p>This connection can read mail. Reconnect it in Settings to allow changes.</p>}
  </div>}</ComposerMenu>;
}
