import { defaultMascotAppearance, normalizeMascotAppearance, type MascotAppearance } from '../../../../../packages/domain/mascot-appearance';
export type MascotExpression = 'idle' | 'listening' | 'speaking';
/** Approved Nova artwork. All interpolated appearance values pass the domain validator. */
function mix(hex: string, target: string, amount: number) {
  const a = hex.match(/[a-f\d]{2}/gi)!.map(x => parseInt(x, 16));
  const b = target.match(/[a-f\d]{2}/gi)!.map(x => parseInt(x, 16));
  return '#' + a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount).toString(16).padStart(2, '0')).join('');
}
const ink = '#25272b';
const reflect = (content: string) => content + `<g transform="translate(400 0) scale(-1 1)">${content}</g>`;

function ears(a: MascotAppearance, inner: string) {
  return `<g fill="${a.markings}">${reflect('<path d="M48 110 C27 103 17 88 21 63 C24 45 31 28 40 22 C45 16 54 27 68 34 L94 49 C111 58 109 77 98 91 L75 97 C81 80 70 60 44 42 C35 60 30 87 48 110Z"/>')}</g>
    <g fill="${inner}">${reflect('<path d="M47 105 C34 93 33 69 43 45 C64 59 78 76 75 93Z"/>')}</g>`;
}
function markings(a: MascotAppearance) {
  const color = a.markings;
  if (a.pattern === 'solid') return '';
  if (a.pattern === 'rosettes') return `<g fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
    <path d="M188 39 Q178 49 187 58 M198 32 Q215 32 219 44 Q223 55 212 60"/>
    ${reflect('<path d="M135 65 Q122 60 120 72 Q117 85 130 89 M139 78 Q146 71 143 66"/><path d="M42 169 Q26 164 25 180 Q25 195 40 198 M48 190 Q58 181 49 174"/><path d="M60 234 Q44 226 34 240 Q23 257 40 266 M53 265 Q66 267 70 252"/><path d="M43 298 Q25 290 21 307 Q18 320 31 325 M43 321 Q52 315 46 305"/>')}
  </g>`;
  if (a.pattern === 'mask') return `<g fill="${color}">
    <path d="M173 37 Q200 20 227 37 L216 83 Q200 68 184 83Z"/>
    ${reflect('<path d="M18 169 C38 134 61 120 99 119 C137 114 165 134 184 167 L172 218 C137 244 81 241 48 223 L10 245 L27 205 L0 209Z"/>')}
  </g>`;
  if (a.pattern === 'patches') return `<g fill="${color}">
    <path d="M34 116 C64 94 123 99 156 117 C177 129 173 151 156 172 C147 187 149 212 128 225 C101 243 52 235 32 209 L0 211 L9 155Z"/>
    <path d="M277 32 C296 15 321 13 330 33 C340 56 314 79 292 75 C269 71 257 50 277 32Z"/>
    <path d="M325 235 C354 227 373 245 400 244 V330 C378 335 342 329 327 310 C314 294 303 271 312 253Z"/>
    <path d="M73 281 C92 274 111 286 105 306 C100 323 77 332 67 319 C58 307 57 288 73 281Z"/>
  </g>`;
  if (a.pattern === 'bands') return `<g fill="${color}">
    <path d="M182 20 Q200 35 218 20 L211 67 L200 92 L189 67Z"/>
    ${reflect('<path d="M133 50 Q151 47 169 63 L162 94 Q144 77 133 50Z"/><path d="M0 152 Q38 151 68 170 L54 190 Q28 175 0 177Z"/><path d="M0 207 Q28 196 60 207 L68 225 Q30 224 0 239Z"/><path d="M0 270 Q26 248 61 247 L76 269 Q35 270 0 302Z"/><path d="M27 329 Q44 297 82 291 L95 312 Q54 320 45 343Z"/>')}
  </g>`;
  if (a.pattern === 'signature') return `<g fill="${color}">
    <path d="M200 13 C215 27 223 50 218 75 C215 94 207 115 200 133 C192 112 184 91 182 72 C179 48 185 28 200 13Z"/>
    ${reflect('<path d="M136 48 C153 43 174 55 183 72 C184 85 178 102 174 113 C157 91 144 68 136 48Z"/>')}
    ${reflect('<path d="M0 193 C27 188 47 173 59 158 C60 176 51 189 35 202 C24 211 10 217 0 221Z"/><path d="M0 252 C17 234 29 219 43 216 C57 213 72 217 79 225 C52 230 45 245 29 260 C19 269 9 275 0 279Z"/><path d="M36 307 L26 315 C15 290 18 269 37 249 C54 233 78 232 100 238 C110 241 108 252 99 259 C74 272 63 293 69 315 L76 337 C55 336 38 327 36 307Z"/>')}
  </g>`;
  if (a.pattern === 'freckles') return `<g fill="${color}">
    <path d="M200 24 C213 41 212 58 200 69 C188 58 187 41 200 24Z"/>
    ${reflect('<path d="M153 46 C165 49 171 59 167 71 C154 71 145 58 153 46Z"/><path d="M76 157 C89 159 93 169 88 181 C77 186 66 176 68 167Z"/><path d="M31 191 C44 185 56 192 54 204 C50 217 32 220 26 208Z"/><path d="M47 235 C62 228 78 237 73 251 C69 264 50 267 44 255Z"/><path d="M11 260 C24 254 36 260 34 272 C29 285 11 288 7 276Z"/><path d="M48 290 C61 285 73 294 69 306 C64 318 45 319 41 307Z"/>')}
  </g>`;
  return `<g fill="${color}">
    <path d="M200 16 C224 49 214 76 205 95 C218 94 225 82 229 75 C234 107 212 134 200 147 C184 131 167 111 171 81 C178 93 185 101 194 101 C183 71 184 44 200 16Z"/>
    ${reflect('<path d="M0 188 C27 184 48 175 67 155 C64 181 50 200 26 211 C17 215 9 219 0 220Z"/><path d="M17 314 C16 277 42 245 84 234 C75 252 55 263 50 281 C62 279 68 273 78 267 C74 295 58 316 36 328 L40 307Z"/>')}
  </g>`;
}

