import type { ModuleAction } from '../../../packages/domain/module-actions';
import { appOpenSchema, appAppearanceSchema, type AppDestination } from '../../../packages/domain/app-actions';
import { readTypography, typographyStore, type TypographyPreferences } from './typography';

export type AppActionOutcome = { state: 'opened' | 'saved' | 'blocked'; message: string };
export type AppActionWindow = {
  epoch: string; deviceId: string; visible: () => boolean;
  exclusive: (name: string, work: () => Promise<void>) => Promise<void>;
  authorize: (actionId: string) => Promise<boolean>;
  open: (destination: AppDestination) => boolean;
  readAppearance?: () => TypographyPreferences;
  saveAppearance?: (preferences: TypographyPreferences) => boolean;
  keep: (id: string) => boolean;
  previous?: (id: string) => AppActionOutcome | undefined;
  retain?: (id: string, outcome: AppActionOutcome) => void;
  acknowledge: (actionId: string, outcome: AppActionOutcome) => Promise<void>;
  now?: () => number;
};

/** Only the requesting device's visible Assistant window consumes a UI request.
 * Mark it before acting; a lost acknowledgement never replays navigation. */
export async function consumeAssistantAppAction(action: ModuleAction, window: AppActionWindow): Promise<void> {
  if (!['app.open', 'app.appearance'].includes(action.operation) || action.state !== 'unknown'
    || (action.result as { state?: string })?.state !== 'requested'
    || action.epoch !== window.epoch || action.deviceId !== window.deviceId || !window.visible()) return;
  await window.exclusive(`e3:app-action:${action.epoch}:${action.id}`,async()=>{
  if(!window.visible())return;
  const previous=window.previous?.(action.id);
  if(previous){await window.acknowledge(action.id,previous);return;}
  const authorized=await window.authorize(action.id);
  if(!window.visible())return;
  if(!authorized){
    await window.acknowledge(action.id,{state:'blocked',message:'This app request is no longer permitted or has expired.'});
    return;
  }
  if (!window.keep(action.id)) {
    return;
  }
  let outcome: AppActionOutcome;
  if ((window.now?.() ?? Date.now()) - Date.parse(action.createdAt) > 120000) {
    outcome = { state: 'blocked', message: 'This app window did not receive the request in time. Ask again if you still want this change.' };
  } else if (action.operation === 'app.open') {
    const input = appOpenSchema.safeParse(action.input);
    outcome = input.success && window.open(input.data)
      ? { state: 'opened', message: `Opened ${input.data.module}.` }
      : { state: 'blocked', message: 'Navigation was held to preserve unsaved writing. Resolve the current form before asking again.' };
  } else {
    const input = appAppearanceSchema.safeParse(action.input);
    outcome = input.success && (window.saveAppearance ?? typographyStore.update)({ ...(window.readAppearance ?? readTypography)(), ...input.data })
      ? { state: 'saved', message: 'Saved appearance preferences on this device.' }
      : { state: 'blocked', message: 'This device could not retain the appearance preferences.' };
  }
  window.retain?.(action.id,outcome);
  await window.acknowledge(action.id, outcome);
  });
}
