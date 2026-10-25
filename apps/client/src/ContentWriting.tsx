import { LoadingRing } from './ModuleLoading';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { lazy } from './preload-lazy';
import type {Content} from '../../../packages/domain/workspace-records';
const Preview=lazy(()=>import('./ContentPreview'));
export function ContentWriting({value,change}:{value:Content;change:(patch:Partial<Content>)=>void}){
 const [view,setView]=useState<'write'|'preview'|'split'>(value.archived?'preview':'write'),input=useRef<HTMLTextAreaElement>(null);
 const [narrow,setNarrow]=useState(false),root=useRef<HTMLElement>(null),mounted=useRef(true),latest=useRef({value,change});latest.current={value,change};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useLayoutEffect(()=>{const container=root.current?.closest('.content-studio')??root.current;if(!container)return;const resize=()=>setNarrow(container.getBoundingClientRect().width<=1100);resize();const observer=new ResizeObserver(resize);observer.observe(container);return()=>observer.disconnect();},[]);
 const shown=value.archived?'preview':view==='split'&&narrow?'preview':view;
 useEffect(()=>{if(value.archived)setView('preview');},[value.archived]);
 const wrap=(before:string,after='',placeholder='Text')=>{const el=input.current,{value,change}=latest.current;if(!el||value.archived||el.disabled||el.closest('fieldset:disabled'))return;const start=el.selectionStart,end=el.selectionEnd,text=value.body.slice(start,end)||placeholder,body=value.body.slice(0,start)+before+text+after+value.body.slice(end);change({body});requestAnimationFrame(()=>{if(mounted.current&&el.isConnected&&el.value===body&&!el.closest('[hidden],[inert]')){el.focus();el.setSelectionRange(start+before.length,start+before.length+text.length);}});};
 const words=value.body.trim()?value.body.trim().split(/\s+/).length:0;
 return <section ref={root} className="content-writing"><div className="content-writing-head"><div className="segmented" aria-label="Writing view">{(['write','preview','split'] as const).map(v=><button type="button" key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v[0].toUpperCase()+v.slice(1)}</button>)}</div><small>{words.toLocaleString()} Words · {value.body.length.toLocaleString()} Characters</small></div>
 {view==='split'&&narrow&&<p className="metadata">Preview Is Focused At This Width. Your Split Preference Is Kept For A Wider Editor.</p>}
 {shown!=='preview'&&value.format==='markdown'&&<div className="content-formatting" role="toolbar" aria-label="Text formatting"><button type="button" onClick={()=>wrap('**','**')}>Bold</button><button type="button" onClick={()=>wrap('*','*')}>Italic</button><button type="button" onClick={()=>wrap('\n## ','\n','Heading')}>Heading</button><button type="button" onClick={()=>wrap('\n- ','\n','List item')}>List</button><button type="button" onClick={()=>wrap('\n- [ ] ','\n','To do')}>Checklist</button><button type="button" onClick={()=>wrap('\n> ','\n','Quote')}>Quote</button><button type="button" onClick={()=>wrap('[','](https://example.com)','Link text')}>Link</button></div>}
 <div className={`content-writing-panes ${shown}`}><label className="content-draft-field" hidden={shown==='preview'}><span className="sr-only">Draft</span><textarea ref={input} aria-label="Draft" maxLength={100000} value={value.body} onChange={e=>change({body:e.target.value})} placeholder="Start writing…" onKeyDown={e=>{if(value.format==='markdown'&&(e.metaKey||e.ctrlKey)&&['b','i'].includes(e.key.toLowerCase())){e.preventDefault();wrap(e.key.toLowerCase()==='b'?'**':'*',e.key.toLowerCase()==='b'?'**':'*');}}}/></label>{shown!=='write'&&<Suspense fallback={<LoadingRing label="Opening preview…"/>}><Preview value={value}/></Suspense>}</div></section>;
}
