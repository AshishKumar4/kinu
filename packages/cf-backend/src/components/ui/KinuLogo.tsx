import type { ReactElement } from 'react';

import { mark, wordmark } from '@kinu.run/core';

export interface KinuMarkProps {
  className?: string;
  size?: number;
}

export function KinuMark({ className, size = 20 }: KinuMarkProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 p-accent-mark${className ? ` ${className}` : ''}`}
      style={{ lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: mark(size) }}
    />
  );
}

export interface KinuLogoProps {
  className?: string;
  compact?: boolean;
}

/** The wordmark alone; it is the logo, with no mark beside it. */
export function KinuLogo({ className, compact = false }: KinuLogoProps): ReactElement {
  return (
    <span
      className={`inline-block shrink-0 p-text${className ? ` ${className}` : ''}`}
      style={{ lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: wordmark(compact ? 24 : 27) }}
    />
  );
}
