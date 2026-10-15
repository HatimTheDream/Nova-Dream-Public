import type { MascotAppearance } from '../../../../../packages/domain/mascot-appearance';
import type { MascotExpression } from './mascot-art';
const ink = '#25272b';
const reflect = (content: string) => content + `<g transform="translate(400 0) scale(-1 1)">${content}</g>`;
function mix(hex: string, target: string, amount: number) {
 const a=hex.match(/[a-f\d]{2}/gi)!.map(x=>parseInt(x,16));
 const b=target.match(/[a-f\d]{2}/gi)!.map(x=>parseInt(x,16));
 return '#'+a.map((v,i)=>Math.round(v*(1-amount)+b[i]*amount).toString(16).padStart(2,'0')).join('');
}
// Approved additions. Original choices deliberately fall through to their unchanged artwork.
// Coordinates use the approved 400 × 400 lynx art and the existing color helpers.
export function extraMarkings(a: MascotAppearance) {
  const fpColor = a.markings;
  const fpSoft = mix(fpColor, a.fur, .32);
  const fpPale = mix(fpColor, a.fur, .55);
  const fpLayers: Record<string, string> = {
    ticked: `<g fill="none" stroke="${fpColor}" stroke-width="6" stroke-linecap="round">
      ${reflect('<path d="M178 27L185 41 M161 40L170 55 M141 51L150 65 M122 61L132 75 M105 75L116 88 M185 65L191 78 M164 79L173 93 M141 94L152 106 M28 164L38 175 M13 187L25 197 M39 192L50 204 M11 227L24 237 M39 230L53 240 M65 241L77 250 M17 267L30 279 M46 272L57 284 M26 303L36 316 M60 302L70 313"/>')}
    </g>`,
    'lynx-spots': `<g fill="${fpColor}">
      <path d="M193 21Q207 15 212 28Q213 42 200 48Q188 41 193 21Z M194 68Q205 61 209 73Q210 84 199 88Q189 82 194 68Z"/>
      ${reflect('<path d="M165 28Q175 26 178 38Q177 52 167 54Q158 47 165 28Z M137 52Q148 48 153 61Q155 73 144 76Q132 70 137 52Z M112 83Q124 77 129 88Q134 101 122 105Q109 100 112 83Z M27 161Q41 157 43 170Q45 180 34 187Q22 182 27 161Z M8 204Q23 199 26 212Q28 224 15 230Q4 222 8 204Z M46 208Q57 200 64 211Q69 225 57 230Q43 226 46 208Z M21 249Q33 239 41 250Q48 264 36 270Q20 267 21 249Z M64 259Q74 251 81 261Q88 272 76 281Q62 277 64 259Z M24 291Q35 282 41 293Q46 308 34 315Q20 309 24 291Z M58 306Q69 298 77 308Q80 320 68 327Q55 322 58 306Z"/>')}
    </g>`,
    chevrons: `<g fill="${fpColor}">
      <path d="M151 26L200 54L249 26L238 48L200 76L162 48Z M166 79L200 99L234 79L225 102L200 123L175 102Z"/>
      ${reflect('<path d="M0 151L39 170L76 151L66 175L39 194L0 175Z M0 216L39 235L80 215L69 241L38 258L0 242Z M17 278L49 292L83 273L76 299L49 317L24 303Z"/>')}
    </g>`,
    dappled: `<g fill="${fpSoft}">
      <path d="M165 22C176 11 193 14 198 26C211 12 231 17 230 32C243 42 231 57 216 56C210 70 188 68 183 55C164 58 153 39 165 22Z"/>
      ${reflect('<path d="M121 58C134 42 158 54 151 72C168 79 159 100 143 97C132 111 111 97 118 83C101 77 107 63 121 58Z M24 165C35 151 54 162 51 175C69 178 63 201 46 201C37 219 16 206 18 193C3 185 8 170 24 165Z M40 239C52 223 73 229 72 246C90 250 82 270 66 271C62 287 42 290 35 275C17 274 18 254 31 250C25 243 32 235 40 239Z M20 299C25 284 45 285 48 299C64 305 55 325 41 323C29 336 13 318 20 309C11 307 12 299 20 299Z"/>')}
    </g><g fill="${fpColor}">${reflect('<ellipse cx="135" cy="75" rx="7" ry="10" transform="rotate(-28 135 75)"/><ellipse cx="39" cy="182" rx="8" ry="12" transform="rotate(24 39 182)"/><ellipse cx="55" cy="258" rx="10" ry="13" transform="rotate(31 55 258)"/><ellipse cx="35" cy="307" rx="6" ry="9"/>')}</g>`,
    contour: `<g fill="none" stroke="${fpColor}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M161 34Q200 8 239 34 M172 54Q200 33 228 54 M184 75Q200 61 216 75"/>
      ${reflect('<path d="M33 127C62 102 108 101 137 119 M9 154C29 123 43 113 61 110 M8 229C28 217 46 218 60 233C69 242 75 244 86 243 M0 254C25 235 42 241 46 259C52 281 38 293 45 319 M8 281C23 267 28 270 28 286C28 305 35 322 52 333 M70 284Q63 300 73 314"/>')}
    </g>`,
    cap: `<g fill="${fpColor}">
      <path d="M94 0H306L298 57Q286 88 261 110L238 99L220 116L200 96L180 116L162 99L139 110Q114 88 102 57Z"/>
      ${reflect('<path d="M0 173Q26 169 52 148L42 176L15 199L0 206Z M0 270Q14 248 37 242L28 267L14 286L0 291Z M27 309Q39 290 61 286L58 308L44 329Z"/>')}
    </g><path d="M181 18Q200 27 219 18L212 68L200 79L188 68Z" fill="${fpSoft}"/>`,
    tearline: `<g fill="${fpColor}">
      <path d="M188 25Q200 18 212 25L207 82L200 107L193 82Z"/>
      ${reflect('<path d="M154 41Q166 43 173 53L165 83L151 63Z M164 205Q176 209 177 225C174 245 161 259 149 273Q139 286 131 304L122 299Q128 274 145 253Q157 237 158 222Z M7 163Q24 157 43 143L36 166L9 185Z M0 248Q20 228 45 229L34 250L0 270Z M20 306Q34 284 59 280L51 299L30 322Z"/>')}
    </g>`,
    mosaic: `<g fill="${fpColor}">
      <path d="M200 18L216 38L200 62L184 38Z M163 52L181 66L173 88L151 74Z M237 52L249 74L227 88L219 66Z"/>
      ${reflect('<path d="M116 37L137 43L126 65L106 57Z M20 153L48 159L41 184L13 180Z M0 204L23 191L39 216L17 238L0 230Z M47 227L73 235L63 259L40 251Z M12 269L35 253L49 278L30 300L10 291Z M58 285L80 292L73 315L50 308Z M22 317L42 305L51 327L31 341Z"/>')}
    </g><g fill="${fpSoft}">${reflect('<path d="M147 31L164 37L157 54L138 48Z M4 165L17 153L10 180L0 188Z M32 183L47 180L51 203L40 214L28 199Z M18 238L36 230L40 250L24 262L12 254Z M42 279L56 268L65 284L53 299Z"/>')}</g>`,
    sable: `<g fill="${fpSoft}">
      <path d="M93 0H307L291 48Q268 70 248 72L225 53L200 72L175 53L152 72Q132 70 109 48Z"/>
      ${reflect('<path d="M0 131Q38 112 60 116Q50 153 34 176Q19 207 25 232Q32 261 62 275L77 302L66 334Q43 335 18 317Q8 298 0 299V269L12 243L0 232Z"/>')}
    </g><g fill="${fpColor}">${reflect('<path d="M0 161Q19 143 35 141Q24 173 10 188L0 193Z M0 279Q16 266 29 270Q34 295 53 305L48 323Q25 316 14 297L0 306Z M131 23Q150 27 170 42L161 59L143 44Z"/>')}</g>`,
    ripple: `<g fill="none" stroke="${fpColor}" stroke-width="9" stroke-linecap="round">
      <path d="M154 32Q175 52 200 32Q225 52 246 32 M167 68Q182 84 200 68Q218 84 233 68"/>
      ${reflect('<path d="M5 162C26 184 43 153 62 168 M0 209C23 190 42 230 64 213 M0 257C23 235 42 273 73 248 M16 298C37 277 49 315 72 296 M34 329Q51 318 63 329"/>')}
    </g>`,
    crown: `<g fill="${fpColor}">
      <path d="M200 14L219 48L245 28L236 71L259 69L240 97L218 87L200 113L182 87L160 97L141 69L164 71L155 28L181 48Z"/>
      ${reflect('<path d="M0 169L24 176L49 156L45 180L69 180L47 199L22 200L0 212Z M0 249L24 253L51 232L49 257L72 258L50 278L22 278L0 290Z M27 308L47 313L71 294L68 317L80 325L57 338L35 329Z"/>')}
    </g><path d="M200 43L212 67L200 83L188 67Z" fill="${fpPale}"/>`,
    pinstripe: `<g fill="none" stroke="${fpColor}" stroke-width="5" stroke-linecap="round">
      <path d="M200 22V103 M181 30L186 83 M219 30L214 83 M161 42L172 82 M239 42L228 82 M144 56L158 88 M256 56L242 88"/>
      ${reflect('<path d="M8 151L32 172 M0 168L25 190 M0 187L15 202 M0 228L41 251 M0 247L37 269 M0 267L32 286 M11 290L32 303 M35 287L67 302 M32 305L62 321"/>')}
    </g>`
  };
  return fpLayers[a.pattern];
}

