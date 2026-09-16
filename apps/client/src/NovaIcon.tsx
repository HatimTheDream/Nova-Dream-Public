import type { FC, HTMLAttributes, ReactNode } from 'react';

export interface IconProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  size?: number | string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  color?: string;
  fill?: string | string[];
  emphasis?: 'line' | 'duotone' | 'solid';
  tone?: 'neutral' | 'gold' | 'coral' | 'violet' | 'sky' | 'success' | 'warning' | 'danger';
  state?: 'default' | 'active' | 'disabled' | 'busy';
  decorative?: boolean;
}
export type Icon = FC<IconProps>;
const tones = { neutral: 'currentColor', gold: 'var(--gold)', coral: 'var(--danger)', violet: 'var(--violet)', sky: 'var(--sky)', success: 'var(--green)', warning: 'rgb(var(--accent-rgb))', danger: 'var(--danger)' };

/** The shared 24-unit Nova family. Control labels own decorative icon names. */
export function novaIcon(body: ReactNode, glyph: string, name: string, original = false): Icon {
  const Component: Icon = ({ size = original ? 18 : 20, strokeWidth, absoluteStrokeWidth = false, emphasis = 'duotone', color, tone, state = 'default', title, decorative, fill: _fill, className = '', style, ...props }) => {
    const label = props['aria-label'] ?? title;
    const hidden = decorative ?? !label;
    // Original-module overrides use the predecessor's 48-unit stroke scale.
    const stroke = strokeWidth === undefined ? 2.2 : original ? strokeWidth / 2 : strokeWidth;
    return <span {...props} className={`e3-icon nova-icon ${original ? 'dc-iconpark ' : ''}${className}`} data-icon={name} data-nova-icon={glyph} data-iconpark-semantic={original ? name : undefined} data-emphasis={emphasis} data-state={state} title={title} role={hidden ? undefined : 'img'} aria-label={hidden ? undefined : label} aria-hidden={hidden ? true : undefined} style={{ ...style, display: 'inline-flex', flexShrink: 0, verticalAlign: 'middle', width: size, height: size, color: color ?? (tone ? tones[tone] : style?.color) }}>
      <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={absoluteStrokeWidth ? { overflow: 'visible' } : undefined} className={absoluteStrokeWidth ? 'nova-icon-absolute' : undefined}>{body}</svg>
    </span>;
  };
  Component.displayName = `Nova:${name}`;
  return Component;
}
