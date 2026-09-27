import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHubRoom, emptyHubLayout, roomFurniture } from '../packages/domain/hub-layout';
import { buildHubNavigation, findHubPath, hubWalkable, moveOnHubPath } from '../packages/domain/hub-navigation';
import { directionFromVector, lynxDirections, motionPhase } from '../packages/domain/lynx-motion';

test('all eight headings use screen-space movement and stop retains the last facing', () => {
  const vectors = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  assert.deepEqual(vectors.map(([x,y]) => directionFromVector(x,y)), lynxDirections);
  assert.equal(directionFromVector(0,0,'NW'),'NW'); assert.equal(directionFromVector(NaN,1,'E'),'E');
  assert.equal(motionPhase('sit-down',999).seated,1); assert.equal(motionPhase('stand-up',999).seated,0);
  assert.equal(motionPhase('walk',4,true).step,0); assert.equal(motionPhase('wave',4,true).wave,0);
});
test('all room kits connect through actual doors, with furniture and walls blocking navigation', () => {
  const layout = emptyHubLayout();
  for (let i=0;i<15;i++) appendHubRoom(layout, (['studio','private','meeting'] as const)[i%3], `Room ${i}`, `room:${i}`);
  const grid = buildHubNavigation(layout), start = { x:17.5,y:17.5 };
  assert.ok(hubWalkable(grid,start));
  for (const room of layout.rooms) {
    const goal = { x:room.x+5.5,y:room.y+13.5 }, path = findHubPath(grid,start,goal);
    assert.ok(path.length,room.name); assert.ok(path.every(p=>hubWalkable(grid,p)));
    const travel = moveOnHubPath(start,path,10000); assert.deepEqual(travel.point,path.at(-1)); assert.equal(travel.path.length,0);
    assert.equal(hubWalkable(grid,{x:room.x,y:room.y+8}),false);
    for (const item of roomFurniture(room)) if (item.kind !== 'none' && !item.kind.endsWith('-rug')) assert.equal(hubWalkable(grid,{x:room.x+item.x,y:room.y+item.y}),false);
  }
});
test('diagonal navigation cannot cut a closed corner and movement consumes only its distance budget', () => {
  const grid = { width:3,height:3,floor:new Uint8Array([1,0,0,0,1,1,0,1,1]) };
  assert.deepEqual(findHubPath(grid,{x:.5,y:.5},{x:1.5,y:1.5}),[]);
  const step=moveOnHubPath({x:0,y:0},[{x:3,y:4},{x:6,y:8}],2.5);
  assert.deepEqual(step.point,{x:1.5,y:2}); assert.equal(step.path.length,2);
});
