import { useState, useSyncExternalStore } from 'react';
import { fontChoices, textSizeChoices, typographyStore, type TypographyPreferences } from './typography';

export function TypographySettings() {
  const preferences = useSyncExternalStore(typographyStore.subscribe, typographyStore.getSnapshot, typographyStore.getSnapshot);
  const [saved, setSaved] = useState(true);
  const change = (next: Partial<TypographyPreferences>) => setSaved(typographyStore.update({ ...preferences, ...next }));
  return <>
    <div className="setting-row typography-setting"><div><strong>Font</strong><p>Nova's interface and reading text. Saved on this device.</p></div><select aria-label="Font" value={preferences.font} onChange={event => change({ font: event.target.value as TypographyPreferences['font'] })}>{fontChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></div>
    <div className="setting-row typography-setting"><div><strong>Assistant text size</strong><p>Messages, plans, reports, and writing.</p></div><select aria-label="Assistant text size" value={preferences.textSize} onChange={event => change({ textSize: event.target.value as TypographyPreferences['textSize'] })}>{textSizeChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></div>
    <div className="typography-preview" aria-label="Text preview"><strong>A comfortable reading size</strong><p>Your messages, plans, and reports use this text size.</p></div>
    {!saved && <p className="field-error" role="status">Applied for this window. Your browser could not save this preference.</p>}
  </>;
}
