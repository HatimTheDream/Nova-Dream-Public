import test from 'node:test';
import assert from 'node:assert/strict';
import {tasks,draft,ownedDraftCleanup,contentSearch} from '../scripts/release-delivery-browser-checks.mjs';

// Stateful accessibility fixture: hidden controls are excluded from ordinary
// role queries, navigation may finish rendering later, and clicking a disclosure
// toggles it. It exercises the real maintained helpers without a browser or API.
function fixture({compact=true,query='',writing='',delayed=false,searchOpen=false,addOpen=false,
  missingSearch=false,missingAdd=false,brokenSearch=false,brokenAdd=false,railOpen=true}={}) {
  const state={mounted:!delayed,searchOpen:!compact||searchOpen,addOpen:!compact||addOpen,
    query,writing,railOpen,route:'home',focused:null,clicks:[]};
  const nodes=[
    {id:'show',role:'button',name:()=> 'Show main navigation',visible:()=>!state.railOpen,
      click:()=>{state.railOpen=true;}},
    {id:'tasks',role:'button',name:()=> 'Tasks',visible:()=>state.railOpen,
      click:()=>{state.route='tasks';state.focused='tasks';}},
    {id:'search',role:'textbox',name:()=> 'Search tasks',visible:()=>state.mounted&&state.searchOpen,
      value:()=>state.query,fill:value=>{state.query=value;}},
    {id:'quick',role:'textbox',name:()=> 'Quick task title',visible:()=>state.mounted&&state.addOpen,
      value:()=>state.writing,fill:value=>{state.writing=value;}},
    {id:'search-button',role:'button',name:()=>state.query?'Search Tasks, Active Query':'Search Tasks',
      visible:()=>compact&&state.mounted&&!missingSearch,
      click:()=>{if(!brokenSearch)state.searchOpen=!state.searchOpen;state.focused='search';}},
    {id:'add-button',role:'button',name:()=> 'Add Task',visible:()=>compact&&state.mounted&&!missingAdd,
      click:()=>{if(!brokenAdd)state.addOpen=!state.addOpen;state.focused='quick';}},
  ];
  const visible=n=>n.visible()&&(n.id==='show'||n.id==='tasks'||state.route==='tasks');
  function byRole(role,options) {
    const matches=()=>nodes.filter(n=>n.role===role
      &&(options.name instanceof RegExp?options.name.test(n.name()):options.name===n.name())
      &&(options.includeHidden||visible(n)));
    const one=()=>{const found=matches();assert.equal(found.length,1,'one accessible control required');return found[0];};
    return {
      async waitFor({state:expected}) {
        if(expected==='attached'&&state.route==='tasks')state.mounted=true;
        const n=one();assert.ok(state.mounted,'view is mounted');
        if(expected==='visible')assert.ok(visible(n),'field must become visible');
      },
      async isVisible(){const found=matches();return found.length===1&&visible(found[0]);},
      async click(){const n=one();assert.ok(visible(n),'click requires visible control');state.clicks.push(n.id);n.click();},
      async inputValue(){return one().value();},
      async fill(value){const n=one();assert.ok(visible(n),'fill requires visible field');n.fill(value);},
    };
  }
  const page={getByRole:byRole,locator(selector){assert.equal(selector,'#main-navigation');return {
    isVisible:async()=>state.railOpen,getByRole:byRole,
  };}};
  return {page,state,reload(){state.mounted=false;state.route='home';state.searchOpen=!compact;state.addOpen=!compact;}};
}

test('legacy visible task inputs retain writing without disclosure clicks or forced field focus',async()=>{
  const f=fixture({compact:false,query:'kept search',writing:'unsent task'});f.state.focused='quick';
  await tasks(f.page);const field=await draft(f.page);
  await tasks(f.page);await draft(f.page);
  assert.equal(await field.inputValue(),'unsent task');assert.equal(f.state.query,'kept search');
  assert.equal(f.state.focused,'tasks');assert.deepEqual(f.state.clicks,['tasks','tasks']);
});

test('new closed disclosures wait for the mounted view and reveal kept search and writing',async()=>{
  const f=fixture({delayed:true,railOpen:false,query:'kept search',writing:'unsent task'});
  await tasks(f.page);const field=await draft(f.page);
  assert.equal(f.state.mounted,true);assert.equal(f.state.searchOpen,true);assert.equal(f.state.addOpen,true);
  assert.equal(f.state.query,'kept search');assert.equal(await field.inputValue(),'unsent task');
  assert.deepEqual(f.state.clicks,['show','tasks','search-button','add-button']);
  await tasks(f.page);await draft(f.page);
  assert.deepEqual(f.state.clicks,['show','tasks','search-button','add-button','tasks']);
  assert.equal(f.state.searchOpen,true);assert.equal(f.state.addOpen,true);
});