type FaceEye = { shape?: string; top?: string; iris?: number; pupil?: number; cy?: number; cx?: number; lid?: string; lower?: string; closed?: string };
const fpFaceStyles: Record<string, { eyes: FaceEye[]; brows: string[]; mouth: string; cheeks?: string }> = {
  alert: {
    eyes: [{ shape: 'M66 186C66 151 87 126 120 126C155 126 175 151 175 186C175 216 157 232 120 232C83 232 66 215 66 186Z', top: 'M67 174C73 141 95 125 120 127C149 126 169 144 174 176', iris: 37, pupil: 20, cy: 185 }],
    brows: ['M66 108Q117 81 166 108Q174 116 168 123Q118 103 70 121Q61 121 66 108Z'],
    mouth: '<path d="M200 269V279Q216 292 232 281M168 281Q184 292 200 279" fill="none" stroke="{ink}" stroke-width="7" stroke-linecap="round"/>'
  },
  dreamy: {
    eyes: [{ shape: 'M68 181C77 153 96 141 121 141C149 142 167 158 172 187C173 216 155 229 120 230C86 229 68 214 68 181Z', top: 'M69 177Q120 166 171 183', lid: 'M60 124H180V184Q122 164 60 178Z', iris: 35, pupil: 18, cy: 182, cx: 127 }],
    brows: ['M69 121Q112 108 164 123Q170 129 166 135Q117 123 73 132Q65 132 69 121Z'],
    mouth: '<path d="M200 269V279Q212 293 229 286M174 284Q187 294 200 279" fill="none" stroke="{ink}" stroke-width="6" stroke-linecap="round"/>'
  },
  playful: {
    eyes: [{ closed: 'M74 187Q118 159 165 191', lower: 'M91 210Q120 221 146 212' }, { shape: 'M67 186C69 155 88 134 120 134C151 134 172 154 173 187C174 216 157 231 120 231C85 231 67 215 67 186Z', top: 'M68 175C78 146 97 133 120 136C148 134 167 150 173 177', iris: 36, pupil: 20, cy: 188 }],
    brows: ['M67 123Q113 105 166 125Q172 132 166 138Q117 121 73 135Q65 135 67 123Z', 'M65 106Q116 80 168 108Q173 116 167 122Q117 103 70 120Q61 120 65 106Z'],
    mouth: '<path d="M168 278Q200 302 236 278Q229 311 202 312Q178 311 168 278Z" fill="{ink}"/><path d="M214 291L225 287L220 300Z" fill="#fffef8"/>'
  },
  thoughtful: {
    eyes: [{ shape: 'M67 185C69 158 89 139 121 139C149 140 170 159 173 187C173 213 156 229 121 230C86 230 67 212 67 185Z', top: 'M68 176Q117 153 172 178', lid: 'M60 124H181V178Q119 153 60 179Z', iris: 33, pupil: 18, cx: 109, cy: 178 }, { shape: 'M67 183C70 152 91 132 122 132C151 133 171 152 174 185C174 215 156 230 121 230C85 230 67 212 67 183Z', top: 'M68 172C80 142 98 131 122 134C148 132 169 150 173 176', iris: 34, pupil: 18, cx: 131, cy: 178 }],
    brows: ['M64 119Q114 106 167 127L165 140Q113 121 68 133Q59 131 64 119Z', 'M67 105Q115 80 165 103Q173 110 168 117Q118 100 72 119Q63 119 67 105Z'],
    mouth: '<path d="M200 269V281M177 287Q190 293 200 281Q212 289 226 282" fill="none" stroke="{ink}" stroke-width="7" stroke-linecap="round"/>'
  },
  determined: {
    eyes: [{ shape: 'M67 184C70 153 91 136 121 137C150 139 170 157 174 185C174 214 157 229 121 230C86 230 68 213 67 184Z', top: 'M67 158L173 184', lid: 'M59 121H182V187L59 155Z', lower: 'M75 213Q121 232 165 212', iris: 34, pupil: 19, cy: 190 }],
    brows: ['M62 105Q99 96 172 130L168 147Q108 120 66 121Q58 119 62 105Z'],
    mouth: '<path d="M200 269V280M170 289Q186 299 200 280Q214 299 230 289" fill="none" stroke="{ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>'
  },
  warm: {
    eyes: [{ shape: 'M66 183Q84 143 120 143Q154 144 175 183Q158 224 120 228Q83 226 66 183Z', top: 'M67 181Q119 138 174 181', lower: 'M76 211Q120 232 165 210', iris: 34, pupil: 18, cy: 189 }],
    brows: ['M68 117Q114 94 164 116Q172 122 166 130Q118 113 73 130Q64 130 68 117Z'],
    mouth: '<path d="M169 279Q200 306 232 279Q229 307 200 309Q175 308 169 279Z" fill="{ink}"/><path d="M180 289Q199 300 220 289L217 298Q200 304 183 298Z" fill="#fffef8"/>'
  },
  skeptical: {
    eyes: [{ shape: 'M67 184C70 153 89 135 120 135C151 135 173 156 174 187C175 214 157 230 121 230C86 230 67 213 67 184Z', top: 'M67 185Q120 175 174 187', lid: 'M59 121H181V187Q122 174 59 185Z', iris: 32, pupil: 18, cy: 190, cx: 125 }, { shape: 'M67 184C67 152 87 130 120 130C153 130 174 151 174 184C175 216 157 230 121 230C85 230 67 215 67 184Z', top: 'M67 173C77 141 95 130 120 132C149 130 169 148 174 177', iris: 34, pupil: 18, cy: 188, cx: 115 }],
    brows: ['M63 129Q116 119 170 132L168 145Q118 134 67 141Q59 140 63 129Z', 'M66 101Q115 77 164 103Q171 111 166 117Q117 97 71 116Q61 116 66 101Z'],
    mouth: '<path d="M200 269V280M174 286Q188 295 200 280Q212 292 235 277" fill="none" stroke="{ink}" stroke-width="7" stroke-linecap="round"/>'
  },
  bashful: {
    eyes: [{ shape: 'M68 185C74 159 94 143 120 143C147 143 166 160 173 186C173 216 155 231 120 231C85 231 68 214 68 185Z', top: 'M69 176Q120 160 172 178', lid: 'M60 122H181V180Q120 160 60 179Z', iris: 32, pupil: 18, cy: 203, cx: 125 }],
    brows: ['M67 131Q112 105 165 105Q173 109 169 116Q117 121 73 141Q64 141 67 131Z'],
    cheeks: '<path d="M72 238L80 247M86 236L94 245M306 245L314 236M320 247L328 238" fill="none" stroke="{blush}" stroke-width="5" stroke-linecap="round"/>',
    mouth: '<path d="M200 269V280Q212 292 225 284M175 284Q188 292 200 280" fill="none" stroke="{ink}" stroke-width="6" stroke-linecap="round"/>'
  },
  delighted: {
    eyes: [{ closed: 'M72 178Q120 218 168 178', lower: 'M86 214Q120 231 154 214' }],
    brows: ['M68 107Q119 77 165 108Q172 116 166 122Q120 102 74 122Q65 122 68 107Z'],
    mouth: '<path d="M165 278Q199 296 235 278C232 314 214 326 200 326C182 324 168 310 165 278Z" fill="{ink}"/><path d="M176 287Q200 299 224 287L219 298Q200 305 181 298Z" fill="#fffef8"/><path d="M188 316Q201 304 214 315Q203 326 191 320Z" fill="#d76f76"/>'
  },
  serene: {
    eyes: [{ closed: 'M74 184Q120 207 166 184', lower: 'M91 211Q120 222 149 211' }],
    brows: ['M68 119Q116 108 165 120Q172 126 167 132Q118 123 73 132Q64 131 68 119Z'],
    mouth: '<path d="M200 269V279Q215 294 232 283M168 283Q185 294 200 279" fill="none" stroke="{ink}" stroke-width="6" stroke-linecap="round"/>'
  },
  mischievous: {
    eyes: [{ shape: 'M65 180Q91 142 121 144Q155 146 175 186Q152 221 119 226Q86 221 65 180Z', top: 'M66 166Q117 164 174 189', lid: 'M59 121H182V189Q119 162 59 164Z', iris: 33, pupil: 17, cy: 189, cx: 124 }, { shape: 'M65 180Q91 142 121 144Q155 146 175 186Q152 221 119 226Q86 221 65 180Z', top: 'M66 170Q119 153 174 183', lid: 'M59 121H182V183Q119 151 59 169Z', iris: 34, pupil: 17, cy: 189, cx: 116 }],
    brows: ['M63 109Q110 96 171 124L167 140Q113 118 68 124Q58 122 63 109Z', 'M66 99Q113 78 165 107Q172 115 166 122Q115 101 71 114Q60 113 66 99Z'],
    mouth: '<path d="M170 282Q202 302 239 274Q234 306 207 310Q182 309 170 282Z" fill="{ink}"/><path d="M216 292L228 285L222 301Z" fill="#fffef8"/>'
  },
  adventurous: {
    eyes: [{ shape: 'M66 183Q78 143 116 135Q151 135 175 181Q163 220 122 230Q82 230 66 183Z', top: 'M67 170Q119 134 174 176', iris: 35, pupil: 19, cy: 185 }, { shape: 'M66 184Q83 153 119 144Q153 144 175 184Q158 220 121 228Q86 226 66 184Z', top: 'M67 174Q120 156 174 184', lid: 'M59 121H182V184Q121 155 59 174Z', iris: 34, pupil: 19, cy: 186 }],
    brows: ['M61 107Q104 90 170 113L167 129Q112 110 66 123Q56 121 61 107Z', 'M63 115Q115 100 170 126L167 141Q115 119 68 131Q58 129 63 115Z'],
    mouth: '<path d="M200 269V279Q215 297 240 279M171 286Q188 297 200 279" fill="none" stroke="{ink}" stroke-width="8" stroke-linecap="round"/>'
  }
};

