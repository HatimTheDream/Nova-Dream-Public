import { useState, type ReactNode } from 'react';
import { Copy, MoreHorizontal } from './icons';
import { ComposerMenu } from './ComposerMenu';
import { Dialog } from './ui';
import { ReplyText } from './ReplyText';
import { transcriptParts, transcriptText, type TranscriptMessage } from './voice-transcript';

/** A display group, never a replacement native message or a new send. */
export function VoiceMessage({ message, renderPart }: { message: TranscriptMessage; renderPart?: (part: TranscriptMessage, index: number) => ReactNode }) {
  const [notice, setNotice] = useState(''), [details, setDetails] = useState(false);
  const parts = transcriptParts(message), saved = parts.filter(part => !part.pendingVoice);
  return <article aria-label={`${message.role} message`} className={`chat-message message-${message.role} ${message.streaming ? 'live-message' : ''}`} id={details ? undefined : `message-${message.id}`}>
    <ReplyText text={transcriptText(message)} role={message.role} streaming={!!message.streaming}/>
    {message.unconfirmed && <span className="metadata">Unconfirmed Transcription{message.retainedVoice && ' · Kept On This Device'}</span>}
    {renderPart && <div className="message-actions"><button className="icon-button" aria-label="Copy message" title="Copy message" onClick={() => void navigator.clipboard.writeText(transcriptText(message)).then(() => setNotice('Copied')).catch(() => setNotice('Copy was unavailable. Select the text to copy it.'))}><Copy size={16}/></button>
      {saved.length > 0 && <ComposerMenu label="Voice message actions" placement="below" icon={<MoreHorizontal size={16}/>}>{close => <button onClick={() => { close(); setDetails(true); }}>Original message parts</button>}</ComposerMenu>}
      {notice && <span className="metadata" role="status">{notice}</span>}
    </div>}
    {details && renderPart && <Dialog title="Original message parts" close={() => setDetails(false)}><p className="metadata">This spoken message has {saved.length} saved part{saved.length === 1 ? '' : 's'}. You can edit, branch or pin each original part here.</p><div className="voice-message-parts">{saved.map((part, index) => <section key={part.id} aria-label={`Message part ${index + 1}`}><span className="metadata">Part {index + 1}</span>{renderPart(part, index)}</section>)}</div></Dialog>}
  </article>;
}
