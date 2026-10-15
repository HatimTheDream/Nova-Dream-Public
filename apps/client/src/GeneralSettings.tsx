import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppIconChoice, Layout, Snapshot } from '../../../packages/domain/contracts';
import { readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { NovaAppMark } from './AppIcon';
import { Dialog } from './ui';
import { fontChoices, textSizeChoices, typographyStorageKey, typographyStore, type TypographyPreferences } from './typography';
import { acknowledgeGeneralSettingsDraft, changedGeneralSettingsFields, generalSettingsValues, mergeGeneralSettingsDraft, newGeneralSettingsDraft, restoreGeneralSettingsDraft, reviewGeneralSettingsField, syncGeneralSettingsDraft, validGeneralSettingsValues, type GeneralSettingsDraft, type GeneralSettingsField, type SharedGeneralSettings } from './general-settings-state';
import { registerSettingsDraftNavigation } from './settings-draft-navigation';
import './general-settings.css';
export type GeneralSettingsSaveContext = { epoch: string; revision: number; values: SharedGeneralSettings };
export interface GeneralSettingsProps {
 currentLayout: Layout;
 appIcon: AppIconChoice;
 snapshot: Snapshot;
 online: boolean;
 pending?: boolean;
 status?: string;
 error?: string;
 saveShared: (patch: Partial<SharedGeneralSettings>, expected: GeneralSettingsSaveContext) => Promise<boolean>;
 resetHome?: () => void;
 resetNavigation?: () => void;
 undoReset?: () => void;
 hasUndoReset?: boolean;
}
const fieldLabels:Record<GeneralSettingsField,string>={theme:'Theme',appIcon:'App Icon',timezone:'Home Timezone',interfaceFont:'App Font',interfaceTextSize:'App Text Size',messageFont:'Message Font',messageTextSize:'Message Text Size'};
const typographyFonts={system:'var(--system-font,system-ui)',sora:'var(--sora-font,system-ui)',serif:'var(--serif-font,serif)'};
const readingSizes={small:14,standard:15,large:17,'extra-large':20};
const interfaceSizes={small:13,standard:14,large:15.4,'extra-large':16.8};
function removeDraft(key:string):boolean {try{localStorage.removeItem(key);return true;}catch{return false;}}
/** Stages shared appearance and device text preferences independently of their durable owners. */
export function GeneralSettings({snapshot,online,pending=false,status,error,saveShared,resetHome,resetNavigation,undoReset,hasUndoReset}:GeneralSettingsProps) {
 const typography=useSyncExternalStore(typographyStore.subscribe,typographyStore.getSnapshot,typographyStore.getSnapshot);
 const current=generalSettingsValues(snapshot.layout.value,typography);
 const currentKey=JSON.stringify(current);
 const key=`e3:general-settings:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`;
 const [draft,setDraft]=useState(()=>restoreGeneralSettingsDraft(readLocal(key),snapshot.epoch,current));
 const ref=useRef(draft);ref.current=draft;
 const currentRef=useRef(current);currentRef.current=current;
 const snapshotRef=useRef(snapshot);snapshotRef.current=snapshot;
 const scope=useRef(key),savingRef=useRef(false),resumeLeave=useRef<(()=>void)|undefined>(undefined);
 const mounted=useRef(true);
 const [saving,setSaving]=useState(false),[leave,setLeave]=useState(false),[storageError,setStorageError]=useState(false),[deviceFailure,setDeviceFailure]=useState(false),[message,setMessage]=useState('');
 const replace=(next:GeneralSettingsDraft,persist=false)=>{ref.current=next;setDraft(next);if(persist)setStorageError(!saveLocal(key,next));};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{
  if(scope.current!==key){scope.current=key;replace(restoreGeneralSettingsDraft(readLocal(key),snapshot.epoch,current));setMessage('');setDeviceFailure(false);setStorageError(false);resumeLeave.current=undefined;setLeave(false);return;}
  if(!savingRef.current){const next=syncGeneralSettingsDraft(ref.current,current);if(JSON.stringify(next)!==JSON.stringify(ref.current))replace(next);}
 },[key,currentKey]);
 useEffect(()=>registerSettingsDraftNavigation(resume=>{
  if(!changedGeneralSettingsFields(ref.current).length&&!savingRef.current)return true;
  resumeLeave.current=resume;setLeave(true);return false;
 }),[]);
 useEffect(()=>{const before=(event:BeforeUnloadEvent)=>{if(changedGeneralSettingsFields(ref.current).length||savingRef.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[]);
 const change=<K extends GeneralSettingsField>(field:K,value:GeneralSettingsDraft['value'][K])=>{
  if(savingRef.current||pending)return;
  const next=syncGeneralSettingsDraft(ref.current,currentRef.current);
  replace({...next,value:{...next.value,[field]:value}},true);setMessage('');
 };
 const discard=()=>{
  if(savingRef.current||pending)return false;
  if(!removeDraft(key)){setStorageError(true);setMessage('The browser could not discard the retained draft. Keep Editing and try again.');return false;}
  if(deviceFailure)typographyStore.receiveStorageChange(typographyStorageKey);
  const fresh=generalSettingsValues(snapshotRef.current.layout.value,typographyStore.getSnapshot());
  replace(newGeneralSettingsDraft(snapshotRef.current.epoch,fresh));setStorageError(false);setDeviceFailure(false);setMessage('Changes discarded.');return true;
 };
 const save=async()=>{
  if(savingRef.current||pending)return false;
  const staged=ref.current,actual=currentRef.current,source=snapshotRef.current;
  if(staged.epoch!==source.epoch){setMessage('The workspace changed. Reopen General to review its settings.');return false;}
  if(!validGeneralSettingsValues(staged.value)){setMessage('Choose valid settings, including a supported timezone.');return false;}
  const merged=mergeGeneralSettingsDraft(staged,actual);
  if(merged.conflicts.length){setMessage('Some settings changed elsewhere. Review each choice below, then Save Changes.');return false;}
  const sharedChanged=Object.keys(merged.sharedPatch).length>0;
  if(sharedChanged&&!online){setMessage('The host is offline. Your settings draft is kept on this device.');return false;}
  // Retain the exact proposed settings before dispatch; storage failure is not
  // permission to replace a pending shared-layout receipt.
  if(!saveLocal(key,staged)){setStorageError(true);setMessage('Browser storage is full. Keep this window open; settings have not been sent.');return false;}
  savingRef.current=true;setSaving(true);setMessage('');
  try{
   if(sharedChanged){
    const values={theme:actual.theme,appIcon:actual.appIcon,timezone:actual.timezone};
    const acknowledged=await saveShared(merged.sharedPatch,{epoch:source.epoch,revision:source.layout.revision,values});
    if(!mounted.current||scope.current!==key||snapshotRef.current.epoch!==source.epoch)return false;
    if(!acknowledged){setMessage('Shared changes are not confirmed. Reconcile the retained save before trying a new proposal. Text preferences are unchanged.');return false;}
   }
   const shared={theme:actual.theme,appIcon:actual.appIcon,timezone:actual.timezone,...merged.sharedPatch};
   let deviceSaved=true;
   if(merged.deviceChanged)deviceSaved=typographyStore.update(merged.typography);
   const next=acknowledgeGeneralSettingsDraft(staged,shared,deviceSaved?merged.typography:undefined);
   replace(next);setDeviceFailure(!deviceSaved);
   const retained=changedGeneralSettingsFields(next).length?saveLocal(key,next):removeDraft(key);setStorageError(!retained);
   if(!deviceSaved){setMessage('Shared settings are saved. Text is applied in this window, but browser storage could not save it. Retry Save Changes or Discard to restore the saved text.');return false;}
   setMessage(retained?'Settings saved.':'Settings saved, but the browser could not clear the old retained draft.');return true;
  }catch(reason){setMessage(reason instanceof Error?reason.message:'Settings could not be saved. Your draft is kept.');return false;}
  finally{savingRef.current=false;if(mounted.current)setSaving(false);}
 };
 const keepEditing=()=>{resumeLeave.current=undefined;setLeave(false);};
 const continueLeave=()=>{const resume=resumeLeave.current;resumeLeave.current=undefined;setLeave(false);resume?.();};
 const changes=changedGeneralSettingsFields(draft),merged=mergeGeneralSettingsDraft(draft,current),value=draft.value;
 const review=(field:GeneralSettingsField,choice:'current'|'draft')=>{replace(reviewGeneralSettingsField(ref.current,currentRef.current,field,choice),true);setMessage('Choice reviewed. Save Changes when ready.');};
 const zones=[...new Set([value.timezone,current.timezone,Intl.DateTimeFormat().resolvedOptions().timeZone,'UTC','America/Los_Angeles','America/New_York','Europe/London','Asia/Dubai','Asia/Tokyo'])];
 return <section className="general-settings" aria-label="General Settings">
  <fieldset disabled={saving||pending}>
   <section className="settings-card"><h2>Appearance</h2><p>Save to apply your choices. Theme, icon and timezone are shared; text preferences stay on this device.</p>
    <div className="setting-row"><strong>Theme</strong><select aria-label="Color Theme" value={value.theme} onChange={event=>change('theme',event.target.value as Layout['theme'])}><option value="light">Light</option><option value="dark">Dark</option><option value="system">Follow This Device</option></select></div>
    <div className="setting-row app-icon-setting"><div><strong id="general-app-icon-label">App Icon</strong></div><div className="app-icon-options" role="group" aria-labelledby="general-app-icon-label">{(['red','cream'] as const).map(choice=><button type="button" key={choice} aria-label={`${choice==='red'?'Red':'Cream'} App Icon`} aria-pressed={value.appIcon===choice} onClick={()=>change('appIcon',choice)}><NovaAppMark choice={choice} width={32} height={32}/></button>)}</div></div>
    {(['interface','message'] as const).map(scope=>{const font=`${scope}Font` as const,size=`${scope}TextSize` as const,title=scope==='interface'?'App Interface':'Assistant Messages';return <div className="setting-row typography-setting" key={scope}><strong id={`general-${scope}-type`}>{title}</strong><div className="typography-controls" role="group" aria-labelledby={`general-${scope}-type`}><select aria-label={`${title} Font`} value={value[font]} onChange={event=>change(font,event.target.value as TypographyPreferences[typeof font])}>{fontChoices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><select aria-label={`${title} Text Size`} value={value[size]} onChange={event=>change(size,event.target.value as TypographyPreferences[typeof size])}>{textSizeChoices.map(choice=><option key={choice.value} value={choice.value}>{choice.value==='extra-large'?'Extra Large':choice.label}</option>)}</select></div></div>;})}
    <details className="settings-preview"><summary>Preview Text</summary><p className="general-text-preview" style={{fontFamily:typographyFonts[value.interfaceFont],fontSize:interfaceSizes[value.interfaceTextSize]}}>Navigation, controls, and writing</p><p className="general-text-preview" style={{fontFamily:typographyFonts[value.messageFont],fontSize:readingSizes[value.messageTextSize]}}>A comfortable size for your conversations.</p><p className="settings-footnote">This preview does not change the app until you save.</p></details>
    <div className="setting-row settings-timezone"><strong>Home Timezone</strong><select aria-label="Home Timezone" value={value.timezone} onChange={event=>change('timezone',event.target.value)}>{zones.map(zone=><option key={zone}>{zone}</option>)}</select></div>
   </section>
  </fieldset>
  {merged.conflicts.length>0&&<section className="notice warning general-settings-review" aria-label="Review Concurrent Settings" role="alert"><strong>Review Changed Settings</strong><p>Choose what to keep for each field. Nothing is overwritten while you review.</p>{merged.conflicts.map(field=><div key={field}><strong>{fieldLabels[field]}</strong><p>Current: {current[field]} · Your Choice: {value[field]}</p><div className="button-row"><button type="button" onClick={()=>review(field,'current')}>Use Current</button><button type="button" onClick={()=>review(field,'draft')}>Keep My Choice</button></div></div>)}</section>}
  <div className="general-settings-footer"><span role="status">{changes.length?`${changes.length} Unsaved ${changes.length===1?'Change':'Changes'}`:'No Unsaved Changes'}</span><div className="button-row"><button type="button" disabled={saving||pending||!changes.length} onClick={discard}>Discard</button><button type="button" className="primary" disabled={saving||pending||!changes.length||merged.conflicts.length>0} onClick={()=>void save()}>{saving?'Saving…':'Save Changes'}</button></div></div>
  {(message||error||pending)&&<p className="general-settings-status" role="status">{message||error||(pending?'A shared save is awaiting confirmation. Reconcile it before changing this proposal.':status)}</p>}
  {storageError&&<p className="field-error" role="status">Browser storage could not retain this settings draft. Keep this window open until it is saved or discarded.</p>}
  {(resetHome||resetNavigation)&&<details className="settings-details"><summary>Reset Layout</summary>{resetHome&&<div className="setting-row"><div><strong>Home Arrangement</strong><p>Reset widget positions. Custom widgets, notes, links, tasks and drafts are kept.</p></div><button type="button" disabled={saving||pending} onClick={resetHome}>Reset Arrangement</button></div>}{resetNavigation&&<div className="setting-row"><div><strong>Navigation Order</strong><p>Settings stays pinned beside the scrollable bottom modules.</p></div><button type="button" disabled={saving||pending} onClick={resetNavigation}>Reset Navigation</button></div>}</details>}
  {hasUndoReset&&undoReset&&<div className="notice"><span>Previous arrangement is available.</span><button type="button" disabled={saving||pending} onClick={undoReset}>Undo Reset</button></div>}
  {leave&&<Dialog title="Unsaved Settings" close={keepEditing}><p>{storageError ? 'Your changes are only in this window.' : 'Your changes are kept on this device.'} Save or discard them before leaving?</p>{(message||error)&&<p role="status">{message||error}</p>}<div className="button-row general-settings-leave"><button type="button" onClick={keepEditing}>Keep Editing</button><button type="button" disabled={saving||pending} onClick={()=>{if(discard())continueLeave();}}>Discard And Leave</button><button type="button" className="primary" disabled={saving||pending||merged.conflicts.length>0} onClick={()=>{void save().then(saved=>{if(saved)continueLeave();});}}>Save And Leave</button></div></Dialog>}
 </section>;
}
