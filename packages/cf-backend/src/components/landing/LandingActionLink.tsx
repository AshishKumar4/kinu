import { LinkButton } from '@cloudflare/kumo';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

type LinkSize = ComponentProps<typeof LinkButton>['size'];

export interface LandingActionLinkProps {
  readonly children: ReactNode;
  readonly href: string;
  readonly external?: boolean;
  readonly primary?: boolean;
  readonly size?: LinkSize;
}

export function LandingActionLink({
  children,
  href,
  external = false,
  primary = false,
  size = 'lg',
}: LandingActionLinkProps): ReactElement {
  // Kumo's primary sets white ink, which brass cannot carry (2.2:1): the primary's own fill and ink win over it.
  const actionClass = `${primary ? '!bg-[var(--c-accent)] !text-[var(--c-accent-on)] hover:!bg-[color-mix(in_srgb,var(--c-accent)_92%,#000)]' : ''} !rounded-full`;

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
