import { Button } from '@cloudflare/kumo';
import { useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
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
      <SectionHead label="01 · Where agents run" lead="It is the same agent either way. You choose when you create a workspace.">
        Run your agents in the cloud, <Accent>or on your own machine.</Accent>
      </SectionHead>
      <div className="grid overflow-hidden rounded-2xl border p-border p-surface md:grid-cols-2">
        <article className="flex min-w-0 flex-col p-6 sm:p-8">
          <span className="mb-5 font-mono text-[11px] uppercase tracking-[.14em] p-accent-fg">Cloud</span>
          <h3 className="text-[27px] font-semibold leading-tight tracking-[-.025em]">Close the device.<br />The agent keeps working.</h3>
          <p className="mb-5 mt-4 text-[15px] leading-[1.7] p-text-3">Cloud agents run on Cloudflare, so they keep working while your device is off. They can start work on a schedule, or when a webhook you create receives a delivery. When a job needs a full computer, the agent can get one of its own, with a preview URL you can open.</p>
          <p className="mb-7 rounded-xl border p-border p-sunken p-4 text-sm leading-[1.7] p-text-3">Run <code className="font-mono text-xs p-text-2">kinu connect</code> on your Mac or Linux machine, and your cloud agents can run commands on it. They reach it only in the workspaces you allow.</p>
          <div className="mt-auto">
            <LandingActionLink href="/login" primary>Sign in to kinu.run →</LandingActionLink>
          </div>
          <p id="deploy" className="mt-6 border-t p-border pt-5 text-sm leading-[1.7] p-text-3">
            To run your own Kinu on your Cloudflare account, sign in with Cloudflare at <a className="p-accent-fg underline underline-offset-4" href="/deploy">kinu.run/deploy</a>. It needs the Workers Paid plan, $5 a month. The <a className="p-accent-fg underline underline-offset-4" href={REPOSITORY + '/blob/main/docs/SELF-HOSTING.md'} target="_blank" rel="noreferrer">self-hosting guide</a> covers the manual route.
          </p>
        </article>
        <article className="flex min-w-0 flex-col border-t p-border p-6 sm:p-8 md:border-l md:border-t-0">
          <span className="mb-5 font-mono text-[11px] uppercase tracking-[.14em] p-accent-fg">Local</span>
          <h3 className="text-[27px] font-semibold leading-tight tracking-[-.025em]">Your terminal or editor.</h3>
          <p className="mb-5 mt-4 text-[15px] leading-[1.7] p-text-3">Local agents run on your machine and need no account. They use a model provider you connect: your own API key, or Workers AI once you sign in.</p>
          <div className="rounded-xl border p-border p-sunken p-4">
            <div className="mb-3 flex items-center justify-between gap-3"><span className="font-mono text-[10px] uppercase tracking-[.14em] p-text-3">Install · macOS or Linux</span><Button type="button" variant="ghost" size="sm" aria-label="Copy local setup commands" onClick={() => copy(install + '\n' + localStart)}>{COPY_LABEL[status]}</Button></div>
            <pre className="whitespace-pre-wrap font-mono text-xs leading-[1.9] [overflow-wrap:anywhere] p-text-2"><code>{install + '\n' + localStart}</code></pre>
          </div>
          <dl className="mt-6 space-y-3 text-sm p-text-3">
            <div><dt className="inline font-mono text-xs p-text-2">kinu run workshop "task"</dt><dd className="mt-1">Runs one task in your terminal, then exits.</dd></div>
            <div><dt className="inline font-mono text-xs p-text-2">kinu acp workshop</dt><dd className="mt-1">Connects editors such as Zed over the Agent Client Protocol.</dd></div>
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
      <SectionHead label="02 · CI" lead="kinu exec runs one task without prompts and exits, so an agent can be one step of your pipeline.">
        Give CI <Accent>an agent.</Accent>
      </SectionHead>
      <div aria-label="Kinu command line preview" className="grid gap-6 overflow-hidden rounded-2xl border p-border p-surface p-6 sm:p-8 lg:grid-cols-[1.15fr_1fr] lg:gap-8">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3"><span className="font-mono text-[11px] uppercase tracking-[.1em] p-accent-fg">CI step</span><Button type="button" variant="ghost" size="sm" aria-label="Copy CI command" onClick={() => copy(command)}>{COPY_LABEL[status]}</Button></div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.9] p-text"><code>{command}</code></pre>
        </div>
        <div className="space-y-3 border-t p-border pt-6 text-sm leading-[1.7] p-text-3 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <p>The step passes only if the task finished with no errors and no refused access. Any device access you did not approve in advance is refused.</p>
          <p>For a cloud workspace, set <code className="font-mono text-xs p-text-2">KINU_TOKEN</code> to a token from <code className="font-mono text-xs p-text-2">kinu tokens create</code>. Your own tests and review rules still decide what merges.</p>
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
        <div className="mx-auto max-w-[580px] rounded-xl border border-[var(--c-accent)] p-selected px-5 py-4 text-center"><h3 className="font-semibold p-accent-fg">Say what better means</h3><p className="mt-2 text-sm leading-[1.65] text-pretty p-text-3">The task, where to start, and a command that measures the result as a number.</p></div>
        <div aria-hidden="true" className="mx-auto h-5 w-px bg-[var(--c-border-strong)]" />
        <div className="grid grid-cols-3 gap-2 md:gap-4">
          {[
            ['Candidate A', 'Change the algorithm'],
            ['Candidate B', 'Change the data structure'],
            ['Candidate C', 'Split the work differently'],
          ].map(([title, body]) => <div key={title} className="rounded-xl border p-border p-sunken p-3 md:px-5 md:py-4"><h4 className="text-xs font-semibold p-text md:text-sm">{title}</h4><p className="mt-1 text-xs p-text-3 md:text-sm">{body}</p><div className="mt-3 hidden border-t border-dashed border-[var(--c-dash)] pt-2.5 font-mono text-[11px] p-accent-fg md:block">run → measure → compare</div></div>)}
        </div>
        <div aria-hidden="true" className="mx-auto h-5 w-px bg-[var(--c-border-strong)]" />
        <div className="mx-auto max-w-[580px] border-t p-border pt-4 text-center"><h3 className="font-semibold">Build on what measured better</h3><p className="mt-2 text-sm leading-[1.65] text-pretty p-text-3">Kinu keeps every measurement, expands the branches that improved, and settles on the best one.</p></div>
      </div>
    </figure>
  );
}

