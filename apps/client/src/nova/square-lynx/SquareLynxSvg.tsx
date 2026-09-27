import type { SquareLynxModules } from '../../../../../packages/domain/square-lynx';

/** Layered vector lynx in the Nova Dream logo's hand. Pattern, colorway, face
 *  and clothing are independent SVG layers on one seamless cream ground — the
 *  face is never outlined, it is implied by ears, markings and features, just
 *  like the logo. Changing one module never changes the others. */
const BG = '#F6E9D2';
const EAR = '#F3E5C8';
const INK = '#26262B';
const IRIS = '#E8A020';
const MARKING: Record<SquareLynxModules['colorway'], string> = {
  red: '#CF2E3B',
  teal: '#1F9E8E',
  purple: '#7A5AF8',
  gold: '#D9A41B',
};

function Ears({ color }: { color: string }) {
  return (
    <g>
      <path d="M14 124 C18 60 40 26 70 10 C92 38 102 72 104 124 Z" fill={EAR} />
      <path d="M386 124 C382 60 360 26 330 10 C308 38 298 72 296 124 Z" fill={EAR} />
      <path d="M36 110 C40 72 50 48 66 34 C81 51 87 77 89 110 Z" fill={color} />
      <path d="M364 110 C360 72 350 48 334 34 C319 51 313 77 311 110 Z" fill={color} />
    </g>
  );
}

function Markings({ pattern, color }: { pattern: SquareLynxModules['pattern']; color: string }) {
  if (pattern === 'stripes') {
    return (
      <g fill={color}>
        <path d="M200 30 C209 58 211 86 200 122 C189 86 191 58 200 30 Z" />
        <path d="M156 42 C168 64 172 90 165 118 C155 92 151 68 156 42 Z" />
        <path d="M244 42 C232 64 228 90 235 118 C245 92 249 68 244 42 Z" />
        <path d="M98 204 C60 222 36 256 28 304 C58 278 84 246 102 216 Z" />
        <path d="M82 262 C54 280 40 308 36 342 C60 320 76 294 90 266 Z" />
        <path d="M302 204 C340 222 364 256 372 304 C342 278 316 246 298 216 Z" />
        <path d="M318 262 C346 280 360 308 364 342 C340 320 324 294 310 266 Z" />
      </g>
    );
  }
  if (pattern === 'spots') {
    return (
      <g fill={color}>
        <path d="M200 44 l14 18 -14 18 -14 -18 Z" /><path d="M164 62 l12 15 -12 15 -12 -15 Z" /><path d="M236 62 l12 15 -12 15 -12 -15 Z" />
        <path d="M200 96 l11 14 -11 14 -11 -14 Z" />
        <path d="M76 220 l13 16 -13 16 -13 -16 Z" /><path d="M64 268 l12 15 -12 15 -12 -15 Z" /><path d="M92 300 l11 14 -11 14 -11 -14 Z" />
        <path d="M324 220 l13 16 -13 16 -13 -16 Z" /><path d="M336 268 l12 15 -12 15 -12 -15 Z" /><path d="M308 300 l11 14 -11 14 -11 -14 Z" />
      </g>
    );
  }
  if (pattern === 'blaze') {
    return (
      <g fill={color}>
        <path d="M208 30 L188 84 L202 84 L186 128 L216 76 L202 76 Z" />
        <path d="M88 210 L56 252 L74 252 L52 300 L104 240 L84 240 Z" />
        <path d="M312 210 L344 252 L326 252 L348 300 L296 240 L316 240 Z" />
      </g>
    );
  }
  return <g />;
}

