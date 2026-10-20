import { Button } from '@cloudflare/kumo';
import { ArrowUpRightIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';

import { KinuLogo } from '@/components/ui/KinuLogo';
import { toggleMode, useTheme } from '@/hooks/use-theme';
import { LandingActionLink } from './LandingActionLink';

export const REPOSITORY = 'https://github.com/AshishKumar4/kinu';

export function LandingHeader({ homeHref = '/' }: { homeHref?: string }): ReactElement {
  const theme = useTheme();

  return (
    <header className="sticky top-0 z-20 border-b p-border bg-[color-mix(in_srgb,var(--c-bg)_90%,transparent)] backdrop-blur-[10px]">
      <div className="landing-shell flex h-[60px] items-center justify-between gap-5">
        <a href={homeHref} aria-label="Kinu home"><KinuLogo /></a>
        <nav className="flex items-center gap-1" aria-label="Landing actions">
          <a href={REPOSITORY} target="_blank" rel="noreferrer" className="hidden items-center gap-1 rounded-full px-3 py-2 text-[13px] p-text-3 hover:p-text xl:flex">GitHub <ArrowUpRightIcon aria-hidden="true" size={13} /></a>
          <Button type="button" variant="ghost" size="sm" onClick={toggleMode} aria-label={`Switch to ${theme.mode === 'dark' ? 'light' : 'dark'} mode`} icon={theme.mode === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />} />
          <LandingActionLink href="/login" primary size="base">Try cloud agents</LandingActionLink>
        </nav>
      </div>
    </header>
  );
}

export function LandingFooter(): ReactElement {
  return (
    <footer className="border-t p-border p-recessed">
      <div className="landing-shell flex flex-wrap items-center gap-5 py-7">
        <div className="flex items-center gap-2.5"><KinuLogo compact /><span className="text-xs p-text-4">絹 · the self-evolving agent platform</span></div>
        <nav className="ml-auto flex flex-wrap gap-5 text-[13px] p-text-3">
          <a href={REPOSITORY}>GitHub</a>
          <a href={`${REPOSITORY}/blob/main/QUICKSTART.md`}>Quickstart</a>
          <a href={`${REPOSITORY}/blob/main/docs/USER-GUIDE.md`}>User guide</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/login">kinu.run</a>
        </nav>
        <span className="text-[12.5px] p-text-4">MIT © 2026</span>
      </div>
    </footer>
  );
}
