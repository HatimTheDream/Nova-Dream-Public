import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, MessageSquare, Mic, MicOff, PhoneOff, Square, VolumeUp, X } from './icons';
import type { VoiceController } from './voice-controller';
import { voiceSourceLabels } from '../../../packages/domain/voice';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { NovaAssistantMark } from './NovaAssistantMark';

/** Presentation only: the workspace controller keeps audio alive across navigation. */
export function VoicePanel({ controller, openConversation, appIcon, floating = false, conversationId }: { controller: VoiceController; openConversation: (id: string) => void; appIcon: AppIconChoice; floating?: boolean; conversationId?: string | null }) {
  const voice = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); panel.current?.querySelector<HTMLButtonElement>('.voice-summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [expanded]);
  if (voice.phase === 'idle') return null;
  const finished = ['ended', 'error'].includes(voice.phase);
  const expression = voice.phase === 'connected' ? voice.speaking ? 'speaking' : voice.listening && !voice.muted ? 'listening' : 'idle' : 'idle';
  const title = finished || voice.phase === 'ending' ? 'Audio is off' : voice.speaking ? 'Speaking' : voice.muted ? 'Muted' : voice.listening ? 'Listening' : voice.processing ? 'Thinking' : voice.phase === 'connected' ? 'Voice connected' : 'Connecting';
  const otherChat = voice.attempt && voice.attempt.target.conversation.id !== conversationId;
  return <section ref={panel} className={`voice-panel voice-bubble ${floating ? 'voice-floating' : ''}`} aria-label="Voice call">
    <button className="voice-summary" aria-label="Voice call details" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} title={voice.message}>
      <NovaAssistantMark choice={appIcon} expression={expression} className="voice-assistant-mark" width="44" height="44"/><span><strong role="status">{title}</strong>{otherChat ? <small>{voice.attempt!.target.conversation.title}</small> : null}</span><ChevronDown size={14}/>
    </button>
    <div className="voice-controls">
      {!finished && <><button className={`voice-mute ${voice.muted ? 'is-muted' : ''}`} aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voice.muted} title={voice.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={controller.mute}>{voice.muted ? <MicOff size={20}/> : <Mic size={20}/>}</button>{voice.soundBlocked ? <button aria-label="Enable sound" title="Enable sound" onClick={() => void controller.enableSound()}><VolumeUp size={20}/></button> : <button aria-label="Interrupt speech" title="Interrupt speech" disabled={!voice.speaking && !voice.processing} onClick={controller.interrupt}><Square size={18}/></button>}<button className="voice-end" aria-label="End voice call" title="End call" onClick={() => void controller.end()}><PhoneOff size={20}/></button></>}
      {finished && <button aria-label={voice.unsaved ? 'Retry saving voice captions' : 'Close voice call'} title={voice.unsaved ? 'Retry saving captions' : 'Close voice call'} onClick={() => void controller.recover()}>{voice.unsaved ? <RotateSave/> : <X size={20}/>}</button>}
    </div>
    {expanded && <div className="voice-details"><div className="voice-status"><p>{voice.message}</p>{voice.soundBlocked && <button onClick={() => void controller.enableSound()}><VolumeUp size={16}/>Enable sound</button>}{voice.unsaved > 0 && <p className="metadata">{voice.unsaved} caption{voice.unsaved === 1 ? '' : 's'} awaiting history save</p>}</div>
      {voice.attempt && <button className="voice-conversation" onClick={() => { openConversation(voice.attempt!.target.conversation.id); setExpanded(false); }}><MessageSquare size={15}/><span>{voice.attempt.target.conversation.title}</span></button>}
      {!!voice.attempt?.target.memory?.entries.length && <details className="voice-sources"><summary>Memories · {voice.attempt.target.memory.entries.length}</summary>{voice.attempt.target.memory.entries.map(entry => <p className="preserve-lines" key={entry.id}>{entry.text}</p>)}<p className="metadata">Captured when this call started.</p></details>}
      {!!voice.attempt?.sources?.length && <details className="voice-sources"><summary>Sources · {voice.attempt.sources.length}</summary>{voice.attempt.sources.map(source => <p className="metadata" key={source.file.id}><a href={`/api/attachments/${source.file.id}`}>{source.file.name}</a> · {source.origin === 'refinement' ? 'Original output · ' : ''}{voiceSourceLabels[source.state]}</p>)}</details>}
    </div>}
  </section>;
}
function RotateSave() { return <span className="voice-retry-label">Retry save</span>; }
