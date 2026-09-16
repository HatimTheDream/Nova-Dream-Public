import furnitureUrl from './assets/nova-hub-furniture-p01.png';
import { lynxDefaultColors, type LynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { lynxDirections, motionPhase, type LynxDirection, type LynxExpression, type LynxMotion } from '../../../../../packages/domain/lynx-motion';
import manifest from './assets/manifest.json';
import bodyUrl from './assets/nova-lynx-body-p01.png';
import regionsUrl from './assets/nova-lynx-regions-p01.png';
import partsUrl from './assets/nova-lynx-parts-p01.png';
import shirtUrl from './assets/nova-lynx-shirt-p02.png';
import trousersUrl from './assets/nova-lynx-trousers-p02.png';
import cardiganUrl from './assets/nova-lynx-cardigan-p02.png';
import jacketUrl from './assets/nova-lynx-jacket-p02.png';
import satchelUrl from './assets/nova-lynx-satchel-p01.png';
import blazerUrl from './assets/nova-lynx-blazer-p02.png';
import suitTrousersUrl from './assets/nova-lynx-suit-trousers-p02.png';
import dressShirtUrl from './assets/nova-lynx-dress-shirt-p02.png';
import tieUrl from './assets/nova-lynx-tie-p02.png';
import walkRig from './assets/walk-rig-p02.json';
import { bendPixels, completeFarArm, largestPixelComponent, torsoEnvelopes } from './raster';

export const SPRITE_SIZE = 128;
const urls = { furniture: furnitureUrl, body: bodyUrl, regions: regionsUrl, parts: partsUrl, shirt: shirtUrl, trousers: trousersUrl, cardigan: cardiganUrl, jacket: jacketUrl, satchel: satchelUrl, blazer: blazerUrl, suitTrousers: suitTrousersUrl, dressShirt: dressShirtUrl, tie: tieUrl };
type AssetName = keyof typeof urls;
type PixelAssets = Record<AssetName, HTMLImageElement>;
let loaded: Promise<PixelAssets> | undefined;
export function loadPixelAssets() {
  return loaded ??= Promise.all(Object.entries(urls).map(([key, url]) => new Promise<[AssetName, HTMLImageElement]>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve([key as AssetName, image]); image.onerror = () => reject(new Error('The bundled character art could not load.')); image.src = url;
  }))).then(images => Object.fromEntries(images) as PixelAssets).catch(error => { loaded = undefined; throw error; });
}
function canvas(width = 128, height = 128) { const value = document.createElement('canvas'); value.width = width; value.height = height; return value; }
function ctx(value: HTMLCanvasElement) { const result = value.getContext('2d', { willReadFrequently: true }); if (!result) throw new Error('Character canvas unavailable.'); result.imageSmoothingEnabled = false; return result; }
function tile(image: HTMLImageElement, direction: number) { const value = canvas(); ctx(value).drawImage(image, direction * 128, 0, 128, 128, 0, 0, 128, 128); return value; }
const rgb = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
type Prepared = { pieces: HTMLCanvasElement[]; movingTorso: HTMLCanvasElement; pixels: ImageData[]; eyes: number[][]; eyelid:string; head: Map<LynxExpression, HTMLCanvasElement> };
const recipes = new Map<string, Prepared[]>();
const walkFrames = new Map<string, HTMLCanvasElement>();
function prepare(assets: PixelAssets, recipe: LynxAppearance): Prepared[] {
  const key = JSON.stringify(recipe); const cached = recipes.get(key); if (cached) { recipes.delete(key); recipes.set(key, cached); return cached; }
  const colors = [null, 'furColor', 'markingsColor', 'earsColor', 'tailTipColor'] as const;
  const deltas = colors.map(field => field ? rgb(recipe[field]).map((value, i) => value - rgb(lynxDefaultColors[field])[i]) : [0, 0, 0]);
  const result = lynxDirections.map((_, direction) => {
    const body = tile(assets.body, direction), bctx = ctx(body), pixels = bctx.getImageData(0, 0, 128, 128);
    const region = ctx(tile(assets.regions, direction)).getImageData(0, 0, 128, 128).data;
    const parts = ctx(tile(assets.parts, direction)).getImageData(0, 0, 128, 128).data;
    for (let p = 0; p < pixels.data.length; p += 4) {
      const regionId = region[p]; if (!pixels.data[p + 3] || !regionId || regionId === 5) continue;
      const marking = regionId === 2;
      if (marking && recipe.pattern === 'solid') {
        const fur = rgb(recipe.furColor); for (let c = 0; c < 3; c++) pixels.data[p + c] = Math.min(255, fur[c] + 26);
      } else {
        const delta = deltas[regionId] ?? [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          const source = pixels.data[p + c]; const shifted = Math.max(0, Math.min(255, source + delta[c]));
          pixels.data[p + c] = marking && recipe.pattern === 'soft' ? Math.round(shifted * .65 + (rgb(recipe.furColor)[c] + 30) * .35) : shifted;
        }
      }
    }
    bctx.putImageData(pixels, 0, 0);
    const dressed = canvas(), context = ctx(dressed); context.drawImage(body, 0, 0);
    const garment = (name: AssetName, charcoal = false) => {
      const image = tile(assets[name], direction);
      if (charcoal) {
        const c = ctx(image), data = c.getImageData(0,0,128,128);
        for (let p=0;p<data.data.length;p+=4) if(data.data[p+3] && data.data[p+2] > data.data[p]+3) {
          const value=(data.data[p]+data.data[p+1]+data.data[p+2])/3;
          data.data[p]=value*1.08;data.data[p+1]=value*1.1;data.data[p+2]=value*1.18;
        }
        c.putImageData(data,0,0);
      }
      context.drawImage(image,0,0);
    };
    if (recipe.trousers !== 'none') garment(recipe.trousers === 'olive-trousers' ? 'trousers' : 'suitTrousers', recipe.trousers === 'charcoal-trousers');
    if (recipe.shirt !== 'none') garment(recipe.shirt === 'dress-shirt' ? 'dressShirt' : 'shirt');
    if (recipe.outerwear !== 'none') garment(recipe.outerwear === 'field-jacket' ? 'jacket' : recipe.outerwear === 'cream-cardigan' ? 'cardigan' : 'blazer', recipe.outerwear === 'charcoal-blazer');
    const composite = context.getImageData(0, 0, 128, 128);
    // Preserve the actual head and the one tail in every garment combination.
    for (let p = 0; p < composite.data.length; p += 4) if (parts[p] === 7 || parts[p] === 2) {
      composite.data.set(pixels.data.subarray(p, p + 4), p);
    }
    const pieces = Array.from({ length: 9 }, () => canvas());
    const rows=Array.from({length:128},(_,y)=>{
      const e=torsoEnvelopes[direction],i=e.findIndex((a,i)=>i<e.length-1&&y>=a[0]&&y<=e[i+1][0]);
      if(i<0)return null;const a=e[i],b=e[i+1],t=(y-a[0])/(b[0]-a[0]);return [a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
    });
    for (let part = 1; part < 8; part++) {
      const copy = new ImageData(new Uint8ClampedArray(composite.data), 128, 128);
      for (let p = 0; p < copy.data.length; p += 4) {
        const y = Math.floor(p / 4 / 128), x = p / 4 % 128;
        let sourcePart = parts[p];
        if (direction === 3 && sourcePart === 1 && y >= 60 && y < 82 && x < 54) sourcePart = 6;
        if(sourcePart===1&&y>=60&&y<92&&rows[y]&&(x<rows[y]![0]||x>rows[y]![1])){
          const distance=manifest.guides[direction].arms.map(arm=>Math.hypot(x-arm[0][0],y-arm[0][1]));sourcePart=distance[0]<distance[1]?5:6;
        }
        let keep = sourcePart === part;
        // Hidden overlap at shoulder and hip seams prevents cracks while joints move.
        if (part === 1 && y === 92 && [3,4].includes(parts[p]) && rows[y] && x>=rows[y]![0]&&x<=rows[y]![1]) keep = true;
        if ((part === 3 || part === 4) && y >= 89 && y < 92 && parts[p] === 1 && (part === 3 ? x < manifest.guides[direction].hip : x >= manifest.guides[direction].hip)) keep = true;
        if (!keep) copy.data[p + 3] = 0;
      }
      // Detached outlines from the source's joint cuts must not float in motion.
      if ([3,4,5,6].includes(part)) copy.data.set(largestPixelComponent(copy.data));
      ctx(pieces[part]).putImageData(copy, 0, 0);
    }
    const nearPixels = ctx(pieces[6]).getImageData(0,0,128,128), farPixels = ctx(pieces[5]).getImageData(0,0,128,128);
    const torsoPixels=ctx(pieces[1]).getImageData(0,0,128,128),cleanTorso=largestPixelComponent(torsoPixels.data);
    for(let p=60*128*4;p<86*128*4;p+=4)if(torsoPixels.data[p+3]&&!cleanTorso[p+3]) {
      const x=p/4%128,y=Math.floor(p/4/128),shoulders=manifest.guides[direction].arms.map(arm=>Math.hypot(x-arm[0][0],y-arm[0][1]));
      const target=shoulders[0]<shoulders[1]?farPixels:nearPixels;target.data.set(torsoPixels.data.subarray(p,p+4),p);
    }
    torsoPixels.data.set(cleanTorso);ctx(pieces[1]).putImageData(torsoPixels,0,0);ctx(pieces[6]).putImageData(nearPixels,0,0);
    farPixels.data.set(completeFarArm(farPixels.data,nearPixels.data,manifest.guides[direction].arms[0][0],manifest.guides[direction].arms[1][0]));
    ctx(pieces[5]).putImageData(farPixels,0,0);
    // Author the hidden torso beneath the resting arms. Turning a shoulder must
    // reveal fur/fabric, never a transparent wedge cut from the original sprite.
    const torso = canvas(), torsoContext = ctx(torso);
    const fabric = (hip:boolean) => {
      const counts=new Map<string,number>();
      for(let y=hip?94:64;y<(hip?107:90);y++)for(let x=0;x<128;x++){
        const p=(y*128+x)*4;
        if(!composite.data[p+3]||!(hip?[3,4].includes(parts[p]):parts[p]===1)||Math.max(...composite.data.subarray(p,p+3))<38)continue;
        const key=Array.from(composite.data.subarray(p,p+3)).join(',');counts.set(key,(counts.get(key)||0)+1);
      }
      return [...counts].sort((a,b)=>b[1]-a[1])[0]?.[0]??rgb(recipe.furColor).join(',');
    };
    const coatTones:Record<string,string>={'cream-cardigan':'219,202,165','field-jacket':'103,125,80','navy-blazer':'31,45,64','charcoal-blazer':'50,52,56'};
    const shirtTones:Record<string,string>={'sage-shirt':'150,163,115','dress-shirt':'232,222,200'};
    const pantTones:Record<string,string>={'olive-trousers':'96,109,64','navy-trousers':'29,41,59','charcoal-trousers':'46,48,52'};
    const torsoFabric=coatTones[recipe.outerwear]??shirtTones[recipe.shirt]??fabric(false),hipFabric=pantTones[recipe.trousers]??fabric(true);
    const envelope=torsoEnvelopes[direction];
    for(let i=0;i<envelope.length-1;i++) {
      const a=envelope[i],b=envelope[i+1];
      for(let y=a[0];y<b[0];y++) {
        const t=(y-a[0])/(b[0]-a[0]),left=Math.ceil(a[1]+(b[1]-a[1])*t),right=Math.floor(a[2]+(b[2]-a[2])*t);
        torsoContext.fillStyle=`rgb(${y>=93?hipFabric:torsoFabric})`;torsoContext.fillRect(left,y,right-left+1,1);
      }
    }
    torsoContext.drawImage(pieces[1],0,0);
    if (recipe.ears === 'short') {
      const head = pieces[7], short = canvas(), context = ctx(short);
      context.drawImage(head, 0, 8, 128, 28, 0, 18, 128, 18); context.drawImage(head, 0, 36, 128, 92, 0, 36, 128, 92); pieces[7] = short;
    }
    if (recipe.accessory !== 'none') ctx(pieces[8]).drawImage(assets.satchel, direction * 128, 0, 128, 128, 0, 0, 128, 128);
    if (recipe.neckwear && recipe.neckwear !== 'none') {
      const tie=tile(assets.tie,direction),c=ctx(tie);
      if(recipe.neckwear==='navy-tie') { const p=c.getImageData(0,0,128,128);for(let i=0;i<p.data.length;i+=4)if(p.data[i+3]) { const light=(p.data[i]+p.data[i+1]+p.data[i+2])/3;p.data[i]=light*.65;p.data[i+1]=light*.88;p.data[i+2]=light*1.35; } c.putImageData(p,0,0); }
      ctx(pieces[8]).drawImage(tie,0,0);
    }
    const tones=new Map<string,number>();
    for(let p=30*128*4;p<58*128*4;p+=4)if(pixels.data[p+3]&&region[p]===1&&Math.max(...pixels.data.subarray(p,p+3))>40){const tone=Array.from(pixels.data.subarray(p,p+3)).join(',');tones.set(tone,(tones.get(tone)||0)+1);}
    const eyelid=`rgb(${[...tones].sort((a,b)=>b[1]-a[1])[0]?.[0]??rgb(recipe.furColor).join(',')})`;
    return { pieces, movingTorso: torso, pixels: pieces.map(piece => ctx(piece).getImageData(0,0,128,128)), eyes: manifest.guides[direction].eyes,eyelid,head: new Map<LynxExpression, HTMLCanvasElement>([['neutral', pieces[7]]]) };
  });
  recipes.set(key, result); if (recipes.size > 32) recipes.delete(recipes.keys().next().value!); return result;
}
function expressionHead(prepared: Prepared, expression: LynxExpression) {
  const existing = prepared.head.get(expression); if (existing) return existing;
  const head = canvas(), context = ctx(head); context.drawImage(prepared.pieces[7], 0, 0);
  context.globalCompositeOperation='source-atop';
  for (const [x0, y0, x1, y1] of prepared.eyes) {
    context.fillStyle = prepared.eyelid;
    const height = expression === 'focused' ? Math.round((y1 - y0) * .42) : y1 - y0 - 1;
    context.fillRect(x0, y0, x1 - x0, height);
    context.fillStyle = '#211f22';
    const y = expression === 'happy' ? y0 + 4 : expression === 'focused' ? y0 + height : y0 + 6;
    context.fillRect(x0 + 1, y, x1 - x0 - 2, 1);
    if (expression === 'happy') { context.fillRect(x0 + 2, y - 1, x1 - x0 - 4, 1); }
  }
  prepared.head.set(expression, head); return head;
}
export type PixelPose = { direction?: LynxDirection; motion?: LynxMotion; expression?: LynxExpression; elapsed?: number; reducedMotion?: boolean; diagnostic?: boolean };
/** Every surface calls the same compositor. Motion is presentation only. */
export function drawLynx(context: CanvasRenderingContext2D, assets: PixelAssets, recipe: LynxAppearance, pose: PixelPose = {}) {
  const direction = pose.direction ?? 'SE', index = lynxDirections.indexOf(direction), prepared = prepare(assets, recipe)[index];
  const motion = pose.motion ?? 'idle', phase = motionPhase(motion, pose.elapsed ?? 0, pose.reducedMotion);
  const expression = phase.blink && (!pose.expression || pose.expression === 'neutral') ? 'blink' : pose.expression ?? 'neutral';
  const walk = motion === 'walk' && !pose.reducedMotion, rig=walkRig[index], walkPose=rig.frames[phase.step];
  const side = ['E', 'W'].includes(direction);
  const destination = context, frameKey = `${JSON.stringify(recipe)}:${index}:${phase.step}:${!!pose.diagnostic}`;
  const paintWalk = (frame: HTMLCanvasElement) => {
    destination.drawImage(frame,0,0);
    if(expression!=='neutral') { destination.save();destination.translate(64,64+walkPose.bob);destination.scale(recipe.face==='tapered'?.94:1,1);destination.drawImage(expressionHead(prepared,expression),-64,-64);destination.restore(); }
  };
  if (walk) { const cached = walkFrames.get(frameKey); if (cached) { walkFrames.delete(frameKey); walkFrames.set(frameKey,cached); paintWalk(cached); return; } context = ctx(canvas()); }
  const walkPiece = (id: number) => {
    const name = (Object.keys(rig.parts) as (keyof typeof rig.parts)[]).find(name=>rig.parts[name]===id)!;
    const result = new ImageData(bendPixels(prepared.pixels[id].data,walkPose.limbs[name]),128,128);
    if(pose.diagnostic) {
      const colors={rightArm:[230,70,159],leftArm:[37,189,223],rightLeg:[240,151,40],leftLeg:[138,198,66]};
      for(let p=0;p<result.data.length;p+=4)if(result.data[p+3])for(let c=0;c<3;c++)result.data[p+c]=colors[name][c];
    }
    const piece=canvas();ctx(piece).putImageData(result,0,0);return piece;
  };
  const bodyWidth = recipe.body === 'plush' ? 1.12 : 1;
  const torsoY = walk ? walkPose.bob : motion==='idle'&&!pose.reducedMotion ? (Math.sin((pose.elapsed??0)*1.8)>.5?-1:0) : Math.round(phase.seated * 11);
  context.imageSmoothingEnabled = false;
  const part = (id: number, dx = 0, dy = 0, rotation = 0, anchorX = 64, anchorY = 64, scaleY = 1) => {
    context.save(); context.translate(Math.round(anchorX + dx), Math.round(anchorY + dy));
    context.scale(id === 7 ? recipe.face === 'tapered' ? .94 : 1 : bodyWidth, scaleY);
    context.rotate(rotation); context.drawImage(id === 7 ? expressionHead(prepared, walk ? 'neutral' : expression) : id===1 ? prepared.movingTorso : walk && [3,4,5,6].includes(id) ? walkPiece(id) : prepared.pieces[id], -anchorX, -anchorY); context.restore();
  };
  if(walk) {
    const ids:Record<string,number>={...rig.parts,torso:1,tail:2,head:7};
    for(const name of walkPose.order) { const id=ids[name];part(id,0,[1,2,7].includes(id)?torsoY:0);if(id===1)part(8,0,torsoY); }
    const frame=context.canvas;walkFrames.set(frameKey,frame);if(walkFrames.size>512)walkFrames.delete(walkFrames.keys().next().value!);paintWalk(frame);return;
  }
  if (index !== 0 && index !== 1 && index !== 7) part(2, 0, torsoY);
  // Two independently articulated legs, alternate support/contact and passing poses.
  for (const id of [3, 4]) {
    if(phase.seated>0) {
      const s=phase.seated,dx=Math.round(s*(side?(direction==='E'?4:-4):(id===3?-2:2)));
      context.save();context.translate(64,0);context.scale(bodyWidth,1);
      context.drawImage(prepared.pieces[id],0,89,128,21,-64+dx,89+Math.round(s*11),128,21-Math.round(s*11));
      context.drawImage(prepared.pieces[id],0,110,128,18,-64+dx,110,128,18);context.restore();
    } else part(id);
  }
  const arm = (id:5|6, upper:number, lower:number, handBob=0) => {
    const [sx,sy]=manifest.guides[index].arms[id-5][0], elbowY=77;
    const pixels=prepared.pixels[id].data;let sum=0,count=0;
    for(let x=0;x<128;x++)if(pixels[(elbowY*128+x)*4+3]){sum+=x;count++;}
    const elbowX=count?Math.round(sum/count):sx;
    context.save();context.translate(64,0);context.scale(bodyWidth,1);context.translate(sx-64,sy+torsoY);context.rotate(upper);
    context.drawImage(prepared.pieces[id],0,0,128,elbowY,-sx,-sy,128,elbowY);
    context.translate(elbowX-sx,elbowY-sy);
    const sample=(elbowY*128+elbowX)*4;
    if(pixels[sample+3]) {context.fillStyle=`rgb(${pixels[sample]},${pixels[sample+1]},${pixels[sample+2]})`;context.beginPath();context.arc(0,0,Math.max(2,Math.min(5,count*.35)),0,Math.PI*2);context.fill();}
    context.rotate(lower);
    context.drawImage(prepared.pieces[id],0,elbowY-2,128,51,-elbowX,-2+handBob,128,51);context.restore();
  };
  const work = (id:5|6) => { const sx=manifest.guides[index].arms[id-5][0][0],sign=sx<64?1:-1;arm(id,-sign*.3,-sign*1.0,pose.reducedMotion?0:Math.floor((pose.elapsed??0)*4+(id===5?1:0))%2); };
  if(motion==='seated-work'||motion==='read')work(5);else if(motion==='stretch')arm(5,-.7,-.45);else part(5,0,torsoY,0,64,62);
  part(1, 0, torsoY);
  part(8, 0, torsoY);
  if ([0, 1, 7].includes(index)) part(2, 0, torsoY);
  const [shoulderX,shoulderY]=manifest.guides[index].arms[1][0], armSign=shoulderX<64?1:-1;
  if(motion==='wave') { const enter=pose.reducedMotion?1:Math.min(1,(pose.elapsed??0)/.35);arm(6,armSign*.85*enter,armSign*(1.55+phase.wave*.15)*enter); }
  else if(motion==='seated-work'||motion==='read')work(6);
  else if(motion==='talk'||motion==='seated-talk') { const gesture=pose.reducedMotion?0:Math.max(0,Math.sin((pose.elapsed??0)*2.8));arm(6,armSign*.25*gesture,armSign*.55*gesture); }
  else if(motion==='stretch')arm(6,armSign*.7,armSign*.45);
  else part(6,0,torsoY,0,shoulderX,shoulderY);
  const nod=!pose.reducedMotion&&['talk','listen','seated-talk'].includes(motion)?Math.round(Math.sin((pose.elapsed??0)*2.1)*.7):0;
  part(7, 0, torsoY+nod);
}

export function clearPixelCache() { recipes.clear(); walkFrames.clear(); }
