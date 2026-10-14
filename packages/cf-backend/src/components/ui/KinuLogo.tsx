import type { ReactElement } from 'react';

import { mark } from '@kinu.run/core';

interface KinuMarkProps {
  className?: string;
  size?: number;
}

export function KinuMark({ className, size = 20 }: KinuMarkProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 text-[var(--c-accent)]${className ? ` ${className}` : ''}`}
      style={{ lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: mark(size) }}
    />
  );
}

interface KinuLogoProps {
  className?: string;
  compact?: boolean;
}

/** The mark and the name, set plainly in the UI face. */
export function KinuLogo({ className, compact = false }: KinuLogoProps): ReactElement {
  return (
    <span className={`inline-flex items-center gap-2 font-medium p-text ${compact ? 'text-[17px]' : 'text-[18px]'}${className ? ` ${className}` : ''}`}>
      <KinuMark size={compact ? 20 : 22} />
      <span>Kinu</span>
    </span>
  );
}
