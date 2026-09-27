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

/** Accent color per colorway, for swatch-style option controls. */
export const squareLynxMarkingColors: Record<SquareLynxModules['colorway'], string> = MARKING;

function Ears({ color }: { color: string }) {
  return (
    <g>
      <path d="M14 124 C18 60 40 26 70 10 C92 38 102 72 104 124 Z" fill={EAR} />
      <path d="M386 124 C382 60 360 26 330 10 C308 38 298 72 296 124 Z" fill={EAR} />
      <path d="M36 110 C40 72 50 48 66 34 C81 51 87 77 89 110 Z" fill={color} />
      <path d="M364 110 C360 72 350 48 334 34 C319 51 313 77 311 110 Z" fill={color} />
      <path d="M48 100 C52 74 58 58 68 48 C77 60 81 78 82 100 Z" fill="#FFFDF6" opacity={0.85} />
      <path d="M352 100 C348 74 342 58 332 48 C323 60 319 78 318 100 Z" fill="#FFFDF6" opacity={0.85} />
    </g>
  );
}

function Markings({ pattern, color }: { pattern: SquareLynxModules['pattern']; color: string }) {
  if (pattern === 'stripes') {
    return (
      <g fill={color}>
        {/* Forehead crown: tall central teardrop with flanking curved blades */}
        <path d="M200 16 C211 48 215 86 200 134 C185 86 189 48 200 16 Z" />
        <path d="M158 40 C150 66 146 94 152 120 C138 100 132 70 140 44 C144 34 154 32 158 40 Z" />
        <path d="M242 40 C250 66 254 94 248 120 C262 100 268 70 260 44 C256 34 246 32 242 40 Z" />
        <path d="M118 78 C112 96 110 114 114 132 C104 118 100 98 106 80 C109 72 116 70 118 78 Z" />
        <path d="M282 78 C288 96 290 114 286 132 C296 118 300 98 294 80 C291 72 284 70 282 78 Z" />
        {/* Upper wing swooshes sweeping out from the eyes */}
        <path d="M112 158 C80 140 48 128 18 128 C44 146 76 162 108 176 Z" />
        <path d="M288 158 C320 140 352 128 382 128 C356 146 324 162 292 176 Z" />
        {/* Mid blades */}
        <path d="M100 208 C66 200 36 198 12 204 C40 216 70 224 100 230 Z" />
        <path d="M300 208 C334 200 364 198 388 204 C360 216 330 224 300 230 Z" />
        {/* Cheek ruffs: large layered commas */}
        <path d="M92 244 C60 258 40 288 36 326 C58 308 78 282 96 258 Z" />
        <path d="M108 268 C88 286 76 310 74 338 C92 322 104 298 114 276 Z" />
        <path d="M308 244 C340 258 360 288 364 326 C342 308 322 282 304 258 Z" />
        <path d="M292 268 C312 286 324 310 326 338 C308 322 296 298 286 276 Z" />
      </g>
    );
  }
  if (pattern === 'spots') {
    return (
      <g fill={color}>
        <path d="M200 34 L214 62 L200 90 L186 62 Z" />
        <path d="M152 56 L162 76 L152 96 L142 76 Z" />
        <path d="M248 56 L258 76 L248 96 L238 76 Z" />
        <path d="M108 108 L122 130 L108 152 L94 130 Z" />
        <path d="M292 108 L306 130 L292 152 L278 130 Z" />
        <path d="M64 168 L80 192 L64 216 L48 192 Z" />
        <path d="M336 168 L352 192 L336 216 L320 192 Z" />
        <path d="M52 248 L68 272 L52 296 L36 272 Z" />
        <path d="M348 248 L364 272 L348 296 L332 272 Z" />
        <path d="M84 300 L96 320 L84 340 L72 320 Z" />
        <path d="M316 300 L328 320 L316 340 L304 320 Z" />
        <path d="M128 232 L136 246 L128 260 L120 246 Z" />
        <path d="M272 232 L280 246 L272 260 L264 246 Z" />
      </g>
    );
  }
  if (pattern === 'blaze') {
    return (
      <g fill={color}>
        <path d="M200 24 C208 60 210 100 200 142 C190 100 192 60 200 24 Z" />
        <path d="M200 142 L216 170 L200 198 L184 170 Z" />
        <path d="M120 120 C106 138 98 160 98 186 C110 170 120 150 130 130 Z" />
        <path d="M280 120 C294 138 302 160 302 186 C290 170 280 150 270 130 Z" />
        <path d="M96 200 C78 220 66 244 62 272 C78 254 92 232 104 212 Z" />
        <path d="M304 200 C322 220 334 244 338 272 C322 254 308 232 296 212 Z" />
      </g>
    );
  }
  return <g />;
}

