import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/service/store';
import {CalendarService} from '../apps/service/calendar';
import {accountCapabilities,Providers} from '../apps/service/providers';
import {startServer} from '../apps/service/http';
import {calendarFollowupSchema,followupEventValue,type CalendarFollowupCommand} from '../packages/domain/calendar-followups';
import {localEventInterval} from '../packages/domain/calendar-time';
import {createInboxFollowups,nextFollowupProposal} from '../apps/client/src/dreamclaw/inbox-followups';
import {createCalendarEditor,formForDraft} from '../apps/client/src/dreamclaw/calendar-editor';
import type {EventDraft} from '../apps/client/src/calendar-edit';
function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'e3-calendar-followups-'));let store=new Store(directory);
 const accounts=(['google','microsoft'] as const).map(provider=>({id:provider+'-account',generation:randomUUID(),provider,state:'connected',capabilities:{...accountCapabilities(provider,[]),mailRead:true}}));
 const authority={state:()=>({accounts,clients:[],attempts:[],probes:[]}),calendarSources:async()=>{throw Error('No provider Calendar request');},calendarEvents:async()=>{throw Error('No provider Calendar request');}} as any;
 let calendar=new CalendarService(store,authority);
 t.after(async()=>{await calendar.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const command=(index=0):CalendarFollowupCommand=>({requestId:randomUUID(),epoch:store.epoch,source:{provider:accounts[index].provider,accountId:accounts[index].id,threadId:'same-thread'},generation:accounts[index].generation,title:'Follow up: original email',notes:'From: Maya\nKeep the original email summary.',startAt:'2026-09-10T00:00:00.000Z',endAt:'2026-09-10T00:30:00.000Z',timezone:'America/Los_Angeles',reminderMinutes:30,deliveryChannel:'last'});
 return {get store(){return store;},get calendar(){return calendar;},accounts,command,async restart(){await calendar.close();store.close();store=new Store(directory);calendar=new CalendarService(store,authority);}};
}

test('both original Inbox accounts create local follow-ups once, recover exact receipts and retain later Calendar edits',async t=>{
 const f=fixture(t),commands=[f.command(),f.command(1)],created=commands.map(cmd=>f.calendar.saveFollowup('first-device',cmd));
 assert.notEqual(created[0].event.id,created[1].event.id);for(const [i,item] of created.entries())assert.deepEqual(f.calendar.readLocal(item.event.id).mailSource,commands[i].source);assert.equal(f.store.internalList('calendar:local:').length,2);
 const original=created[0].event;
 const changed=f.calendar.saveLocal('other-device',{requestId:randomUUID(),epoch:f.store.epoch,eventId:original.id,expectedRevision:1,value:{...original.value,title:'Edited in the original Calendar',start:{date:'2026-09-11',time:'10:00'},end:{date:'2026-09-11',time:'10:30'}},scope:'event'});
 const duplicate=f.calendar.saveFollowup('other-device',{...commands[0],requestId:randomUUID(),title:'Must not overwrite the saved event'});assert.equal(duplicate.created,false);assert.deepEqual(duplicate.event,changed);
 await f.restart();assert.deepEqual(f.calendar.readLocal(original.id).mailSource,commands[0].source);assert.deepEqual(f.calendar.saveFollowup('first-device',commands[0]),created[0]);assert.equal(f.store.internalList('calendar:local:').length,2);assert.equal(f.store.snapshot('first-device').tasks.length,0);
 assert.throws(()=>f.calendar.saveFollowup('other-device',commands[0]),/different work/);
 assert.throws(()=>f.calendar.saveFollowup('first-device',{...commands[0],title:'Changed replay'}),/different work/);
 assert.throws(()=>f.calendar.saveFollowup('first-device',{...commands[0],requestId:randomUUID(),epoch:randomUUID()}),/workspace changed/);
});

test('planning another follow-up preserves the previous event and requires its current identity and account generation',t=>{
 const f=fixture(t),cmd=f.command(),first=f.calendar.saveFollowup('a',cmd).event;
 assert.throws(()=>f.calendar.saveFollowup('a',{...cmd,requestId:randomUUID(),generation:randomUUID(),after:{eventId:first.id,revision:1}}),/Refresh this mail account/);
 const next=f.calendar.saveFollowup('a',{...cmd,requestId:randomUUID(),startAt:'2026-09-11T00:00:00.000Z',endAt:'2026-09-11T00:30:00.000Z',after:{eventId:first.id,revision:1}}).event;
 assert.notEqual(next.id,first.id);assert.equal(f.calendar.readLocal(first.id).event.revision,1);for(const event of [first,next])assert.deepEqual(f.calendar.readLocal(event.id).mailSource,cmd.source);
 assert.throws(()=>f.calendar.saveFollowup('a',{...cmd,requestId:randomUUID(),after:{eventId:first.id,revision:1}}),/follow-up changed/);
 f.accounts[0].state='disconnected';assert.equal(f.calendar.saveFollowup('a',{...cmd,requestId:randomUUID()}).event.id,next.id);
 assert.throws(()=>f.calendar.saveFollowup('a',{...cmd,requestId:randomUUID(),source:{...cmd.source,threadId:'new-thread'}}),/Refresh this mail account/);
});

test('follow-up instants retain their date, midnight crossing and exact side of a daylight-saving overlap',t=>{
 const f=fixture(t),cmd=f.command();
 const value=followupEventValue({...cmd,timezone:'Asia/Tokyo'});assert.deepEqual(value.start,{date:'2026-09-10',time:'09:00'});
 const midnight=followupEventValue({...cmd,startAt:'2026-09-10T06:45:00.000Z',endAt:'2026-09-10T07:15:00.000Z'});assert.equal(midnight.start.date,'2026-09-09');assert.equal(midnight.end.date,'2026-09-10');
 for(const startAt of ['2026-11-01T08:15:00.000Z','2026-11-01T09:15:00.000Z']){const endAt=new Date(Date.parse(startAt)+1800000).toISOString(),v=followupEventValue({...cmd,startAt,endAt});assert.deepEqual(localEventInterval(v).interval,{kind:'instant',start:startAt,end:endAt,timezone:cmd.timezone});}
 assert.equal(calendarFollowupSchema.safeParse({...cmd,startAt:'2026-09-10T00:00:01.000Z'}).success,false);
 assert.throws(()=>f.calendar.saveFollowup('a',{...cmd,endAt:cmd.startAt}));assert.equal(f.store.internalList('calendar:local:').length,0);
});

test('lost follow-up responses and cloned windows reuse the admitted request while storage failure admits nothing',async t=>{
 const f=fixture(t),records=new Map<string,any>(),disk={read:(key:string)=>structuredClone(records.get(key)),write:(key:string,value:any)=>{records.set(key,structuredClone(value));return true;}};
 let calls=0;const inputs:any[]=[];const send=async(command:CalendarFollowupCommand)=>{calls++;inputs.push(command);const result=f.calendar.saveFollowup('a',command);if(calls===1)throw Error('Lost response after commit');return result;};
 const scope={epoch:f.store.epoch,deviceId:'a',windowId:'one'},first=createInboxFollowups(scope,send,disk),cmd=f.command();await assert.rejects(first.schedule(cmd),/Lost response/);
 const source=Object.keys(first.store.getState().records)[0],cloned=createInboxFollowups({...scope,windowId:'two',previousWindowId:'one'},send,disk);const recovered=await cloned.retry(source);assert.deepEqual(inputs[0],inputs[1]);assert.equal(f.store.internalList('calendar:local:').length,1);assert.equal(recovered.event.value.notes,cmd.notes);assert.throws(()=>first.forget(source),/Check this follow-up/);cloned.forget(source);assert.equal(Object.keys(cloned.store.getState().records).length,0);await cloned.schedule(cmd);assert.equal(f.store.internalList('calendar:local:').length,1);
 const blocked=createInboxFollowups({...scope,windowId:'full'},send,{read:()=>undefined,write:()=>false});assert.throws(()=>blocked.schedule(cmd),/Free browser storage/);assert.equal(calls,3);
});

function localStorageFixture(t:TestContext){const records=new Map<string,string>();const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>records.get(k)??null,setItem:(k:string,v:string)=>records.set(k,v)}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');});return records;}
test('opening a saved follow-up parks an unconfirmed original Calendar draft and restores exact writing after reload',t=>{
 const f=fixture(t),records=localStorageFixture(t),event=f.calendar.saveFollowup('a',f.command()).event;
 const current:EventDraft={id:randomUUID(),epoch:f.store.epoch,revision:0,value:{...event.value,title:'Independent Calendar writing'}};
 current.pending={requestId:randomUUID(),epoch:current.epoch,eventId:current.id,expectedRevision:0,value:current.value};
 records.set('e3:calendar:a:one',JSON.stringify({draft:current,editorOpen:true,retainedRefresh:{requestId:'keep-me'}}));
 const options={epoch:f.store.epoch,deviceId:'a',windowId:'one',timezone:'America/Los_Angeles',findLocal(){throw Error('Not used');},async changed(){}};
 const editor=createCalendarEditor(options);editor.getState().openSaved(f.calendar.readLocal(event.id));assert.equal(editor.getState().draft?.id,event.id);assert.deepEqual(editor.getState().keptDrafts,[current]);
 editor.getState().keepForm({...formForDraft(editor.getState().draft!),title:'Edited follow-up writing'});editor.getState().close();
 const resumed=createCalendarEditor(options);resumed.getState().resumeKept(current.id);assert.deepEqual(resumed.getState().draft,current);assert.equal(resumed.getState().keptDrafts[0].originalForm?.title,'Edited follow-up writing');assert.equal(JSON.parse(records.get('e3:calendar:a:one')!).retainedRefresh.requestId,'keep-me');
 t.mock.method(globalThis.localStorage,'setItem',()=>{throw Error('full');});assert.throws(()=>resumed.getState().openSaved(f.calendar.readLocal(event.id)),/Free browser storage/);assert.deepEqual(resumed.getState().draft,current);
});

test('Calendar follow-up HTTP saves require the private session and origin, with no provider request',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'e3-calendar-followup-http-'));let calls=0;const server=await startServer({directory,port:0,providers:new Providers((async()=>{calls++;throw Error('No provider request');}) as typeof fetch)});
 try{const session=await fetch(server.origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1'},body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0];await session.json();const generation=randomUUID(),accountId='fixture-account';server.store.internalWrite('accounts:item:'+accountId,{id:accountId,generation,provider:'google',state:'connected',scopes:[],capabilities:{mailRead:true}});
 const command={requestId:randomUUID(),epoch:server.store.epoch,source:{provider:'google',accountId,threadId:'original-thread'},generation,title:'Inbox follow-up',notes:'Original context',startAt:'2026-09-10T00:00:00.000Z',endAt:'2026-09-10T00:30:00.000Z',timezone:'America/Los_Angeles'};
 const send=(headers:Record<string,string>={})=>fetch(server.origin+'/api/calendar/followups',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Edition3-Client':'1',...headers},body:JSON.stringify(command)});
 assert.equal((await send({cookie:''})).status,401);assert.equal((await send({origin:'https://foreign.example'})).status,403);assert.equal((await send({'X-Edition3-Client':''})).status,403);
 const response=await send();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const result=await response.json();assert.deepEqual(await (await send()).json(),result);assert.equal(server.store.internalList('calendar:local:').length,1);assert.equal(calls,0);
 const sourceUrl=server.origin+'/api/calendar/local/'+result.event.id;assert.equal((await fetch(sourceUrl)).status,401);const detailResponse=await fetch(sourceUrl,{headers:{cookie}});assert.equal(detailResponse.headers.get('cache-control'),'no-store');const detail=await detailResponse.json();assert.deepEqual(detail.mailSource,command.source);assert.equal(detail.epoch,server.store.epoch);assert.equal(calls,0);
 }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});

test('another follow-up uses the current Calendar title, notes, timezone and time instead of stale Inbox defaults',t=>{
 const f=fixture(t),command=f.command(),result=f.calendar.saveFollowup('a',command);result.event.value={...result.event.value,title:'Revised plan',notes:'Revised context',timezone:'Asia/Tokyo',start:{date:'2026-09-12',time:'11:00'},end:{date:'2026-09-12',time:'12:00'}};
 const proposal=nextFollowupProposal({command,pending:false,result},Date.parse('2026-09-08T00:00:00Z'));
 assert.equal(proposal.title,'Revised plan');assert.equal(proposal.notes,'Revised context');assert.equal(proposal.timezone,'Asia/Tokyo');assert.equal(proposal.startAt,'2026-09-13T02:00:00.000Z');assert.equal(proposal.endAt,'2026-09-13T02:30:00.000Z');
});
