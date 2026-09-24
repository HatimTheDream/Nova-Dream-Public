import { useState, useSyncExternalStore } from 'react';
import { fontChoices, textSizeChoices, typographyStore, type TypographyPreferences } from './typography';

export function TypographySettings() {
  const preferences = useSyncExternalStore(typographyStore.subscribe, typographyStore.getSnapshot, typographyStore.getSnapshot);
  const [saved, setSaved] = useState(true);
  const change = (next: Partial<TypographyPreferences>) => setSaved(typographyStore.update({ ...preferences, ...next }));
  return <>
    {(['interface', 'message'] as const).map(scope => {
      const title = scope === 'interface' ? 'App interface' : 'Assistant messages';
      const font = `${scope}Font` as const, size = `${scope}TextSize` as const;
      return <div className="setting-row typography-setting" key={scope}>
        <span id={`${scope}-type-label`}>{title}</span>
        <div className="typography-controls" role="group" aria-labelledby={`${scope}-type-label`}>
          <select aria-label={`${title} font`} value={preferences[font]} onChange={event => change({ [font]: event.target.value })}>{fontChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
          <select aria-label={`${title} text size`} value={preferences[size]} onChange={event => change({ [size]: event.target.value })}>{textSizeChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
        </div>
      </div>;
    })}
    <details className="settings-preview"><summary>Preview text</summary>
      <p className="typography-preview typography-interface-preview" aria-label="App interface preview">Navigation, controls, and writing</p>
      <p className="typography-preview typography-message-preview" aria-label="Assistant messages preview">A comfortable size for your conversations.</p>
      <p className="settings-footnote">Font preferences are saved on this device.</p>
    </details>
    {!saved && <p className="field-error" role="status">Applied for this window. Your browser could not save this preference.</p>}
  </>;
}
