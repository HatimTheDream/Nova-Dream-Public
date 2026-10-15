import { defaultMascotAppearance, mascotOptions, type MascotAppearance } from '../../../../../packages/domain/mascot-appearance';

export const creatorChoices = ['face', 'pattern', 'outfit', 'glasses'] as const;
export const creatorColors = ['fur', 'eyes', 'markings', 'clothing', 'accent', 'glassesColor'] as const;
export type CreatorChoice = typeof creatorChoices[number];
export type CreatorColor = typeof creatorColors[number];
export type CreatorLocks = Record<CreatorChoice | CreatorColor, boolean>;
export const creatorLabels: Record<string, string> = {
 face:'Face',pattern:'Pattern',outfit:'Outfit',glasses:'Glasses',fur:'Fur',eyes:'Eyes',markings:'Markings',clothing:'Clothing',accent:'Accent',glassesColor:'Frame',
 classic:'Classic',bright:'Bright',calm:'Calm',focused:'Focused',curious:'Curious',cheerful:'Cheerful',gentle:'Gentle',confident:'Confident',
 signature:'Signature',freckles:'Freckles',blaze:'Blaze',rosettes:'Rosettes',mask:'Mask',patches:'Patches',bands:'Bands',solid:'Solid',
 suit:'The Executive',knit:'Soft Knit',shirt:'Open Collar',hoodie:'Off Duty',cardigan:'Cardigan',vest:'Vest',turtleneck:'Turtleneck',utility:'Utility',
 none:'No Glasses',round:'Round',square:'Square',browline:'Browline',alert:'Alert',dreamy:'Dreamy',playful:'Playful',thoughtful:'Thoughtful',determined:'Determined',warm:'Warm',skeptical:'Skeptical',bashful:'Bashful',delighted:'Delighted',serene:'Serene',mischievous:'Mischievous',adventurous:'Adventurous',
 ticked:'Ticked','lynx-spots':'Lynx Spots',chevrons:'Chevrons',dappled:'Dappled',contour:'Contour',cap:'Cap',tearline:'Tearline',mosaic:'Mosaic',sable:'Sable',ripple:'Ripple',crown:'Crown',pinstripe:'Pinstripe',
 polo:'Polo',bomber:'Bomber Jacket',henley:'Henley',denim:'Denim Jacket',varsity:'Varsity Jacket',blazer:'Open Blazer',vneck:'V-Neck',raincoat:'Rain Jacket',scarf:'Winter Scarf',tuxedo:'Tuxedo',track:'Track Jacket',overalls:'Overalls',
 aviator:'Aviator','cat-eye':'Cat Eye',oval:'Oval',hexagon:'Hexagon',octagon:'Octagon','club-round':'Club Round',wayfarer:'Wayfarer',rectangle:'Rectangle',panto:'Panto',navigator:'Navigator',rimless:'Rimless','half-rim':'Half Rim',sport:'Sport',shield:'Shield','horn-rim':'Horn Rim',keyhole:'Keyhole',
};
/** Rows: six neutrals, then light-to-dark tones in consistent hue columns. */
export const creatorPresets = [
 ['Ivory','#f7ecd6'],['White','#fffdf8'],['Silver','#d4d6d9'],['Slate','#858992'],['Charcoal','#272930'],['Ink','#25272b'],
 ['Light Red','#f3c5cc'],['Light Orange','#f5d0b5'],['Light Gold','#f7e3a4'],['Light Green','#c6dfcf'],['Light Blue','#c3deef'],['Light Purple','#dcccef'],
 ['Red','#e27384'],['Orange','#e69d6b'],['Gold','#edac23'],['Green','#78ad91'],['Blue','#7faccb'],['Purple','#ad8ac7'],
 ['Deep Red','#cf2c40'],['Deep Orange','#ba6343'],['Deep Gold','#bb873e'],['Deep Green','#517268'],['Deep Blue','#376d88'],['Deep Purple','#785073'],
 ['Dark Red','#762e3b'],['Dark Orange','#886248'],['Dark Gold','#75602e'],['Dark Green','#263e36'],['Dark Blue','#243d52'],['Dark Purple','#39303f'],
] as const;
const palettes = [
 ['#f7ecd6','#edac23','#cf2c40','#272930','#cf2c40','#25272b'],
 ['#f5e2c5','#bb873e','#886248','#514137','#a66a45','#514137'],
 ['#f5ecd9','#cfaa59','#517268','#263e36','#c39651','#263e36'],
 ['#eaf0e9','#dda447','#376d88','#243d52','#5b9dae','#243d52'],
 ['#f4e7df','#d4a45b','#785073','#39303f','#b9799b','#785073'],
 ['#f8e6de','#b98345','#b86472','#68434b','#df9b99','#68434b'],
 ['#f3f0e9','#78a9b6','#6c8392','#364959','#c8a564','#364959'],
 ['#f8e8ce','#dba13a','#ba6343','#4a3535','#e29b48','#4a3535'],
] as const;
export function normalizeCreatorLocks(value: unknown): CreatorLocks {
 const next = Object.fromEntries([...creatorChoices,...creatorColors].map(key=>[key,false])) as CreatorLocks;
 if (!value || typeof value!=='object' || Array.isArray(value)) return next;
 for(const key of [...creatorChoices,...creatorColors]) { const field=Object.getOwnPropertyDescriptor(value,key); if(field && field.value===true) next[key]=true; }
 // Legacy all-colors preference is presentation state, never an appearance edit.
 if(Object.getOwnPropertyDescriptor(value,'colors')?.value===true) for(const key of creatorColors) next[key]=true;
 return next;
}
export function shuffleCreatorAppearance(value: MascotAppearance, locks: CreatorLocks, random= Math.random): MascotAppearance {
 const next={...value};
 const select=<T,>(choices: readonly T[])=>choices[Math.min(choices.length-1,Math.max(0,Math.floor(random()*choices.length)))];
 for(const key of creatorChoices) if(!locks[key]) Object.assign(next,{[key]:select(mascotOptions[key].filter(item=>item!==value[key])) ?? value[key]});
 const alternatives=palettes.filter(palette=>creatorColors.some((key,i)=>!locks[key] && palette[i]!==value[key]));
 const palette=select(alternatives) ?? creatorColors.map(key=>defaultMascotAppearance[key]);
 creatorColors.forEach((key,i)=>{if(!locks[key]) next[key]=palette[i];});
 return next;
}
