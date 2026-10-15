import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createMascotAppearance, editableMascotAppearance, mascotOptions, resolveMascotAppearance, type MascotAppearance } from '../../../../../packages/domain/mascot-appearance';
import { readLocal, saveLocal } from '../../api';
import { MascotSvg } from './MascotSvg';
import { creatorChoices, creatorColors, creatorLabels as labels, creatorPresets, normalizeCreatorLocks, shuffleCreatorAppearance, type CreatorChoice, type CreatorColor, type CreatorLocks } from './creator-state';
import './mascot-creator.css';

type AppearanceValue = Record<string, unknown> | null;
export interface SquareLynxCreatorProps {
 value: AppearanceValue;
 change: (value: AppearanceValue) => void;
 name: string;
 /** The actual saved record, independent of a recovered or unsaved parent draft. */
 savedValue?: AppearanceValue;
 onSaveLook?: (appearance: AppearanceValue) => void | Promise<void>;
 onCancelLook?: () => void;
 saveDisabled?: boolean;
 saving?: boolean;
 saveLabel?: string;
 /** Device-local shuffle preferences, scoped by workspace and record by the owner. */
 preferenceKey?: string;
}
type Expression = 'idle' | 'listening' | 'speaking';
type History = { past: AppearanceValue[]; future: AppearanceValue[] };
const rowColors: Record<CreatorChoice, readonly CreatorColor[]> = { face:['fur','eyes'], pattern:['markings'], outfit:['clothing','accent'], glasses:['glassesColor'] };
const equal=(a: unknown,b: unknown)=>JSON.stringify(a)===JSON.stringify(b);
const copy=(value: AppearanceValue): AppearanceValue=>value===null?null:JSON.parse(JSON.stringify(value)) as Record<string,unknown>;
const recipe=(a: MascotAppearance): AppearanceValue=>({...createMascotAppearance(a)});
const hex=/^#[0-9a-f]{6}$/i;
function Icon({ kind }: {kind:'undo'|'redo'|'lock'|'unlock'|'shuffle'|'previous'|'next'|'close'}) {
 return <svg className="mc-icon" viewBox="0 0 24 24" aria-hidden="true">
 {kind==='undo'&&<path d="M8 5 3 10l5 5M3 10h10a7 7 0 0 1 7 7"/>}
 {kind==='redo'&&<path d="m16 5 5 5-5 5m5-5H11a7 7 0 0 0-7 7"/>}
 {(kind==='lock'||kind==='unlock')&&<><rect x="5" y="10" width="14" height="11" rx="3"/><path d={kind==='lock'?'M8 10V7a4 4 0 0 1 8 0v3m-4 5v2':'M8 10V7a4 4 0 0 1 7.5-2m-3.5 10v2'}/></>}
 {kind==='shuffle'&&<path d="m17 3 4 4-4 4m4-4h-3c-6 0-6 10-12 10H3m14-4 4 4-4 4m4-4h-3c-6 0-6-10-12-10H3"/>}
 {kind==='previous'&&<path d="m14 6-6 6 6 6"/>}{kind==='next'&&<path d="m10 6 6 6-6 6"/>}{kind==='close'&&<path d="m6 6 12 12M18 6 6 18"/>}
 </svg>;
}
/** Only deliberate appearance edits reach the containing retained record draft. */
export function SquareLynxCreator({value,change,name,savedValue=null,onSaveLook,onCancelLook,saveDisabled=false,saving=false,saveLabel='Save Look',preferenceKey}:SquareLynxCreatorProps) {
 const id=useId();
 const host=useRef<HTMLElement>(null), panel=useRef<HTMLDivElement>(null);
 const triggers=useRef<Partial<Record<CreatorColor,HTMLButtonElement>>>({});
 const [expression,setExpression]=useState<Expression>('idle');
 const [preview,setPreview]=useState<'saved'|'editing'>('editing');
 const [locks,setLocks]=useState<CreatorLocks>(()=>normalizeCreatorLocks(preferenceKey?readLocal(preferenceKey):null));
 const [activeColor,setActiveColor]=useState<CreatorColor|null>(null);
 const [position,setPosition]=useState<CSSProperties>({left:8,top:8});
 const [announcement,announce]=useState('');
 const [history,setHistory]=useState<History>({past:[],future:[]});
 const historyRef=useRef(history), valueRef=useRef(value), emittedKey=useRef<string|undefined>(undefined);
 valueRef.current=value;
 const valueKey=JSON.stringify(value), previousKey=useRef(valueKey);
 const colorBefore=useRef<{value:AppearanceValue}|null>(null);
 const appearance=editableMascotAppearance(value);
 const shown=preview==='saved'?editableMascotAppearance(savedValue):appearance;
 const resolution=resolveMascotAppearance(value);
 const updateHistory=(next:History)=>{historyRef.current=next;setHistory(next);};
 useEffect(()=>{if(previousKey.current===valueKey)return;previousKey.current=valueKey;if(emittedKey.current!==valueKey){colorBefore.current=null;updateHistory({past:[],future:[]});}emittedKey.current=undefined;},[valueKey]);
 useEffect(()=>{setLocks(normalizeCreatorLocks(preferenceKey?readLocal(preferenceKey):null));},[preferenceKey]);
 const emit=(next:AppearanceValue)=>{emittedKey.current=JSON.stringify(next);valueRef.current=next;change(next);setPreview('editing');};
 const remember=(prior:AppearanceValue)=>updateHistory({past:[...historyRef.current.past,copy(prior)].slice(-60),future:[]});
 const finishColor=()=>{const before=colorBefore.current;colorBefore.current=null;if(before&&!equal(before.value,valueRef.current))remember(before.value);};
 const commit=(next:AppearanceValue,message:string)=>{finishColor();if(!equal(next,valueRef.current)){remember(valueRef.current);emit(next);}announce(message);};
 const pick=(patch:Partial<MascotAppearance>,message:string)=>commit(recipe({...editableMascotAppearance(valueRef.current),...patch}),message);
 const closeColor=(focus=true)=>{finishColor();setActiveColor(null);if(focus&&activeColor)triggers.current[activeColor]?.focus();};
 const undo=()=>{finishColor();const {past,future}=historyRef.current;if(!past.length)return;updateHistory({past:past.slice(0,-1),future:[...future,copy(valueRef.current)]});emit(copy(past[past.length-1]));announce('Change undone.');};
 const redo=()=>{finishColor();const {past,future}=historyRef.current;if(!future.length)return;updateHistory({past:[...past,copy(valueRef.current)].slice(-60),future:future.slice(0,-1)});emit(copy(future[future.length-1]));announce('Change redone.');};
 const toggleLock=(key:keyof CreatorLocks)=>{const next={...locks,[key]:!locks[key]};setLocks(next);if(preferenceKey)saveLocal(preferenceKey,next);announce(`${labels[key]} ${next[key]?'locked':'unlocked'} for Shuffle.`);};
 const lockButton=(key:keyof CreatorLocks,color=false)=><button type="button" className={`mc-lock${color?' mc-color-lock':''}`} aria-pressed={locks[key]} aria-label={`${locks[key]?'Unlock':'Lock'} ${labels[key]} ${color?'Color':'Style'} For Shuffle`} title={`${locks[key]?'Unlock':'Lock'} ${labels[key]} For Shuffle`} onClick={()=>toggleLock(key)}><Icon kind={locks[key]?'lock':'unlock'}/></button>;
 const cycle=(key:CreatorChoice,direction:number)=>{closeColor(false);const choices:readonly string[]=mascotOptions[key];const index=(choices.indexOf(appearance[key])+direction+choices.length)%choices.length;pick({[key]:choices[index]} as Partial<MascotAppearance>,choices[index]==='none'?'No Glasses.':`${labels[key]} ${key==='glasses'?index:index+1}: ${labels[choices[index]]}.`);};
 const updateColor=(key:CreatorColor,color:string)=>{if(!hex.test(color))return;if(!colorBefore.current)colorBefore.current={value:copy(valueRef.current)};emit(recipe({...editableMascotAppearance(valueRef.current),[key]:color.toLowerCase()}));};
 useLayoutEffect(()=>{
  if(!activeColor)return;
  const place=()=>{const target=triggers.current[activeColor]?.getBoundingClientRect(), popup=panel.current?.getBoundingClientRect();if(!target||!popup)return;setPosition({left:Math.max(4,Math.min(target.left,window.innerWidth-popup.width-4)),top:Math.max(4,Math.min(target.bottom+6,window.innerHeight-popup.height-4))});};
  place();const observer=new ResizeObserver(place);if(host.current)observer.observe(host.current);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  const selected=panel.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')??panel.current?.querySelector<HTMLButtonElement>('[data-color-preset]');selected?.focus();
  return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[activeColor]);
 useEffect(()=>{if(!activeColor)return;const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!panel.current?.contains(target)&&!triggers.current[activeColor]?.contains(target))closeColor(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[activeColor]);
 const allLocked=[...creatorChoices,...creatorColors].every(key=>locks[key]);
 return <section ref={host} className="mascot-creator" aria-label={`${name||'Your'} Appearance`}>
  <div className="mc-heading"><h3>Appearance</h3><span className="metadata">{name||'Your Profile'}</span></div>
  <div className="mc-layout">
   <div className="mc-preview">
    <div className="mc-avatar mc-main-preview" role="img" aria-label={`${preview==='saved'?'Saved':'Editing'} ${name||'Your'} Mascot, ${expression}`}><MascotSvg appearance={shown} expression={expression}/></div>
    <div className="mc-preview-controls"><label>Preview<select aria-label="Preview Expression" value={expression} onChange={event=>setExpression(event.target.value as Expression)}>{(['idle','listening','speaking'] as const).map(item=><option key={item} value={item}>{item[0].toUpperCase()+item.slice(1)}</option>)}</select></label>
     <div className="mc-preview-switch" role="group" aria-label="Appearance Preview">{(['saved','editing'] as const).map(item=><button type="button" key={item} aria-pressed={preview===item} onClick={()=>{finishColor();setPreview(item);}}>{item==='saved'?'Saved':'Editing'}</button>)}</div>
    </div>
   </div>
   <div className="mc-choices">{creatorChoices.map(key=>{
    const index=(mascotOptions[key] as readonly string[]).indexOf(appearance[key]);
    const colors=key==='glasses'&&appearance.glasses==='none'?[]:rowColors[key];
    return <div key={key} className="mc-choice-block" role="group" aria-label={labels[key]}>
     <div className="mc-cycle"><div className="mc-choice-current" title={appearance[key]==='none'?'No Glasses':`${labels[key]} ${key==='glasses'?index:index+1} · ${labels[appearance[key]]}`}><strong>{key==='glasses'&&appearance.glasses==='none'?'No Glasses':`${labels[key]} ${key==='glasses'?index:index+1}`}</strong>{appearance[key]!=='none'&&<span>{labels[appearance[key]]}</span>}</div><div className="mc-arrows"><button type="button" aria-label={`Previous ${labels[key]}`} onClick={()=>cycle(key,-1)}><Icon kind="previous"/></button><button type="button" aria-label={`Next ${labels[key]}`} onClick={()=>cycle(key,1)}><Icon kind="next"/></button></div></div>
     {lockButton(key)}
     {colors.length>0&&<div className="mc-row-colors" aria-label={`${labels[key]} Colors`}>{colors.map(color=><span className="mc-color-pair" key={color}><button type="button" className="mc-color-trigger" ref={node=>{if(node)triggers.current[color]=node;else delete triggers.current[color];}} aria-label={`${labels[color]} Color`} aria-expanded={activeColor===color} aria-haspopup="dialog" onClick={()=>{finishColor();setActiveColor(activeColor===color?null:color);}}><span className="mc-chip" style={{backgroundColor:appearance[color]}} aria-hidden="true"/><span>{labels[color]}</span></button>{lockButton(color,true)}</span>)}</div>}
    </div>;
   })}</div>
  </div>
  {value&&resolution.status!=='ready'&&<p className="mc-save-note">Your saved avatar stays unchanged until you edit and save.</p>}
  <div className="mc-footer"><div className="mc-tools"><button type="button" aria-label="Undo Appearance Change" title="Undo" disabled={!history.past.length&&!colorBefore.current} onClick={undo}><Icon kind="undo"/></button><button type="button" aria-label="Redo Appearance Change" title="Redo" disabled={!history.future.length} onClick={redo}><Icon kind="redo"/></button><button type="button" aria-label="Shuffle Appearance" title="Shuffle" disabled={allLocked} onClick={()=>{closeColor(false);commit(recipe(shuffleCreatorAppearance(appearance,locks)),'A new look. Locked styles and colors are unchanged.');}}><Icon kind="shuffle"/><span>Shuffle</span></button></div><div className="mc-save-actions"><button type="button" disabled={saving||equal(value,savedValue)} onClick={()=>{closeColor(false);if(onCancelLook)onCancelLook();else commit(copy(savedValue),'Appearance edits cancelled.');setPreview('editing');}}>Cancel</button>{onSaveLook?<button type="button" className="primary" disabled={saveDisabled||saving||equal(value,savedValue)} onClick={()=>{finishColor();void onSaveLook(copy(valueRef.current));}}>{saving?'Saving…':saveLabel}</button>:<span className="metadata">Save Changes To Apply</span>}</div></div>
  {activeColor&&<div ref={panel} className="mc-color-panel" style={position} role="dialog" aria-label={`${labels[activeColor]} Color`} onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeColor();return;}
   if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
   const tiles=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[data-color-preset]')??[]);const index=tiles.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tiles.length-1:(index+({ArrowLeft:-1,ArrowRight:1,ArrowUp:-6,ArrowDown:6}[event.key]??0)+tiles.length)%tiles.length;tiles[next]?.focus();
  }}><div className="mc-color-heading"><strong>{labels[activeColor]} Color</strong><button type="button" aria-label="Close Color Picker" onClick={()=>closeColor()}><Icon kind="close"/></button></div><div className="mc-preset-grid" role="group" aria-label="Neutrals And Hue Tones">{creatorPresets.map(([label,color])=><button type="button" key={color} data-color-preset={color} aria-label={`${label} ${color}`} aria-pressed={appearance[activeColor]===color} style={{'--swatch':color} as CSSProperties} onClick={()=>{pick({[activeColor]:color},`${labels[activeColor]} Color: ${label}.`);closeColor();}}><span style={{backgroundColor:color}} aria-hidden="true">{appearance[activeColor]===color?'✓':''}</span></button>)}</div><div className="mc-custom-color"><label>Custom Color<input type="color" aria-label={`Custom ${labels[activeColor]} Color`} value={appearance[activeColor]} onChange={event=>updateColor(activeColor,event.target.value)} onBlur={finishColor}/></label><code>{appearance[activeColor]}</code></div></div>}
  <p className="mc-sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
 </section>;
}
