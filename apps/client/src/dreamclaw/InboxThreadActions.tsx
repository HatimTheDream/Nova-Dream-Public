import { ComposerMenu } from '../ComposerMenu';
import { Ban, Flag, FlagOff, MoreHorizontal, Pin, PinOff, ReplyAll, Trash2, Undo, Unblock, Unsubscribe } from './components/icons';

type ThreadActions = {
  pinned: boolean;
  flagged: boolean;
  canModify: boolean;
  busy: boolean;
  inTrash: boolean;
  onPin(): void;
  onFlag(): void;
  onDelete(): void;
  onRestore?(): void;
};

/** Nova uses one flag; the reviewed mail service maps it to each provider. */
export function InboxRowActions({ pinned, flagged, canModify, busy, inTrash, onPin, onFlag, onDelete, onRestore }: ThreadActions) {
  return <div className="dc-mail-row-actions" aria-label="Conversation actions">
    <button type="button" onClick={onFlag} disabled={!canModify || busy} data-mail-flag={flagged ? 'active' : 'available'} aria-pressed={flagged} aria-label={flagged ? 'Remove flag' : 'Flag thread'} title={flagged ? 'Remove flag' : 'Flag thread'}><Flag size={14} /></button>
    <button type="button" onClick={onPin} data-pinned={pinned ? 'true' : 'false'} aria-pressed={pinned} aria-label={pinned ? 'Unpin thread' : 'Pin thread'} title={pinned ? 'Unpin thread' : 'Pin thread'}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
    <button type="button" onClick={inTrash ? onRestore : onDelete} disabled={!canModify || busy || inTrash && !onRestore} aria-label={inTrash ? 'Restore Thread' : 'Delete thread'} title={inTrash ? 'Review Restore To Original Folder' : 'Move To Trash'}>{inTrash ? <Undo size={14}/> : <Trash2 size={14}/>}</button>
  </div>;
}

export function InboxReaderFlag({flagged,canModify,busy,onFlag,className}:{flagged:boolean;canModify:boolean;busy:boolean;onFlag():void;className:string}){
  return <button type="button" disabled={!canModify||busy} onClick={onFlag} aria-pressed={flagged}
    aria-label={flagged?'Remove Flag':'Flag Thread'} title={flagged?'Remove Flag':'Flag Thread'} className={className}><Flag size={12}/></button>;
}

type Props = ThreadActions & {
  canReply: boolean;
  onReplyAll(): void;
  sender: { loading: boolean; canManage?: boolean; blocked?: boolean; error?: string };
  onSender(action: 'unsubscribe' | 'block-sender' | 'unblock-sender'): void;
};

export function InboxThreadMenu({ pinned, flagged, canModify, busy, inTrash, onPin, onFlag, onDelete, onRestore, canReply, onReplyAll, sender, onSender }: Props) {
  return <ComposerMenu label="More Actions" panelLabel="Email Actions" kind="menu" placement="below" align="right" icon={<MoreHorizontal size={16} />} className="dc-inbox-thread-menu">{close => <div className="dc-inbox-action-menu">
    <button role="menuitem" type="button" onClick={() => { onPin(); close(); }}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}<span>{pinned ? 'Unpin thread' : 'Pin thread'}</span></button>
    <button role="menuitem" type="button" disabled={!canModify || busy} onClick={() => { onFlag(); close(); }}>{flagged ? <FlagOff size={16} /> : <Flag size={16} />}<span>{flagged ? 'Remove flag' : 'Flag thread'}</span></button>
    <button role="menuitem" type="button" disabled={!canReply} onClick={() => { onReplyAll(); close(); }}><ReplyAll size={16} /><span>Reply All</span></button>
    <button role="menuitem" type="button" disabled={!canModify || busy || inTrash && !onRestore} onClick={() => { if(inTrash)onRestore?.();else onDelete(); close(); }}>{inTrash ? <Undo size={16}/> : <Trash2 size={16}/>}<span>{inTrash ? 'Restore To Original Folder' : 'Move To Trash'}</span></button>
    {sender.canManage === true ? <>
      <hr />
      <button role="menuitem" type="button" disabled={busy || sender.loading} onClick={() => { onSender('unsubscribe'); close(); }}><Unsubscribe size={16} /><span>Unsubscribe From Sender</span></button>
      <button role="menuitem" type="button" disabled={busy || sender.loading} onClick={() => { onSender(sender.blocked ? 'unblock-sender' : 'block-sender'); close(); }}>{sender.blocked ? <Unblock size={16} /> : <Ban size={16} />}<span>{sender.blocked ? 'Unblock Sender' : 'Block Future Mail'}</span></button>
    </> : <p>{sender.loading ? 'Checking sender actions…' : 'Unsubscribe and sender blocking aren’t available for this connection yet.'}</p>}
    {!canModify && <p>This connection can read mail. Reconnect it in Settings to allow changes.</p>}
  </div>}</ComposerMenu>;
}
