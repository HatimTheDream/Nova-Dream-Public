import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileHubLayout,appendHubRoom,roomDoors,roomTemplates,hubWorldSize,hubOfficeGrid,boardroomSeats} from '../packages/domain/hub-layout';
import {buildHubNavigation,findHubPath,hubWalkable} from '../packages/domain/hub-navigation';
import {officeAnchor} from '../packages/domain/hub-actors';
for(const count of [4,6,9,16,25,50])test(`${count} offices form a balanced campus around the central boardroom`,()=>{
 let id=0;const agents=Array.from({length:count},(_,i)=>({id:`a${i}`,name:`Agent ${i}`,archived:false}));
 const layout=reconcileHubLayout(undefined,agents,()=>`r${id++}`),grid=buildHubNavigation(layout),offices=layout.rooms.filter(r=>r.template==='private'),board=layout.rooms.find(r=>r.template==='boardroom')!;
 const shape=hubOfficeGrid(count);assert.equal(new Set(offices.map(r=>r.x)).size,shape.columns);assert.equal(new Set(offices.map(r=>r.y)).size,shape.rows);
 const size=hubWorldSize(layout);assert(size.width/size.height<1.8&&size.height/size.width<1.8,JSON.stringify(size));
 const centre={x:board.x+26,y:board.y+10};assert(Math.abs(centre.x-size.width/2)<3);assert(Math.abs(centre.y-size.height/2)<3);
 for(const a of layout.rooms)for(const b of layout.rooms)if(a.id!==b.id){const t=roomTemplates[a.template],u=roomTemplates[b.template];assert(a.x+t.width<=b.x||b.x+u.width<=a.x||a.y+t.height<=b.y||b.y+u.height<=a.y);}
 const seat=boardroomSeats(board)[0];
 for(const agent of agents){const start=officeAnchor(layout,agent.id)!;assert(hubWalkable(grid,start));const path=findHubPath(grid,start,seat);assert(path.length,agent.id);assert(path.every(p=>hubWalkable(grid,p)));}
 for(const door of roomDoors(board)){assert(hubWalkable(grid,door));assert(findHubPath(grid,officeAnchor(layout,agents[0].id)!,door).length);}
 const coffee=layout.rooms.find(r=>r.template==='commons')!;assert(findHubPath(grid,seat,{x:coffee.x+19.5,y:coffee.y+8.5}).length);
 assert.equal(reconcileHubLayout(layout,agents,()=>`r${id++}`),layout);
});
test('central routing keeps the board table and walls solid while all twelve chairs are reachable',()=>{
 let id=0;const layout=reconcileHubLayout(undefined,Array.from({length:9},(_,i)=>({id:`a${i}`,archived:false})),()=>`r${id++}`),grid=buildHubNavigation(layout),board=layout.rooms.find(r=>r.template==='boardroom')!;
 assert.equal(hubWalkable(grid,{x:board.x+26,y:board.y+11}),false);
 assert.equal(hubWalkable(grid,{x:board.x+5,y:board.y+.5}),false);
 for(const seat of boardroomSeats(board))assert(findHubPath(grid,officeAnchor(layout,'a0')!,seat).length,seat.id);
});
test('additional room kits keep their furnishings and remain connected after campus growth',()=>{
 let id=0;const agents=Array.from({length:4},(_,i)=>({id:`a${i}`,archived:false}));
 const original=reconcileHubLayout(undefined,agents,()=>`r${id++}`);
 for(const template of ['studio','meeting','boardroom','meeting'] as const){const room=appendHubRoom(original,template,`Custom ${id}`,`r${id++}`);room.furniture={'corner-left':'bookcase'};}
 const saved=original.rooms.map(({x,y,entry,...room})=>room),placements=structuredClone(original.placements);
 const grown=reconcileHubLayout(original,[...agents,...Array.from({length:5},(_,i)=>({id:`b${i}`,archived:false}))],()=>`r${id++}`),grid=buildHubNavigation(grown);
 assert.deepEqual(grown.rooms.slice(0,saved.length).map(({x,y,entry,...room})=>room),saved);
 for(const agent of agents)assert.deepEqual(grown.placements[agent.id],placements[agent.id]);
 for(const room of grown.rooms)assert(findHubPath(grid,officeAnchor(grown,'a0')!,{x:room.x+3.5,y:room.y+12.5}).length,room.name);
});