function EvolutionSection(): ReactElement {
  const stages = [
    {
      time: 'As you rate turns',
      title: 'Ranks its own tools',
      evidence: 'Which of its own tools each turn chose, and how you rated that turn',
      change: 'A tool ranks higher each time a turn you rate well chooses it',
      persists: 'The best 20 are offered on every turn. Tools it stops choosing retire.',
      detail: 'A tool that raises an error is marked broken, with the error, until the agent rewrites it or a later call succeeds.',
    },
    {
      time: 'Every five rated turns, or when idle',
      title: 'Reviews its recent turns',
      evidence: 'Your replies and ratings, and the turns they rate',
      change: 'Drafts, tests and reviews small edits to its prompt, tool descriptions, memory and skills',
      persists: 'Edits you can undo from the changelog',
      detail: 'If a review finds nothing worth changing, it changes nothing.',
    },
    {
      time: 'Across many turns',
      title: 'Rewrites its agent loop',
      evidence: 'A problem that keeps coming back, and the turns where it happened',
      change: 'Writes a new version of the code that runs its loop, and replays your recent turns through it',
      persists: 'The new loop, if the replay passes. The old one stays ready to restore.',
      detail: 'Kinu watches a new loop over its next ten rated turns and restores the old one if it does worse. You can restore it yourself from the changelog too.',
    },
  ] as const;

  const [activeIndex, setActiveIndex] = useState(0);
  const active = stages[activeIndex] ?? stages[0];

  return (
    <section id="evolution" data-evolution-stage={activeIndex} className={SECTION}>
      <SectionHead label="03 · Self-evolution" lead="Kinu learns from how each turn went: your ratings and corrections, and which of its tools it chose. Every few turns it uses that record to adjust itself.">
        The agent <Accent>gets better with use.</Accent>
      </SectionHead>
      <div className="grid overflow-hidden rounded-2xl border p-border p-surface lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="grid gap-px bg-[var(--c-border)] sm:grid-cols-3 lg:grid-cols-1">
          {stages.map((stage, index) => (
            <button
              type="button"
              key={stage.title}
              aria-pressed={activeIndex === index}
              onClick={() => setActiveIndex(index)}
              className={`flex min-h-[64px] items-center justify-between gap-4 px-5 py-4 text-left transition-colors lg:min-h-[80px] ${activeIndex === index ? 'p-selected' : 'p-sunken hover:p-hover'}`}
            >
              <span><span className="block font-mono text-[10px] uppercase tracking-[.13em] p-accent-fg">{stage.time}</span><strong className="mt-1.5 block text-[13.5px] p-text">{stage.title}</strong></span>
              <span className={`font-mono text-sm ${activeIndex === index ? 'p-accent-fg' : 'p-text-3'}`}>0{index + 1}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col justify-between p-5 sm:p-8">
          <div>
            <h3 className="mb-6 hidden text-[24px] font-semibold tracking-[-.02em] p-text lg:block">{active.title}</h3>
            <div className="grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-3">
              <div className="rounded-xl border p-border p-sunken p-3.5 sm:p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-text-3">Learns from</span><p className="mt-2 text-[13px] leading-[1.55] p-text">{active.evidence}</p></div>
              <span aria-hidden="true" className="hidden self-center font-mono p-accent-fg md:block">→</span>
              <div className="rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] p-selected p-3.5 sm:p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-accent-fg">Changes</span><p className="mt-2 text-[13px] leading-[1.55] p-text">{active.change}</p></div>
              <span aria-hidden="true" className="hidden self-center font-mono p-accent-fg md:block">→</span>
              <div className="rounded-xl border p-border p-sunken p-3.5 sm:p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-text-3">Keeps</span><p className="mt-2 text-[13px] leading-[1.55] p-text">{active.persists}</p></div>
            </div>
          </div>
          <p className="mt-6 border-t border-dashed border-[var(--c-dash)] pt-5 text-sm leading-[1.65] p-text-3">{active.detail}</p>
        </div>
      </div>
      <a className={TRAILING_LINK} href={REPOSITORY + '/blob/main/docs/EVOLUTION.md'} target="_blank" rel="noreferrer">How the agent learns →</a>
    </section>
  );
}

function SwarmSection(): ReactElement {
  return (
    <section id="swarm" className={SECTION}>
      <SectionHead label="04 · Swarms" lead="A swarm runs several agents on one task, each trying a different approach. Give it a number to improve and a command that measures it, and the measurements decide which approaches it builds on.">
        Try several approaches <Accent>at once.</Accent>
      </SectionHead>
      <SwarmSearch />
      <p className="mt-6 max-w-[660px] text-sm leading-[1.7] p-text-3">Without a measure, a swarm can still rank candidates by having agents review them, or collect ideas without ranking them. A search can end with nothing better than where it started. <a className="p-accent-fg underline underline-offset-4" href={REPOSITORY + '/blob/main/docs/EXPLORATION.md'} target="_blank" rel="noreferrer">How swarms work</a></p>
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
