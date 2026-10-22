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
      className={`${className ?? ''} inline-block shrink-0 p-accent`}
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
    <span className={`p-wordmark inline-flex items-center gap-2 p-text${className ? ` ${className}` : ''}`} data-compact={compact ? '' : undefined}>
      <KinuMark size={compact ? 20 : 22} />
      <span>Kinu</span>
    </span>
  );
}
