import {test} from 'node:test';import assert from 'node:assert/strict';
import {locateHistoryPosition} from '../apps/service/history-position.js';
const messages=Array.from({length:10000},(_,i)=>({id:`message-${i}`,__openclaw:{id:`message-${i}`,seq:i*3+42,transcriptPosition:{source:'current-source'}}}));
const page=(offset:number)=>({sessionId:'native',offset,totalMessages:messages.length,hasMore:offset+100<messages.length,nextOffset:offset+100,messages:messages.slice(Math.max(0,messages.length-offset-100),messages.length-offset)});
test('locates an exact message in a bounded ordinary page without treating sequence as offset',async()=>{
 const calls:number[]=[];const id='message-712',around={sessionId:'native',messages:messages.slice(662,762)};
 const found=await locateHistoryPosition(around,id,async offset=>{calls.push(offset);return page(offset);});
 assert.ok(found.messages.some((m:any)=>m.id===id));assert.ok(found.offset>0);assert.ok(calls.length<12);assert.equal(found.totalMessages,10000);
 const tail=await locateHistoryPosition({sessionId:'native',messages:messages.slice(-100)},'message-9999',async offset=>page(offset));assert.equal(tail.offset,0);
});
test('does not restore a nearby message after transcript replacement, growth or source change',async()=>{
 const id='message-712',around={sessionId:'native',messages:messages.slice(662,762)};
 await assert.rejects(locateHistoryPosition(around,id,async offset=>({...page(offset),sessionId:'replacement'})),{code:'session_replaced'});
 let reads=0;await assert.rejects(locateHistoryPosition(around,id,async offset=>({...page(offset),totalMessages:reads++?10001:10000})),{code:'history_position_changed'});
 await assert.rejects(locateHistoryPosition(around,id,async offset=>({...page(offset),messages:page(offset).messages.map(m=>({...m,__openclaw:{...m.__openclaw,transcriptPosition:{source:'other-source'}}}))})),{code:'history_position_unavailable'});
 await assert.rejects(locateHistoryPosition(around,id,async offset=>({...page(offset),messages:page(offset).messages.filter(m=>m.id!==id)})),{code:'history_position_unavailable'});
});
