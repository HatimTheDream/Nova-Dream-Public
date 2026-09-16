import { useEffect, useMemo, useRef, useState } from 'react';
import { advanceHubActor, actorSeed, createHubActor, hubConversation, hubWalkSpeed, meetingDestinations, officeAnchor, sendHubActor, type HubActor } from '../../../../../packages/domain/hub-actors';
import { buildHubNavigation } from '../../../../../packages/domain/hub-navigation';
import type { HubLayout } from '../../../../../packages/domain/hub-layout';
import type { HubMember } from '../../../../../packages/domain/agent-hub';
import type { HubMeeting } from '../../../../../packages/domain/hub-meetings';
import { resolveLynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { PixelLynx } from './PixelLynx';
import { Portrait } from '../lynx-portrait/Portrait';

const populationCache=new Map<string,{revision:number;actors:Map<string,HubActor>;chat:string[]}>();
export type HubInteraction={id:string;agentId:string;type:'hello'|'coffee'|'chat'|'office'};
export function HubPopulation({layout,roster,scale,selected,stale,pick,meeting,interaction,persistenceKey}:{layout:HubLayout;roster:HubMember[];scale:number;selected?:string;stale:boolean;pick:(member:HubMember,element:HTMLElement)=>void;meeting:HubMeeting|null;interaction?:HubInteraction;persistenceKey:string}){
  const grid=useMemo(()=>buildHubNavigation(layout),[layout.revision]);
  const geometry=JSON.stringify(layout.rooms.map(r=>[r.id,r.x,r.y,r.template])),previousGeometry=useRef(geometry);
  const actors=useRef(populationCache.get(persistenceKey)?.revision===layout.revision?new Map(populationCache.get(persistenceKey)!.actors):new Map<string,HubActor>()), latest=useRef({roster,meeting,interaction,stale});latest.current={roster,meeting,interaction,stale};
  const [poses,setPoses]=useState<HubActor[]>([]), command=useRef(''), breaks=useRef(new Map<string,number>()), chat=useRef<string[]>(populationCache.get(persistenceKey)?.chat??[]), holds=useRef(new Map<string,number>());
  useEffect(()=>{
    if(previousGeometry.current!==geometry){actors.current.clear();chat.current=[];holds.current.clear();previousGeometry.current=geometry;}
    const live=new Set(roster.map(a=>a.id));
    for(const id of actors.current.keys())if(!live.has(id))actors.current.delete(id);
    for(const a of roster)if(!actors.current.has(a.id)){const pose=createHubActor(a.id,layout,grid);if(pose)actors.current.set(a.id,pose);}
    for(const [id,a] of actors.current){if(a.intent==='office'){const target=officeAnchor(layout,id);if(target&&Math.hypot(target.x-a.target.x,target.y-a.target.y)>.1)actors.current.set(id,sendHubActor(a,grid,target,'office','N',true));}}
  },[roster.map(a=>a.id).join(','),grid]);
  useEffect(()=>{
    let frame=0,previous=performance.now(),lastPaint=0,time=0;holds.current.clear();breaks.current.clear();
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const route=(id:string,target:{x:number;y:number},intent:HubActor['intent'],facing:HubActor['facing'],seated=false)=>{holds.current.delete(id);const a=actors.current.get(id);if(a)actors.current.set(id,sendHubActor(a,grid,target,intent,facing,seated));};
    const home=(id:string)=>{const point=officeAnchor(layout,id);if(point){route(id,point,'office','N',true);breaks.current.set(id,time+25+actorSeed(id)*45);}};
    const tick=(now:number)=>{
      const dt=Math.min(.06,(now-previous)/1000);previous=now;
      if(document.hidden){frame=requestAnimationFrame(tick);return;}time+=dt;
      const {roster:members,meeting:m,interaction:action,stale:unavailable}=latest.current;
      const attending=m&&m.state!=='ended'?meetingDestinations(layout,m.roomId,m.attendees.map(a=>a.id)):[];
      const attendees=new Set(attending.map(a=>a.id));
      for(const seat of attending){const a=actors.current.get(seat.id);if(a&&(a.intent!=='meeting'||Math.hypot(a.target.x-seat.x,a.target.y-seat.y)>.1))route(a.id,seat,'meeting',seat.direction,true);}
      for(const a of actors.current.values())if(a.intent==='meeting'&&!attendees.has(a.id))home(a.id);
      if(action&&action.id!==command.current){
        command.current=action.id;const member=members.find(a=>a.id===action.agentId),a=actors.current.get(action.agentId);
        if(a&&member&&!attendees.has(a.id)&&member.status!=='working'&&!unavailable){
          if(action.type==='office')home(a.id);
          else if(action.type==='hello')route(a.id,a.point,'hello','S');
          else if(action.type==='coffee'){const common=layout.rooms.find(r=>r.template==='commons');if(common){const index=members.findIndex(p=>p.id===a.id)%4;route(a.id,{x:common.x+19.5-(index%2)*4,y:common.y+8.5+Math.floor(index/2)*4},'coffee','N');}}
          else {const partner=members.find(p=>p.id!==a.id&&p.status==='idle'&&!attendees.has(p.id)),common=layout.rooms.find(r=>r.template==='commons');if(partner&&common){for(const old of chat.current)if(old!==a.id&&old!==partner.id)home(old);holds.current.delete('chat');chat.current=[a.id,partner.id];route(a.id,{x:common.x+11.5,y:common.y+11.5},'chat','E');route(partner.id,{x:common.x+15.5,y:common.y+11.5},'chat','W');}}
        }
      }
      if(chat.current.length){const conversation=hubConversation([...actors.current.values()],chat.current,holds.current.get('chat'),time);if(conversation.state==='done'){for(const id of chat.current)if(actors.current.get(id)?.intent==='chat')home(id);chat.current=[];holds.current.delete('chat');}else if(conversation.started!==undefined)holds.current.set('chat',conversation.started);}
      for(const member of members){
        let a=actors.current.get(member.id);if(!a)continue;
        const working=!unavailable&&member.status==='working';
        if(working&&!attendees.has(a.id)&&a.intent!=='office'){home(a.id);a=actors.current.get(a.id)!;}
        // Small independent breaks keep a quiet office alive, never changing work status.
        if(!breaks.current.has(a.id))breaks.current.set(a.id,25+actorSeed(a.id)*45);
        if(!reduced.matches&&!unavailable&&member.status==='idle'&&![...actors.current.values()].some(p=>p.intent==='coffee')&&a.intent==='office'&&!a.path.length&&a.motion==='seated-idle'&&time>breaks.current.get(a.id)!){
          breaks.current.set(a.id,time+80+actorSeed(a.id)*35);const common=layout.rooms.find(r=>r.template==='commons');
          if(common){route(a.id,{x:common.x+18.5+Math.floor(actorSeed(a.id)*3),y:common.y+8.5},'coffee','N');a=actors.current.get(a.id)!;}
        }
        if(['hello','coffee'].includes(a.intent)&&!a.path.length&&!['stand-up','walk'].includes(a.motion)){
          if(!holds.current.has(a.id))holds.current.set(a.id,time);
          if(time-holds.current.get(a.id)!>(a.intent==='hello'?2.4:7)){home(a.id);a=actors.current.get(a.id)!;}
        }
        const speaking=a.intent==='meeting'?m?.state==='running'&&m.turns[m.next]?.agentId===a.id&&working:a.intent==='chat'&&holds.current.has('chat')&&chat.current[Math.floor(time/2.4)%2]===a.id;
        const next=advanceHubActor(a,grid,dt,working,!!speaking,reduced.matches);
        actors.current.set(a.id,next);
      }
      if(now-lastPaint>40){lastPaint=now;setPoses([...actors.current.values()]);}
      frame=requestAnimationFrame(tick);
    };frame=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(frame);populationCache.set(persistenceKey,{revision:layout.revision,actors:new Map(actors.current),chat:[...chat.current]});};
  },[grid]);
  return <>{poses.map(a=>{
    const member=roster.find(m=>m.id===a.id);if(!member)return null;
    const lynx=resolveLynxAppearance(member.appearance),size=scale*6;
    const talking=['talk','seated-talk'].includes(a.motion),social=a.intent==='chat'||a.intent==='hello'||a.intent==='coffee';
    const activity=a.motion==='walk'?`Walking ${a.intent==='meeting'?'to the boardroom':a.intent==='office'?'to the office':a.intent==='coffee'?'to the coffee area':'to chat'}`:a.intent==='meeting'?talking?'Contributing to the discussion':'At the board table':a.intent==='chat'?'Social conversation':a.intent==='coffee'?'Coffee break':a.intent==='hello'?'Waving hello':member.reason;
    return <button key={a.id} className="pixel-hub-actor" aria-label={`${member.name}, ${member.position}. ${activity}. ${stale?'Status unavailable':member.reason}`} aria-pressed={selected===a.id} data-state={stale?'stale':member.status} data-motion={a.motion} data-direction={a.direction} data-intent={a.intent}
      style={{left:(a.point.x+(a.motion==='walk'&&['N','NE','NW'].includes(a.direction)?.3:a.motion==='walk'&&['S','SE','SW'].includes(a.direction)?-.3:0))*scale-size/2,top:a.point.y*scale-size*.9375,width:size,zIndex:Math.round(a.point.y*10)+1}} onClick={e=>pick(member,e.currentTarget)}>
      {lynx.status==='ready'?<PixelLynx recipe={lynx.recipe} direction={a.direction} motion={a.motion} elapsed={a.motion==='walk'?a.distance/hubWalkSpeed:undefined} phaseOffset={a.phase} expression={social?'happy':member.status==='working'?'focused':'neutral'} size={size}/>:<Portrait recipe={member.appearance} size="icon" accessibility={{mode:'decorative'}}/>}
      {talking&&<span className="hub-speech-bubble" aria-hidden="true"><b/><b/><b/></span>}{a.intent==='coffee'&&a.motion==='idle'&&<span className="hub-coffee-cup" aria-hidden="true"/>}
      <span className="hub-actor-label">{member.name}</span><i aria-hidden="true"/>
    </button>;
  })}</>;
}