for(const [searchOpen,addOpen,expected] of [[true,false,['tasks','add-button']],[false,true,['tasks','search-button']]]) {
  test(`partly open controls preserve the open disclosure (${searchOpen}, ${addOpen})`,async()=>{
    const f=fixture({searchOpen,addOpen,writing:'keep me'});
    await tasks(f.page);await draft(f.page);
    assert.deepEqual(f.state.clicks,expected);assert.equal(f.state.writing,'keep me');
    assert.equal(f.state.searchOpen,true);assert.equal(f.state.addOpen,true);
  });
}

test('reload requires revealing the new controls again and cleans only the exact owned draft',async()=>{
  const f=fixture();await tasks(f.page);const field=await draft(f.page);await field.fill('owned unsent verification');
  f.reload();await tasks(f.page);
  assert.equal(await(await draft(f.page)).inputValue(),'owned unsent verification');
  await ownedDraftCleanup(f.page,'owned unsent verification');
  assert.equal(f.state.writing,'');
  assert.equal(f.state.clicks.filter(x=>x==='search-button').length,2);
  assert.equal(f.state.clicks.filter(x=>x==='add-button').length,2);
});

test('a changed retained draft is refused rather than erased after revealing its control',async()=>{
  const f=fixture({writing:'changed writing'});
  await assert.rejects(ownedDraftCleanup(f.page,'original owned writing'),/browser-owned-draft-changed/);
  assert.equal(f.state.writing,'changed writing');assert.equal(f.state.addOpen,true);
});

for(const failure of ['missingSearch','brokenSearch']) {
  test(`hidden search cannot pass when its real disclosure is ${failure}`,async()=>{
    const f=fixture({[failure]:true,query:'keep query',writing:'keep draft'});
    await assert.rejects(tasks(f.page),/accessible control|required|visible/);
    assert.equal(f.state.searchOpen,false);assert.equal(f.state.query,'keep query');assert.equal(f.state.writing,'keep draft');
    assert.ok(!f.state.clicks.includes('add-button'));
  });
}
for(const failure of ['missingAdd','brokenAdd']) {
  test(`hidden draft cannot pass when its real disclosure is ${failure}`,async()=>{
    const f=fixture({[failure]:true,writing:'keep draft'});await tasks(f.page);
    await assert.rejects(draft(f.page),/accessible control|required|visible/);
    assert.equal(f.state.addOpen,false);assert.equal(f.state.writing,'keep draft');
  });
}

function contentFixture({legacy=false,open=false,missing=false,broken=false,wrongRole=false}={}) {
  const state={mounted:false,route:'home',open,query:'kept content query',clicks:[]};
  const nodes=[
    {role:'button',name:'Content',visible:()=>true,click:()=>{state.route='content';}},
    {role:'textbox',name:'Search content records',visible:()=>legacy},
    {role:wrongRole?'textbox':'searchbox',name:'Search Content Records',visible:()=>!legacy&&state.open},
    {role:'button',name:'Search Content',visible:()=>!legacy&&!missing,
      click:()=>{if(!broken)state.open=!state.open;}},
  ];
  const shown=n=>n.name==='Content'||state.mounted&&state.route==='content'&&n.visible();
  const locator=select=>({
    select,
    or(other){return locator(()=>[...new Set([...select(),...other.select()])]);},
    first(){return locator(()=>select().slice(0,1));},
    async isVisible(){return select().length===1&&shown(select()[0]);},
    async waitFor({state:expected}){assert.equal(expected,'visible');state.mounted=true;const n=select();assert.equal(n.length,1,'one visible content control required');assert.ok(shown(n[0]));},
    async click(){const n=select();assert.equal(n.length,1,'one visible content control required');assert.ok(shown(n[0]));state.clicks.push(n[0].name);n[0].click();},
  });
  const getByRole=(role,{name})=>locator(()=>nodes.filter(n=>n.role===role&&n.name===name&&shown(n)));
  return {state,page:{getByRole,locator(selector){assert.equal(selector,'#main-navigation');return {isVisible:async()=>true,getByRole};}}};
}

test('legacy Content keeps its visible textbox and query without a new disclosure',async()=>{
  const f=contentFixture({legacy:true});await contentSearch(f.page);
  assert.deepEqual(f.state.clicks,['Content']);assert.equal(f.state.query,'kept content query');
});
test('current Content reveals its unmounted searchbox once after lazy view readiness',async()=>{
  const f=contentFixture();await contentSearch(f.page);await contentSearch(f.page);
  assert.equal(f.state.open,true);assert.deepEqual(f.state.clicks,['Content','Search Content','Content']);
  assert.equal(f.state.query,'kept content query');
});
for(const failure of ['missing','broken','wrongRole']) {
  test(`Content cannot pass with ${failure} current search control`,async()=>{
    const f=contentFixture({[failure]:true});
    await assert.rejects(contentSearch(f.page),/visible content control/);
    assert.equal(f.state.query,'kept content query');
  });
}
