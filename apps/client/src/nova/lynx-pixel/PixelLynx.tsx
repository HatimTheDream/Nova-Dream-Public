import { LoadingRing } from '../../ModuleLoading';
import { useEffect, useRef, useState } from 'react';
import type { LynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { drawLynx, loadPixelAssets, type PixelPose } from './compositor';
import './lynx-pixel.css';

type Props = PixelPose & { recipe: LynxAppearance; label?: string; size?: number; portrait?: boolean; animated?: boolean; phaseOffset?: number };
/** One canvas lifetime: changing facing must not reload art or restart the gait. */
export function PixelLynx(props: Props) {
  const { label, size=128 }=props;
  const ref=useRef<HTMLCanvasElement>(null), latest=useRef(props); latest.current=props;
  const [state,setState]=useState<'loading'|'ready'|'unavailable'>('loading');
  useEffect(()=>{
    let stopped=false, raf=0, elapsed=0, previous=performance.now(), last=-Infinity, previousMotion=latest.current.motion, lastKey='';
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)'), canvas=ref.current, context=canvas?.getContext('2d');
    if(!canvas||!context){setState('unavailable');return;}
    const buffer=document.createElement('canvas');buffer.width=buffer.height=128;
    const target=buffer.getContext('2d');if(!target){setState('unavailable');return;}
    void loadPixelAssets().then(assets=>{
      if(stopped)return;setState('ready');
      const paint=(now:number)=>{
        if(stopped)return;
        const p=latest.current, dt=Math.min(.1,(now-previous)/1000);previous=now;
        if(p.motion!==previousMotion){elapsed=0;previousMotion=p.motion;last=-Infinity;}
        if(!document.hidden && p.animated!==false)elapsed+=dt;
        const staticPose=p.animated===false||p.elapsed!==undefined||(p.reducedMotion??reduced.matches);
        const poseKey=JSON.stringify([p.recipe,p.direction,p.motion,p.expression,p.elapsed,p.portrait,p.reducedMotion??reduced.matches,p.phaseOffset]);
        if(now-last>=1000/30&&!document.hidden&&(!staticPose||poseKey!==lastKey)){
          lastKey=poseKey;
          last=now;target.clearRect(0,0,128,128);
          const {recipe,portrait,...pose}=p;
          const cyclic=['idle','listen','seated-idle','seated-work','talk','seated-talk','read'].includes(p.motion??'idle');
          drawLynx(target,assets,recipe,{...pose,elapsed:p.elapsed??(elapsed+(cyclic?p.phaseOffset??0:0)),reducedMotion:p.reducedMotion??reduced.matches});
          context.clearRect(0,0,128,128);context.imageSmoothingEnabled=false;
          if(portrait){const upper=recipe.cropId==='crop-upper-torso';context.drawImage(buffer,upper?21:26,5,upper?88:78,upper?88:78,0,0,128,128);}else context.drawImage(buffer,0,0);
        }
        raf=requestAnimationFrame(paint);
      };paint(performance.now());
    }).catch(()=>{if(!stopped)setState('unavailable');});
    return()=>{stopped=true;cancelAnimationFrame(raf);};
  },[]);
  return <span className="pixel-lynx" data-pixel-state={state} style={{width:size}}>
    <canvas ref={ref} width={128} height={128} role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}/>
    {state!=='ready'&&<span className="pixel-lynx-placeholder" role="status">{state==='unavailable'?'Character unavailable':<LoadingRing label="Loading character"/>}</span>}
  </span>;
}
