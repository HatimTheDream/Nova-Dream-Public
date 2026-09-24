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
      return <section className="typography-group" aria-label={title} key={scope}>
        <h3>{title}</h3>
        <div className="setting-row typography-setting"><label htmlFor={`${scope}-font`}>Font</label><select id={`${scope}-font`} aria-label={`${title} font`} value={preferences[font]} onChange={event => change({ [font]: event.target.value })}>{fontChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></div>
        <div className="setting-row typography-setting"><label htmlFor={`${scope}-size`}>Text size</label><select id={`${scope}-size`} aria-label={`${title} text size`} value={preferences[size]} onChange={event => change({ [size]: event.target.value })}>{textSizeChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></div>
        <p className={`typography-preview typography-${scope}-preview`} aria-label={`${title} preview`}>{scope === 'interface' ? 'Navigation, controls, and writing' : 'A comfortable size for your conversations.'}</p>
      </section>;
    })}
    <p className="settings-footnote">Font preferences are saved on this device.</p>
    {!saved && <p className="field-error" role="status">Applied for this window. Your browser could not save this preference.</p>}
  </>;
}