function Features({ face }: { face: SquareLynxModules['face'] }) {
  const muzzle = <ellipse cx={200} cy={282} rx={58} ry={30} fill="#FFFDF8" opacity={0.4} />;
  const noseBridge = <path d="M200 232 L200 248" stroke={INK} strokeWidth={5} strokeLinecap="round" />;
  const nose = (
    <g>
      {noseBridge}
      <path d="M178 252 Q200 242 222 252 Q218 272 200 277 Q182 272 178 252 Z" fill={INK} />
    </g>
  );
  const whiskers = (
    <g stroke={INK} strokeWidth={2.5} strokeLinecap="round" opacity={0.7}>
      <path d="M146 264 L108 256" /><path d="M146 276 L110 276" /><path d="M148 288 L116 296" />
      <path d="M254 264 L292 256" /><path d="M254 276 L290 276" /><path d="M252 288 L284 296" />
    </g>
  );
  /** Big logo-style eye: white sclera, thick liner, amber iris, pupil, catchlight. */
  const eye = (cx: number, cy: number, rx: number, ry: number, lidY: number) => (
    <g>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="#fff" />
      <circle cx={cx} cy={cy + 4} r={rx * 0.62} fill={IRIS} />
      <circle cx={cx} cy={cy + 4} r={rx * 0.34} fill="#1b1b1f" />
      <circle cx={cx - rx * 0.2} cy={cy - ry * 0.25} r={rx * 0.16} fill="#fff" />
      <path d={`M${cx - rx} ${lidY} Q${cx} ${lidY - 26} ${cx + rx} ${lidY}`} stroke={INK} strokeWidth={10} fill="none" strokeLinecap="round" />
    </g>
  );
  if (face === 'bold') {
    return (
      <g>
        {muzzle}
        {eye(134, 196, 37, 41, 182)}{eye(266, 196, 37, 41, 182)}
        <path d="M92 142 Q134 108 180 134" stroke={INK} strokeWidth={13} fill="none" strokeLinecap="round" />
        <path d="M220 134 Q266 108 308 142" stroke={INK} strokeWidth={13} fill="none" strokeLinecap="round" />
        {nose}{whiskers}
        <path d="M200 277 C196 290 184 296 172 290 M200 277 C204 290 216 296 228 290" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  if (face === 'sharp') {
    return (
      <g>
        {muzzle}
        {eye(134, 198, 35, 33, 186)}{eye(266, 198, 35, 33, 186)}
        <path d="M96 130 L178 150" stroke={INK} strokeWidth={12} strokeLinecap="round" />
        <path d="M304 130 L222 150" stroke={INK} strokeWidth={12} strokeLinecap="round" />
        <path d="M99 182 L126 176" stroke={INK} strokeWidth={7} strokeLinecap="round" />
        <path d="M301 182 L274 176" stroke={INK} strokeWidth={7} strokeLinecap="round" />
        {nose}{whiskers}
        <path d="M180 292 Q200 286 220 292" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  if (face === 'soft') {
    return (
      <g>
        {muzzle}
        <ellipse cx={134} cy={198} rx={31} ry={35} fill="#fff" />
        <ellipse cx={266} cy={198} rx={31} ry={35} fill="#fff" />
        <circle cx={134} cy={202} r={20} fill={IRIS} />
        <circle cx={266} cy={202} r={20} fill={IRIS} />
        <circle cx={134} cy={202} r={10} fill="#1b1b1f" />
        <circle cx={266} cy={202} r={10} fill="#1b1b1f" />
        <circle cx={128} cy={195} r={5} fill="#fff" />
        <circle cx={260} cy={195} r={5} fill="#fff" />
        <path d="M103 184 Q134 160 165 184" stroke={INK} strokeWidth={8} fill="none" strokeLinecap="round" />
        <path d="M235 184 Q266 160 297 184" stroke={INK} strokeWidth={8} fill="none" strokeLinecap="round" />
        <path d="M106 148 Q134 132 162 144" stroke={INK} strokeWidth={8} fill="none" strokeLinecap="round" />
        <path d="M238 144 Q266 132 294 148" stroke={INK} strokeWidth={8} fill="none" strokeLinecap="round" />
        {nose}{whiskers}
        <path d="M176 284 Q200 302 224 284" stroke={INK} strokeWidth={7} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  return (
    <g>
      {muzzle}
      <ellipse cx={134} cy={202} rx={33} ry={26} fill="#fff" />
      <ellipse cx={266} cy={202} rx={33} ry={26} fill="#fff" />
      <circle cx={134} cy={206} r={18} fill={IRIS} />
      <circle cx={266} cy={206} r={18} fill={IRIS} />
      <circle cx={134} cy={206} r={9} fill="#1b1b1f" />
      <circle cx={266} cy={206} r={9} fill="#1b1b1f" />
      <circle cx={128} cy={200} r={4.5} fill="#fff" />
      <circle cx={260} cy={200} r={4.5} fill="#fff" />
      <path d="M101 192 Q134 172 167 192" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
      <path d="M233 192 Q266 172 299 192" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
      <path d="M104 142 L164 142" stroke={INK} strokeWidth={8} strokeLinecap="round" />
      <path d="M236 142 L296 142" stroke={INK} strokeWidth={8} strokeLinecap="round" />
      {nose}{whiskers}
      <path d="M184 290 Q200 295 216 290" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Clothing({ style, color }: { style: SquareLynxModules['clothing']; color: string }) {
  if (style === 'tie') {
    return (
      <g>
        <path d="M0 400 L0 338 Q100 318 200 330 Q300 318 400 338 L400 400 Z" fill="#232327" />
        <path d="M168 330 L200 366 L232 330 L222 322 L200 340 L178 322 Z" fill="#fff" />
        <path d="M168 330 L124 400 L162 400 L188 348 Z" fill="#2E2E34" />
        <path d="M232 330 L276 400 L238 400 L212 348 Z" fill="#2E2E34" />
        <path d="M190 340 L210 340 L206 354 L194 354 Z" fill={color} />
        <path d="M194 354 L206 354 L210 386 L200 398 L190 386 Z" fill={color} />
      </g>
    );
  }
  return (
    <g>
      <path d="M0 400 L0 346 Q200 328 400 346 L400 400 Z" fill="#2E3D5C" />
      <path d="M158 336 L200 368 L242 336 L232 326 L200 354 L168 326 Z" fill="#46587E" />
      <path d="M158 336 L200 368 L184 400 L142 400 Z" fill="#24304A" />
      <path d="M242 336 L200 368 L216 400 L258 400 Z" fill="#24304A" />
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
