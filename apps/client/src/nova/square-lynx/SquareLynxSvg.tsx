import type { SquareLynxModules } from '../../../../../packages/domain/square-lynx';

/** Layered vector lynx built from the Nova Dream logo's measured proportions.
 *  Pattern, colorway, face and clothing are independent SVG layers on one
 *  seamless cream ground — the face is never outlined, it is implied by ears,
 *  markings and features, just like the logo. Changing one module never
 *  changes the others.
 *
 *  Logo measurements (400-space): iris 67px wide at (120,187)/(280,187),
 *  brows are 40px+ thick bars at y 98-148, nose 57px wide at y 228-260,
 *  forehead crown center spike y 14-127, cheek ruffs reach the frame edges,
 *  suit mass starts y 344. */
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

/** Accent color per colorway, for swatch-style option controls. */
export const squareLynxMarkingColors: Record<SquareLynxModules['colorway'], string> = MARKING;

function Ears({ color }: { color: string }) {
  return (
    <g>
      <path d="M8 130 C12 62 36 24 72 6 C96 36 108 74 110 130 Z" fill={EAR} />
      <path d="M392 130 C388 62 364 24 328 6 C304 36 292 74 290 130 Z" fill={EAR} />
      <path d="M32 116 C37 76 48 50 66 34 C82 52 89 80 91 116 Z" fill={color} />
      <path d="M368 116 C363 76 352 50 334 34 C318 52 311 80 309 116 Z" fill={color} />
      <path d="M46 104 C51 78 57 62 68 52 C77 64 81 82 82 104 Z" fill="#FFFDF6" opacity={0.9} />
      <path d="M354 104 C349 78 343 62 332 52 C323 64 319 82 318 104 Z" fill="#FFFDF6" opacity={0.9} />
    </g>
  );
}

function Markings({ pattern, color }: { pattern: SquareLynxModules['pattern']; color: string }) {
  if (pattern === 'stripes') {
    return (
      <g fill={color}>
        {/* Forehead crown: tall center spike, flanking blades (measured) */}
        <path d="M200 14 C211 46 215 88 200 127 C185 88 189 46 200 14 Z" />
        <path d="M158 47 C150 64 146 84 152 105 C140 92 136 68 143 50 C146 42 155 41 158 47 Z" />
        <path d="M242 47 C250 64 254 84 248 105 C260 92 264 68 257 50 C254 42 245 41 242 47 Z" />
        {/* Side swooshes flowing out from the eyes toward the frame edges */}
        <path d="M104 160 C70 146 36 140 6 144 C36 160 68 172 100 182 Z" />
        <path d="M296 160 C330 146 364 140 394 144 C364 160 332 172 300 182 Z" />
        <path d="M92 214 C58 208 28 208 4 216 C32 228 62 234 92 238 Z" />
        <path d="M308 214 C342 208 372 208 396 216 C368 228 338 234 308 238 Z" />
        {/* Cheek ruffs: big layered commas reaching the edges (measured y 162-334) */}
        <path d="M84 246 C48 262 22 294 14 334 C40 312 62 284 88 258 Z" />
        <path d="M100 272 C78 292 64 318 62 348 C82 330 96 304 108 280 Z" />
        <path d="M316 246 C352 262 378 294 386 334 C360 312 338 284 312 258 Z" />
        <path d="M300 272 C322 292 336 318 338 348 C318 330 304 304 292 280 Z" />
      </g>
    );
  }
  if (pattern === 'spots') {
    return (
      <g fill={color}>
        <path d="M200 30 L216 62 L200 94 L184 62 Z" />
        <path d="M150 52 L162 74 L150 96 L138 74 Z" />
        <path d="M250 52 L262 74 L250 96 L238 74 Z" />
        <path d="M100 100 L116 124 L100 148 L84 124 Z" />
        <path d="M300 100 L316 124 L300 148 L284 124 Z" />
        <path d="M48 170 L66 196 L48 222 L30 196 Z" />
        <path d="M352 170 L370 196 L352 222 L334 196 Z" />
        <path d="M36 250 L54 276 L36 302 L18 276 Z" />
        <path d="M364 250 L382 276 L364 302 L346 276 Z" />
        <path d="M70 310 L84 332 L70 354 L56 332 Z" />
        <path d="M330 310 L344 332 L330 354 L316 332 Z" />
        <path d="M124 240 L132 254 L124 268 L116 254 Z" />
        <path d="M276 240 L284 254 L276 268 L268 254 Z" />
      </g>
    );
  }
  if (pattern === 'blaze') {
    return (
      <g fill={color}>
        <path d="M200 22 C209 58 211 100 200 142 C189 100 191 58 200 22 Z" />
        <path d="M200 142 L217 172 L200 202 L183 172 Z" />
        <path d="M118 118 C104 138 96 162 96 190 C110 172 121 150 131 128 Z" />
        <path d="M282 118 C296 138 304 162 304 190 C290 172 279 150 269 128 Z" />
        <path d="M92 198 C74 220 62 246 58 276 C76 256 90 232 102 210 Z" />
        <path d="M308 198 C326 220 338 246 342 276 C324 256 310 232 298 210 Z" />
      </g>
    );
  }
  return <g />;
}

