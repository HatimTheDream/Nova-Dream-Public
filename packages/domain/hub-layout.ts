import { z } from 'zod';

export const hubLayoutKey = 'agents:hub-layout';
export const roomTemplates = {
  commons: { name: 'Commons', width: 24, height: 16, desks: [] },
  studio: { name: 'Team studio', width: 24, height: 16, desks: [{ x: 7, y: 8 }, { x: 17, y: 8 }] },
  private: { name: 'Private office', width: 18, height: 16, desks: [{ x: 9, y: 8 }] },
  meeting: { name: 'Meeting room', width: 24, height: 16, desks: [] },
  boardroom: { name: 'Boardroom', width: 52, height: 20, desks: [] },
} as const;
export type RoomTemplate = keyof typeof roomTemplates;
export const furnitureChoices = {
  'walnut-desk': 'Walnut desk', 'birch-desk': 'Birch desk', 'sage-sofa': 'Sage sofa', 'cream-sofa': 'Cream sofa',
  plant: 'Leafy plant', bookcase: 'Bookcase', 'meeting-table': 'Meeting table', 'coffee-bar': 'Coffee cabinet', 'board-table': 'Long boardroom table',
  'sage-rug': 'Sage rug', 'sand-rug': 'Sand rug', none: 'Empty',
} as const;
export type FurnitureKind = keyof typeof furnitureChoices;
const furnitureKind = z.enum(Object.keys(furnitureChoices) as [FurnitureKind, ...FurnitureKind[]]);
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
export const hubRoomSchema = z.object({
  id, name: z.string().trim().min(1).max(80), template: z.enum(['commons', 'studio', 'private', 'meeting', 'boardroom']),
  x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), kit: z.literal('studio-v1'), entry: z.enum(['N', 'S', 'E', 'W']).optional(),
  furniture: z.record(z.string().regex(/^(desk-[01]|corner-left|corner-right|center|lounge)$/), furnitureKind).optional(),
}).strict();
const placementSchema = z.object({ roomId: id, desk: z.number().int().nonnegative() }).strict();
export const hubLayoutSchema = z.object({
  version: z.literal(1), arrangement: z.literal('central-v1').optional(), revision: z.number().int().positive(), rooms: z.array(hubRoomSchema).min(1).max(2000),
  placements: z.record(id, placementSchema), previousPlacements: z.record(id, placementSchema),
}).strict();
export type HubLayout = z.infer<typeof hubLayoutSchema>;
export type HubRoom = z.infer<typeof hubRoomSchema>;
export type HubPlacement = z.infer<typeof placementSchema>;
export const hubLayoutCommandSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), expectedRevision: z.number().int().positive(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('add-room'), template: z.enum(['studio', 'private', 'meeting', 'boardroom']), name: z.string().trim().min(1).max(80) }).strict(),
    z.object({ type: z.literal('rename-room'), roomId: id, name: z.string().trim().min(1).max(80) }).strict(),
    z.object({ type: z.literal('place-agent'), agentId: id, roomId: id, desk: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal('furnish-room'), roomId: id, slot: z.string().max(30), furniture: furnitureKind }).strict(),
  ]),
}).strict();

/** The number of office columns grows with the team instead of remaining fixed at two. */
export function hubOfficeGrid(count: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.ceil(count / columns) };
}

