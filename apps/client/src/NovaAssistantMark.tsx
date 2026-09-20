import type { ImgHTMLAttributes } from 'react';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { appIconAssets } from './app-icon';

export type AssistantExpression = 'idle' | 'listening' | 'speaking';

export function NovaAssistantMark({ choice, expression = 'idle', className = '', alt = '', ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { choice: AppIconChoice; expression?: AssistantExpression }) {
  const src = expression === 'idle' ? appIconAssets(choice).brand : `/icons/nova-assistant-${choice}-${expression}-256-v1.webp`;
  return <img {...props} className={`nova-app-mark nova-assistant-mark ${className}`.trim()} src={src} alt={alt}/>;
}
