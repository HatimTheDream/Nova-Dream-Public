import { hubWorldSize, hubCorridors, roomDoors, roomFurniture, roomTemplates, type HubLayout } from './hub-layout.js';
export type HubPoint = { x: number; y: number };
export type HubNavigation = { width: number; height: number; floor: Uint8Array };
export function buildHubNavigation(layout: HubLayout): HubNavigation {
  const size = hubWorldSize(layout), width = Math.ceil(size.width), height = Math.ceil(size.height), floor = new Uint8Array(width * height);
  const rect = (x: number, y: number, w: number, h: number, value = 1) => {
    for (let row = Math.max(0, Math.ceil(y)); row < Math.min(height, y + h); row++) for (let col = Math.max(0, Math.ceil(x)); col < Math.min(width, x + w); col++) floor[row * width + col] = value;
  };
  for(const path of hubCorridors(layout))rect(path.x,path.y,path.width,path.height);
  for (const room of layout.rooms) {
    const t=roomTemplates[room.template];
    rect(room.x,room.y,t.width,t.height,0);
    rect(room.x+1,room.y+2,t.width-2,t.height-2);
    for(const d of roomDoors(room))rect(d.x-2,d.y-2,4,4);
  }
  // Furniture is applied after every hall and room, so a junction cannot erase a solid obstacle.
  for(const room of layout.rooms)for(const item of roomFurniture(room))if(item.kind!=='none'&&!item.kind.endsWith('-rug'))rect(room.x+item.x-item.width/2,room.y+item.y-item.depth/2,item.width,item.depth,0);
  return { width, height, floor };
}
export function hubWalkable(grid: HubNavigation, point: HubPoint) {
  const x = Math.floor(point.x), y = Math.floor(point.y);
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height && grid.floor[y * grid.width + x] === 1;
}
export function nearestHubFloor(grid: HubNavigation, point: HubPoint): HubPoint | undefined {
  for (let radius = 0; radius < 12; radius++) for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
    const candidate = { x: Math.floor(point.x) + x + .5, y: Math.floor(point.y) + y + .5 }; if (hubWalkable(grid, candidate)) return candidate;
  }
}
/** Eight-way shortest paths; no cutting diagonally through furniture or wall corners. */
export function findHubPath(grid: HubNavigation, start: HubPoint, end: HubPoint): HubPoint[] {
  if (!hubWalkable(grid, start) || !hubWalkable(grid, end)) return [];
  const index = (p: HubPoint) => Math.floor(p.y) * grid.width + Math.floor(p.x);
  const source = index(start), destination = index(end); if (source === destination) return [{ ...end }];
  const cost = new Map<number, number>([[source, 0]]), parent = new Map<number, number>(), open: { index: number; score: number }[] = [{ index: source, score: 0 }], closed = new Set<number>();
  const heuristic = (x: number, y: number) => Math.hypot(x - Math.floor(end.x), y - Math.floor(end.y));
  const push = (node: { index: number; score: number }) => { let i = open.length; open.push(node); while (i > 0) { const p = Math.floor((i - 1) / 2); if (open[p].score <= node.score) break; open[i] = open[p]; i = p; } open[i] = node; };
  const pop = () => { const first = open[0], last = open.pop()!; if (open.length) { let i = 0; while (i * 2 + 1 < open.length) { let c = i * 2 + 1; if (c + 1 < open.length && open[c + 1].score < open[c].score) c++; if (open[c].score >= last.score) break; open[i] = open[c]; i = c; } open[i] = last; } return first; };
  while (open.length && closed.size < 100000) {
    const current = pop().index; if (closed.has(current)) continue;
    if (current === destination) {
      const path: HubPoint[] = []; let node = current;
      while (node !== source) { path.push({ x: node % grid.width + .5, y: Math.floor(node / grid.width) + .5 }); node = parent.get(node)!; }
      return path.reverse();
    }
    closed.add(current); const x = current % grid.width, y = Math.floor(current / grid.width);
    for (const [dx, dy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]) {
      const nx = x + dx, ny = y + dy, next = ny * grid.width + nx;
      if (!hubWalkable(grid, { x: nx, y: ny }) || closed.has(next)) continue;
      if (dx && dy && (!hubWalkable(grid, { x: x + dx, y }) || !hubWalkable(grid, { x, y: y + dy }))) continue;
      const nextCost = cost.get(current)! + (dx && dy ? Math.SQRT2 : 1);
      if (nextCost >= (cost.get(next) ?? Infinity)) continue;
      parent.set(next, current); cost.set(next, nextCost); push({ index: next, score: nextCost + heuristic(nx, ny) });
    }
  }
  return [];
}
export function moveOnHubPath(position: HubPoint, path: HubPoint[], distance: number) {
  let point = { ...position }, remaining = Math.max(0, distance), index = 0;
  while (index < path.length && remaining > 0) {
    const next = path[index], gap = Math.hypot(next.x - point.x, next.y - point.y);
    if (gap <= remaining) { point = { ...next }; remaining -= gap; index++; }
    else { const t = remaining / gap; point = { x: point.x + (next.x - point.x) * t, y: point.y + (next.y - point.y) * t }; remaining = 0; }
  }
  return { point, path: path.slice(index) };
}