export function extraFeatures(a: MascotAppearance, pose: MascotExpression, id: string, muzzle: string) {
  const fpStyle = fpFaceStyles[a.face];
  if (!fpStyle) return undefined;
  const fpLook = pose === 'listening' ? -3 : 0;
  let fpEyes = '';
  for (let fpSide = 0; fpSide < 2; fpSide++) {
    const fpEye = fpStyle.eyes[fpSide] || fpStyle.eyes[0];
    const fpTransform = fpSide ? 'translate(400 0) scale(-1 1)' : '';
    const fpLower = fpEye.lower ? `<path d="${fpEye.lower}" fill="none" stroke="${mix(a.fur, ink, .14)}" stroke-width="4" stroke-linecap="round"/>` : '';
    if (fpEye.closed) {
      fpEyes += `<g transform="${fpTransform}"><path d="${fpEye.closed}" fill="none" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>${fpLower}</g>`;
      continue;
    }
    const fpClip = `${id}-fp-eye-${fpSide}`;
    const fpCx = fpEye.cx || 120;
    const fpCy = (fpEye.cy ?? 190) + fpLook;
    fpEyes += `<g transform="${fpTransform}">
      <defs><clipPath id="${fpClip}"><path d="${fpEye.shape}"/></clipPath></defs>
      <path d="${fpEye.shape}" fill="#fffef8"/>
      <g clip-path="url(#${fpClip})">
        <circle cx="${fpCx}" cy="${fpCy}" r="${fpEye.iris}" fill="${a.eyes}"/>
        <circle cx="${fpCx}" cy="${fpCy}" r="${fpEye.pupil}" fill="${ink}"/>
        <circle cx="${fpCx + (fpSide ? 10 : -10)}" cy="${fpCy - 15}" r="7" fill="#ffffff"/>
        ${fpEye.lid ? `<path d="${fpEye.lid}" fill="${a.fur}"/>` : ''}
      </g>
      <path d="${fpEye.top}" fill="none" stroke="${ink}" stroke-width="7" stroke-linecap="round"/>${fpLower}
    </g>`;
  }
  const fpBrows = fpStyle.brows.length === 1
    ? reflect(`<path d="${fpStyle.brows[0]}"/>`)
    : `<path d="${fpStyle.brows[0]}"/><g transform="translate(400 0) scale(-1 1)"><path d="${fpStyle.brows[1]}"/></g>`;
  const fpMouth = pose === 'speaking'
    ? `<path d="M174 280Q200 294 226 280C225 313 208 320 198 317C184 315 175 302 174 280Z" fill="${ink}"/><path d="M187 306Q200 296 215 305Q206 319 193 313Z" fill="#d76f76"/>`
    : fpStyle.mouth.replaceAll('{ink}', ink);
  const fpCheeks = (fpStyle.cheeks || '').replaceAll('{blush}', mix(a.markings, a.fur, .35));
  return `<path d="M167 230C139 234 108 257 94 293L110 285C98 306 104 321 125 334L129 323C145 343 173 348 200 347C227 348 255 343 271 323L275 334C296 321 302 306 290 285L306 293C292 257 261 234 233 230Z" fill="${muzzle}"/>
    ${fpEyes}<g fill="${ink}" transform="translate(0 ${pose === 'listening' ? -5 : 0})">${fpBrows}</g>${fpCheeks}
    <path d="M166 242C164 232 177 228 200 228C223 228 236 232 234 242C231 253 213 262 204 271Q200 276 196 271C187 262 169 253 166 242Z" fill="${ink}"/>
    ${fpMouth}`;
}

