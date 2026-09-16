import clsx from 'clsx';
import type {
  IconParkEmphasis,
  IconParkIconComponent,
  IconParkState,
  IconParkTone,
} from './IconParkIcon';

export function IconParkIconTile({
  icon: Icon,
  tone = 'gold',
  emphasis = 'duotone',
  state = 'default',
  size = 34,
  label,
  className,
}: {
  icon: IconParkIconComponent;
  tone?: IconParkTone;
  emphasis?: IconParkEmphasis;
  state?: IconParkState;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={clsx('dc-icon-tile inline-flex shrink-0 items-center justify-center', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Icon size={size} tone={tone} emphasis={emphasis} state={state} decorative />
    </span>
  );
}
