import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const slot = Symbol.for('nova.test.reorder-persistence');
const loader = registerHooks({
 resolve(name, context, next) { return name === 'react' && context.parentURL?.includes('/apps/client/src/useReorder') ? { url: 'nova-reorder-test:react', shortCircuit: true } : next(name, context); },
 load(url, context, next) { return url === 'nova-reorder-test:react' ? { format: 'module', shortCircuit: true, source: `const f=()=>globalThis[Symbol.for('nova.test.reorder-persistence')];export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useEffect=(fn,deps)=>f().effect(fn,deps);export const useLayoutEffect=()=>{};` } : next(url, context); },
});
const { useReorder } = await import('../apps/client/src/useReorder.js');
class Hooks {
 slots: any[] = []; index=0; effects: (()=>void)[]=[]; updates=0;
 state(value: any) { const i=this.index++;if (!(i in this.slots)) this.slots[i]=value;return [this.slots[i],(next:any)=>{this.updates++;this.slots[i]=typeof next==='function'?next(this.slots[i]):next;}]; }
 ref(value: any) { const i=this.index++;return this.slots[i]??={current:value}; }
 effect(fn: ()=>void|(()=>void), deps: unknown[]) { const i=this.index++,old=this.slots[i];if (!old || deps.some((v,n)=>v!==old.deps[n])) this.effects.push(()=>{old?.cleanup?.();this.slots[i]={deps,cleanup:fn()};}); }
 render<T>(fn:()=>T) { (globalThis as any)[slot]=this;this.index=0;this.effects=[];const result=fn();this.effects.forEach(fn=>fn());return result; }
 dispose() { this.slots.forEach(value=>value?.cleanup?.()); }
}
class Surface {
 dataset={reorderItem:'b'}; captured=false;
 closest() { return null; } setPointerCapture() { this.captured=true; } hasPointerCapture() { return this.captured; } releasePointerCapture() { this.captured=false; }
 getBoundingClientRect() { return {top:0,bottom:200}; } scrollBy() {}
}
const listeners=new EventTarget(), doc=new EventTarget();
Object.assign(doc,{elementFromPoint:()=>({dataset:{reorderItem:'b'},closest(){return this;}})});
Object.defineProperty(globalThis,'window',{configurable:true,value:listeners});
Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
const emit=(name:string,fields:Record<string,unknown>)=>listeners.dispatchEvent(Object.assign(new Event(name,{cancelable:true}),fields));
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

test('synchronous reorder callers retain their confirmed feedback and do not enter pending state',()=>{
 const f=new Hooks(),writes:string[][]=[];const render=()=>f.render(()=>useReorder(['a','b'],next=>{writes.push(next);},'fixture'));
 try { render().move('a',1);const state=render();assert.deepEqual(writes,[['b','a']]);assert.equal(state.saving,false);assert.equal(state.announcement,'Moved to position 2 of 2.'); } finally {f.dispose();}
});
test('async reorder blocks a second move until the original save confirms',async()=>{
 const f=new Hooks(),writes:string[][]=[];let resolve!:(value:boolean)=>void;const save=(next:string[])=>{writes.push(next);return new Promise<boolean>(done=>{resolve=done;});};const render=()=>f.render(()=>useReorder(['a','b'],save,'fixture'));
 try {render().move('a',1);let state=render();assert.equal(state.saving,true);assert.equal(state.announcement,'Saving move…');state.move('b',0);assert.equal(writes.length,1);resolve(true);await settle();state=render();assert.equal(state.saving,false);assert.equal(state.announcement,'Moved to position 2 of 2.');} finally {f.dispose();}
});
test('rejected async reorder reports uncertainty without announcing a saved order',async()=>{
 const f=new Hooks();let reject!:(error:Error)=>void;const render=()=>f.render(()=>useReorder(['a','b'],()=>new Promise<boolean>((_resolve,fail)=>{reject=fail;}),'fixture'));
 try {render().move('a',1);reject(new Error('lost response'));await settle();const state=render();assert.equal(state.saving,false);assert.equal(state.announcement,'Move unconfirmed. Check the original save.');assert.deepEqual(state.order,['a','b']);} finally {f.dispose();}
});
test('pointer Escape cancels preview without dispatching a save, and disabled movement stays inert',()=>{
 const f=new Hooks(),writes:string[][]=[];let disabled=false;const render=()=>f.render(()=>useReorder(['a','b'],next=>{writes.push(next);},'fixture',{disabled}));
 try {const state=render(),target=new Surface();state.bind('a').onPointerDown({button:0,isPrimary:true,pointerType:'mouse',pointerId:1,clientX:0,clientY:0,currentTarget:target} as any);emit('pointermove',{pointerId:1,clientX:20,clientY:100});assert.deepEqual(render().order,['b','a']);emit('keydown',{key:'Escape'});assert.deepEqual(render().order,['a','b']);assert.equal(render().announcement,'Move cancelled.');assert.equal(target.captured,false);assert.equal(writes.length,0);disabled=true;render().move('a',1);assert.equal(writes.length,0);} finally {f.dispose();}
});
test('a delayed save cannot update an unmounted reorder owner',async()=>{
 const f=new Hooks();let resolve!:(value:boolean)=>void;const state=f.render(()=>useReorder(['a','b'],()=>new Promise<boolean>(done=>{resolve=done;}),'fixture'));state.move('a',1);f.dispose();const updates=f.updates;resolve(true);await settle();assert.equal(f.updates,updates);
});
test.after(()=>{loader.deregister();delete(globalThis as any)[slot];delete(globalThis as any).window;delete(globalThis as any).document;});
