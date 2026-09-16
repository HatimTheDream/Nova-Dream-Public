import type { Icon as IconParkSourceIcon, Theme } from '@icon-park/react/es/runtime';
import type { CSSProperties, FC, HTMLAttributes } from 'react';

export type IconParkTone = 'neutral' | 'gold' | 'coral' | 'violet' | 'sky' | 'success' | 'warning' | 'danger';
export type IconParkEmphasis = 'line' | 'duotone' | 'solid';
export type IconParkState = 'default' | 'active' | 'disabled' | 'busy';

export interface IconParkIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'title'> {
  size?: number | string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  tone?: IconParkTone;
  emphasis?: IconParkEmphasis;
  state?: IconParkState;
  title?: string;
  decorative?: boolean;
  color?: string;
  fill?: string | string[];
}

export type IconParkIconComponent = FC<IconParkIconProps>;

export interface IconParkIconDefinition {
  semanticName: string;
  sourceName: string;
  role: string;
  colorRole: 'context' | 'success' | 'warning' | 'danger';
  style: 'outline' | 'two-tone';
  accessibleName: 'parent-control-or-title';
  rtl: 'fixed' | 'logical';
}

const TONE_COLORS: Record<IconParkTone, string> = {
  neutral: 'currentColor',
  gold: 'var(--dc-gold-color, #f6c453)',
  coral: 'var(--dc-coral, #d94f5c)',
  violet: 'var(--dc-violet, #6b5de7)',
  sky: 'var(--dc-sky, #3fafe3)',
  success: 'rgb(var(--aegis-success, 15 122 88))',
  warning: 'rgb(var(--aegis-warning, 139 90 0))',
  danger: 'rgb(var(--aegis-danger, 217 54 67))',
};

const STATUS_TONES: Partial<Record<IconParkIconDefinition['colorRole'], IconParkTone>> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

function parseNumericSize(size: number | string): number | undefined {
  if (typeof size === 'number') return size;
  const parsed = Number.parseFloat(size);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveTheme(emphasis: IconParkEmphasis, fill?: string | string[]): Theme {
  if (fill) return 'filled';
  if (emphasis === 'solid') return 'filled';
  if (emphasis === 'duotone') return 'two-tone';
  return 'outline';
}

function softTone(color: string): string {
  return color === 'currentColor'
    ? 'color-mix(in srgb, currentColor 18%, transparent)'
    : `color-mix(in srgb, ${color} 18%, transparent)`;
}

export function createIconParkIcon(
  SourceIcon: IconParkSourceIcon,
  definition: IconParkIconDefinition,
): IconParkIconComponent {
  const Component: IconParkIconComponent = ({
    size = 18,
    strokeWidth = 4,
    absoluteStrokeWidth = false,
    tone,
    emphasis = definition.style === 'two-tone' ? 'duotone' : 'line',
    state = 'default',
    title,
    decorative = !title,
    color,
    fill,
    className = '',
    style,
    ...props
  }) => {
    const numericSize = parseNumericSize(size);
    const resolvedStrokeWidth = absoluteStrokeWidth && numericSize && numericSize > 0
      ? (strokeWidth * 48) / numericSize
      : strokeWidth;
    const resolvedTone = tone ?? STATUS_TONES[definition.colorRole] ?? 'neutral';
    const resolvedColor = color ?? TONE_COLORS[resolvedTone];
    const theme = resolveTheme(emphasis, fill);
    // Keep the SVG paint tied to currentColor so parent interaction states can
    // override the contextual tone without fighting presentation attributes.
    const colors = fill ?? (theme === 'two-tone'
      ? ['currentColor', softTone('currentColor')]
      : 'currentColor');
    const iconStyle: CSSProperties = {
      ...style,
      color: resolvedColor,
    };

    return (
      <SourceIcon
        size={size}
        strokeWidth={resolvedStrokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        theme={theme}
        fill={colors}
        spin={state === 'busy'}
        className={`dc-iconpark dc-iconpark--${state} ${className}`.trim()}
        data-iconpark-semantic={definition.semanticName}
        data-iconpark-source={definition.sourceName}
        data-tone={resolvedTone}
        data-emphasis={emphasis}
        role={!decorative && title ? 'img' : undefined}
        aria-hidden={decorative ? true : undefined}
        aria-label={!decorative && title ? title : undefined}
        title={!decorative && title ? title : undefined}
        style={iconStyle}
        {...props}
      />
    );
  };
  Component.displayName = `IconPark:${definition.semanticName}`;
  return Component;
}
