import { Button } from '@cloudflare/kumo';
import { useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { buildCliInstallCommand } from '@kinu.run/core';

import { useCopy } from '@/hooks/use-copy';

import { LandingActionLink } from './LandingActionLink';
import { LandingFooter, LandingHeader, REPOSITORY } from './LandingChrome';
import { COPY_LABEL, LandingHero } from './LandingHero';

const SHELL = 'landing-shell';

const SECTION = 'border-t p-border py-12 lg:py-16';

const CARD = 'min-w-0 rounded-[14px] border p-border p-surface';

const TRAILING_LINK = 'mt-6 inline-block text-sm font-semibold p-accent-fg';

/** The origin the build's prerender writes the install line for: production's, the one most visitors load. */
const PRERENDERED_ORIGIN = 'https://kinu.run';

const unchanging = (): (() => void) => () => {};

/** The install line for this page's origin; the prerendered one while the markup hydrates, so the two match. */
function useInstallCommand(): string {
  const origin = useSyncExternalStore(unchanging, () => window.location.origin, () => PRERENDERED_ORIGIN);

  return useMemo(() => buildCliInstallCommand({ origin }), [origin]);
}

function Accent({ children }: { children: ReactNode }): ReactElement {
  return <span className="p-accent-fg">{children}</span>;
}

/** `tight` is for a head sharing its row, taking the lead's margin rather than the section's. */
function SectionHead({ label, lead, tight = false, children }: {
  label: string;
  lead: ReactNode;
  tight?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={tight ? 'mb-9' : 'mb-8 lg:mb-12'}>
      <div className="mb-4 flex items-center gap-3 text-[13px] font-semibold p-accent-fg"><span className="h-px w-[22px] shrink-0 bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />{label}</div>
      <h2 className="max-w-[780px] text-[clamp(30px,3.4vw,44px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">{children}</h2>
      <p className="mt-4 max-w-[620px] text-base leading-[1.65] p-text-3 sm:text-[17px]">{lead}</p>
    </div>
  );
}

function PlatformSection({ install }: { install: string }): ReactElement {
  const { status, copy } = useCopy();
  const localStart = 'kinu create workshop --mode local\nkinu chat workshop';

  return (
    <section id="platform" className={SECTION}>
      <SectionHead label="01 · Where it runs" lead="Same agent either way. You choose when you create a workspace.">
        In the cloud, <Accent>or on your machine.</Accent>
      </SectionHead>
      <div className="grid overflow-hidden rounded-2xl border p-border p-surface md:grid-cols-2">
        <article className="flex min-w-0 flex-col p-6 sm:p-8">
          <span className="mb-5 font-mono text-[11px] uppercase tracking-[.14em] p-accent-fg">Cloud</span>
          <h3 className="text-[27px] font-semibold leading-tight tracking-[-.025em]">Close the laptop.<br />It keeps going.</h3>
          <p className="mb-5 mt-4 text-[15px] leading-[1.7] p-text-3">Cloud agents run on Cloudflare. Start one from chat, on a schedule, or from a webhook. When a job needs a full computer, the agent gets one of its own, with a preview link you can open.</p>
          <p className="mb-7 rounded-xl border p-border p-sunken p-4 text-sm leading-[1.7] p-text-3">Run <code className="font-mono text-xs p-text-2">kinu connect</code> on your Mac or Linux machine, and agents can use it in the workspaces you allow.</p>
          <div className="mt-auto">
            <LandingActionLink href="/login" primary>Sign in to kinu.run →</LandingActionLink>
          </div>
          <p id="deploy" className="mt-6 border-t p-border pt-5 text-sm leading-[1.7] p-text-3">
            Want it on your own Cloudflare account? Sign in at <a className="p-accent-fg underline underline-offset-4" href="/deploy">kinu.run/deploy</a>. It needs Workers Paid, $5 a month. Or follow the <a className="p-accent-fg underline underline-offset-4" href={REPOSITORY + '/blob/main/docs/SELF-HOSTING.md'} target="_blank" rel="noreferrer">self-hosting guide</a>.
          </p>
        </article>
        <article className="flex min-w-0 flex-col border-t p-border p-6 sm:p-8 md:border-l md:border-t-0">
          <span className="mb-5 font-mono text-[11px] uppercase tracking-[.14em] p-accent-fg">Local</span>
          <h3 className="text-[27px] font-semibold leading-tight tracking-[-.025em]">Your terminal or editor.</h3>
          <p className="mb-5 mt-4 text-[15px] leading-[1.7] p-text-3">No account needed. Bring your own API key, or use Workers AI once you sign in.</p>
          <div className="rounded-xl border p-border p-sunken p-4">
            <div className="mb-3 flex items-center justify-between gap-3"><span className="font-mono text-[10px] uppercase tracking-[.14em] p-text-3">Install · macOS or Linux</span><Button type="button" variant="ghost" size="sm" aria-label="Copy local setup commands" onClick={() => copy(install + '\n' + localStart)}>{COPY_LABEL[status]}</Button></div>
            <pre className="whitespace-pre-wrap font-mono text-xs leading-[1.9] [overflow-wrap:anywhere] p-text-2"><code>{install + '\n' + localStart}</code></pre>
          </div>
          <dl className="mt-6 space-y-3 text-sm p-text-3">
            <div><dt className="inline font-mono text-xs p-text-2">kinu run workshop "task"</dt><dd className="mt-1">Runs one task, then exits.</dd></div>
            <div><dt className="inline font-mono text-xs p-text-2">kinu acp workshop</dt><dd className="mt-1">Connects editors like Zed.</dd></div>
          </dl>
          {/* mt-auto: the two articles share one stretched grid row. */}
          <a href={REPOSITORY + '/blob/main/QUICKSTART.md'} target="_blank" rel="noreferrer" className="mt-auto pt-6 text-sm font-semibold p-accent-fg">Setup and providers →</a>
        </article>
      </div>
    </section>
  );
}

function CiSection(): ReactElement {
  const { status, copy } = useCopy();
  const command = 'kinu exec -w workshop --json "Review this diff and report what you checked."';

  return (
    <section id="ci" className={SECTION}>
      <SectionHead label="02 · CI" lead={<><code className="font-mono text-[0.9em] p-text-2">kinu exec</code> runs one task with no prompts and exits with the result.</>}>
        Put an agent <Accent>in CI.</Accent>
      </SectionHead>
      <div aria-label="Kinu command line preview" className="grid gap-6 overflow-hidden rounded-2xl border p-border p-surface p-6 sm:p-8 lg:grid-cols-[1.15fr_1fr] lg:gap-8">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3"><span className="font-mono text-[11px] uppercase tracking-[.1em] p-accent-fg">CI step</span><Button type="button" variant="ghost" size="sm" aria-label="Copy CI command" onClick={() => copy(command)}>{COPY_LABEL[status]}</Button></div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.9] p-text"><code>{command}</code></pre>
        </div>
        <div className="space-y-3 border-t p-border pt-6 text-sm leading-[1.7] p-text-3 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <p>The step fails if the task errors or reaches for access you didn't grant ahead of time. Your tests and reviewers still decide what merges.</p>
          <p>For a cloud workspace, set <code className="font-mono text-xs p-text-2">KINU_TOKEN</code> from <code className="font-mono text-xs p-text-2">kinu tokens create</code>.</p>
        </div>
      </div>
    </section>
  );
}

function SwarmSearch(): ReactElement {
  return (
    <figure className="overflow-hidden rounded-2xl border p-border p-surface">
      <figcaption className="flex flex-wrap items-center justify-between gap-3 border-b p-border p-sunken px-6 py-3.5 font-mono text-[11px] p-text-3"><span>Example</span><span>Goal: faster runtime, same results</span></figcaption>
      <div className="p-5 sm:p-7">
        <div className="mx-auto max-w-[580px] rounded-xl border border-[var(--c-accent)] p-selected px-5 py-4 text-center"><h3 className="font-semibold p-accent-fg">Set the goal</h3><p className="mt-2 text-sm leading-[1.65] text-pretty p-text-3">The task, and a command that scores the result.</p></div>
        <div aria-hidden="true" className="mx-auto h-5 w-px bg-[var(--c-border-strong)]" />
        <div className="grid grid-cols-3 gap-2 md:gap-4">
          {[
            ['Candidate A', 'Change the algorithm'],
            ['Candidate B', 'Change the data structure'],
            ['Candidate C', 'Split the work differently'],
          ].map(([title, body]) => <div key={title} className="rounded-xl border p-border p-sunken p-3 md:px-5 md:py-4"><h4 className="text-xs font-semibold p-text md:text-sm">{title}</h4><p className="mt-1 text-xs p-text-3 md:text-sm">{body}</p><div className="mt-3 hidden border-t border-dashed border-[var(--c-dash)] pt-2.5 font-mono text-[11px] p-accent-fg md:block">run → score</div></div>)}
        </div>
        <div aria-hidden="true" className="mx-auto h-5 w-px bg-[var(--c-border-strong)]" />
        <div className="mx-auto max-w-[580px] border-t p-border pt-4 text-center"><h3 className="font-semibold">Keep what scores best</h3><p className="mt-2 text-sm leading-[1.65] text-pretty p-text-3">Kinu keeps every score and builds on the approaches that improved.</p></div>
      </div>
    </figure>
  );
}

function EvolutionSection(): ReactElement {
  const ways = [
    ['Keeps the tools that work', 'It writes tools as it goes. The ones that help rise to the top, and the ones it stops using retire.'],
    ['Learns from your corrections', 'Every few rated turns, it reviews them and makes small, tested edits to its prompt, memory and skills.'],
    ['Rewrites its own loop', 'When a problem keeps coming back, it writes a new loop, replays your recent turns through it, and rolls back if it does worse.'],
  ] as const;

  return (
    <section id="evolution" className={SECTION}>
      <SectionHead label="03 · Learning" lead="Rate a turn or correct it, and Kinu adjusts. Its edits land in a changelog, and you can undo them.">
        It gets better <Accent>at your work.</Accent>
      </SectionHead>
      <div className="grid gap-4 md:grid-cols-3">
        {ways.map(([title, body]) => <article key={title} className={`${CARD} p-6`}><h3 className="text-[17px] font-semibold tracking-[-.01em] p-text">{title}</h3><p className="mt-2 text-[14.5px] leading-[1.65] p-text-3">{body}</p></article>)}
      </div>
      <a className={TRAILING_LINK} href={REPOSITORY + '/blob/main/docs/EVOLUTION.md'} target="_blank" rel="noreferrer">How the agent learns →</a>
    </section>
  );
}

function SwarmSection(): ReactElement {
  return (
    <section id="swarm" className={SECTION}>
      <SectionHead label="04 · Swarms" lead="A swarm puts several agents on one problem, each trying something different. Give it a command that scores the result, and it builds on whatever scores best.">
        Try several approaches <Accent>at once.</Accent>
      </SectionHead>
      <SwarmSearch />
      <a className={TRAILING_LINK} href={REPOSITORY + '/blob/main/docs/EXPLORATION.md'} target="_blank" rel="noreferrer">How swarms work →</a>
    </section>
  );
}

function OpenSourceSection(): ReactElement {
  const rows: readonly (readonly [string, ReactNode])[] = [['Licence', <span key="mit">MIT</span>], ['Source', <a key="source" href={REPOSITORY} target="_blank" rel="noreferrer" className="p-accent-fg">github.com/AshishKumar4/kinu</a>], ['Backends', <span key="backends">Cloudflare Workers · macOS and Linux</span>], ['Docs', <span key="docs" className="flex flex-wrap gap-3.5">{['ARCHITECTURE', 'EXPLORATION', 'EVOLUTION', 'DEPLOYMENT'].map((doc) => <a key={doc} href={`${REPOSITORY}/blob/main/docs/${doc}.md`} target="_blank" rel="noreferrer" className="p-accent-fg">{doc.toLowerCase()}</a>)}</span>]];

  return (
    <section id="cta" className="border-t p-border bg-[linear-gradient(180deg,var(--c-surface)_0%,var(--c-bg)_100%)]">
      <div className={`${SHELL} grid items-center gap-10 py-12 lg:grid-cols-[1.2fr_1fr] lg:gap-14 lg:py-16`}>
        <div><SectionHead label="05 · Open source" lead="The agent, both backends and the CLI are MIT-licensed." tight>Open source, <Accent>end to end.</Accent></SectionHead><div className="flex flex-wrap gap-3"><LandingActionLink external primary href={REPOSITORY}>Read the source →</LandingActionLink><LandingActionLink href="/login">Try cloud agents</LandingActionLink></div></div>
        <div className={`${CARD} px-[26px] py-1.5`}>
          {rows.map(([label, value], index) => <div key={label} className={`grid gap-2 py-[15px] sm:grid-cols-[96px_1fr] sm:gap-4 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}><span className="text-xs p-text-3">{label}</span><div className="min-w-0 [overflow-wrap:anywhere] font-mono text-[12.5px] p-text-2">{value}</div></div>)}
        </div>
      </div>
    </section>
  );
}

export function LandingPage(): ReactElement {
  const install = useInstallCommand();

  return (
    <div className="min-h-screen overflow-x-clip p-bg font-sans p-text">
      <LandingHeader homeHref="#top" />
      <main>
        <LandingHero install={install} />
        <div className={SHELL}>
          <PlatformSection install={install} />
          <CiSection />
          <EvolutionSection />
          <SwarmSection />
        </div>
        <OpenSourceSection />
      </main>
      <LandingFooter />
    </div>
  );
}
