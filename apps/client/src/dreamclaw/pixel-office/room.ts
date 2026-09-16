// Adapted from the fixed Dream Claw PixelAgents assetLoader, renderTileGrid,
// wallTiles and layoutToFurnitureInstances. See PROVENANCE.json and LICENSE.
import type { FloorColor, OfficeLayout, SpriteData, FurnitureInstance } from './types';
import { setFloorSprites, getColorizedFloorSprite, WALL_COLOR } from './floorTiles';
import { setWallSprites, getWallInstances, wallColorToHex } from './wallTiles';
import { getColorizedSprite } from './colorize';
import { getCachedSprite } from './sprites/spriteCache';
import floorsUrl from './assets/floors.png';
import wallsUrl from './assets/walls.png';
import rawLayout from './assets/default-layout.json';
import catalog from './assets/catalog.json';

export const officeLayout = rawLayout as unknown as OfficeLayout;
export const officeSize = { width: officeLayout.cols * 16, height: (officeLayout.rows + 1) * 16 };
const furnitureUrls = import.meta.glob('./assets/furniture/**/*.png', { eager: true, import: 'default', query: '?no-inline' }) as Record<string, string>;
const image = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('An original office asset could not load.')); i.src = url; });
function pixels(img: HTMLImageElement): ImageData { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, c.width, c.height); }
function sprite(data: ImageData, x: number, y: number, width: number, height: number): SpriteData {
  return Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => { const i = ((y + r) * data.width + x + c) * 4; return data.data[i + 3] < 128 ? '' : `#${[data.data[i], data.data[i + 1], data.data[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('')}`; }));
}
type Entry = { id: string; category: string; footprintW: number; footprintH: number; isDesk: boolean; canPlaceOnWalls?: boolean; canPlaceOnSurfaces?: boolean; orientation?: string; sprite: SpriteData };
function furniture(entries: Map<string, Entry>): FurnitureInstance[] {
  const desks = new Map<string, number>();
  for (const item of officeLayout.furniture) { const e = entries.get(item.type); if (!e?.isDesk) continue; for (let r = 0; r < e.footprintH; r++) for (let c = 0; c < e.footprintW; c++) { const key = `${item.col + c},${item.row + r}`; desks.set(key, Math.max(desks.get(key) ?? 0, item.row * 16 + e.sprite.length)); } }
  return officeLayout.furniture.map(item => {
    const e = entries.get(item.type); if (!e) throw new Error('An original room furnishing is unavailable.');
    const x = item.col * 16, y = (item.row - (e.canPlaceOnWalls ? 1 : 0)) * 16;
    let zY = e.canPlaceOnWalls ? (item.row + 1) * 16 + .5 : y + e.sprite.length;
    if (e.category === 'chairs') zY = (item.row + 1) * 16 + (e.orientation === 'back' ? 1 : 0);
    if (e.canPlaceOnSurfaces) for (let r = 0; r < e.footprintH; r++) for (let c = 0; c < e.footprintW; c++) { const desk = desks.get(`${item.col + c},${item.row + r}`); if (desk !== undefined) zY = Math.max(zY, desk + .5); }
    const adjusted = item.color ? getColorizedSprite(`${item.type}:${JSON.stringify(item.color)}`, e.sprite, item.color) : e.sprite;
    return { x, y, zY, sprite: adjusted };
  });
}
let loading: Promise<HTMLCanvasElement> | undefined;
export function loadOfficeRoom(): Promise<HTMLCanvasElement> {
  if (loading) return loading;
  loading = (async () => {
    const [floors, walls, ...assets] = await Promise.all([image(floorsUrl), image(wallsUrl), ...catalog.map(a => image(furnitureUrls[`./assets/${a.file}`]))]);
    const f = pixels(floors), w = pixels(walls);
    setFloorSprites(Array.from({ length: 7 }, (_, i) => sprite(f, i * 16, 0, 16, 16)));
    setWallSprites(Array.from({ length: 16 }, (_, i) => sprite(w, i % 4 * 16, Math.floor(i / 4) * 32, 16, 32)));
    const entries = new Map(catalog.map((entry, i) => [entry.id, { ...entry, sprite: sprite(pixels(assets[i]), 0, 0, assets[i].width, assets[i].height) } as Entry]));
    const c = document.createElement('canvas'); c.width = officeSize.width; c.height = officeSize.height; const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    const map = Array.from({ length: officeLayout.rows }, (_, r) => officeLayout.tiles.slice(r * officeLayout.cols, (r + 1) * officeLayout.cols));
    for (let r = 0; r < officeLayout.rows; r++) for (let col = 0; col < officeLayout.cols; col++) {
      const tile = map[r][col], color = officeLayout.tileColors?.[r * officeLayout.cols + col] as FloorColor | null;
      if (tile === 8) continue;
      if (tile === 0) { ctx.fillStyle = color ? wallColorToHex(color) : WALL_COLOR; ctx.fillRect(col * 16, (r + 1) * 16, 16, 16); }
      else ctx.drawImage(getCachedSprite(getColorizedFloorSprite(tile, color ?? { h: 0, s: 0, b: 0, c: 0 }), 1), col * 16, (r + 1) * 16);
    }
    for (const item of [...getWallInstances(map, officeLayout.tileColors, officeLayout.cols), ...furniture(entries)].sort((a, b) => a.zY - b.zY)) ctx.drawImage(getCachedSprite(item.sprite, 1), item.x, item.y + 16);
    return c;
  })().catch(error => { loading = undefined; throw error; });
  return loading;
}

// Positions use the actual original room's workstations and meeting seats.
// Stable roster paging assigns identities; this does not assign real work.
export const officePlaces = [
  { x: 14.5, y: 5 }, { x: 22.5, y: 5 }, { x: 14.5, y: 10 }, { x: 22.5, y: 10 },
  { x: 14.5, y: 15 }, { x: 22.5, y: 15 }, { x: 5.5, y: 5 }, { x: 29.5, y: 9 },
  { x: 30.5, y: 9 }, { x: 5.5, y: 16 }, { x: 30.5, y: 19 }, { x: 31.5, y: 19 },
];
