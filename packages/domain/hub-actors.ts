import { boardroomSeats, roomTemplates, type HubLayout } from './hub-layout.js';
import { findHubPath, hubWalkable, moveOnHubPath, nearestHubFloor, type HubNavigation, type HubPoint } from './hub-navigation.js';
import { directionFromVector, turnToward, type LynxDirection, type LynxMotion } from './lynx-motion.js';

export const hubWalkSpeed=3.2;
export type ActorIntent='office'|'meeting'|'coffee'|'chat'|'hello';
export type HubActor={id:string;point:HubPoint;direction:LynxDirection;motion:LynxMotion;intent:ActorIntent;path:HubPoint[];target:HubPoint;facing:LynxDirection;seated:boolean;elapsed:number;distance:number;phase:number;turnClock:number};
export function actorSeed(id:string){let n=0;for(const c of id)n=(n*31+c.charCodeAt(0))>>>0;return (n%997)/997;}
export function officeAnchor(layout:HubLayout,id:string){const p=layout.placements[id],room=layout.rooms.find(r=>r.id===p?.roomId),desk=room&&roomTemplates[room.template].desks[p.desk];return room&&desk?{x:room.x+desk.x+.5,y:room.y+desk.y+3.5}:undefined;}
export function createHubActor(id:string,layout:HubLayout,grid:HubNavigation):HubActor|undefined{const anchor=officeAnchor(layout,id),point=anchor&&nearestHubFloor(grid,anchor);return point?{id,point,direction:'N',motion:'seated-idle',intent:'office',path:[],target:point,facing:'N',seated:true,elapsed:0,distance:0,phase:actorSeed(id)*5,turnClock:0}:undefined;}
export function sendHubActor(actor:HubActor,grid:HubNavigation,target:HubPoint,intent:ActorIntent,facing:LynxDirection,seated=false):HubActor{
 const goal=nearestHubFloor(grid,target);if(!goal)return actor;
 const path=findHubPath(grid,actor.point,goal);if(!path.length&&Math.hypot(actor.point.x-goal.x,actor.point.y-goal.y)>.1)return actor;
 return {...actor,path,target:goal,intent,facing,seated,elapsed:0,distance:0,motion:actor.motion.startsWith('seated')||actor.motion==='read'?'stand-up':'idle'};
}
export function advanceHubActor(actor:HubActor,grid:HubNavigation,dt:number,working:boolean,speaking:boolean,reduced=false):HubActor{
 let a={...actor,elapsed:actor.elapsed+dt,turnClock:actor.turnClock+dt};
 if(a.motion==='stand-up'&&a.elapsed<.6&&!reduced)return a;
 if(a.path.length){
  const step=moveOnHubPath(a.point,a.path,hubWalkSpeed*dt);
  if(!hubWalkable(grid,step.point))return {...a,path:[],motion:'idle'};
  const distance=Math.hypot(step.point.x-a.point.x,step.point.y-a.point.y),targetDirection=directionFromVector(step.point.x-a.point.x,step.point.y-a.point.y,a.direction);
  a={...a,point:step.point,path:step.path,distance:a.distance+distance,motion:'walk',elapsed:0};
  if(a.turnClock>=.07){a.direction=turnToward(a.direction,targetDirection);a.turnClock=0;}
  return a;
 }
 if(a.direction!==a.facing){if(a.turnClock>=.09||reduced){a.direction=reduced?a.facing:turnToward(a.direction,a.facing);a.turnClock=0;}return {...a,motion:'idle',elapsed:0};}
 if(a.seated&&!['sit-down','seated-idle','seated-work','seated-talk','read'].includes(a.motion))return {...a,motion:'sit-down',elapsed:0};
 if(a.motion==='sit-down'&&a.elapsed<.6&&!reduced)return a;
 const motion:LynxMotion=a.intent==='meeting'?(speaking?'seated-talk':'seated-idle'):a.intent==='office'?(working?'seated-work':'seated-idle'):a.intent==='hello'?'wave':a.intent==='chat'?(speaking?'talk':'listen'):'idle';
 if(motion!==a.motion)a={...a,motion,elapsed:0};
 return a;
}
export function meetingDestinations(layout:HubLayout,roomId:string,ids:string[]){const room=layout.rooms.find(r=>r.id===roomId);return room?boardroomSeats(room).slice(0,ids.length).map((seat,i)=>({...seat,id:ids[i],seatId:seat.id})):[];}

/** A conversation starts when both partners arrive and ends for both together. */
export function hubConversation(actors:HubActor[],ids:string[],started:number|undefined,now:number):{state:'waiting'|'talking'|'done';started?:number}{
 const pair=ids.map(id=>actors.find(a=>a.id===id));
 if(pair.length!==2||pair.some(a=>!a||a.intent!=='chat'))return {state:'done'};
 if(pair.some(a=>a!.path.length||a!.direction!==a!.facing||['stand-up','walk'].includes(a!.motion)))return {state:'waiting'};
 const since=started??now;return {state:now-since>=12?'done':'talking',started:since};
}
