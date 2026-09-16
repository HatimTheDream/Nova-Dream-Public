import test from 'node:test';
import assert from 'node:assert/strict';
import { boardroomSeats, emptyHubLayout, reconcileHubLayout, roomTemplates } from '../packages/domain/hub-layout';
import { buildHubNavigation, findHubPath, hubWalkable } from '../packages/domain/hub-navigation';
import { advanceHubActor, createHubActor, sendHubActor } from '../packages/domain/hub-actors';
import { turnToward } from '../packages/domain/lynx-motion';

test('legacy shared studios become individual offices without losing room IDs or furnishings',()=>{
 const old=emptyHubLayout();old.rooms.push({id:'room:old',name:'Existing studio',template:'studio',x:33,y:3,kit:'studio-v1',furniture:{'desk-0':'birch-desk','corner-right':'plant'}});old.placements={a:{roomId:'room:old',desk:0},b:{roomId:'room:old',desk:1}};
 let n=0;const agents=[{id:'a',name:'A',archived:false},{id:'b',name:'B',archived:false},{id:'c',name:'C',archived:false}],next=reconcileHubLayout(old,agents,()=>`room:new-${++n}`);
 assert.equal(next.rooms.find(r=>r.id==='room:old')?.template,'private');assert.deepEqual(next.rooms.find(r=>r.id==='room:old')?.furniture,old.rooms[1].furniture);
 assert.equal(new Set(Object.values(next.placements).map(p=>p.roomId)).size,3);
 for(const p of Object.values(next.placements))assert.equal(next.rooms.find(r=>r.id===p.roomId)?.template,'private');
 assert.equal(next.rooms.filter(r=>r.template==='boardroom').length,1);
 assert.equal(reconcileHubLayout(next,agents,()=>`room:new-${++n}`),next);
 for(const a of next.rooms)for(const b of next.rooms)if(a.id!==b.id){const t=roomTemplates[a.template],u=roomTemplates[b.template];assert(a.x+t.width<=b.x||b.x+u.width<=a.x||a.y+t.height<=b.y||b.y+u.height<=a.y);}
});
test('all twelve boardroom chairs are reachable from a private office without crossing the table',()=>{
 let n=0;const layout=reconcileHubLayout(undefined,[{id:'a',name:'A',archived:false}],()=>`room:${++n}`),grid=buildHubNavigation(layout),actor=createHubActor('a',layout,grid)!;
 const room=layout.rooms.find(r=>r.template==='boardroom')!,seats=boardroomSeats(room);assert.equal(seats.length,12);
 assert.equal(hubWalkable(grid,{x:room.x+26,y:room.y+11}),false);
 for(const seat of seats){assert(hubWalkable(grid,seat));assert(findHubPath(grid,actor.point,seat).length,seat.id);}
});
test('a seated agent stands, travels through the door, faces its chair and sits before speaking',()=>{
 let n=0;const layout=reconcileHubLayout(undefined,[{id:'a',name:'A',archived:false}],()=>`room:${++n}`),grid=buildHubNavigation(layout),seat=boardroomSeats(layout.rooms.find(r=>r.template==='boardroom')!)[0];
 let actor=sendHubActor(createHubActor('a',layout,grid)!,grid,seat,'meeting',seat.direction,true);
 assert.equal(actor.motion,'stand-up');const seen=new Set<string>();
 for(let i=0;i<4000;i++){actor=advanceHubActor(actor,grid,.05,false,true);seen.add(actor.motion);assert(hubWalkable(grid,actor.point));if(actor.motion==='seated-talk')break;}
 assert(seen.has('walk'));assert(seen.has('sit-down'));assert.equal(actor.motion,'seated-talk');assert.equal(actor.direction,seat.direction);assert(Math.hypot(actor.point.x-seat.x,actor.point.y-seat.y)<.01);
});
test('turns advance one heading and reduced motion still reaches the same seated destination',()=>{
 assert.equal(turnToward('N','S'),'NE');assert.equal(turnToward('N','NW'),'NW');
 let n=0;const layout=reconcileHubLayout(undefined,[{id:'a',name:'A',archived:false}],()=>`room:${++n}`),grid=buildHubNavigation(layout),initial=createHubActor('a',layout,grid)!;
 let actor=sendHubActor(initial,grid,initial.point,'meeting','S',true);
 for(let i=0;i<5;i++)actor=advanceHubActor(actor,grid,.05,false,false,true);
 assert.equal(actor.motion,'seated-idle');assert.equal(actor.direction,'S');
});

test('partners wait for each other and leave a social conversation together', async () => {
 const {hubConversation}=await import('../packages/domain/hub-actors');
 const make=(id:string)=>({id,intent:'chat',path:[],direction:'E',facing:'E',motion:'listen'} as unknown as import('../packages/domain/hub-actors').HubActor);
 const pair=[make('a'),make('b')];pair[1].path=[{x:5,y:5}];pair[1].motion='walk';
 assert.equal(hubConversation(pair,['a','b'],undefined,10).state,'waiting');
 pair[1].path=[];pair[1].motion='listen';const arrival=hubConversation(pair,['a','b'],undefined,30);assert.equal(arrival.state,'talking');assert.equal(arrival.started,30);
 assert.equal(hubConversation(pair,['a','b'],arrival.started,41).state,'talking');assert.equal(hubConversation(pair,['a','b'],arrival.started,42).state,'done');
 pair[1].intent='meeting';assert.equal(hubConversation(pair,['a','b'],arrival.started,35).state,'done');
});
