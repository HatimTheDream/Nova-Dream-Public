import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {blankRecord,type Content} from '../packages/domain/workspace-records';
const key=Symbol.for('nova.test.content-writing'),react=import.meta.resolve('react');
const loader=registerHooks({
 resolve(name,context,next){return name==='react'&&context.parentURL?.endsWith('/ContentWriting.tsx')?{url:'nova-test:writing',shortCircuit:true}:next(name,context);},
 load(url,context,next){return url==='nova-test:writing'?{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};const h=()=>globalThis[Symbol.for('nova.test.content-writing')];export const useState=v=>h().state(v),useRef=v=>h().ref(v),useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;`}:next(url,context);}
});
const {ContentWriting}=await import('../apps/client/src/ContentWriting');loader.deregister();
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'?node:'';
function fixture(){
 let value={...blankRecord('content','UTC') as Content,body:'Original complete writing'},width=1920,cursor=0,dirty=true,tree:any,resize=()=>{},retired=false;
 const cells:any[]=[],effects:(()=>void)[]=[],frames:(()=>void)[]=[];
 const input={value:value.body,selectionStart:9,selectionEnd:17,scrollTop:88,disabled:false,isConnected:true,focused:false,
  closest:(selector:string)=>selector.includes('[hidden]')&&nodes(tree).find(n=>n.props.className==='content-draft-field').props.hidden?{}:null,
  focus(){this.focused=true;},setSelectionRange(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;}};
 const root={closest:()=>null,getBoundingClientRect:()=>({width})};
 const values:Record<PropertyKey,unknown>={
  [key]:{
   state(initial:any){const i=cursor++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,(next:any)=>{const current=typeof next==='function'?next(cells[i].value):next;if(!Object.is(current,cells[i].value)){cells[i].value=current;dirty=true;}}];},
   ref(initial:any){return cells[cursor++]??={current:initial};},
   effect(run:()=>any,deps:unknown[]){const i=cursor++,before=cells[i];if(!before||deps.some((v,k)=>!Object.is(v,before.deps[k]))){cells[i]={deps,cleanup:before?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=run();});}}
  },
  ResizeObserver:class{constructor(fn:()=>void){resize=fn;}observe(){}disconnect(){}},
  requestAnimationFrame:(fn:()=>void)=>{frames.push(fn);return frames.length;}
 };
 const originals=Reflect.ownKeys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const k of Reflect.ownKeys(values))Object.defineProperty(globalThis,k,{configurable:true,value:values[k]});
 const flush=()=>{for(let n=0;n<10&&dirty;n++){dirty=false;cursor=0;tree=ContentWriting({value,change:patch=>{value={...value,...patch};dirty=true;}});tree.props.ref.current=root;const node=nodes(tree).find(n=>n.type==='textarea');node.props.ref.current=input;input.value=node.props.value;while(effects.length)effects.shift()!();}};
 const retire=()=>{if(retired)return;retired=true;for(const cell of cells)cell.cleanup?.();};
 return {input,get tree(){return tree;},get value(){return value;},flush,frames,retire,
  mode(label:string){nodes(tree).find(n=>n.type==='button'&&text(n)===label).props.onClick();flush();},
  resize(next:number){width=next;resize();flush();},
  type(body:string){nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:body}});flush();},
  close(){retire();for(const[k,d]of originals)if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}
 };
}
test('Write, Preview and Split keep one textarea and exact writing while narrow Split retains the wide preference',()=>{
 const f=fixture();
 try{f.flush();const ref=nodes(f.tree).find(n=>n.type==='textarea').props.ref;f.mode('Split');assert.match(nodes(f.tree).find(n=>n.props.className?.includes('content-writing-panes')).props.className,/split/);
  f.resize(1100);assert.equal(nodes(f.tree).find(n=>n.props.className==='content-draft-field').props.hidden,true);
  assert.equal(nodes(f.tree).find(n=>n.type==='button'&&text(n)==='Split').props['aria-pressed'],true);assert.equal(nodes(f.tree).find(n=>n.type==='textarea').props.ref,ref);
  f.resize(1101);assert.equal(nodes(f.tree).find(n=>n.props.className==='content-draft-field').props.hidden,false);
  f.mode('Preview');f.mode('Write');assert.deepEqual([f.input.selectionStart,f.input.selectionEnd,f.input.scrollTop],[9,17,88]);assert.equal(f.value.body,'Original complete writing');
  f.type('Changed full writing');f.mode('Preview');assert.equal(nodes(f.tree).find(n=>n.type==='textarea').props.value,'Changed full writing');
 }finally{f.close();}
});
test('formatting preserves exact selected text and a retired callback cannot steal focus',()=>{
 const f=fixture();
 try{f.flush();const original=f.value.body,start=f.input.selectionStart,end=f.input.selectionEnd;
  f.mode('Bold');assert.equal(f.value.body,original.slice(0,start)+'**'+original.slice(start,end)+'**'+original.slice(end));f.frames.shift()!();
  assert.deepEqual([f.input.selectionStart,f.input.selectionEnd],[start+2,end+2]);
  f.input.focused=false;f.mode('Italic');f.retire();f.frames.shift()!();assert.equal(f.input.focused,false);
 }finally{f.close();}
});
