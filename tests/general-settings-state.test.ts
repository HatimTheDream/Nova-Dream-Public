import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout } from '../packages/domain/contracts';
import { defaultTypography } from '../apps/client/src/typography';
import { acknowledgeGeneralSettingsDraft, changedGeneralSettingsFields, generalSettingsValues, mergeGeneralSettingsDraft, newGeneralSettingsDraft, restoreGeneralSettingsDraft, reviewGeneralSettingsField, syncGeneralSettingsDraft } from '../apps/client/src/general-settings-state';
import { mayLeaveSettingsDraft, registerSettingsDraftNavigation } from '../apps/client/src/settings-draft-navigation';
const current=generalSettingsValues({...defaultLayout,timezone:'UTC'},defaultTypography);
test('staged shared and device settings remain detached from their durable values',()=>{
 const draft=newGeneralSettingsDraft('epoch',current);draft.value.theme='dark';draft.value.messageTextSize='large';
 assert.equal(current.theme,'light');assert.equal(current.messageTextSize,'standard');assert.equal(draft.base.theme,'light');
 assert.deepEqual(changedGeneralSettingsFields(draft),['theme','messageTextSize']);
 const merged=mergeGeneralSettingsDraft(draft,current);assert.deepEqual(merged.sharedPatch,{theme:'dark'});assert.equal(merged.typography.messageTextSize,'large');assert.equal(merged.deviceChanged,true);assert.deepEqual(merged.conflicts,[]);
});
test('concurrent untouched choices stay current and changed choices require explicit review',()=>{
 const draft=newGeneralSettingsDraft('epoch',current);draft.value.theme='dark';draft.value.interfaceFont='serif';
 const external={...current,theme:'system' as const,timezone:'Asia/Tokyo',messageTextSize:'large' as const};
 const synced=syncGeneralSettingsDraft(draft,external);assert.equal(synced.value.timezone,'Asia/Tokyo');assert.equal(synced.value.messageTextSize,'large');assert.equal(synced.base.theme,'light');
 assert.deepEqual(mergeGeneralSettingsDraft(synced,external).conflicts,['theme']);
 const keep=reviewGeneralSettingsField(synced,external,'theme','draft');assert.deepEqual(mergeGeneralSettingsDraft(keep,external).conflicts,[]);assert.deepEqual(mergeGeneralSettingsDraft(keep,external).sharedPatch,{theme:'dark'});
 const use=reviewGeneralSettingsField(synced,external,'theme','current');assert.equal(use.value.theme,'system');assert.deepEqual(mergeGeneralSettingsDraft(use,external).sharedPatch,{});assert.equal(use.value.interfaceFont,'serif');
});
test('host acknowledgement never pretends failed device typography was saved',()=>{
 const draft=newGeneralSettingsDraft('epoch',current);draft.value.theme='dark';draft.value.messageTextSize='large';
 const partial=acknowledgeGeneralSettingsDraft(draft,{theme:'dark',appIcon:'red',timezone:'UTC'});
 assert.deepEqual(changedGeneralSettingsFields(partial),['messageTextSize']);
 const retry=mergeGeneralSettingsDraft(partial,{...current,theme:'dark',messageTextSize:'large'});assert.equal(retry.deviceChanged,true,'an in-window text application still needs a durable retry');assert.deepEqual(retry.sharedPatch,{});
 const complete=acknowledgeGeneralSettingsDraft(partial,{theme:'dark',appIcon:'red',timezone:'UTC'},retry.typography);assert.deepEqual(changedGeneralSettingsFields(complete),[]);
});
test('retained settings restore only their exact workspace and validated bounded fields',()=>{
 const draft=newGeneralSettingsDraft('epoch',current);draft.value.theme='dark';draft.value.timezone='Europe/London';
 const restored=restoreGeneralSettingsDraft(JSON.parse(JSON.stringify(draft)),'epoch',current);assert.deepEqual(restored,draft);
 restored.value.theme='system';assert.equal(draft.value.theme,'dark');
 for(const raw of [{...draft,epoch:'other'},{...draft,version:2},{...draft,value:{...draft.value,theme:'injected'}},{...draft,value:{...draft.value,timezone:'not/a/zone'}},{...draft,value:{...draft.value,messageFont:'external-font'}},{...draft,value:{...draft.value,extra:'oversized'}}])assert.deepEqual(restoreGeneralSettingsDraft(raw,'epoch',current),newGeneralSettingsDraft('epoch',current));
 assert.ok(JSON.stringify(draft).length<2048);
});
test('only the current settings editor owns navigation and a blocked departure cannot execute its callback',()=>{
 let resumed=0,held:(()=>void)|undefined;
 const old=registerSettingsDraftNavigation(()=>true);
 const fresh=registerSettingsDraftNavigation(resume=>{held=resume;return false;});old();
 assert.equal(mayLeaveSettingsDraft(()=>resumed++),false);assert.equal(resumed,0);held?.();assert.equal(resumed,1);fresh();assert.equal(mayLeaveSettingsDraft(),true);
});
