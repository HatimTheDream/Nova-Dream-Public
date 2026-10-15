import { useEffect, useRef, useState, type RefObject } from 'react';
import type { HubMember } from '../../../../../packages/domain/agent-hub';
import type { HubMeetingState } from '../../../../../packages/domain/hub-meetings';
import type { AgentActivityState, AgentActivityEvent } from '../../../../../packages/domain/agent-activity';

export type HeadquartersPlace = 'office' | 'commons' | 'boardroom' | 'visit';
type Travel = { id: string; to: HeadquartersPlace; origin?: AgentActivityEvent['origin']; elapsed: number; started: number | null; startX: number; duration: number };
export type HeadquartersBubble = { speakerId: string; meetingId: string; text: string; fullText: string; fileId: string };
type Moving = { id: string; x: number; y: number; tilt: number; opacity: number };
const clip = (n:number,low:number,high:number)=>Math.max(low,Math.min(Math.max(low,high),n));
const excerpt=(text:string)=>{const clean=text.replace(/[`#*_]/g,'').replace(/\s+/g,' ').trim();return [...clean].length<=22?clean:[...clean].slice(0,21).join('')+'…';};

/** Ephemeral visual positions consume accepted service activity. They never
 * dispatch work or determine whether an actual agent is busy. */
export function useHeadquartersMotion(floor: RefObject<HTMLDivElement|null>, roster: HubMember[], activity: AgentActivityState|undefined, meetings: HubMeetingState|undefined, stale:boolean) {
  const [places,setPlaces]=useState<Record<string,HeadquartersPlace>>({}),[slots,setSlots]=useState<Record<string,number>>({}),[moving,setMoving]=useState<Moving|null>(null),[bubble,setBubble]=useState<HeadquartersBubble|null>(null),[wave,setWave]=useState(''),[visitor,setVisitor]=useState<{x:number;y:number}|null>(null);
  const locations=useRef<Record<string,HeadquartersPlace>>({}),reservations=useRef<Record<string,number>>({}),queue=useRef<Travel[]>([]),active=useRef<Travel|null>(null),frame=useRef(0),seen=useRef(new Set<string>()),seenReplies=useRef(new Set<string>()),initialized=useRef(false),lastMeeting=useRef(''),lastAttendees=useRef<string[]>([]),pendingSpeech=useRef<HeadquartersBubble[]>([]);
  const bubbleClock=useRef({timer:0,remaining:0,started:0}),waveTimer=useRef(0),waving=useRef(''),live=useRef({roster,activity,meetings,stale});live.current={roster,activity,meetings,stale};
  const visitedAgent=useRef(''),visitorPoint=useRef<{x:number;y:number}|null>(null);
  const lastMeetingState=useRef('');
  const api=useRef<{enqueue:(id:string,to:HeadquartersPlace,origin?:AgentActivityEvent['origin'])=>void;settle:(id:string,to:HeadquartersPlace)=>void;stop:(id:string)=>void;reset:()=>void;showSpeech:()=>void}|undefined>(undefined);
  useEffect(()=>{
    let disposed=false;
    const reduce=matchMedia('(prefers-reduced-motion: reduce)');
    const pref=(id:string)=>live.current.activity?.preferences.find(p=>p.agentId===id)?.value;
    const lane=()=>{
      const host=floor.current,hall=host?.querySelector<HTMLElement>('.hq-hallway');if(!host||!hall)return null;
      const base=host.getBoundingClientRect(),r=hall.getBoundingClientRect(),you=hall.querySelector('.hq-you')?.getBoundingClientRect(),manage=hall.querySelector('.hq-floor-settings')?.getBoundingClientRect();
      return {left:(you?you.right:r.left)+6-base.left,right:(manage?manage.left:r.right)-6-base.left,y:r.top-base.top+r.height/2+14};
    };
    const point=(id:string,to:HeadquartersPlace)=>{
      const host=floor.current;if(!host)return null;
      const selector=id==='you'&&to==='visit'?'[data-office-agent="'+CSS.escape(visitedAgent.current)+'"] .square-lynx':id==='you'?'.hq-you .square-lynx':to==='commons'?'[data-commons-agent="'+CSS.escape(id)+'"] .hq-commons-anchor':to==='boardroom'?'[data-seat-agent="'+CSS.escape(id)+'"] .hq-seat-anchor':'[data-office-agent="'+CSS.escape(id)+'"] .square-lynx';
      const node=host.querySelector<HTMLElement>(selector),base=host.getBoundingClientRect(),r=node?.getBoundingClientRect();return r?{x:r.left+r.width/2-base.left,y:r.bottom-base.top}:null;
    };
    const savePlaces=()=>setPlaces({...locations.current});
    const reserve=(id:string)=>{if(reservations.current[id]!==undefined)return;const used=new Set(Object.values(reservations.current));let next=0;while(used.has(next))next++;reservations.current[id]=next;setSlots({...reservations.current});};
    const release=(id:string)=>{if(reservations.current[id]!==undefined){delete reservations.current[id];setSlots({...reservations.current});}};
    const cancel=(id:string)=>{queue.current=queue.current.filter(t=>t.id!==id);if(active.current?.id===id){cancelAnimationFrame(frame.current);frame.current=0;active.current=null;setMoving(null);}};
    const settle=(id:string,to:HeadquartersPlace)=>{cancel(id);if(to==='commons')reserve(id);else release(id);locations.current[id]=to;if(id==='you'&&to==='visit')parkVisitor();savePlaces();};
    const armBubble=()=>{const clock=bubbleClock.current;if(document.hidden||live.current.stale||!clock.remaining||clock.timer)return;clock.started=performance.now();clock.timer=window.setTimeout(()=>{clock.timer=0;clock.remaining=0;setBubble(null);showSpeech();},clock.remaining);};
    const showSpeech=()=>{
      if(disposed||document.hidden||live.current.stale||active.current||queue.current.length||bubbleClock.current.timer||bubbleClock.current.remaining)return;
      while(pendingSpeech.current.length){const next=pendingSpeech.current.shift()!,discussion=[...(live.current.meetings?.history??[]),...(live.current.meetings?.current?[live.current.meetings.current]:[])].find(m=>m.id===next.meetingId);if(pref(next.speakerId)?.sleep!=='awake'||discussion?.attendees.some(a=>pref(a.id)?.sleep!=='awake'))continue;setBubble(next);bubbleClock.current.remaining=4200;armBubble();break;}
    };
    const paint=(request:Travel,elapsed:number)=>{
      const hall=lane();if(!hall||hall.right-hall.left<34)return false;
      const progress=clip(elapsed/request.duration,0,1),start=clip(request.startX,hall.left+16,hall.right-16),target=point(request.id,request.to),end=clip(target?.x??(hall.left+hall.right)/2,hall.left+16,hall.right-16),phase=elapsed/75;
      setMoving({id:request.id,x:start+(end-start)*progress,y:hall.y-(reduce.matches?0:Math.abs(Math.sin(phase))),tilt:reduce.matches?0:Math.sin(phase)*3,opacity:Math.min(1,progress*8,(1-progress)*8)});return true;
    };
    const parkVisitor=()=>{const hall=lane();if(!hall)return;visitorPoint.current={x:clip(point('you','visit')?.x??(hall.left+hall.right)/2,hall.left+16,hall.right-16),y:hall.y};setVisitor(visitorPoint.current);};
    const finish=(request:Travel)=>{if(active.current!==request)return;active.current=null;frame.current=0;setMoving(null);locations.current[request.id]=request.to;if(request.id==='you'&&request.to==='visit')parkVisitor();if(request.to!=='commons')release(request.id);savePlaces();pump();showSpeech();};
    const tick=(now:number)=>{const request=active.current;if(disposed||!request||document.hidden)return;if(request.started===null)request.started=now;const elapsed=request.elapsed+now-request.started;if(!paint(request,elapsed)||elapsed>=request.duration){finish(request);return;}frame.current=requestAnimationFrame(tick);};
    const pump=()=>{
      if(disposed||document.hidden||active.current||!queue.current.length||live.current.stale)return;
      const request=queue.current.shift()!,p=pref(request.id);
      if(request.id!=='you'&&(p?.sleep!=='awake'||p?.initiative==='on-request'&&request.origin==='initiative')){settle(request.id,'office');pump();return;}
      if(request.id!=='you'&&locations.current.you==='visit'){delete locations.current.you;visitorPoint.current=null;setVisitor(null);savePlaces();}
      const hall=lane(),start=request.id==='you'&&visitorPoint.current?visitorPoint.current:point(request.id,locations.current[request.id]??'office');
      if(reduce.matches||!hall||!start){settle(request.id,request.to);if(request.id==='you'&&request.to==='visit')parkVisitor();pump();return;}
      request.startX=start.x;request.duration=clip(Math.abs((point(request.id,request.to)?.x??hall.left)-start.x)*5,650,1400);request.started=null;request.elapsed=0;active.current=request;
      if(request.to!=='commons')release(request.id);setMoving({id:request.id,x:clip(start.x,hall.left+16,hall.right-16),y:hall.y,tilt:0,opacity:0});frame.current=requestAnimationFrame(tick);
    };
    const enqueue=(id:string,to:HeadquartersPlace,origin?:AgentActivityEvent['origin'])=>{
      if(disposed)return;if(to==='commons')reserve(id);cancel(id);
      if(document.hidden||reduce.matches){settle(id,to);if(id==='you'&&to==='visit')parkVisitor();return;}
      if((locations.current[id]??'office')===to){pump();return;}
      queue.current.push({id,to,origin,elapsed:0,started:null,startX:0,duration:0});pump();
    };
    const involves=(speech:HeadquartersBubble,id:string)=>speech.speakerId===id||[...(live.current.meetings?.history??[]),...(live.current.meetings?.current?[live.current.meetings.current]:[])].find(m=>m.id===speech.meetingId)?.attendees.some(a=>a.id===id);
    const stop=(id:string)=>{cancel(id);settle(id,'office');pendingSpeech.current=pendingSpeech.current.filter(b=>!involves(b,id));setBubble(current=>{if(!current||!involves(current,id))return current;clearTimeout(bubbleClock.current.timer);bubbleClock.current={timer:0,remaining:0,started:0};return null;});if(waving.current===id){clearTimeout(waveTimer.current);waving.current='';setWave('');}pump();showSpeech();};
    const reset=()=>{queue.current=[];active.current=null;cancelAnimationFrame(frame.current);frame.current=0;clearTimeout(bubbleClock.current.timer);bubbleClock.current={timer:0,remaining:0,started:0};clearTimeout(waveTimer.current);waveTimer.current=0;waving.current='';pendingSpeech.current=[];visitorPoint.current=null;visitedAgent.current='';locations.current={};reservations.current={};lastMeeting.current='';lastMeetingState.current='';lastAttendees.current=[];setMoving(null);setBubble(null);setWave('');setVisitor(null);setPlaces({});setSlots({});};
    api.current={enqueue,settle,stop,reset,showSpeech};
    const visibility=()=>{
      const request=active.current,clock=bubbleClock.current;
      if(document.hidden){if(request){cancelAnimationFrame(frame.current);frame.current=0;if(request.started!==null){request.elapsed+=performance.now()-request.started;request.started=null;}}if(clock.timer){clearTimeout(clock.timer);clock.remaining=Math.max(0,clock.remaining-performance.now()+clock.started);clock.timer=0;}}
      else{if(request)frame.current=requestAnimationFrame(tick);else pump();armBubble();showSpeech();}
    };
    const resize=new ResizeObserver(()=>{if(active.current){const t=active.current;paint(t,t.elapsed+(t.started===null?0:performance.now()-t.started));}else if(locations.current.you==='visit')parkVisitor();});if(floor.current)resize.observe(floor.current);
    document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;cancelAnimationFrame(frame.current);clearTimeout(bubbleClock.current.timer);clearTimeout(waveTimer.current);resize.disconnect();document.removeEventListener('visibilitychange',visibility);api.current=undefined;};
  },[floor]);
  useEffect(()=>{
    const events=activity?.events??[],prefs=activity?.preferences??[];
    if(stale){events.forEach(e=>seen.current.add(e.id));if(activity)initialized.current=true;return;}
    const apply=(event:AgentActivityEvent,instant=false)=>{
      const p=prefs.find(p=>p.agentId===event.agentId)?.value;if(p?.sleep!=='awake'&&event.action!=='wake'){api.current?.stop(event.agentId);return;}
      const to=event.action==='coffee'?'commons':event.action==='conversation'&&live.current.meetings?.current?.id===event.meetingId?'boardroom':event.action==='visit'?'visit':'office';
      if(event.action==='hello'){if(!instant&&!document.hidden){waving.current=event.agentId;setWave(event.agentId);clearTimeout(waveTimer.current);waveTimer.current=window.setTimeout(()=>{waving.current='';setWave('');},650);}return;}
      if(event.action==='wake')return;
      const id=event.action==='visit'?'you':event.agentId;
      if(event.action==='visit')visitedAgent.current=event.agentId;
      if(instant)api.current?.settle(id,to);else api.current?.enqueue(id,to,event.origin);
    };
    if(!initialized.current&&activity){initialized.current=true;const latest=new Map<string,AgentActivityEvent>();events.forEach(e=>{seen.current.add(e.id);latest.set(e.agentId,e);});latest.forEach(e=>apply(e,true));}
    else events.forEach(e=>{if(!seen.current.has(e.id)){seen.current.add(e.id);apply(e);}});
    if(seen.current.size>500)seen.current=new Set(events.map(e=>e.id));
    prefs.forEach(p=>{if(p.value.sleep!=='awake')api.current?.stop(p.agentId);else if(p.value.initiative==='on-request'&&active.current?.id===p.agentId&&active.current.origin==='initiative')api.current?.stop(p.agentId);});
  },[activity,stale]);
  useEffect(()=>{
    const current=meetings?.current,key=current?.id??'';
    const results=[...(meetings?.history??[]).slice(0,1),...(current?[current]:[])].flatMap(m=>m.turns.flatMap(t=>t.result?[{speakerId:t.agentId,meetingId:m.id,text:excerpt(t.result.text),fullText:t.result.text,fileId:t.result.fileId}]:[]));
    if(stale){results.forEach(r=>seenReplies.current.add(r.fileId));return;}
    const changed=key!==lastMeeting.current,resumed=current?.state==='running'&&lastMeetingState.current!=='running';
    if(changed){lastAttendees.current.filter(id=>!current?.attendees.some(a=>a.id===id)).forEach(id=>api.current?.enqueue(id,'office'));lastMeeting.current=key;lastAttendees.current=current?.attendees.map(a=>a.id)??[];}
    if(changed||resumed)current?.attendees.forEach(a=>{if(activity?.preferences.find(p=>p.agentId===a.id)?.value.sleep==='awake')api.current?.enqueue(a.id,'boardroom');});
    lastMeetingState.current=current?.state??'';
    results.forEach(result=>{if(seenReplies.current.has(result.fileId))return;seenReplies.current.add(result.fileId);if(document.hidden||!initialized.current||result.meetingId!==current?.id&&Date.now()-(meetings?.history[0]?.updatedAt??0)>10000)return;pendingSpeech.current.push(result);});
    // Start a pending real reply when the movement lane is already clear.
    api.current?.showSpeech();
  },[meetings,activity?.preferences,stale]);
  useEffect(()=>{if(stale)api.current?.reset();},[stale]);
  const expression=(id:string):'idle'|'listening'|'speaking'=>{const discussion=bubble&&[...(meetings?.history??[]),...(meetings?.current?[meetings.current]:[])].find(m=>m.id===bubble.meetingId);return bubble?.speakerId===id&&!moving?'speaking':bubble&&discussion?.attendees.some(a=>a.id===id)&&id!==bubble.speakerId?'listening':'idle';};
  return {places,slots,moving,bubble,wave,visitor,expression};
}
