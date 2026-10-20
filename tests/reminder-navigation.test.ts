import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Snapshot, Entity, Task } from '../packages/domain/contracts';
import type { LocalCalendarDetail } from '../packages/domain/calendar';
import { preparedReminderReturnMatches, readReminderView, reminderViewKey, retainReminderReturn, type PreparedReminderReturn, type ReminderReturn } from '../apps/client/src/reminder-workspace';
import { TaskNavigationController } from '../apps/client/src/task-editor-navigation';
import { resolveLocalCalendarTarget, keepCalendarTarget, calendarTargetKey } from '../apps/client/src/calendar-target';
import type { WorkspaceReminder } from '../apps/client/src/reminder-items';
import type { Reminder } from '../packages/domain/reminders';

const hookKey = Symbol.for('nova.test.reminder-hooks'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'nova-test:reminder-css', shortCircuit: true };
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:reminder-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:reminder-css') return { format: 'module', shortCircuit: true, source: 'export {}' };
    if (url === 'nova-test:reminder-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(react)};
      export const useEffect = () => {};
      export const useLayoutEffect = callback => globalThis[Symbol.for('nova.test.reminder-hooks')].effects.push(callback);
      export const useRef = initial => { const f=globalThis[Symbol.for('nova.test.reminder-hooks')], i=f.index++; return f.values[i] ??= {current:initial}; };
      export const useState = initial => { const f=globalThis[Symbol.for('nova.test.reminder-hooks')], i=f.index++; if(!(i in f.values))f.values[i]=typeof initial==='function'?initial():initial; return [f.values[i],v=>{f.values[i]=typeof v==='function'?v(f.values[i]):v;}]; };
    ` };
    return next(url, context);
  },
});
const { Reminders } = await import('../apps/client/src/Reminders');
const { TaskWorkspace } = await import('../apps/client/src/TaskWorkspace');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
hooks.deregister();
const nodes = (value: any): any[] => Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : [];
function globals(t: any, values: Record<PropertyKey, unknown>) {
  for (const key of Reflect.ownKeys(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
}
function fixture(t: any) {
  const state = { index: 0, values: [] as any[], effects: [] as (() => void)[] }, stored: Record<string, string> = {};
  let full = false, closed = 0;
  const storage = { getItem: (key: string) => stored[key] ?? null, setItem(key: string, value: string) { if(full)throw Error('Full'); stored[key]=value; } };
  globals(t, { [hookKey]: state, localStorage: storage });
  const reminder: Reminder = { id: randomUUID(), taskId: 'task:original', taskRevision: 1, revision: 1, spec: { date: '2026-10-20', time: '09:00', timezone: 'UTC' }, dueAt: 123, snoozes: 0, state: 'missed' };
  const snapshot = { epoch: randomUUID(), deviceId: 'device', tasks: [{id:'task:original', revision:1, value:{title:'Original'}}], taskState: { reminders: [reminder], notificationAttempts:[] }, calendarReminders: { reminders: [], notificationAttempts: [] } } as unknown as Snapshot;
  const scope = { epoch: snapshot.epoch, deviceId:snapshot.deviceId, windowId:retainedWindowId }, actions = new Map(), opened: ReminderReturn[] = [];
  const render = () => { state.index=0; const tree = Reminders({ snapshot, originRoute:'home', actions, notifications:{enabled:false} as any, close(){closed++;}, async refresh(){}, async openReminder(_item, origin){opened.push(origin!); return true;} }); for(const effect of state.effects.splice(0))effect(); return nodes(tree); };
  return { render, stored, state, snapshot, reminder, scope, opened, closed:()=>closed, full:(value:boolean)=>{full=value;}, view:()=>JSON.parse(stored[reminderViewKey(scope)]) };
}

test('actual Reminders callbacks retain tab, page, scroll and custom text before exact original return', async t => {
  const f = fixture(t); let tree=f.render(), row=tree.find(n=>n.props.reminder);
  row.props.keepDuration('12.5'); tree=f.render();
  const body = tree.find(n=>n.props.className==='reminders-body'); body.props.ref.current={scrollTop:271}; body.props.onScroll();
  await tree.find(n=>n.props.reminder).props.openOriginal(f.reminder);
  assert.equal(f.opened.length,1); assert.equal(f.opened[0].id,'task:original'); assert.equal(f.view().positions.due.scroll,271);
  f.state.values=[]; tree=f.render(); assert.equal(tree.find(n=>n.props.reminder).props.duration,'12.5');
  f.full(true); tree[0].props.close(); assert.equal(f.closed(),0);
  f.full(false); f.render()[0].props.close(); assert.equal(f.closed(),1);
});

test('actual original launch cannot leave after view storage refusal', async t => {
  const f=fixture(t), row=f.render().find(n=>n.props.reminder); f.full(true);
  await row.props.openOriginal(f.reminder); assert.deepEqual(f.opened,[]);
  assert.ok(f.render().some(n=>n.props.role==='alert')); assert.equal(f.closed(),0);
});

test('actual History controls page beyond fifty retained reminders without losing identity', t => {
  const f=fixture(t); f.snapshot.taskState!.reminders=Array.from({length:73},(_,index)=>({...f.reminder,id:randomUUID(),dueAt:index,state:'dismissed'}));
  let tree=f.render(); tree.find(n=>n.props.id==='reminders-tab-history').props.onClick();
  const ids:string[]=[];
  for(let page=0;page<4;page++){ tree=f.render(); ids.push(...tree.filter(n=>n.props.reminder).map(n=>n.props.reminder.id)); const next=tree.find(n=>n.type==='button'&&n.props.children==='Next'); if(page<3)next.props.onClick(); else assert.equal(next.props.disabled,true); }
  assert.equal(new Set(ids).size,73); assert.equal(f.view().positions.history.page,3);
});

test('TaskWorkspace guarded return keeps active pointer and adopts confirmation without premature close', () => {
  const task={id:'task:original',revision:1,value:{title:'Original'}} as Entity<Task>;
  const origin={route:'home' as const,label:'Reminders'}, state={active:true,token:'original-token',origin,frames:[{taskId:task.id,section:'details',scroll:0}]};
  let allow=false, closes=0, returned=0, cleanSeen:boolean|undefined, retry:(()=>void)|undefined;
  const workspace={state,task,controller:{state,resolve:()=>task},close(){closes++;state.active=false;return true;},acknowledge(_task:unknown,_token:string,clean:boolean){cleanSeen=clean;if(clean)state.active=false;return true;}} as any;
  const render=()=>TaskWorkspace({workspace,snapshot:{} as Snapshot,async refresh(){},closed(){returned++;},openOrigin(){},canClose(_origin,next){retry=next;return allow;}}) as any;
  render().props.close(); assert.equal(closes,0); assert.equal(state.active,true);
  render().props.saved({...task,revision:2},true); assert.equal(cleanSeen,false); assert.equal(state.active,true); assert.equal(returned,0);
  allow=true; retry!(); assert.equal(closes,1); assert.equal(returned,1);
});

test('final return view is retained before editor close; second-write refusal keeps original active and no third write is needed', () => {
  const scope={epoch:randomUUID(),deviceId:'device',windowId:'window'}, original:ReminderReturn={...scope,token:randomUUID(),reminderId:randomUUID(),kind:'tasks',id:'task:original',from:'home'};
  const task={id:original.id,revision:1,deviceId:scope.deviceId,updatedAt:'',value:{title:'Original',notes:'',planned:'',due:'',status:'open'}} as Entity<Task>;
  const snapshot={epoch:scope.epoch,deviceId:scope.deviceId,tasks:[task]} as Snapshot;
  const records=new Map<string,unknown>(); let writes=0, refuseAt=Infinity;
  const storage={read:(key:string)=>records.get(key),write(key:string,value:unknown){if(++writes===refuseAt)return false;records.set(key,structuredClone(value));return true;}};
  const c=new TaskNavigationController(scope,storage,()=>snapshot); c.open(task,{route:'home',label:'Reminders',reminderReturn:original});
  records.set(reminderViewKey(scope),{...readReminderView(undefined,scope),original});
  let prepared:PreparedReminderReturn|undefined, returned=0, navigation=4;
  const render=()=>TaskWorkspace({workspace:{state:c.state,task:c.selected,controller:c,close:()=>c.close()} as any,snapshot,async refresh(){},openOrigin(){},
    canClose(){try{prepared=retainReminderReturn(original,scope,navigation,storage);return true;}catch{return false;}},
    closed(){assert.equal(preparedReminderReturnMatches(prepared,original,scope,navigation),true);returned++;navigation++;}}) as any;
  writes=0;refuseAt=1;render().props.close();assert.equal(c.state?.active,true);assert.equal(returned,0);
  writes=0;refuseAt=2;render().props.close();assert.equal(c.state?.active,true);assert.equal(returned,0);
  assert.equal(readReminderView(records.get(reminderViewKey(scope)),scope).original?.token,original.token);
  writes=0;refuseAt=3;render().props.close();assert.equal(c.state?.active,false);assert.equal(returned,1);assert.equal(writes,2);
  assert.equal(preparedReminderReturnMatches(prepared,original,scope,navigation),false);
  assert.equal(preparedReminderReturnMatches(prepared,{...original,token:randomUUID()},scope,4),false);
  assert.equal(preparedReminderReturnMatches(prepared,original,{...scope,epoch:randomUUID()},4),false);
});

test('a retained old TaskWorkspace finish cannot prepare or close a newly opened task', () => {
  const original={id:'task:original',revision:1,value:{title:'Original'}} as Entity<Task>, newer={...original,id:'task:newer'};
  const state={active:true,token:'old-token',origin:{route:'home' as const,label:'Reminders'},frames:[{taskId:original.id,section:'details',scroll:0}]};
  let current=state, preparations=0, closes=0, returned=0;
  const workspace={state,task:original,controller:{get state(){return current;}},close(){closes++;current.active=false;return true;}} as any;
  const old=TaskWorkspace({workspace,snapshot:{} as Snapshot,async refresh(){},closed(){returned++;},openOrigin(){},canClose(){preparations++;return false;}}) as any;
  old.props.close();assert.equal(preparations,1);
  current={...state,token:'new-token',frames:[{...state.frames[0],taskId:newer.id}]};
  old.props.close();assert.equal(preparations,1);assert.equal(closes,0);assert.equal(returned,0);assert.equal(current.active,true);assert.equal(current.frames[0].taskId,newer.id);
});

test('late Calendar lookup cannot open a replaced target, and exact epoch/date/return identity is required', async () => {
  const scope={epoch:randomUUID(),deviceId:'device',windowId:'window'}, origin:ReminderReturn={...scope,token:randomUUID(),reminderId:randomUUID(),kind:'calendar',id:'event:series',originalDate:'2026-10-19',from:'home'};
  const target={nonce:randomUUID(),eventId:origin.id,originalDate:origin.originalDate,reminderReturn:origin};
  const view={...readReminderView(undefined,scope),original:origin}, detail={epoch:scope.epoch,event:{id:origin.id},occurrence:{originalDate:origin.originalDate}} as LocalCalendarDetail;
  let current=true, release!:(value:LocalCalendarDetail)=>void;
  const pending=resolveLocalCalendarTarget(target,scope,()=>current,()=>new Promise(resolve=>{release=resolve;}),()=>view);
  current=false;release(detail);assert.equal(await pending,undefined);
  current=true;assert.equal(await resolveLocalCalendarTarget(target,scope,()=>current,async()=>detail,()=>view),detail);
  await assert.rejects(resolveLocalCalendarTarget(target,scope,()=>true,async()=>({...detail,epoch:'different'}),()=>view),/Reconnect/);
  await assert.rejects(resolveLocalCalendarTarget(target,scope,()=>true,async()=>({...detail,occurrence:{...detail.occurrence!,originalDate:'2026-10-20'}}),()=>view),/original occurrence/);
  await assert.rejects(resolveLocalCalendarTarget(target,scope,()=>true,async()=>detail,()=>({...view,original:{...origin,token:randomUUID()}})),/retained reminder/);
});

test('Calendar target storage refusal preserves the existing exact target and sends no navigation event', t => {
  const records=new Map([[calendarTargetKey('device','window'),JSON.stringify({nonce:'existing',eventId:'event:existing'})]]);let events=0;
  globals(t,{localStorage:{getItem:(key:string)=>records.get(key),setItem(){throw Error('Full');}},window:{dispatchEvent(){events++;}}});
  assert.throws(()=>keepCalendarTarget('device','window','event:new','2026-10-20'),/storage/);assert.equal(events,0);
  assert.equal(JSON.parse(records.get(calendarTargetKey('device','window'))!).eventId,'event:existing');
});