// Prototype-only additions. Original catalog choices fall through to approved art.
export function extraClothing(a: MascotAppearance, id: string) {
  const ogC = a.clothing;
  const ogA = a.accent;
  const ogHigh = mix(ogC, '#ffffff', .15);
  const ogLow = mix(ogC, '#000000', .23);
  const ogAccentLow = mix(ogA, '#000000', .2);
  const ogBase = `<path d="M0 400V359L120 328Q150 316 172 321H228Q251 317 280 328L400 359V400Z" fill="${ogC}"/>`;
  const ogSeams = `<path d="M62 348L78 400 M338 348L322 400" fill="none" stroke="${ogLow}" stroke-width="4"/>`;
  switch (a.outfit) {
    case 'polo':
      return ogBase + ogSeams + `
        <path d="M140 321L200 349L260 321L274 339L229 364L200 348L171 364L126 339Z" fill="${ogA}"/>
        <path d="M192 348H208V391H192Z" fill="${ogHigh}"/>
        <circle cx="200" cy="367" r="3.5" fill="${ogLow}"/><circle cx="200" cy="382" r="3.5" fill="${ogLow}"/>
        <path d="M280 372H313" stroke="${ogA}" stroke-width="5" stroke-linecap="round"/>`;
    case 'bomber':
      return ogBase + `
        <path d="M137 321Q200 344 263 321L261 343Q200 365 139 343Z" fill="${ogA}"/>
        <path d="M140 329Q200 350 260 329" fill="none" stroke="${ogAccentLow}" stroke-width="5"/>
        <path d="M200 353V400" stroke="${ogA}" stroke-width="7"/>
        <path d="M208 363V377" stroke="${ogLow}" stroke-width="5" stroke-linecap="round"/>
        <path d="M82 375L127 392 M318 375L273 392" stroke="${ogLow}" stroke-width="7" stroke-linecap="round"/>
        <path d="M43 354L61 382" stroke="${ogHigh}" stroke-width="9" stroke-linecap="round"/>`;
    case 'henley':
      return ogBase + ogSeams + `
        <path d="M141 323Q200 351 259 323L253 343Q200 369 147 343Z" fill="${ogA}"/>
        <path d="M190 353H210V400H190Z" fill="${ogHigh}"/>
        <path d="M190 356V400" stroke="${ogLow}" stroke-width="4"/>
        <circle cx="202" cy="365" r="3.5" fill="${ogA}"/><circle cx="202" cy="379" r="3.5" fill="${ogA}"/><circle cx="202" cy="393" r="3.5" fill="${ogA}"/>`;
    case 'denim':
      return ogBase + `
        <path d="M140 320L200 348L260 320L275 340L233 365L200 349L167 365L125 340Z" fill="${ogHigh}"/>
        <path d="M190 351H209V400H190Z" fill="${ogLow}"/>
        <path d="M65 366H130V398H65Z M270 366H335V398H270Z" fill="${ogHigh}"/>
        <path d="M65 366H130L121 380H74Z M270 366H335L326 380H279Z" fill="${ogLow}"/>
        <path d="M42 351L132 336 M268 336L358 351" fill="none" stroke="${ogA}" stroke-width="4"/>
        <circle cx="199" cy="366" r="3.5" fill="${ogA}"/><circle cx="199" cy="389" r="3.5" fill="${ogA}"/>
        <circle cx="98" cy="374" r="3.5" fill="${ogA}"/><circle cx="302" cy="374" r="3.5" fill="${ogA}"/>`;
    case 'varsity':
      return ogBase + `
        <path d="M0 359L96 334L111 400H0Z M400 359L304 334L289 400H400Z" fill="${ogA}"/>
        <path d="M140 322Q200 346 260 322L257 344Q200 366 143 344Z" fill="${ogA}"/>
        <path d="M145 332Q200 353 255 332" fill="none" stroke="${ogC}" stroke-width="5"/>
        <path d="M194 352H208V400H194Z" fill="${ogHigh}"/>
        <circle cx="201" cy="369" r="4" fill="${ogA}"/><circle cx="201" cy="391" r="4" fill="${ogA}"/>
        <path d="M275 360H287L299 382L311 360H323L304 395H294Z" fill="${ogA}"/>
        <path d="M83 380L122 394" stroke="${ogHigh}" stroke-width="6" stroke-linecap="round"/>`;
    case 'blazer':
      return ogBase + `
        <path d="M153 320H247L227 400H173Z" fill="${ogA}"/>
        <path d="M142 320L174 351L165 366L190 400H151L119 355L130 348L110 337Z M258 320L226 351L235 366L210 400H249L281 355L270 348L290 337Z" fill="${ogHigh}"/>
        <path d="M166 352Q200 368 234 352" fill="none" stroke="${ogAccentLow}" stroke-width="5"/>
        <path d="M284 369H325" stroke="${ogLow}" stroke-width="6" stroke-linecap="round"/>
        <path d="M298 356L305 346L313 356Z" fill="${ogA}"/>
        <circle cx="231" cy="393" r="4" fill="${ogLow}"/>`;
    case 'vneck':
      return ogBase + ogSeams + `
        <path d="M141 321L200 371L259 321L268 337L200 391L132 337Z" fill="${ogA}"/>
        <path d="M157 329L200 365L243 329L232 322H168Z" fill="${mix(a.fur, '#ffffff', .52)}"/>
        <path d="M148 339L200 382L252 339" fill="none" stroke="${ogAccentLow}" stroke-width="4"/>
        <path d="M48 368L68 400 M352 368L332 400" stroke="${ogHigh}" stroke-width="4"/>`;
    case 'raincoat':
      return ogBase + `
        <path d="M108 337Q108 319 136 318L157 328L176 361L160 373L122 354Z M292 337Q292 319 264 318L243 328L224 361L240 373L278 354Z" fill="${ogHigh}"/>
        <path d="M155 333L175 360 M245 333L225 360" fill="none" stroke="${ogLow}" stroke-width="6" stroke-linecap="round"/>
        <path d="M192 350H210V400H192Z" fill="${ogA}"/>
        <path d="M205 357V400" stroke="${ogAccentLow}" stroke-width="4"/>
        <path d="M54 374H128L120 387H62Z M272 374H346L338 387H280Z" fill="${ogHigh}"/>
        <path d="M22 363L128 345 M272 345L378 363" stroke="${ogA}" stroke-width="5"/>
        <circle cx="201" cy="370" r="3.5" fill="${ogC}"/><circle cx="201" cy="391" r="3.5" fill="${ogC}"/>`;
    case 'scarf':
      return ogBase + ogSeams + `
        <path d="M115 327Q200 350 285 327L276 360Q200 384 124 360Z" fill="${ogA}"/>
        <path d="M128 346Q200 368 272 346" fill="none" stroke="${ogAccentLow}" stroke-width="6"/>
        <path d="M205 365L251 356L272 400H219Z" fill="${ogA}"/>
        <path d="M215 377L258 371 M221 390L265 384" stroke="${ogAccentLow}" stroke-width="5"/>
        <path d="M140 365L166 400 M260 365L239 400" fill="none" stroke="${ogHigh}" stroke-width="7"/>`;
    case 'tuxedo':
      return ogBase + `
        <path d="M149 320H251L224 400H176Z" fill="#fffdf8"/>
        <path d="M139 320Q127 350 174 400H149Q111 363 116 338Z M261 320Q273 350 226 400H251Q289 363 284 338Z" fill="${ogHigh}"/>
        <path d="M167 343L194 352L167 366Z M233 343L206 352L233 366Z" fill="${ogA}"/>
        <rect x="192" y="348" width="16" height="14" rx="4" fill="${ogAccentLow}"/>
        <circle cx="200" cy="376" r="4" fill="${ogLow}"/><circle cx="200" cy="392" r="4" fill="${ogLow}"/>
        <path d="M283 376H324" stroke="${ogLow}" stroke-width="6" stroke-linecap="round"/>
        <path d="M294 369L302 358L309 369L317 358L321 369Z" fill="${ogA}"/>`;
    case 'track':
      return ogBase + `
        <path d="M141 319Q200 331 259 319L264 349Q200 372 136 349Z" fill="${ogHigh}"/>
        <path d="M194 352H206V400H194Z" fill="${ogA}"/>
        <path d="M17 356L100 335L137 400H121L86 352L23 369Z M383 356L300 335L263 400H279L314 352L377 369Z" fill="${ogA}"/>
        <path d="M37 356L93 341L128 400 M363 356L307 341L272 400" fill="none" stroke="${ogHigh}" stroke-width="4"/>
        <path d="M76 382L112 392 M324 382L288 392" fill="none" stroke="${ogLow}" stroke-width="6" stroke-linecap="round"/>`;
    case 'overalls':
      return ogBase + `
        <path d="M140 321Q200 349 260 321L254 341Q200 367 146 341Z" fill="${ogHigh}"/>
        <path d="M118 329L144 323L160 383L146 400H119Z M282 329L256 323L240 383L254 400H281Z" fill="${ogA}"/>
        <path d="M131 369H269V400H131Z" fill="${ogA}"/>
        <path d="M165 382H235V400H165Z" fill="${ogAccentLow}"/>
        <path d="M171 388H229" stroke="${ogA}" stroke-width="4"/>
        <rect x="127" y="353" width="23" height="17" rx="4" fill="none" stroke="${ogLow}" stroke-width="5"/>
        <rect x="250" y="353" width="23" height="17" rx="4" fill="none" stroke="${ogLow}" stroke-width="5"/>`;
    default:
      return undefined;
  }
}

