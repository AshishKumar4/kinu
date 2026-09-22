import { Button } from '@cloudflare/kumo';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useCopy, type CopyStatus } from '@/hooks/use-copy';
import { LandingActionLink } from './LandingActionLink';
import { LandingFrame } from './LandingFrame';
import { HeroDust } from './hero-dust/HeroDust';
import { CHECKOUT_FRAME_CAPTION } from './landing-fixtures';
import { SearchTreeHero } from './search-tree/SearchTreeHero';
import { useWideHero } from './search-tree/stage';

const PHRASES = ['get better with use.', 'build their own tools.', 'run in the cloud or on your machine.', 'connect to multiple devices.', 'work while your device is closed.'] as const;

/** A failure asks for the click again; the command is on screen either way. */
const COPY_LABEL: Record<CopyStatus, string> = { idle: 'Copy', copied: 'Copied', failed: 'Retry copy' };

/** Derived from the animated phrases so the accessible name cannot drift from them. */
const HERO_LABEL = `Agents that ${PHRASES
  .map((phrase) => phrase.replace(/\.$/, ''))
  .map((phrase, index, all) => (index === all.length - 1 ? `and ${phrase}` : phrase))
  .join(', ')}.`;

function Typewriter(): ReactElement {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [phrase, setPhrase] = useState<string>(PHRASES[0]);
  useEffect(() => {
    const element = elementRef.current;

    if (element === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let index = 0;
    let length = PHRASES[0].length;
    let deleting = true;
    let visible = false;
    let timer = 0;

    const step = (): void => {
      const current = PHRASES[index];
      length += deleting ? -1 : 1;
      setPhrase(current.slice(0, length));
      let delay = deleting ? 24 : 65;

      if (length === 0) {
        index = (index + 1) % PHRASES.length;
        deleting = false;
        delay = 400;
      } else if (length === current.length) {
        deleting = true;
        delay = 2_600;
      }

      timer = window.setTimeout(step, delay);
    };

    const sync = (): void => {
      window.clearTimeout(timer);

      if (reduced.matches) {
        index = 0;
        length = PHRASES[0].length;
        deleting = true;
        setPhrase(PHRASES[0]);
      } else if (visible && !document.hidden) {
        timer = window.setTimeout(step, 2_600);
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting === true;
      sync();
    });

    observer.observe(element);
    reduced.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      reduced.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return (
    <span ref={elementRef} aria-hidden="true" className="grid p-accent">
      {/* Shared grid cells reserve the tallest phrase at every font and width. */}
      {PHRASES.map((sizer) => <span key={sizer} className="invisible col-start-1 row-start-1">{sizer}<span className="inline-block w-[.12em]" /></span>)}
      <span data-typewriter className="col-start-1 row-start-1">{phrase}<span className="ml-[.04em] inline-block h-[.8em] w-[.075em] translate-y-[.08em] bg-[var(--c-accent)] motion-reduce:hidden" /></span>
    </span>
  );
}

export function LandingHero({ install }: { install: string }): ReactElement {
  const { status, copy } = useCopy();
  const wide = useWideHero();

  return (
    <section id="top" className="relative overflow-hidden">
      {/* Full-bleed stage; the sizers reserve two lines, the heading's height for every phrase
          at 1020px. Below `lg` the dust replaces the tree. */}
      <div className="relative">
        {wide ? <SearchTreeHero /> : <HeroDust />}
        <div className="landing-shell relative pt-16 lg:pt-20">
          <p className="sr-only">Kinu tries several approaches to a task, checks each, and keeps the one that passes, along with any tool it built along the way.</p>
          <div className="relative">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border p-border p-surface px-3.5 py-1.5 text-xs p-text-2">
              <span className="size-[5px] rounded-full p-dot-accent" />
              The self-evolving agent platform
            </div>
            <h1 aria-label={HERO_LABEL} className="max-w-[900px] text-[clamp(40px,5vw,64px)] font-semibold leading-[.99] tracking-[-.04em] text-pretty p-text">
              Agents that{' '}
              <Typewriter />
            </h1>
            {/* Explicit minmax(0,…): the implicit auto track takes the install row's min-content
                and overflow-x-clip hides it from scrollWidth. */}
            <div className="mt-8 grid grid-cols-1 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
              <div className="min-w-0">
                <p className="mb-8 max-w-[520px] text-[17.5px] leading-[1.65] text-pretty p-text-3">
                  Put agents to work on your files, with tools they write themselves. They get better as you correct them, and can run several attempts at once, keeping whichever one your objective scores highest.
                </p>
                <div className="flex max-w-[540px] items-center justify-between gap-4 rounded-xl border p-border p-recessed px-4 py-3.5">
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed p-text-2"><span aria-hidden="true" className="p-accent">$</span> <span data-install-command>{install}</span></code>
                  <Button type="button" variant="ghost" size="sm" onClick={() => copy(install)} aria-label="Copy install command">
                    {COPY_LABEL[status]}
                  </Button>
                </div>
                <div className="mt-[22px] flex flex-wrap items-center gap-3">
                  <LandingActionLink href="/login" primary>Try cloud agents →</LandingActionLink>
                  <LandingActionLink href="/deploy">Self-host</LandingActionLink>
                  <LandingActionLink href="#platform">Run locally</LandingActionLink>
                  <span className="w-full text-[12.5px] p-text-4 sm:w-auto">MIT · open source</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="landing-shell pb-20 lg:pb-24">
        <figure className="mt-14 lg:mt-16">
          <LandingFrame kind="checkout" caption={CHECKOUT_FRAME_CAPTION} />
          <figcaption className="px-1 pt-3 text-[11px] leading-relaxed p-text-4">Run and Supervise, the Work tab, and Retry act on this page only.</figcaption>
        </figure>
      </div>
    </section>
  );
}
