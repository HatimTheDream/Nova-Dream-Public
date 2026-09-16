// ═══════════════════════════════════════════════════════════
// GlassCard — Transparent glass panel with hover lift
// + Shimmer edge light streak (conceptual design)
// ═══════════════════════════════════════════════════════════

import clsx from 'clsx';
import React, { type ReactNode } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  hover?: boolean;
  delay?: number;
  noPad?: boolean;
  /** Enable shimmer light streak on top edge (conceptual design) */
  shimmer?: boolean;
  onClick?: () => void;
}

export const GlassCard = React.memo(function GlassCard({
  children,
  className = '',
  contentClassName = '',
  hover = true,
  delay = 0,
  noPad = false,
  shimmer = true,
  onClick,
}: GlassCardProps) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        'relative overflow-hidden',
        'border border-aegis-border',
        'bg-aegis-card',
        'backdrop-blur-xl',
        'hover:border-aegis-border-hover',
        'hover:bg-aegis-glass-hover',
        'transition-all duration-300',
        onClick && 'cursor-pointer',
        shimmer && 'card-shimmer-edge',
        className
      )}
      style={{ borderRadius: 'var(--aegis-radius)' }}
    >
      {/* Top light edge — subtle glass reflection */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
      <div className={clsx(!noPad && 'p-5', contentClassName)}>
        {children}
      </div>
    </div>
  );
});
