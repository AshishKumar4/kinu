import { LinkButton } from '@cloudflare/kumo';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

type LinkSize = ComponentProps<typeof LinkButton>['size'];

export interface LandingActionLinkProps {
  readonly children: ReactNode;
  readonly href: string;
  readonly external?: boolean;
  readonly primary?: boolean;
  readonly size?: LinkSize;
  readonly className?: string;
}

export function LandingActionLink({
  children,
  href,
  external = false,
  primary = false,
  size = 'lg',
  className,
}: LandingActionLinkProps): ReactElement {
  const actionClass = `${primary ? 'p-btn !text-[var(--c-accent-on)]' : ''} !rounded-full${className ? ` ${className}` : ''}`;
  return (
    <LinkButton
      href={href}
      external={external}
      size={size}
      variant={primary ? 'primary' : 'outline'}
      className={actionClass}
    >
      {children}
    </LinkButton>
  );
}