/** Reflow coordinates only: office IDs, assignments, titles and furnishings stay attached. */
export function arrangeHubLayout(layout: HubLayout): boolean {
  const before = JSON.stringify(layout.rooms.map(r => [r.id, r.x, r.y, r.entry]));
  const board = layout.rooms.find(r => r.template === 'boardroom');
  const offices = layout.rooms.filter(r => r.template === 'private');
  const commons = layout.rooms.find(r => r.template === 'commons');
  if (!board) {
    const { columns } = hubOfficeGrid(layout.rooms.length);
    layout.rooms.forEach((room, i) => { room.x = 4 + i % columns * 60; room.y = 8 + Math.floor(i / columns) * 28; room.entry = 'N'; });
  } else {
    const { columns, rows } = hubOfficeGrid(offices.length);
    const extras = layout.rooms.filter(r => r !== board && r !== commons && r.template !== 'private');
    const extraColumns = Math.max(1, Math.ceil(Math.sqrt(extras.length)));
    const width = Math.max(116, columns * 26 - 8, extras.length ? extraColumns * 60 - 8 : 0);
    const northRows = Math.floor(rows / 2), lobbyRow = rows % 2;
    board.x = 4 + Math.round((width - roomTemplates.boardroom.width) / 2);
    board.y = 4 + (northRows + lobbyRow) * 24; board.entry = 'S';
    offices.forEach((room, i) => {
      const row = Math.floor(i / columns), col = i % columns;
      room.x = 4 + Math.round(columns === 1 ? (width - 18) / 2 : col * (width - 18) / (columns - 1));
      room.y = row < northRows ? 4 + (lobbyRow + row) * 24 : board.y + 28 + (row - northRows) * 24;
      room.entry = row < northRows ? 'S' : 'N';
    });
    if (commons) {
      commons.x = lobbyRow ? board.x + 14 : 4;
      commons.y = lobbyRow ? 4 : board.y + 2;
      commons.entry = lobbyRow ? 'S' : 'E';
    }
    const lowerEdge = Math.max(board.y + 20, ...offices.map(r => r.y + 16));
    extras.forEach((room, i) => {
      room.x = 4 + Math.round((width - extraColumns * 60 + 8) / 2) + i % extraColumns * 60;
      room.y = lowerEdge + 12 + Math.floor(i / extraColumns) * 28; room.entry = 'N';
    });
  }
  const changed = layout.arrangement !== 'central-v1' || before !== JSON.stringify(layout.rooms.map(r => [r.id, r.x, r.y, r.entry]));
  layout.arrangement = 'central-v1'; return changed;
}

