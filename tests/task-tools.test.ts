import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';

const key = Symbol.for('nova.test.task-tools'), react = import.meta.resolve('react');
const loader = registerHooks({
  resolve(name, context, next) { return name === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url:'nova-task-tools:react',shortCircuit:true } : next(name,context); },
  load(url, context, next) { return url === 'nova-task-tools:react' ? { format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)}; const h=()=>globalThis[Symbol.for('nova.test.task-tools')]; export const useState=v=>h().state(v),useRef=v=>h().ref(v),useEffect=()=>{},useLayoutEffect=(f,d)=>h().effect(f,d);` } : next(url,context); },
});
const { TaskTools } = await import('../apps/client/src/TaskTools');
const { TaskFilterFields } = await import('../apps/client/src/TaskFilters');
loader.deregister();
const nodes = (node:any):any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node,...nodes(node.props.children)] : [];
const text = (node:any):string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' ? node : '';

function tools(query='') {
  const cells:any[]=[]; let cursor=0,tree:any,focus='';const effects:(()=>void)[]=[];
  const state = { effect(f:()=>void,deps:any[]){const i=cursor++;if(!cells[i]||deps.some((v,j)=>v!==cells[i][j]))effects.push(f);cells[i]=deps;}, state(value:any) { const i=cursor++; if(!(i in cells))cells[i]=value;return[cells[i],(next:any)=>{cells[i]=typeof next==='function'?next(cells[i]):next;}]; }, ref(value:any){const i=cursor++;return cells[i]??=( {current:value});} };
  const add=createElement('input',{value:'Exact Unsent Writing'}), search=createElement('input',{value:query});
  const render=()=>{cursor=0;(globalThis as any)[key]=state;tree=TaskTools({openCalendar(){},filters:null,search,add,searchInput:{current:{focus(){focus='Search Input';}} as HTMLInputElement},query}); for(const node of nodes(tree)){if(node.type==='button'&&node.props.ref)node.props.ref.current={focus(){focus=node.props['aria-label'];}};if(node.type==='div'&&node.props.id==='task-add-disclosure')node.props.ref.current={querySelector(){return{focus(){focus='Quick Task Title';}};}};}for(const effect of effects.splice(0))effect();return tree;};
  render();
  return {render,add,search,get focus(){return focus;},get tree(){return tree;},button(name:string){return nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']===name);},region(id:string){return nodes(tree).find(node=>node.props.id===id);}};
}

test('Add and Search retain exact mounted writing across disclosure and return focus',()=>{
  const h=tools('Retained Query');assert.equal(h.region('task-add-disclosure').props.hidden,true);
  h.button('Add Task').props.onClick();h.render();assert.equal(h.focus,'Quick Task Title');assert.equal(h.region('task-add-disclosure').props.hidden,false);
  assert.ok(nodes(h.tree).includes(h.add));h.button('Close Add Task').props.onClick();h.render();
  assert.equal(h.focus,'Add Task');assert.equal(h.region('task-add-disclosure').props.hidden,true);assert.ok(nodes(h.tree).includes(h.add));
  h.button('Search Tasks, Active Query').props.onClick();h.render();assert.equal(h.focus,'Search Input');h.button('Close Task Search').props.onClick();h.render();
  assert.equal(h.focus,'Search Tasks, Active Query');assert.ok(nodes(h.tree).includes(h.search));assert.equal(h.search.props.value,'Retained Query');
});

test('disclosure Escape respects composition, prior handling, and an active search query',()=>{
  for(const query of ['', 'Kept'])for(const blocked of ['composition','handled','229','none']){
    const h=tools(query);h.button(query?'Search Tasks, Active Query':'Search Tasks').props.onClick();h.render();
    let prevented=false;h.region('task-search-disclosure').props.onKeyDown({key:'Escape',defaultPrevented:blocked==='handled',nativeEvent:{isComposing:blocked==='composition',keyCode:blocked==='229'?229:27},preventDefault(){prevented=true;}});h.render();
    assert.equal(prevented,query===''&&blocked==='none');assert.equal(h.region('task-search-disclosure').props.hidden,query===''&&blocked==='none');
  }
});

test('closing Add with Escape retains its unsent title and returns to the exact add control',()=>{
  const h=tools();h.button('Add Task').props.onClick();h.render();let prevented=false;
  h.region('task-add-disclosure').props.onKeyDown({key:'Escape',defaultPrevented:false,nativeEvent:{isComposing:false,keyCode:27},preventDefault(){prevented=true;}});h.render();
  assert.equal(prevented,true);assert.equal(h.focus,'Add Task');assert.equal(h.add.props.value,'Exact Unsent Writing');
});

test('task filters retain all destinations and apply choices immediately without closing or rewriting names',()=>{
  const calls:any[]=[], snapshot={projects:[{id:'project:a',value:{name:'mY Original NAME'}}],layout:{value:defaultLayout}} as unknown as Snapshot;
  let closed=0;const props:any={snapshot,view:'Today',project:'all',status:'all',priority:'all',sort:'planned',trash:false,selecting:false};
  for(const name of ['chooseView','setProject','setStatus','setPriority','setSort','setTrash','setSelecting'])props[name]=(value:any)=>calls.push([name,value]);
  const tree=TaskFilterFields({props,close(){closed++;}}),labels=nodes(tree).filter(node=>node.type==='label');
  const select=(name:string)=>nodes(labels.find(node=>text(node).startsWith(name))).find(node=>node.type==='select');
  assert.deepEqual(nodes(select('Task View')).filter(node=>node.type==='option').map(node=>node.props.value),['Today','All Open','Scheduled','Unsorted','Anytime','Completed','Daily History','Trash']);
  assert.equal(text(nodes(select('Project')).find(node=>node.props.value==='project:a')),'mY Original NAME');
  select('Task View').props.onChange({target:{value:'Daily History'}});select('Project').props.onChange({target:{value:'project:a'}});
  assert.deepEqual(calls,[['chooseView','Daily History'],['setProject','project:a']]);assert.equal(closed,0);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Done').props.onClick();assert.equal(closed,1);
});

test('filter Reset uses existing setters and returns to Today without mutating task records',()=>{
  const calls:any[]=[], snapshot={projects:[],layout:{value:defaultLayout}} as unknown as Snapshot;
  const props:any={snapshot,view:'Daily History',project:'missing',status:'blocked',priority:'high',sort:'deadline',trash:false,selecting:false};
  for(const name of ['chooseView','setProject','setStatus','setPriority','setSort','setTrash','setSelecting'])props[name]=(value:any)=>calls.push([name,value]);
  const tree=TaskFilterFields({props,close(){}});assert.ok(text(tree).includes('Unavailable Project'));
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Reset').props.onClick();
  assert.deepEqual(calls,[['setProject','all'],['setStatus','all'],['setPriority','all'],['setSort','planned'],['chooseView','Today']]);
});