function clothing(a: MascotAppearance, id: string) {
  const c = a.clothing, high = mix(c, '#ffffff', 0.10), low = mix(c, '#000000', 0.2);
  const accent = a.accent;
  const base = `<path d="M0 400V359L120 328Q150 316 172 321H228Q251 317 280 328L400 359V400Z" fill="${c}"/>`;
  if (a.outfit === 'suit') return base + `
    <path d="M133 327 L174 400 H226 L268 327 L232 316 H169Z" fill="#fffdf8"/>
    <path d="M163 318 L200 344 L237 318 L248 332 L221 372 L200 347 L180 372 L151 332Z" fill="#ffffff"/>
    <path d="M179 345 H221 L211 365 H189Z M191 365 H209 L222 400 H178Z" fill="${accent}"/>
    <path d="M132 326 L154 343 L143 365 L177 400 H139 L109 364 L120 355 L98 348Z" fill="${high}"/>
    <path d="M268 326 L246 343 L257 365 L223 400 H261 L291 364 L280 355 L302 348Z" fill="${high}"/>`;
  if (a.outfit === 'knit') return base + `
    <path d="M137 322 Q200 344 263 322 L252 353 Q200 374 148 353Z" fill="${accent}"/>
    <path d="M149 331 Q200 348 251 331" stroke="${mix(accent,'#000000',.16)}" stroke-width="6" fill="none"/>
    <path d="M75 369V400 M91 365V400 M107 361V400 M293 361V400 M309 365V400 M325 369V400" stroke="${high}" stroke-width="3"/>
    <path d="M157 369 Q200 382 243 369" stroke="${low}" stroke-width="3" fill="none"/>`;
  if (a.outfit === 'shirt') return base + `
    <path d="M145 320 L200 348 L255 320 L268 336 L227 367 L200 348 L173 367 L132 336Z" fill="${high}"/>
    <path d="M200 349V400" stroke="${low}" stroke-width="3"/>
    <circle cx="207" cy="372" r="3" fill="${accent}"/><circle cx="207" cy="389" r="3" fill="${accent}"/>
    <path d="M278 372H312V390H278Z" fill="${high}"/>
    <path d="M283 376H307" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>`;
  if (a.outfit === 'cardigan') return base + `
    <path d="M153 324 Q200 342 247 324 L225 400 H175Z" fill="${accent}"/>
    <path d="M135 324 L157 329 L193 382 L193 400 H175 L143 357Z M265 324 L243 329 L207 382 L207 400 H225 L257 357Z" fill="${high}"/>
    <path d="M196 380V400" stroke="${low}" stroke-width="4"/>
    <circle cx="204" cy="384" r="3" fill="${accent}"/><circle cx="204" cy="397" r="3" fill="${accent}"/>
    <path d="M73 381H117 M283 381H327" stroke="${low}" stroke-width="4" stroke-linecap="round"/>`;
  if (a.outfit === 'vest') return base + `
    <path d="M0 359 L106 332 L91 400 H0Z M400 359 L294 332 L309 400 H400Z" fill="${accent}"/>
    <path d="M143 324 L200 372 L257 324 L241 317 H159Z" fill="#fffdf8"/>
    <path d="M132 328 L194 382 L194 400 H178 L120 345Z M268 328 L206 382 L206 400 H222 L280 345Z" fill="${high}"/>
    <circle cx="202" cy="386" r="3" fill="${accent}"/><circle cx="202" cy="398" r="3" fill="${accent}"/>
    <path d="M262 375H298" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>`;
  if (a.outfit === 'turtleneck') return base + `
    <path d="M135 319 Q200 326 265 319 L260 355 Q200 371 140 355Z" fill="${high}"/>
    <path d="M142 335 Q200 347 258 335 M142 348 Q200 361 258 348" fill="none" stroke="${low}" stroke-width="3"/>
    <path d="M144 366 Q200 383 256 366" fill="none" stroke="${accent}" stroke-width="3"/>
    <circle cx="200" cy="384" r="5" fill="${accent}"/>`;
  if (a.outfit === 'utility') return base + `
    <path d="M153 322 L200 355 L247 322 L259 337 L225 370 L200 355 L175 370 L141 337Z" fill="${high}"/>
    <path d="M200 355V400" stroke="${accent}" stroke-width="4"/>
    <path d="M60 367H122V394H60Z M278 367H340V394H278Z" fill="${low}"/>
    <path d="M58 367H124L116 379H66Z M276 367H342L334 379H284Z" fill="${high}"/>
    <circle cx="91" cy="373" r="3" fill="${accent}"/><circle cx="309" cy="373" r="3" fill="${accent}"/>
    <path d="M27 355L84 344 M316 344L373 355" stroke="${high}" stroke-width="7" stroke-linecap="round"/>`;
  return base + `
    <path d="M120 328 Q138 300 160 318 L200 353 L240 318 Q262 300 280 328 L264 370 L225 381 L200 358 L175 381 L136 370Z" fill="${high}"/>
    <path d="M157 326 L185 358 M243 326 L215 358" stroke="${low}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M168 357 L168 390 M232 357 L232 390" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>
    <path d="M184 384 Q200 377 216 384" stroke="${low}" stroke-width="3" fill="none"/>`;
}

