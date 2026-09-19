import { useLayoutEffect, type ImgHTMLAttributes } from 'react';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { appIconAssets, applyDocumentAppIcon, cacheAppIcon, resolveAppIcon } from './app-icon';

export function useAppIcon(value: unknown): AppIconChoice {
  const choice = resolveAppIcon(value);
  useLayoutEffect(() => { cacheAppIcon(choice); applyDocumentAppIcon(choice); }, [choice]);
  return choice;
}
export function NovaAppMark({ choice, className = '', alt = '', ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { choice: AppIconChoice }) {
  return <img {...props} className={`nova-app-mark ${className}`.trim()} src={appIconAssets(choice).brand} alt={alt}/>;
}
export function AppIconPicker({ value, change }: { value: AppIconChoice; change: (choice: AppIconChoice) => void }) {
  return <div className="setting-row app-icon-setting">
    <div><strong id="app-icon-label">App Icon</strong></div>
    <div className="app-icon-options" role="group" aria-labelledby="app-icon-label">
      {(['red', 'cream'] as const).map(choice => <button key={choice} type="button" aria-pressed={value === choice} onClick={() => change(choice)}>
        <NovaAppMark choice={choice} width="60" height="60"/><span>{choice === 'red' ? 'Red' : 'Cream'}</span>
      </button>)}
    </div>
  </div>;
}