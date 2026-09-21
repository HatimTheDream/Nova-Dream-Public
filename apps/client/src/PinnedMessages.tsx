import { useState } from 'react';
import type { MessagePin } from '../../../packages/domain/message-pins';
import { ComposerMenu } from './ComposerMenu';
import { Pin, X } from './icons';

type Props = { pins: MessagePin[]; open: (pin: MessagePin) => void; remove: (pin: MessagePin) => Promise<void> };
export function PinnedMessages({ pins, open, remove }: Props) {
  if (!pins.length) return null;
  return <ComposerMenu className="pinned-message-menu" label="Pinned messages" icon={<Pin size={18}/>} align="right" placement="below">{close => <PinnedMessageList pins={pins} open={pin => { close(); open(pin); }} remove={remove}/>}</ComposerMenu>;
}
export function PinnedMessageList({ pins, open, remove }: Props) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  if (!pins.length) return null;
  return <><span className="eyebrow">Pinned messages</span>{pins.map(pin => <div className="pinned-message-row" key={pin.id}><button className="preserve-case" onClick={() => open(pin)}><span>{pin.excerpt || 'Attached message'}<small>{pin.role === 'assistant' ? 'Reply' : 'Your message'}</small></span></button><button className="icon-button" aria-label={`Unpin ${pin.role === 'assistant' ? 'reply' : 'message'}`} disabled={!!busy} onClick={() => { setError(''); setBusy(pin.id); void remove(pin).catch(e => setError(e instanceof Error ? e.message : 'The pin was not confirmed.')).finally(() => setBusy('')); }}><X size={16}/></button></div>)}{error && <p role="alert" className="field-error">{error}</p>}</>;
}