export function appendHubRoom(layout: HubLayout, template: RoomTemplate, name: string, roomId: string): HubRoom {
  if (layout.rooms.length >= 2000) throw new Error('The hub has reached its room limit. Existing rooms are kept.');
  const room: HubRoom = { id: roomId, name, template, x: 4, y: 4, kit: 'studio-v1' };
  layout.rooms.push(room); arrangeHubLayout(layout); return room;
}
export function emptyHubLayout(): HubLayout {
  const layout: HubLayout = { version: 1, revision: 1, rooms: [], placements: {}, previousPlacements: {} };
  appendHubRoom(layout, 'commons', 'Commons', 'room:commons'); return layout;
}
export function deskAvailable(layout: HubLayout, placement: HubPlacement, except?: string): boolean {
  const room = layout.rooms.find(r => r.id === placement.roomId);
  return !!room && room.template === 'private' && placement.desk >= 0 && placement.desk < roomTemplates[room.template].desks.length &&
    !Object.entries(layout.placements).some(([id, p]) => id !== except && p.roomId === placement.roomId && p.desk === placement.desk);
}
/** Run inside the agent-save transaction, including imports and Assistant writes. */
export function reconcileHubLayout(previous: HubLayout | undefined, agents: { id: string; archived: boolean; name?: string }[], newId: () => string): HubLayout {
  const layout = previous ? structuredClone(hubLayoutSchema.parse(previous)) : emptyHubLayout();
  const current = new Set(agents.filter(a => !a.archived).map(a => a.id));
  let changed = !previous;
  for (const [id, placement] of Object.entries(layout.placements)) if (!current.has(id)) {
    layout.previousPlacements[id] = placement; delete layout.placements[id]; changed = true;
  }
  // Upgrade occupied shared studios in place for their first occupant. Other
  // occupants get their own office; all saved rooms and furniture remain.
  for (const agent of agents) {
    if (agent.archived) continue;
    const placement = layout.placements[agent.id], room = layout.rooms.find(r => r.id === placement?.roomId);
    if (room?.template === 'studio') { room.template = 'private'; room.name = `${agent.name ?? 'Agent'}’s office`; layout.placements[agent.id] = { roomId: room.id, desk: 0 }; changed = true; }
    else if (placement && (room?.template !== 'private' || placement.desk !== 0 || !deskAvailable(layout, placement, agent.id))) { delete layout.placements[agent.id]; changed = true; }
  }
  for (const agent of agents) {
    if (agent.archived || layout.placements[agent.id]) continue;
    let placement: HubPlacement | undefined = layout.previousPlacements[agent.id];
    if (!placement || !deskAvailable(layout, placement)) {
      placement = undefined;
      for (const room of layout.rooms) {
        if (room.template !== 'private') continue;
        const desk = roomTemplates[room.template].desks.findIndex((_, desk) => deskAvailable(layout, { roomId: room.id, desk }));
        if (desk >= 0) { placement = { roomId: room.id, desk }; break; }
      }
    }
    if (!placement) { const room = appendHubRoom(layout, 'private', `${agent.name ?? 'Agent'}’s office`, newId()); placement = { roomId: room.id, desk: 0 }; }
    layout.placements[agent.id] = placement; delete layout.previousPlacements[agent.id]; changed = true;
  }
  if (current.size && !layout.rooms.some(r => r.template === 'boardroom')) { appendHubRoom(layout, 'boardroom', 'Boardroom', newId()); changed = true; }
  if (arrangeHubLayout(layout)) changed = true;
  if (previous && changed) layout.revision++;
  return changed ? layout : previous!;
}
export function roomDoors(room: HubRoom) {
  const t = roomTemplates[room.template];
  const entries = room.template === 'boardroom' ? ['N', 'S', 'W', 'E'] as const : [room.entry ?? 'S'];
  return entries.map(side => ({ side, x: room.x + (side === 'W' ? 0 : side === 'E' ? t.width : t.width / 2), y: room.y + (side === 'N' ? 0 : side === 'S' ? t.height : t.height / 2) }));
}
export function roomDoor(room: HubRoom) { return roomDoors(room)[0]; }
export type HubCorridor = { x:number;y:number;width:number;height:number };
/** One shared set of hallway rectangles feeds drawing and collision navigation. */
export function hubCorridors(layout: HubLayout): HubCorridor[] {
  const paths: HubCorridor[] = [];
  const add = (x:number,y:number,width:number,height:number) => { if(width>0&&height>0)paths.push({x,y,width,height}); };
  const board = layout.rooms.find(r => r.template === 'boardroom');
  const offices = layout.rooms.filter(r => r.template === 'private');
  const columns = [...new Set(offices.map(r=>r.x))].sort((a,b)=>a-b);
  const occupiedRight = Math.max(...layout.rooms.map(r=>r.x+roomTemplates[r.template].width));
  const row = (rooms:HubRoom[], laneY:number) => {
    const doors=rooms.map(roomDoor);add(Math.min(...doors.map(d=>d.x))-2,laneY,Math.max(...doors.map(d=>d.x))-Math.min(...doors.map(d=>d.x))+4,4);
  };
  // Each room has a real opening through its wall; the boardroom offers four routes.
  for(const room of layout.rooms)for(const door of roomDoors(room)) {
    if(door.side==='N'||door.side==='S')add(door.x-2,door.y-6,4,8+(door.side==='S'?4:0));
    else add(door.x-6,door.y-2,12,4);
  }
  if(board) {
    const t=roomTemplates.boardroom,left=board.x-6,right=board.x+t.width+2,top=board.y-6,bottom=board.y+t.height+2;
    add(left,top,t.width+12,4);add(left,bottom,t.width+12,4);add(left,top,4,t.height+12);add(right,top,4,t.height+12);
    for(const side of ['N','S'] as const) {
      const bank=offices.filter(r=>side==='N'?r.y<board.y:r.y>board.y);
      const lobby=layout.rooms.find(r=>r.template==='commons'&&r.entry==='S'&&r.y<board.y);
      const lanes=new Map<number,HubRoom[]>();
      for(const room of [...bank,...(side==='N'&&lobby?[lobby]:[])]){const y=room.entry==='S'?room.y+roomTemplates[room.template].height+2:room.y-6;lanes.set(y,[...(lanes.get(y)??[]),room]);}
      const far=side==='N'?Math.min(top,...lanes.keys()):Math.max(bottom,...lanes.keys());
      const gaps=columns.length>1?columns.slice(1).map((x,i)=>Math.round((columns[i]+18+x)/2)-2):[board.x+t.width/2-2];
      for(const [y,rooms] of lanes){row(rooms,y);const doors=rooms.map(roomDoor);const lo=Math.min(...doors.map(d=>d.x-2),...gaps),hi=Math.max(...doors.map(d=>d.x+2),...gaps.map(x=>x+4));add(lo,y,hi-lo,4);}
      for(const x of gaps)add(x,side==='N'?far:bottom,4,Math.abs(far-(side==='N'?top:bottom))+4);
    }
    const commons=layout.rooms.find(r=>r.template==='commons'&&r.entry==='E');
    if(commons){const d=roomDoor(commons);add(d.x-2,d.y-2,left+4-d.x+2,4);}
    const extras=layout.rooms.filter(r=>r!==board&&r.template!=='private'&&r.template!=='commons');
    if(extras.length){
      const edge=occupiedRight+2,far=Math.max(...extras.map(r=>r.y-6));add(right,bottom,edge-right+4,4);add(edge,bottom,4,far-bottom+4);
      for(const r of extras){const d=roomDoor(r);add(d.x-2,r.y-6,edge+4-d.x+2,4);}
    }
  } else {
    const edge=occupiedRight+2,far=Math.max(...layout.rooms.map(r=>r.y-6));
    add(edge,2,4,far+2);
    for(const r of layout.rooms){const d=roomDoor(r);add(d.x-2,r.y-6,edge+4-d.x+2,4);}
  }
  return paths;
}
export function hubWorldSize(layout: HubLayout) {
  const paths=hubCorridors(layout);
  return { width: Math.max(...layout.rooms.map(r=>r.x+roomTemplates[r.template].width),...paths.map(p=>p.x+p.width))+4, height:Math.max(...layout.rooms.map(r=>r.y+roomTemplates[r.template].height),...paths.map(p=>p.y+p.height))+4 };
}

