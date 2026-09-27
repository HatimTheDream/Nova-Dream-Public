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
        {/* Forehead crown: plump petal center, crescent blades leaning outward */}
        <path d="M200 12 C214 38 220 78 200 128 C180 78 186 38 200 12 Z" />
        <path d="M154 52 C130 66 116 100 122 140 C126 162 136 180 148 190 C140 162 140 124 150 92 C153 76 155 62 154 52 Z" />
        <path d="M246 52 C270 66 284 100 278 140 C274 162 264 180 252 190 C260 162 260 124 250 92 C247 76 245 62 246 52 Z" />
        {/* Side swooshes: curved bands flowing from the eyes to the frame edges */}
        <path d="M112 158 C76 142 40 136 6 142 C40 156 76 168 110 182 C114 174 114 166 112 158 Z" />
        <path d="M288 158 C324 142 360 136 394 142 C360 156 324 168 290 182 C286 174 286 166 288 158 Z" />
        <path d="M100 214 C64 206 30 206 4 216 C32 230 66 238 98 244 C102 234 102 224 100 214 Z" />
        <path d="M300 214 C336 206 370 206 396 216 C368 230 334 238 302 244 C298 234 298 224 300 214 Z" />
        {/* Cheek ruffs: layered fat commas, plump outer curve tapering inward */}
        <path d="M98 240 C56 252 26 286 20 328 C22 336 30 338 38 332 C56 318 70 296 84 272 C90 260 94 248 98 240 Z" />
        <path d="M112 268 C90 286 74 312 72 344 C92 326 106 302 118 278 C120 272 116 267 112 268 Z" />
        <path d="M84 296 C62 312 48 336 46 364 C64 348 78 326 92 304 C94 298 89 294 84 296 Z" />
        <path d="M302 240 C344 252 374 286 380 328 C378 336 370 338 362 332 C344 318 330 296 316 272 C310 260 306 248 302 240 Z" />
        <path d="M288 268 C310 286 326 312 328 344 C308 326 294 302 282 278 C280 272 284 267 288 268 Z" />
        <path d="M316 296 C338 312 352 336 354 364 C336 348 322 326 308 304 C306 298 311 294 316 296 Z" />
      </g>
    );
  }
  if (pattern === 'spots') {
    return (
      <g fill={color}>
        <path d="M200 30 C208 44 210 58 200 72 C190 58 192 44 200 30 Z" />
        <path d="M150 52 C156 62 157 72 150 82 C143 72 144 62 150 52 Z" />
        <path d="M250 52 C256 62 257 72 250 82 C243 72 244 62 250 52 Z" />
        <path d="M100 100 C108 114 110 128 100 142 C90 128 92 114 100 100 Z" />
        <path d="M300 100 C308 114 310 128 300 142 C290 128 292 114 300 100 Z" />
        <path d="M48 170 C58 186 60 202 48 218 C36 202 38 186 48 170 Z" />
        <path d="M352 170 C362 186 364 202 352 218 C340 202 342 186 352 170 Z" />
        <path d="M36 250 C46 266 48 282 36 298 C24 282 26 266 36 250 Z" />
        <path d="M364 250 C374 266 376 282 364 298 C352 282 354 266 364 250 Z" />
        <path d="M70 310 C77 321 78 332 70 343 C62 332 63 321 70 310 Z" />
        <path d="M330 310 C337 321 338 332 330 343 C322 332 323 321 330 310 Z" />
        <path d="M124 240 C129 248 130 256 124 264 C118 256 119 248 124 240 Z" />
        <path d="M276 240 C281 248 282 256 276 264 C270 256 271 248 276 240 Z" />
      </g>
    );
  }
  if (pattern === 'blaze') {
    return (
      <g fill={color}>
        <path d="M200 22 C209 58 211 100 200 142 C189 100 191 58 200 22 Z" />
        <path d="M200 142 C206 156 207 168 200 182 C193 168 194 156 200 142 Z" />
        <path d="M118 118 C104 138 96 162 96 190 C110 172 121 150 131 128 C127 122 122 118 118 118 Z" />
        <path d="M282 118 C296 138 304 162 304 190 C290 172 279 150 269 128 C273 122 278 118 282 118 Z" />
        <path d="M92 198 C74 220 62 246 58 276 C76 256 90 232 102 210 C99 204 95 200 92 198 Z" />
        <path d="M308 198 C326 220 338 246 342 276 C324 256 310 232 298 210 C301 204 305 200 308 198 Z" />
      </g>
    );
  }
  return <g />;
}

function Features({ face }: { face: SquareLynxModules['face'] }) {
  const muzzle = <ellipse cx={200} cy={290} rx={62} ry={32} fill="#FFFDF8" opacity={0.4} />;
  /** Logo eye: big. Iris 67px wide, thick liner hugging the upper eye,
   *  white sclera ring, large pupil, catchlight on the pupil's upper-left. */
  const eye = (cx: number, cy: number, irisR: number, lidDrop: number) => (
    <g>
      <ellipse cx={cx} cy={cy} rx={irisR + 8} ry={irisR + 10} fill="#fff" />
      <circle cx={cx} cy={cy + 3} r={irisR} fill={IRIS} />
      <circle cx={cx} cy={cy + 3} r={irisR * 0.52} fill="#1b1b1f" />
      <circle cx={cx - irisR * 0.28} cy={cy - irisR * 0.28} r={irisR * 0.26} fill="#fff" />
      <path
        d={`M${cx - irisR - 10} ${cy - lidDrop} Q${cx} ${cy - irisR - 20} ${cx + irisR + 10} ${cy - lidDrop}`}
        stroke={INK} strokeWidth={17} fill="none" strokeLinecap="round"
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
