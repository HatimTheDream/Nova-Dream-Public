import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { buildHubNavigation, findHubPath, hubWalkable, moveOnHubPath, nearestHubFloor, type HubPoint } from '../../../../../packages/domain/hub-navigation';
import { boardroomSeats, roomDoors, hubCorridors, roomFurniture, roomTemplates, type HubLayout, type HubRoom } from '../../../../../packages/domain/hub-layout';
import { resolveLynxAppearance, type LynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { directionFromVector, type LynxDirection, type LynxMotion } from '../../../../../packages/domain/lynx-motion';
import type { HubMember } from '../../../../../packages/domain/agent-hub';
import { readLocal, saveLocal } from '../../api';
import { Portrait } from '../lynx-portrait/Portrait';
import { PixelLynx } from './PixelLynx';
import { HubPopulation, type HubInteraction } from './HubPopulation';
import type { HubMeeting } from '../../../../../packages/domain/hub-meetings';
import furnitureUrl from './assets/nova-hub-furniture-p01.png';
import './pixel-hub.css';

const furnitureFrame: Record<string, number> = { 'walnut-desk': 0, 'birch-desk': 0, 'sage-sofa': 1, 'cream-sofa': 1, plant: 2, bookcase: 3, 'meeting-table': 4, chair: 5, 'coffee-bar': 6, 'sage-rug': 7, 'sand-rug': 7 };
// Match the short-legged eight-frame gait to movement through the floor plan.
const walkSpeed=2.4;
function Furniture({ kind, x, y, scale, width }: { kind: string; x: number; y: number; scale: number; width: number }) {
  if (kind === 'none') return null;
  if (kind === 'board-table') return <span className="pixel-board-table" aria-label="Long boardroom table" style={{left:(x-width/2)*scale,top:(y-2)*scale,width:width*scale,height:4*scale,zIndex:Math.round((y+2)*10),'--table-unit':`${scale}px`} as React.CSSProperties}><i/><i/><i/><i/></span>;
  const size = width * scale, light = ['birch-desk', 'cream-sofa', 'sand-rug'].includes(kind);
  return <span className={`pixel-furniture pixel-furniture-${kind}`} aria-hidden="true" style={{ left: x * scale - size / 2, top: y * scale - size * .87,
    width: size, height: size, zIndex: kind.endsWith('-rug') ? 1 : Math.round(y * 10), backgroundImage: `url(${furnitureUrl})`, backgroundSize: `${size * 8}px ${size}px`, backgroundPositionX: -furnitureFrame[kind] * size,
    filter: light ? 'brightness(1.35) saturate(.55)' : undefined }}/>
}
export default function PixelHub({ layout, roster, visibleRooms, scale, selected, stale, pick, editRoom, disabled, viewport, ownerAppearance, persistenceKey, meeting, interaction }: {
  layout: HubLayout; roster: HubMember[]; visibleRooms: HubRoom[]; scale: number; selected?: string; stale: boolean;
  pick: (member: HubMember, element: HTMLElement) => void; editRoom: (room: HubRoom) => void; disabled: boolean;
  viewport: RefObject<HTMLDivElement | null>; ownerAppearance: unknown; persistenceKey: string; meeting:HubMeeting|null; interaction?:HubInteraction;
}) {
  return <>
    {hubCorridors(layout).map((path,i)=><div key={`path-${i}`} className="hub-courtyard-path" style={{left:path.x*scale,top:path.y*scale,width:path.width*scale,height:path.height*scale,'--path-unit':`${scale}px`} as React.CSSProperties}/>)}
    {visibleRooms.map(room => {
      const t = roomTemplates[room.template];
      return <div key={room.id}>
        <article className={`hub-room pixel-hub-room hub-room-${room.template}`} style={{ left: room.x * scale, top: room.y * scale, width: t.width * scale, height: t.height * scale, '--pixel-unit': `${scale}px` } as React.CSSProperties} aria-label={room.name} data-entry={room.entry}>
          <button className="hub-room-title" aria-label={`Customize ${room.name}`} disabled={disabled} onClick={() => editRoom(room)}>{room.name}</button>
        </article>
        {roomDoors(room).map(door=><div key={door.side} className={`hub-room-entry entry-${door.side}`} style={{left:door.x*scale,top:door.y*scale,'--entry-unit':`${scale}px`} as React.CSSProperties}/>)}
        {roomFurniture(room).map(item => <Furniture key={item.id} kind={item.kind} x={room.x + item.x} y={room.y + item.y} width={item.kind === 'plant' ? 3 : item.width + 1} scale={scale}/>)}
        {t.desks.map((desk, index) => <Furniture key={`chair-${index}`} kind="chair" x={room.x + desk.x} y={room.y + desk.y + 3} width={2.4} scale={scale}/>)}
        {boardroomSeats(room).map(seat=><span key={seat.id} className={`pixel-board-chair chair-facing-${seat.direction}`} aria-hidden="true" style={{left:(seat.x-1.1)*scale,top:(seat.y-2.2)*scale,width:2.2*scale,height:2.4*scale,zIndex:Math.round(seat.y*10),'--chair-unit':`${scale}px`} as React.CSSProperties}/>) }
      </div>;
    })}
    <HubPopulation layout={layout} roster={roster} scale={scale} selected={selected} stale={stale} pick={pick} meeting={meeting} interaction={interaction} persistenceKey={persistenceKey}/>
    <HubExplorer layout={layout} scale={scale} viewport={viewport} appearance={ownerAppearance} persistenceKey={persistenceKey}/>
  </>;
}
function HubExplorer({ layout, scale, viewport, appearance, persistenceKey }: { layout: HubLayout; scale: number; viewport: RefObject<HTMLDivElement | null>; appearance: unknown; persistenceKey: string }) {
  const grid = useMemo(() => buildHubNavigation(layout), [layout.revision]);
  const first = layout.rooms[0];
  const initial = () => nearestHubFloor(grid, readLocal<HubPoint>(persistenceKey) ?? { x: first.x + 12, y: first.y + 14 }) ?? nearestHubFloor(grid,{x:first.x+12.5,y:first.y+14.5})!;
  const [position, setPosition] = useState(initial), [direction, setDirection] = useState<LynxDirection>('SE'), [walking, setWalking] = useState(false);
  const point = useRef(position), route = useRef<HubPoint[]>([]), keys = useRef(new Set<string>()), moved = useRef(false);
  const [notice, setNotice] = useState('Click a clear floor tile to walk. Arrow keys or WASD also move.');
  const lynx = resolveLynxAppearance(appearance), size = scale * 6;
  useEffect(() => {
    const next = nearestHubFloor(grid, point.current) ?? initial(); if (next && !hubWalkable(grid, point.current)) { point.current = next; setPosition(next); }
    route.current = [];
    const v = viewport.current; if (!v) return;
    const click = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('button,input,select')) return;
      const bounds=(v.querySelector('.hub-world')??v).getBoundingClientRect(),target={x:(event.clientX-bounds.left)/scale,y:(event.clientY-bounds.top)/scale};
      const path = findHubPath(grid, point.current, target); route.current = path; v.focus({ preventScroll: true });
      setNotice(path.length ? 'Walking through the headquarters.' : 'Choose a clear floor tile. Walls and furniture block this spot.');
    };
    const down = (event: KeyboardEvent) => {
      if (event.target !== v || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','W','A','S','D'].includes(event.key)) return;
      event.preventDefault(); const key=event.key.toLowerCase(); keys.current.add(key);
      // Keep a one-tile step when keydown and keyup fall between display frames.
      const dx=Number(['arrowright','d'].includes(key))-Number(['arrowleft','a'].includes(key));
      const dy=Number(['arrowdown','s'].includes(key))-Number(['arrowup','w'].includes(key));
      const target={x:point.current.x+dx,y:point.current.y+dy};
      route.current=hubWalkable(grid,target)?findHubPath(grid,point.current,target):[];
    };
    const up = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    const blur = () => { keys.current.clear(); };
    v.addEventListener('click', click); v.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur); v.addEventListener('blur', blur);
    let frame = 0, previous = performance.now(), lastPaint = 0;
    const tick = (now: number) => {
      const dt = Math.min(.05, (now - previous) / 1000); previous = now;
      let next = point.current; const k = keys.current;
      const dx = Number(k.has('arrowright') || k.has('d')) - Number(k.has('arrowleft') || k.has('a'));
      const dy = Number(k.has('arrowdown') || k.has('s')) - Number(k.has('arrowup') || k.has('w'));
      if (!document.hidden && (dx || dy)) {
        route.current=[];
        const norm = Math.hypot(dx, dy), candidate = { x: next.x + dx / norm * dt * walkSpeed, y: next.y + dy / norm * dt * walkSpeed };
        if (hubWalkable(grid, candidate) && hubWalkable(grid, { x: next.x, y: candidate.y }) && hubWalkable(grid, { x: candidate.x, y: next.y })) next = candidate;
      } else if (!document.hidden && route.current.length) { const step = moveOnHubPath(next, route.current, dt * walkSpeed); next = step.point; route.current = step.path; }
      const moving = Math.hypot(next.x - point.current.x, next.y - point.current.y) > .0001;
      if (moving) {
        setDirection(d => directionFromVector(next.x - point.current.x, next.y - point.current.y, d)); point.current = next;
        const world=v.querySelector<HTMLElement>('.hub-world'),x=next.x*scale+(world?.offsetLeft??0),y=next.y*scale+(world?.offsetTop??0);
        if (x < v.scrollLeft + 35 || x > v.scrollLeft + v.clientWidth - 35 || y < v.scrollTop + 60 || y > v.scrollTop + v.clientHeight - 45) {
          v.scrollTo({ left: Math.max(0, x - v.clientWidth / 2), top: Math.max(0, y - v.clientHeight / 2), behavior: 'instant' });
        }
      }
      if (now - lastPaint > 30 && (moving || moved.current)) { lastPaint = now; setPosition({ ...point.current }); setWalking(moving); }
      if (moved.current && !moving) { saveLocal(persistenceKey, point.current); setNotice('Arrived. Choose another clear floor tile to keep exploring.'); }
      moved.current = moving; frame = requestAnimationFrame(tick);
    }; frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); saveLocal(persistenceKey, point.current); v.removeEventListener('click', click); v.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); v.removeEventListener('blur', blur); };
  }, [grid, scale, persistenceKey]);
  return <><span className="pixel-hub-explorer" data-direction={direction} data-motion={walking ? 'walk' : 'idle'} style={{ left: position.x * scale - size / 2, top: position.y * scale - size * .9375, width: size, zIndex: Math.round(position.y * 10) + 2 }}>
    {lynx.status === 'ready' ? <PixelLynx recipe={lynx.recipe} direction={direction} motion={walking ? 'walk' : 'idle'} size={size}/> : <span className="pixel-visitor-pin" aria-label="Your position">You</span>}<span className="hub-actor-label">You</span>
  </span><span className="sr-only" role="status">{notice}</span></>;
}