function features(a: MascotAppearance, pose: MascotExpression, id: string, muzzle: string) {
  const bright = a.face === 'bright', calm = a.face === 'calm', focused = a.face === 'focused';
  const curious = a.face === 'curious', cheerful = a.face === 'cheerful';
  const gentle = a.face === 'gentle', confident = a.face === 'confident';
  const iris = bright ? 37 : calm ? 32 : gentle ? 36 : confident ? 33 : 35;
  const cy = 190, look = pose === 'listening' ? -3 : 0;
  const eyeShape = 'M66 188 C68 151 87 134 117 134 C149 132 174 153 175 190 C176 219 162 229 123 231 C85 232 65 220 66 188Z';
  const lids = calm ? '<path d="M62 133H179V187Q123 171 62 187Z"/>' : focused ? '<path d="M62 131H180V171L62 154Z"/>' : confident ? '<path d="M62 131H179V176Q123 157 62 172Z"/>' : '';
  let eyes = '';
  for (const side of [0, 1]) {
    const transform = side ? 'translate(400 0) scale(-1 1)' : '';
    const clip = `${id}-eye-${side}`;
    if (cheerful) {
      eyes += `<g transform="${transform}"><path d="M76 194 Q120 145 164 194" fill="none" stroke="${ink}" stroke-width="10" stroke-linecap="round"/><path d="M84 213 Q120 225 156 213" fill="none" stroke="${mix(a.fur, ink, .14)}" stroke-width="4" stroke-linecap="round"/></g>`;
      continue;
    }
    eyes += `<g transform="${curious && side === 0 ? 'translate(0 -7)' : transform}">
      <defs><clipPath id="${clip}"><path d="${eyeShape}"/></clipPath></defs>
      <path d="${eyeShape}" fill="#fffef8"/>
      <g clip-path="url(#${clip})">
        <circle cx="120" cy="${cy + look}" r="${iris}" fill="${a.eyes}"/>
        <circle cx="120" cy="${cy + look}" r="${bright ? 21 : 19}" fill="${ink}"/>
        <circle cx="${side ? 130 : 110}" cy="${174 + look}" r="7" fill="#ffffff"/>
        <g fill="${a.fur}">${lids}</g>
      </g>
      <path d="${calm ? 'M67 183 Q118 168 174 181' : focused ? 'M68 155 Q122 164 173 174' : confident ? 'M68 172 Q120 155 172 175' : 'M67 178 C73 146 96 132 120 135 C146 133 167 150 174 180'}" fill="none" stroke="${ink}" stroke-width="${calm || gentle ? 6 : 7}" stroke-linecap="round"/>
    </g>`;
  }
  let brow;
  if (focused) brow = 'M62 115 C92 96 121 106 172 125 L169 143 C126 128 103 118 62 130 C57 131 57 121 62 115Z';
  else if (calm) brow = 'M63 119 C98 108 136 107 169 119 Q175 127 170 133 C133 125 98 125 63 130 Q57 127 63 119Z';
  else if (gentle) brow = 'M69 123 Q113 100 164 120 Q172 126 166 131 Q116 116 73 132 Q65 133 69 123Z';
  else if (cheerful) brow = 'M69 123 Q114 96 163 117 Q170 123 167 130 Q119 113 73 133 Q65 134 69 123Z';
  else if (confident) brow = 'M62 118 Q108 100 169 118 L166 133 Q111 118 66 132 Q57 129 62 118Z';
  else brow = bright ? 'M61 113 C86 78 132 78 165 108 L173 123 C172 127 167 128 162 125 C130 104 99 104 65 123 C58 127 56 121 61 113Z' : 'M61 130 C80 104 100 96 121 98 C148 99 165 114 175 139 C178 146 175 149 170 146 C135 120 106 119 65 139 C58 142 57 136 61 130Z';
  const browArt = curious ? `<path d="M61 109 C80 82 129 85 160 106 Q168 114 167 124 C121 107 90 101 66 122 Q56 125 61 109Z"/><g transform="translate(400 0) scale(-1 1)"><path d="${brow}"/></g>` : reflect(`<path d="${brow}"/>`);
  const brows = `<g fill="${ink}" transform="translate(0 ${pose === 'listening' ? -5 : 0})">${browArt}</g>`;
  let mouth;
  if (pose === 'speaking') mouth = `<path d="M174 280 Q200 294 226 280 C225 313 208 320 198 317 C184 315 175 302 174 280Z" fill="${ink}"/><path d="M187 306Q200 296 215 305Q206 319 193 313Z" fill="#d76f76"/>`;
  else if (bright || cheerful) mouth = `<path d="M164 279 Q200 304 236 279 Q230 313 200 314 Q170 313 164 279Z" fill="${ink}"/><path d="M174 287 Q200 300 226 287 L221 297 Q200 304 179 297Z" fill="#fffef8"/>`;
  else if (confident) mouth = `<path d="M200 269V280 Q215 291 240 274 M177 287 Q190 291 200 280" stroke="${ink}" stroke-width="8" stroke-linecap="round" fill="none"/>`;
  else if (curious) mouth = `<path d="M200 269V280 Q214 294 231 287 M176 288 Q190 294 200 280" stroke="${ink}" stroke-width="8" stroke-linecap="round" fill="none"/>`;
  else if (gentle) mouth = `<path d="M200 269V278 Q216 296 235 281 M165 281 Q184 296 200 278" stroke="${ink}" stroke-width="6" stroke-linecap="round" fill="none"/>`;
  else mouth = `<path d="${focused ? 'M200 269V280 M173 289Q190 296 200 280Q210 296 227 289' : calm ? 'M200 269V280 M173 284Q185 295 200 280Q215 295 227 284' : 'M200 266V275 C196 295 163 298 153 279 M200 275 C204 295 237 298 247 279'}" stroke="${ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  return `<path d="M167 230 C139 234 108 257 94 293 L110 285 C98 306 104 321 125 334 L129 323 C145 343 173 348 200 347 C227 348 255 343 271 323 L275 334 C296 321 302 306 290 285 L306 293 C292 257 261 234 233 230Z" fill="${muzzle}"/>
    ${eyes}${brows}
    <path d="M166 242 C164 232 177 228 200 228 C223 228 236 232 234 242 C231 253 213 262 204 271 Q200 276 196 271 C187 262 169 253 166 242Z" fill="${ink}"/>
    ${mouth}`;
}

function eyewear(a: MascotAppearance) {
  if (a.glasses === 'none') return '';
  const sides = '<path d="M65 175L47 165 M335 175L353 165 M171 174Q200 155 229 174"/>';
  if (a.glasses === 'round') return `<g fill="none" stroke="${a.glassesColor}" stroke-width="7" stroke-linecap="round"><circle cx="120" cy="188" r="51"/><circle cx="280" cy="188" r="51"/>${sides}</g>`;
  const lenses = '<rect x="63" y="146" width="113" height="86" rx="18"/><rect x="224" y="146" width="113" height="86" rx="18"/>';
  if (a.glasses === 'square') return `<g fill="none" stroke="${a.glassesColor}" stroke-width="8" stroke-linecap="round">${lenses}${sides}</g>`;
  return `<g fill="none" stroke="${a.glassesColor}" stroke-width="4" stroke-linecap="round">${lenses}${sides}<path d="M65 170V161Q65 147 80 147H159Q174 147 174 161V170 M226 170V161Q226 147 241 147H320Q335 147 335 161V170" stroke-width="11"/></g>`;
}

let sequence = 0;
export function renderMascot(input: unknown = defaultMascotAppearance, options: { size?: number; expression?: MascotExpression; uid?: string } = {}) {
  const a = normalizeMascotAppearance(input);
  const pose: MascotExpression = options.expression === 'listening' || options.expression === 'speaking' ? options.expression : 'idle';
  const id = 'nova-' + String(options.uid || ++sequence).replace(/[^a-z0-9_-]/gi, '');
  const size = typeof options.size === 'number' && Number.isFinite(options.size) ? Math.max(16, Math.min(1600, options.size)) : 400;
  const muzzle = mix(a.fur, '#ffffff', .52);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="${size}" height="${size}" role="img" aria-label="${a.face} Nova lynx, ${a.pattern} markings, ${a.outfit}, ${pose}">
    <rect width="400" height="400" fill="${a.fur}"/>
    ${ears(a, muzzle)}${markings(a)}${clothing(a, id)}${features(a, pose, id, muzzle)}${eyewear(a)}
  </svg>`;
}
