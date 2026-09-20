import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { MessageSquare, Mic, MicOff, PhoneOff, Square, VolumeUp, X } from './icons';
import type { VoiceController } from './voice-controller';
import { voiceSourceLabels } from '../../../packages/domain/voice';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { NovaAssistantMark, type AssistantExpression } from './NovaAssistantMark';

/** Presentation only: the workspace controller keeps audio alive across navigation. */
export function VoicePanel({ controller, openConversation, appIcon, floating = false, conversationId }: { controller: VoiceController; openConversation: (id: string) => void; appIcon: AppIconChoice; floating?: boolean; conversationId?: string | null }) {
  const voice = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (voice.phase === 'error') setExpanded(true);
    else if (voice.phase === 'idle') setExpanded(false);
  }, [voice.phase]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); panel.current?.querySelector<HTMLButtonElement>('.voice-summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [expanded]);
  if (voice.phase === 'idle') return null;
  const finished = ['ended', 'error'].includes(voice.phase);
  const connecting = ['permission', 'preparing', 'connecting'].includes(voice.phase);
  // The controller's listening flag means detected speech. An open, ready mic
  // should also look attentive during the silence before the next turn.
  const expression = voice.phase === 'connected' ? voice.speaking ? 'speaking' : !voice.muted && !voice.processing ? 'listening' : 'idle' : 'idle';
  const title = finished || voice.phase === 'ending' ? 'Audio is off' : connecting ? 'Connecting' : voice.speaking ? 'Speaking' : voice.muted ? 'Muted' : voice.processing ? 'Thinking' : 'Listening';
  const otherChat = voice.attempt && voice.attempt.target.conversation.id !== conversationId;
  return <section ref={panel} className={`voice-panel voice-bubble ${floating ? 'voice-floating' : ''}`} aria-label="Voice call">
    <span className="sr-only" role="status">{title}{otherChat ? ` · ${voice.attempt!.target.conversation.title}` : ''}</span>
    <VoiceActivityMark controller={controller} appIcon={appIcon} expression={expression} connecting={connecting} expanded={expanded} title={`${title} · ${voice.message}`} toggle={() => setExpanded(value => !value)}/>
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
/** Only the artwork subscribes to audio levels; transcript and call controls do not rerender per sample. */
function VoiceActivityMark({ controller, appIcon, expression, connecting, expanded, title, toggle }: { controller: VoiceController; appIcon: AppIconChoice; expression: AssistantExpression; connecting: boolean; expanded: boolean; title: string; toggle: () => void }) {
  const levels = useSyncExternalStore(controller.subscribeLevels, controller.getLevelsSnapshot);
  const level = connecting ? 0 : expression === 'speaking' ? levels.output : expression === 'listening' ? levels.input : 0;
  return <button className={`voice-summary${connecting ? ' is-connecting' : ''}`} data-expression={connecting ? 'connecting' : expression} style={{ '--voice-level': level } as CSSProperties} aria-label="Voice call details" aria-expanded={expanded} onClick={toggle} title={title}>
    {connecting ? <span className="voice-connection-pulse" aria-hidden="true"/> : <span className="voice-expression" aria-hidden="true">
      <NovaAssistantMark choice={appIcon} expression={expression} className="voice-assistant-mark" width="104" height="104"/>
      {expression === 'listening' && <svg className="voice-listening-cue" viewBox="-18 -6 136 112" fill="none" focusable="false" aria-hidden="true">
        <path className="voice-ear-wave" d="M-1 16Q-9 28-1 40M101 16Q109 28 101 40"/>
        <path className="voice-ear-wave voice-ear-wave-outer" d="M-8 9Q-20 28-8 47M108 9Q120 28 108 47"/>
      </svg>}
    </span>}
  </button>;
}
function RotateSave() { return <span className="voice-retry-label">Retry save</span>; }