function Features({ face }: { face: SquareLynxModules['face'] }) {
  const muzzle = <ellipse cx={200} cy={290} rx={62} ry={32} fill="#FFFDF8" opacity={0.4} />;
  /** Logo eye: big. Iris 67px wide, thick upper liner, white sclera ring. */
  const eye = (cx: number, cy: number, irisR: number, lidDrop: number) => (
    <g>
      <ellipse cx={cx} cy={cy} rx={irisR + 8} ry={irisR + 10} fill="#fff" />
      <circle cx={cx} cy={cy + 3} r={irisR} fill={IRIS} />
      <circle cx={cx} cy={cy + 3} r={irisR * 0.52} fill="#1b1b1f" />
      <circle cx={cx - irisR * 0.3} cy={cy - irisR * 0.35} r={irisR * 0.24} fill="#fff" />
      <path
        d={`M${cx - irisR - 8} ${cy - lidDrop} Q${cx} ${cy - irisR - 18} ${cx + irisR + 8} ${cy - lidDrop}`}
        stroke={INK} strokeWidth={14} fill="none" strokeLinecap="round"
      />
    </g>
  );
  /** Logo nose: big rounded triangle with bridge line. */
  const nose = (
    <g>
      <path d="M200 228 L200 246" stroke={INK} strokeWidth={7} strokeLinecap="round" />
      <path d="M172 250 Q200 240 228 250 Q224 272 200 278 Q176 272 172 250 Z" fill={INK} />
    </g>
  );
  /** Logo mouth: w-smile under the nose. */
  const smile = (
    <path d="M200 278 C196 294 182 300 168 294 M200 278 C204 294 218 300 232 294"
      stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
  );
  if (face === 'bold') {
    return (
      <g>
        {muzzle}
        {eye(120, 187, 33, 22)}{eye(280, 187, 33, 22)}
        {/* Thick brow bars (measured y 98-148) */}
        <path d="M78 118 Q120 92 164 112 Q168 126 162 138 Q120 120 84 136 Q74 128 78 118 Z" fill={INK} />
        <path d="M322 118 Q280 92 236 112 Q232 126 238 138 Q280 120 316 136 Q326 128 322 118 Z" fill={INK} />
        {nose}{smile}
      </g>
    );
  }
  if (face === 'sharp') {
    return (
      <g>
        {muzzle}
        {eye(120, 190, 30, 18)}{eye(280, 190, 30, 18)}
        <path d="M80 104 L166 128 L162 142 L76 118 Z" fill={INK} />
        <path d="M320 104 L234 128 L238 142 L324 118 Z" fill={INK} />
        {nose}
        <path d="M176 296 Q200 290 224 296" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  if (face === 'soft') {
    return (
      <g>
        {muzzle}
        <ellipse cx={120} cy={192} rx={38} ry={42} fill="#fff" />
        <ellipse cx={280} cy={192} rx={38} ry={42} fill="#fff" />
        <circle cx={120} cy={196} r={28} fill={IRIS} />
        <circle cx={280} cy={196} r={28} fill={IRIS} />
        <circle cx={120} cy={196} r={14} fill="#1b1b1f" />
        <circle cx={280} cy={196} r={14} fill="#1b1b1f" />
        <circle cx={112} cy={187} r={7} fill="#fff" />
        <circle cx={272} cy={187} r={7} fill="#fff" />
        <path d="M82 178 Q120 152 158 178" stroke={INK} strokeWidth={11} fill="none" strokeLinecap="round" />
        <path d="M242 178 Q280 152 318 178" stroke={INK} strokeWidth={11} fill="none" strokeLinecap="round" />
        <path d="M88 128 Q120 110 152 124" stroke={INK} strokeWidth={11} fill="none" strokeLinecap="round" />
        <path d="M248 124 Q280 110 312 128" stroke={INK} strokeWidth={11} fill="none" strokeLinecap="round" />
        {nose}
        <path d="M172 288 Q200 308 228 288" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  return (
    <g>
      {muzzle}
      <ellipse cx={120} cy={196} rx={38} ry={32} fill="#fff" />
      <ellipse cx={280} cy={196} rx={38} ry={32} fill="#fff" />
      <circle cx={120} cy={200} r={26} fill={IRIS} />
      <circle cx={280} cy={200} r={26} fill={IRIS} />
      <circle cx={120} cy={200} r={13} fill="#1b1b1f" />
      <circle cx={280} cy={200} r={13} fill="#1b1b1f" />
      <circle cx={112} cy={192} r={6} fill="#fff" />
      <circle cx={272} cy={192} r={6} fill="#fff" />
      <path d="M82 186 Q120 164 158 186" stroke={INK} strokeWidth={12} fill="none" strokeLinecap="round" />
      <path d="M242 186 Q280 164 318 186" stroke={INK} strokeWidth={12} fill="none" strokeLinecap="round" />
      <path d="M86 124 L154 124" stroke={INK} strokeWidth={11} strokeLinecap="round" />
      <path d="M246 124 L314 124" stroke={INK} strokeWidth={11} strokeLinecap="round" />
      {nose}
      <path d="M180 294 Q200 300 220 294" stroke={INK} strokeWidth={8} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Clothing({ style, color }: { style: SquareLynxModules['clothing']; color: string }) {
  if (style === 'tie') {
    return (
      <g>
        <path d="M0 400 L0 344 Q100 328 200 338 Q300 328 400 344 L400 400 Z" fill="#232327" />
        <path d="M166 338 L200 376 L234 338 L222 328 L200 348 L178 328 Z" fill="#fff" />
        <path d="M166 338 L120 400 L160 400 L188 356 Z" fill="#2E2E34" />
        <path d="M234 338 L280 400 L240 400 L212 356 Z" fill="#2E2E34" />
        <path d="M190 348 L210 348 L206 362 L194 362 Z" fill={color} />
        <path d="M194 362 L206 362 L211 392 L200 400 L189 392 Z" fill={color} />
      </g>
    );
  }
  return (
    <g>
      <path d="M0 400 L0 352 Q200 336 400 352 L400 400 Z" fill="#2E3D5C" />
      <path d="M156 342 L200 376 L244 342 L232 332 L200 360 L168 332 Z" fill="#46587E" />
      <path d="M156 342 L200 376 L182 400 L138 400 Z" fill="#24304A" />
      <path d="M244 342 L200 376 L218 400 L262 400 Z" fill="#24304A" />
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