export function extraEyewear(a: MascotAppearance) {
  const ogColor = a.glassesColor;
  const ogSides = '<path d="M64 173L46 164 M336 173L354 164"/>';
  const ogBridge = '<path d="M174 179Q200 162 226 179"/>';
  const ogFrame = (content: string, width = 7) => `<g fill="none" stroke="${ogColor}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${content}${ogSides}</g>`;
  switch (a.glasses) {
    case 'aviator':
      return ogFrame(reflect('<path d="M64 155Q119 139 176 155L169 196Q157 236 122 237Q83 232 67 203Z"/>') + '<path d="M176 166Q200 156 224 166 M174 151H226"/>', 6);
    case 'cat-eye':
      return ogFrame(reflect('<path d="M50 141L103 151Q146 140 177 164L171 202Q157 230 120 230Q85 229 70 202Z"/>') + ogBridge, 8);
    case 'oval':
      return ogFrame('<ellipse cx="120" cy="190" rx="56" ry="38"/><ellipse cx="280" cy="190" rx="56" ry="38"/>' + ogBridge, 7);
    case 'hexagon':
      return ogFrame(reflect('<path d="M92 140H148L178 187L149 232H91L62 187Z"/>') + '<path d="M177 178Q200 167 223 178"/>', 7);
    case 'octagon':
      return ogFrame(reflect('<path d="M90 142H150L175 166V210L150 234H90L65 210V166Z"/>') + ogBridge, 7);
    case 'club-round':
      return ogFrame('<circle cx="120" cy="190" r="48"/><circle cx="280" cy="190" r="48"/>' + ogBridge, 4) + `<g fill="none" stroke="${ogColor}" stroke-width="12" stroke-linecap="round">${reflect('<path d="M72 180Q79 141 119 141Q156 140 168 180"/>')}</g>`;
    case 'wayfarer':
      return ogFrame(reflect('<path d="M58 151L180 157L166 216Q122 237 78 217Z"/>') + '<path d="M178 169Q200 158 222 169"/>', 10);
    case 'rectangle':
      return ogFrame('<rect x="61" y="157" width="117" height="65" rx="8"/><rect x="222" y="157" width="117" height="65" rx="8"/>' + '<path d="M178 179Q200 166 222 179"/>', 7);
    case 'panto':
      return ogFrame(reflect('<path d="M70 154Q120 135 170 154L174 184Q172 235 121 238Q68 235 66 184Z"/>') + ogBridge, 8);
    case 'navigator':
      return ogFrame(reflect('<path d="M65 151H175V204Q161 232 121 235Q81 232 65 204Z"/>') + '<path d="M175 162H225 M175 180Q200 166 225 180"/>', 6);
    case 'rimless':
      return `<g fill="${ogColor}" fill-opacity=".08" stroke="${ogColor}" stroke-opacity=".32" stroke-width="3">${reflect('<path d="M65 154H175V200Q166 226 120 228Q74 226 65 200Z"/>')}</g>` + ogFrame('<path d="M169 180Q200 159 231 180 M64 174H77 M323 174H336"/>', 5);
    case 'half-rim':
      return ogFrame(reflect('<path d="M63 177V162Q63 150 77 150H161Q176 150 176 162V177"/>') + ogBridge, 9) + `<g fill="none" stroke="${ogColor}" stroke-opacity=".5" stroke-width="3">${reflect('<path d="M63 177L70 207Q83 227 121 227Q158 227 170 207L176 177"/>')}</g>`;
    case 'sport':
      return ogFrame(reflect('<path d="M51 158L177 169L169 204Q133 225 82 215L68 194Z"/>') + '<path d="M176 178Q200 166 224 178 M52 157L38 149 M348 157L362 149"/>', 9) + `<path d="M59 158L170 169 M230 169L341 158" fill="none" stroke="${mix(ogColor, '#ffffff', .4)}" stroke-width="4"/>`;
    case 'shield':
      return `<path d="M53 153Q200 133 347 153L335 206Q307 232 270 225L225 206Q200 197 175 206L130 225Q93 232 65 206Z" fill="${ogColor}" fill-opacity=".13"/>` + ogFrame('<path d="M53 153Q200 133 347 153L335 206Q307 232 270 225L225 206Q200 197 175 206L130 225Q93 232 65 206Z"/>', 7);
    case 'horn-rim':
      return ogFrame(reflect('<path d="M58 145L119 150L180 143L173 196Q161 231 120 234Q77 232 66 200Z"/>') + '<path d="M178 169Q200 160 222 169"/>', 10) + `<g fill="${mix(ogColor, '#ffffff', .4)}">${reflect('<path d="M70 151L83 154L80 159L68 157Z"/>')}</g>`;
    case 'keyhole':
      return ogFrame(reflect('<path d="M71 153Q118 135 166 153Q179 172 174 198Q166 232 122 235Q78 232 68 201Q62 175 71 153Z"/>') + '<path d="M174 181L185 169V159Q200 146 215 159V169L226 181"/>', 7);
    default:
      return undefined;
  }
}