function Features({ face }: { face: SquareLynxModules['face'] }) {
  const nose = <path d="M182 254 Q200 245 218 254 Q214 272 200 276 Q186 272 182 254 Z" fill={INK} />;
  const whiskers = (
    <g stroke={INK} strokeWidth={2.5} strokeLinecap="round" opacity={0.75}>
      <path d="M148 262 L112 254" /><path d="M148 272 L114 272" />
      <path d="M252 262 L288 254" /><path d="M252 272 L286 272" />
    </g>
  );
  const muzzle = <ellipse cx={200} cy={272} rx={44} ry={24} fill="#FFFDF8" opacity={0.35} />;
  const eyeWhite = (cx: number, narrowed: boolean) => (
    <ellipse cx={cx} cy={190} rx={36} ry={narrowed ? 32 : 40} fill="#fff" />
  );
  const iris = (cx: number) => (
    <g>
      <circle cx={cx} cy={195} r={22} fill={IRIS} />
      <circle cx={cx} cy={195} r={11} fill="#1b1b1f" />
      <circle cx={cx - 7} cy={187} r={5.5} fill="#fff" />
    </g>
  );
  const lid = (cx: number) => (
    <path d={`M${cx - 36} 182 Q${cx} 150 ${cx + 36} 182`} stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
  );
  if (face === 'bold') {
    return (
      <g>
        {muzzle}
        {eyeWhite(138, false)}{eyeWhite(262, false)}{iris(138)}{iris(262)}{lid(138)}{lid(262)}
        <path d="M100 140 Q138 112 178 136" stroke={INK} strokeWidth={10} fill="none" strokeLinecap="round" />
        <path d="M222 136 Q262 112 300 140" stroke={INK} strokeWidth={10} fill="none" strokeLinecap="round" />
        {nose}{whiskers}
        <path d="M200 276 C200 288 188 292 177 285 M200 276 C200 288 212 292 223 285" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  if (face === 'sharp') {
    return (
      <g>
        {muzzle}
        {eyeWhite(138, true)}{eyeWhite(262, true)}{iris(138)}{iris(262)}{lid(138)}{lid(262)}
        <path d="M102 128 L176 148" stroke={INK} strokeWidth={10} strokeLinecap="round" />
        <path d="M298 128 L224 148" stroke={INK} strokeWidth={10} strokeLinecap="round" />
        {nose}{whiskers}
        <path d="M182 290 Q200 284 218 290" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  if (face === 'soft') {
    return (
      <g>
        {muzzle}
        <ellipse cx={138} cy={192} rx={30} ry={34} fill="#fff" />
        <ellipse cx={262} cy={192} rx={30} ry={34} fill="#fff" />
        {iris(138)}{iris(262)}
        <path d="M108 182 Q138 158 168 182" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
        <path d="M232 182 Q262 158 292 182" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
        <path d="M112 148 Q138 134 164 146" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
        <path d="M236 146 Q262 134 288 148" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
        {nose}{whiskers}
        <path d="M178 282 Q200 300 222 282" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  return (
    <g>
      {muzzle}
      <ellipse cx={138} cy={198} rx={32} ry={27} fill="#fff" />
      <ellipse cx={262} cy={198} rx={32} ry={27} fill="#fff" />
      <circle cx={138} cy={202} r={18} fill={IRIS} />
      <circle cx={262} cy={202} r={18} fill={IRIS} />
      <circle cx={138} cy={202} r={9} fill="#1b1b1f" />
      <circle cx={262} cy={202} r={9} fill="#1b1b1f" />
      <circle cx={132} cy={196} r={4.5} fill="#fff" />
      <circle cx={256} cy={196} r={4.5} fill="#fff" />
      <path d="M106 190 Q138 172 170 190" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
      <path d="M230 190 Q262 172 294 190" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
      <path d="M108 142 L168 142" stroke={INK} strokeWidth={7} strokeLinecap="round" />
      <path d="M232 142 L292 142" stroke={INK} strokeWidth={7} strokeLinecap="round" />
      {nose}{whiskers}
      <path d="M186 288 Q200 292 214 288" stroke={INK} strokeWidth={5} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Clothing({ style, color }: { style: SquareLynxModules['clothing']; color: string }) {
  if (style === 'tie') {
    return (
      <g>
        <path d="M0 400 L0 340 Q100 320 200 332 Q300 320 400 340 L400 400 Z" fill="#232327" />
        <path d="M174 332 L226 332 L200 378 Z" fill="#fff" />
        <path d="M174 332 L132 400 L168 400 L192 350 Z" fill="#2E2E34" />
        <path d="M226 332 L268 400 L232 400 L208 350 Z" fill="#2E2E34" />
        <path d="M192 338 L208 338 L205 350 L195 350 Z" fill={color} />
        <path d="M195 350 L205 350 L209 384 L200 394 L191 384 Z" fill={color} />
      </g>
    );
  }
  return (
    <g>
      <path d="M0 400 L0 348 Q200 330 400 348 L400 400 Z" fill="#2E3D5C" />
      <path d="M160 338 L200 368 L240 338 L240 326 L200 352 L160 326 Z" fill="#46587E" />
      <path d="M160 338 L200 368 L186 400 L146 400 Z" fill="#24304A" />
      <path d="M240 338 L200 368 L214 400 L254 400 Z" fill="#24304A" />
    </g>
  );
}

export function SquareLynxSvg({ modules, className }: { modules: SquareLynxModules; className?: string }) {
  const color = MARKING[modules.colorway];
  return (
    <svg viewBox="0 0 400 400" className={className} role="img" aria-hidden={false}>
      <rect width={400} height={400} fill={BG} />
      <Ears color={color} />
      <Markings pattern={modules.pattern} color={color} />
      <Features face={modules.face} />
      <Clothing style={modules.clothing} color={color} />
    </svg>
  );
}