export type FurnitureSlot = { id: string; name: string; x: number; y: number; width: number; depth: number; choices: FurnitureKind[]; initial: FurnitureKind };
/** Permanent kit coordinates. Furnishing one room never moves another room or desk. */
export function roomFurnitureSlots(room: HubRoom): FurnitureSlot[] {
  const template = roomTemplates[room.template];
  const slots: FurnitureSlot[] = template.desks.map((desk, index) => ({ id: `desk-${index}`, name: `Desk ${index + 1}`, ...desk, width: 5, depth: 2, choices: ['walnut-desk', 'birch-desk'], initial: 'walnut-desk' }));
  slots.push({ id: 'corner-left', name: 'Left wall', x: 3.5, y: 4.5, width: 3, depth: 1.5, choices: ['plant', 'bookcase', 'coffee-bar', 'none'], initial: 'plant' },
    { id: 'corner-right', name: 'Right wall', x: template.width - 3.5, y: 4.5, width: 3, depth: 1.5, choices: ['plant', 'bookcase', 'coffee-bar', 'none'], initial: room.template === 'commons' ? 'coffee-bar' : 'bookcase' });
  if (room.template === 'commons') slots.push({ id: 'lounge', name: 'Lounge', x: 8, y: 8, width: 5, depth: 2, choices: ['sage-sofa', 'cream-sofa', 'bookcase', 'none'], initial: 'sage-sofa' });
  if (room.template === 'boardroom') {
    slots.push({ id: 'center', name: 'Board table', x: 26, y: 11, width: 26, depth: 4, choices: ['board-table'], initial: 'board-table' });
    return slots;
  }
  slots.push({ id: 'center', name: 'Center', x: template.width / 2, y: 11, width: 7, depth: room.template === 'meeting' ? 4 : 3,
    choices: room.template === 'meeting' ? ['meeting-table', 'sage-rug', 'sand-rug', 'none'] : ['sage-rug', 'sand-rug', 'none'], initial: room.template === 'meeting' ? 'meeting-table' : 'sage-rug' });
  return slots;
}
export function roomFurniture(room: HubRoom) {
  return roomFurnitureSlots(room).map(slot => ({ ...slot, kind: room.furniture?.[slot.id] ?? slot.initial }));
}

/** Seat anchors also serve as walk destinations; the table remains solid. */
export function boardroomSeats(room: HubRoom) {
  if (room.template !== 'boardroom') return [];
  return [ ...[16,21,26,31,36].flatMap(x => [{x, y:7, direction:'S' as const}, {x, y:15, direction:'N' as const}]), {x:10, y:11, direction:'E' as const}, {x:42, y:11, direction:'W' as const} ].map((seat,index) => ({...seat, id:`${room.id}:seat-${index}`, x:room.x+seat.x+.5, y:room.y+seat.y+.5}));
}
