import { LoadingRing } from './ModuleLoading';
import { Suspense, useEffect, useRef, useState } from 'react';
import { lazy } from './preload-lazy';
import type {Content} from '../../../packages/domain/workspace-records';
const Preview=lazy(()=>import('./ContentPreview'));
export function ContentWriting({value,change}:{value:Content;change:(patch:Partial<Content>)=>void}){
 const [view,setView]=useState<'write'|'preview'|'split'>(value.archived?'preview':'write'),input=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{if(value.archived)setView('preview');},[value.archived]);
 const wrap=(before:string,after='',placeholder='Text')=>{const el=input.current;if(!el)return;const start=el.selectionStart,end=el.selectionEnd,text=value.body.slice(start,end)||placeholder;change({body:value.body.slice(0,start)+before+text+after+value.body.slice(end)});requestAnimationFrame(()=>{el.focus();el.setSelectionRange(start+before.length,start+before.length+text.length);});};
 const words=value.body.trim()?value.body.trim().split(/\s+/).length:0;
 return <section className="content-writing"><div className="content-writing-head"><div className="segmented" aria-label="Writing view">{(['write','preview','split'] as const).map(v=><button type="button" key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v[0].toUpperCase()+v.slice(1)}</button>)}</div><small>{words.toLocaleString()} words · {value.body.length.toLocaleString()} characters</small></div>
 {view!=='preview'&&value.format==='markdown'&&<div className="content-formatting" role="toolbar" aria-label="Text formatting"><button type="button" onClick={()=>wrap('**','**')}>Bold</button><button type="button" onClick={()=>wrap('*','*')}>Italic</button><button type="button" onClick={()=>wrap('\n## ','\n','Heading')}>Heading</button><button type="button" onClick={()=>wrap('\n- ','\n','List item')}>List</button><button type="button" onClick={()=>wrap('\n- [ ] ','\n','To do')}>Checklist</button><button type="button" onClick={()=>wrap('\n> ','\n','Quote')}>Quote</button><button type="button" onClick={()=>wrap('[','](https://example.com)','Link text')}>Link</button></div>}
 <div className={`content-writing-panes ${view}`}>{view!=='preview'&&<label className="content-draft-field"><span className="sr-only">Draft</span><textarea ref={input} aria-label="Draft" maxLength={100000} value={value.body} onChange={e=>change({body:e.target.value})} placeholder="Start writing…" onKeyDown={e=>{if(value.format==='markdown'&&(e.metaKey||e.ctrlKey)&&['b','i'].includes(e.key.toLowerCase())){e.preventDefault();wrap(e.key.toLowerCase()==='b'?'**':'*',e.key.toLowerCase()==='b'?'**':'*');}}}/></label>}{view!=='write'&&<Suspense fallback={<LoadingRing label="Opening preview…"/>}><Preview value={value}/></Suspense>}</div></section>;
}
