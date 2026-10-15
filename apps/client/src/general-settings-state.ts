import type { Layout } from '../../../packages/domain/contracts';
import { fontChoices, textSizeChoices, type TypographyPreferences } from './typography';
export type SharedGeneralSettings = Pick<Layout, 'theme' | 'appIcon' | 'timezone'>;
export type GeneralSettingsValues = SharedGeneralSettings & TypographyPreferences;
export type GeneralSettingsField = keyof GeneralSettingsValues;
export const sharedGeneralFields = ['theme', 'appIcon', 'timezone'] as const;
export const typographyGeneralFields = ['interfaceFont', 'interfaceTextSize', 'messageFont', 'messageTextSize'] as const;
export const generalSettingsFields = [...sharedGeneralFields, ...typographyGeneralFields] as const;
export type GeneralSettingsDraft = { version: 1; epoch: string; base: GeneralSettingsValues; value: GeneralSettingsValues };
export function generalSettingsValues(layout: SharedGeneralSettings, typography: TypographyPreferences): GeneralSettingsValues {
 return { theme: layout.theme, appIcon: layout.appIcon ?? 'red', timezone: layout.timezone, ...typography };
}
export function newGeneralSettingsDraft(epoch: string, current: GeneralSettingsValues): GeneralSettingsDraft {
 return { version: 1, epoch, base: { ...current }, value: { ...current } };
}
export function validGeneralSettingsValues(value: unknown): value is GeneralSettingsValues {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const v=value as GeneralSettingsValues;
 if(Object.keys(v).length!==generalSettingsFields.length||!generalSettingsFields.every(key=>Object.hasOwn(v,key)))return false;
 if(!['light','dark','system'].includes(v.theme)||!['red','cream'].includes(v.appIcon)||typeof v.timezone!=='string'||v.timezone.length>80)return false;
 try{new Intl.DateTimeFormat('en',{timeZone:v.timezone});}catch{return false;}
 return typographyGeneralFields.every(key=>(key.endsWith('Font')?fontChoices:textSizeChoices).some(choice=>choice.value===v[key]));
}
export function restoreGeneralSettingsDraft(raw: unknown, epoch: string, current: GeneralSettingsValues): GeneralSettingsDraft {
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
  const v=raw as GeneralSettingsDraft;
  if(v.version===1&&v.epoch===epoch&&validGeneralSettingsValues(v.base)&&validGeneralSettingsValues(v.value))return syncGeneralSettingsDraft({version:1,epoch,base:{...v.base},value:{...v.value}},current);
 }
 return newGeneralSettingsDraft(epoch,current);
}
export function changedGeneralSettingsFields(draft: GeneralSettingsDraft): GeneralSettingsField[] {
 return generalSettingsFields.filter(key=>draft.value[key]!==draft.base[key]);
}
/** Rebase only untouched fields; a concurrent changed field remains reviewable. */
export function syncGeneralSettingsDraft(draft: GeneralSettingsDraft,current: GeneralSettingsValues): GeneralSettingsDraft {
 const next={...draft,base:{...draft.base},value:{...draft.value}};
 for(const key of generalSettingsFields)if(draft.base[key]===draft.value[key]){Object.assign(next.base,{[key]:current[key]});Object.assign(next.value,{[key]:current[key]});}
 return next;
}
export function mergeGeneralSettingsDraft(draft: GeneralSettingsDraft,current: GeneralSettingsValues) {
 const conflicts:GeneralSettingsField[]=[],sharedPatch:Partial<SharedGeneralSettings>={},typography={...current} as GeneralSettingsValues;
 for(const key of changedGeneralSettingsFields(draft)){
  if(current[key]!==draft.base[key]&&current[key]!==draft.value[key])conflicts.push(key);
  if(sharedGeneralFields.includes(key as typeof sharedGeneralFields[number])&&current[key]!==draft.value[key])Object.assign(sharedPatch,{[key]:draft.value[key]});
  Object.assign(typography,{[key]:draft.value[key]});
 }
 const deviceChanged=typographyGeneralFields.some(key=>draft.value[key]!==draft.base[key]);
 return {conflicts,sharedPatch,deviceChanged,typography:{interfaceFont:typography.interfaceFont,interfaceTextSize:typography.interfaceTextSize,messageFont:typography.messageFont,messageTextSize:typography.messageTextSize}};
}
/** A review choice changes the baseline; it never saves by itself. */
export function reviewGeneralSettingsField(draft:GeneralSettingsDraft,current:GeneralSettingsValues,key:GeneralSettingsField,choice:'current'|'draft'):GeneralSettingsDraft {
 return {...draft,base:{...draft.base,[key]:current[key]},value:{...draft.value,[key]:choice==='current'?current[key]:draft.value[key]}};
}
export function acknowledgeGeneralSettingsDraft(draft:GeneralSettingsDraft,shared:SharedGeneralSettings,typography?:TypographyPreferences):GeneralSettingsDraft {
 const next={...draft,base:{...draft.base},value:{...draft.value}};
 for(const key of sharedGeneralFields){Object.assign(next.base,{[key]:shared[key]});Object.assign(next.value,{[key]:shared[key]});}
 if(typography)for(const key of typographyGeneralFields){Object.assign(next.base,{[key]:typography[key]});Object.assign(next.value,{[key]:typography[key]});}
 return next;
}
