import { Button } from '@cloudflare/kumo';
import type { ReactElement } from 'react';

import { useCopy, type CopyStatus } from '@/hooks/use-copy';
import { LandingActionLink } from './LandingActionLink';
import { LandingFrame } from './LandingFrame';
import { HeroDust } from './hero-dust/HeroDust';
import { SearchTreeHero } from './search-tree/SearchTreeHero';
import { useWideHero } from './search-tree/stage';

/** A failure asks for the click again; the command is on screen either way. */
export const COPY_LABEL: Record<CopyStatus, string> = { idle: 'Copy', copied: 'Copied', failed: 'Retry copy' };

export function LandingHero({ install }: { install: string }): ReactElement {
  const { status, copy } = useCopy();
  const wide = useWideHero();

  return (
    <section id="top" className="relative overflow-hidden">
      {/* Full-bleed stage. Below `lg` the dust replaces the tree. */}
      <div className="relative">
        {wide ? <SearchTreeHero /> : <HeroDust />}
        <div className="landing-shell relative pt-12 lg:pt-16">
          <p className="sr-only">Kinu tries several approaches to a task, checks each, and keeps the one that passes, along with any tool it built along the way.</p>
          <div className="relative">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border p-border p-surface px-3.5 py-1.5 text-xs p-text-2">
              <span className="size-[5px] rounded-full p-dot-accent" />
              The self-evolving agent platform
            </div>
            <h1 className="max-w-[900px] text-[clamp(40px,5vw,64px)] font-semibold leading-[.99] tracking-[-.04em] text-pretty p-text">
              Agents that <span className="block p-accent-fg">build their own tools.</span>
            </h1>
            <div className="mt-8 min-w-0 max-w-[560px]">
              <p className="mb-8 max-w-[520px] text-[17.5px] leading-[1.65] text-pretty p-text-3">
                Kinu agents work on your files and write the tools they need. They learn from your corrections. On a hard problem, they can try several approaches at once and keep the one that scores best on your own check.
              </p>
              <div className="flex max-w-[540px] items-center justify-between gap-4 rounded-xl border p-border p-sunken px-4 py-3.5">
                <code className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed [overflow-wrap:anywhere] p-text-2"><span aria-hidden="true" className="p-accent-fg">$</span> <span data-install-command>{install}</span></code>
                <Button type="button" variant="ghost" size="sm" onClick={() => copy(install)} aria-label="Copy install command">
                  {COPY_LABEL[status]}
                </Button>
              </div>
              <div className="mt-[22px] flex flex-wrap items-center gap-3">
                <LandingActionLink href="/login" primary>Try cloud agents →</LandingActionLink>
                <LandingActionLink href="/deploy">Deploy your own</LandingActionLink>
                <span className="w-full text-[12.5px] p-text-3 sm:w-auto">MIT · open source</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="landing-shell pb-14 lg:pb-16">
        <figure className="mt-10 lg:mt-12">
          <LandingFrame />
          <figcaption className="mt-5 grid gap-3 px-1 text-sm leading-[1.7] p-text-3 md:grid-cols-2 md:gap-12">
            <p>In Plan mode the agent reads and researches, but it cannot change anything. It writes a plan for you to review. You approve it, or mark the lines to change, and only then does it build.</p>
            <p>The dashboard is a live app: a small web app the agent writes and Kinu serves in a tab beside the chat. It can use only what you give it, such as workspace files or one tool on a connection, and it never sees your credentials.</p>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
