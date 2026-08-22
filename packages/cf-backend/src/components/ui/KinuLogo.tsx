import type { ReactElement } from 'react';

import { mark } from '@/lib/public-shell';

export interface KinuMarkProps {
  className?: string;
  size?: number;
}

export function KinuMark({ className, size = 20 }: KinuMarkProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 p-gold${className ? ` ${className}` : ''}`}
      style={{ lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: mark(size) }}
    />
  );
}

export interface KinuLogoProps {
  className?: string;
  compact?: boolean;
}

export function KinuLogo({ className, compact = false }: KinuLogoProps): ReactElement {
  return (
    <span className={`inline-flex items-center gap-[9px] font-serif ${compact ? 'text-[18px]' : 'text-[20px]'}${className ? ` ${className}` : ''}`}>
      <KinuMark size={compact ? 17 : 20} />
      <span className="font-semibold tracking-[.01em]">Kinu</span>
    </span>
  );
}
