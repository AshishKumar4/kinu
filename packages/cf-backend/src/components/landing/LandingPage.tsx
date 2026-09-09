import { Button } from '@cloudflare/kumo';
import { ArrowUpRightIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useState, type ReactElement, type ReactNode } from 'react';

import { KinuLogo } from '@/components/ui/KinuLogo';
import { toggleMode, useTheme } from '@/hooks/use-theme';
import { useCopy } from '@/hooks/use-copy';

import { LandingActionLink } from './LandingActionLink';
import { LandingFrame } from './LandingFrame';
import { LandingHero } from './LandingHero';
import { LandingShowcases, RuleLabel } from './LandingShowcases';

const REPOSITORY = 'https://github.com/AshishKumar4/kinu';
const SHELL = 'landing-shell';
const SECTION = 'border-t p-border py-20 lg:py-[104px] lg:pb-24';
const CARD = 'min-w-0 rounded-[14px] border p-border p-surface';
const SAMPLE_NOTE = 'flex flex-wrap justify-between gap-2 px-1 pt-3 text-[11px] leading-relaxed p-text-4';

function SectionTitle({ children, className = '' }: { children: ReactNode; className?: string }): ReactElement {
  return <h2 className={`max-w-[900px] text-[clamp(30px,3.4vw,44px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty ${className}`}>{children}</h2>;
}

function Accent({ children }: { children: ReactNode }): ReactElement {
  return <span className="p-accent">{children}</span>;
}

function PlatformSection({ install }: { install: string }): ReactElement {
  const { status, copy } = useCopy();
  const localStart = 'kinu create workshop --mode local\nkinu chat workshop';
  return (
    <section id="platform" className={SECTION}>
      <RuleLabel>01 · Where agents work</RuleLabel>
      <SectionTitle>A computer for your agents. <Accent>Choose where it lives.</Accent></SectionTitle>
      <p className="mb-10 mt-4 max-w-[700px] text-[17px] leading-[1.65] p-text-3">A workspace is where one agent works. It holds the agent's files, tools, memory, and conversations.</p>
      <div className="grid overflow-hidden rounded-2xl border p-border p-surface md:grid-cols-2">
        <article className="flex min-w-0 flex-col p-6 sm:p-8">
          <span className="mb-6 font-mono text-[11px] uppercase tracking-[.14em] p-accent">Cloud agents</span>
          <h3 className="text-[27px] font-semibold leading-tight tracking-[-.025em]">Close the laptop.<br />The agent keeps working.</h3>
          <p className="mb-6 mt-4 text-[15px] leading-[1.7] p-text-3">Cloud workspaces keep their files, conversations, and memory. Schedules, signed webhooks, and background jobs can start work without an open browser.</p>
          <ul className="mb-8 space-y-3 text-sm leading-[1.65] p-text-2">
            <li>Investigate repository events as they arrive.</li>
            <li>Schedule research and check back on the sources.</li>
            <li>Run builds in an attached Linux sandbox.</li>
          </ul>
          <div className="mt-auto flex flex-wrap gap-3"><LandingActionLink href="/login" primary>Sign in to kinu.run →</LandingActionLink></div>
          <div id="deploy" className="mt-6 border-t p-border pt-5 text-sm leading-[1.7] p-text-3">
            To run it in your own Cloudflare account, <a className="p-accent underline underline-offset-4" href="https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu" target="_blank" rel="noreferrer">deploy Kinu</a> with the <a className="p-accent underline underline-offset-4" href={REPOSITORY + '/blob/main/docs/SELF-HOSTING.md'} target="_blank" rel="noreferrer">self-hosting guide</a>. You need a Workers Paid plan and your model credentials.
          </div>
        </article>
        <article className="flex min-w-0 flex-col border-t p-border p-6 sm:p-8 md:border-l md:border-t-0">
          <span className="mb-6 font-mono text-[11px] uppercase tracking-[.14em] p-accent">Local</span>
          <h3 className="text-[27px] font-semibold leading-tight tracking-[-.025em]">Your checkout.<br />Your terminal or editor.</h3>
          <p className="mb-6 mt-4 text-[15px] leading-[1.7] p-text-3">Local workspaces run on your machine. Use the full-screen TUI, a one-shot CLI task, or an editor that speaks ACP. Model requests go to the provider you configured.</p>
          <div className="rounded-xl border p-border p-recessed p-4">
            <div className="mb-3 flex items-center justify-between gap-3"><span className="font-mono text-[10px] uppercase tracking-[.14em] p-text-4">Install · Linux</span><Button type="button" variant="ghost" size="sm" aria-label="Copy local setup commands" onClick={() => copy(install + '\n' + localStart)}>{status === 'copied' ? 'Copied' : status === 'failed' ? 'Retry copy' : 'Copy'}</Button></div>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-[1.9] p-text-2"><code>{install + '\n' + localStart}</code></pre>
          </div>
          <dl className="mt-6 space-y-3 text-sm p-text-3">
            <div><dt className="inline font-mono text-xs p-text-2">kinu run workshop "task"</dt><dd className="mt-1">One task, streamed to your terminal.</dd></div>
            <div><dt className="inline font-mono text-xs p-text-2">kinu acp workshop</dt><dd className="mt-1">Connect from editors such as Zed over ACP.</dd></div>
          </dl>
          <a href={REPOSITORY + '/blob/main/QUICKSTART.md'} target="_blank" rel="noreferrer" className="mt-6 text-sm font-semibold p-accent">Setup and provider configuration →</a>
        </article>
      </div>
      <div className="mt-12">
        <LandingFrame kind="checkout" />
        <p className={SAMPLE_NOTE}><span>Example UI and sample data, not a live workspace.</span><span>Run and Supervise, the Work tab, and Retry act on this page only.</span></p>
      </div>
    </section>
  );
}

function PlanSection(): ReactElement {
  return (
    <section id="plan" className={SECTION}>
      <RuleLabel>03 · Plan mode</RuleLabel>
      <SectionTitle>Ask for a plan first, and <Accent>nothing changes until you approve it.</Accent></SectionTitle>
      <p className="mb-10 mt-4 max-w-[720px] text-[17px] leading-[1.65] p-text-3">In Plan mode the agent can read files and research, but not edit anything. It submits a Markdown plan. You mark the lines that need work, or approve it, and only then does a Build turn start.</p>
      <LandingFrame kind="plan" />
      <p className={SAMPLE_NOTE}><span>Example UI and sample data, not a live workspace.</span><span>Request changes is live while an annotation is on the plan; Approve is live once the plan is clean.</span></p>
      <a className="mt-6 inline-block text-sm font-semibold p-accent" href={REPOSITORY + '/blob/main/docs/TOOLS.md#plan-authority'} target="_blank" rel="noreferrer">What Plan mode can and cannot do →</a>
    </section>
  );
}

function SlatesSection(): ReactElement {
  return (
    <section id="slates" className={SECTION}>
      <RuleLabel>04 · Slates</RuleLabel>
      <SectionTitle>Build live apps <Accent>with slates.</Accent></SectionTitle>
      <p className="mb-10 mt-4 max-w-[720px] text-[17px] leading-[1.65] p-text-3">Ask for a dashboard and the agent writes a small Worker. The source lives in the workspace, and its package.json declares what the app may reach. The app opens in its own tab on a preview URL.</p>
      <LandingFrame kind="slate" />
      <p className={SAMPLE_NOTE}><span>Example UI and sample data, not a running app.</span><span>The charts draw once on open.</span></p>
      <div className="mt-8 grid gap-4 text-[13px] leading-[1.7] p-text-3 md:grid-cols-2 md:gap-12">
        <p>A binding passes one of the caller's own capabilities: files, an MCP connection narrowed to named tools, or a read model. A declaration is not a permission grant. The owner's existing gates still apply on every call.</p>
        <p>Kinu compiles the source and serves it on its own preview hostname. Credentials never enter the app. Lasting state belongs in workspace files or another allowed capability, and committed versions survive restarts. <a className="p-accent underline underline-offset-4" href={REPOSITORY + '/blob/main/docs/LIVE-UI.md'} target="_blank" rel="noreferrer">How a live app runs</a></p>
      </div>
    </section>
  );
}

function SwarmSearch(): ReactElement {
  return (
    <figure className="overflow-hidden rounded-2xl border p-border p-surface">
      <figcaption className="flex flex-wrap items-center justify-between gap-3 border-b p-border p-recessed px-6 py-4 font-mono text-[11px] p-text-4"><span>Example search · not benchmark results</span><span>Objective: reduce runtime · preserve correctness</span></figcaption>
      <div className="p-6 sm:p-8">
        <div className="mx-auto max-w-[580px] rounded-xl border border-[var(--c-accent)] p-accent-subtle p-5 text-center"><h3 className="font-semibold p-accent">Say what better means</h3><p className="mt-2 text-sm leading-[1.65] p-text-3">The task, a starting context, and a registered verifier that reports a number in its own unit.</p></div>
        <div aria-hidden="true" className="mx-auto h-8 w-px bg-[var(--c-border-strong)]" />
        <div className="grid gap-4 md:grid-cols-3">
          {[
            ['Candidate A', 'Change the algorithm'],
            ['Candidate B', 'Change the data structure'],
            ['Candidate C', 'Change the work partition'],
          ].map(([title, body]) => <div key={title} className="rounded-xl border p-border p-recessed p-5"><h4 className="text-sm font-semibold p-text">{title}</h4><p className="mt-2 text-sm p-text-3">{body}</p><div className="mt-5 border-t border-dashed border-[var(--c-dash)] pt-3 font-mono text-[11px] p-accent">run → verify → compare</div></div>)}
        </div>
        <div aria-hidden="true" className="mx-auto h-8 w-px bg-[var(--c-border-strong)]" />
        <div className="mx-auto max-w-[580px] border-t p-border pt-5 text-center"><h3 className="font-semibold">Expand what measured better</h3><p className="mt-2 text-sm leading-[1.65] p-text-3">Keep every measured result for the same objective, expand the branches that improved, and settle on one. A search can fail to improve on the starting point.</p></div>
      </div>
    </figure>
  );
}

function EvolutionSection(): ReactElement {
  const stages = [
    {
      time: 'After crafted code runs',
      title: 'Tool fitness',
      evidence: 'Finished tool runs and later turn outcomes',
      change: 'Update the crafted tool fitness score',
      persists: 'Evidence for future crafted tool selection',
      detail: 'Agents can craft reusable tools. Execution updates their fitness and affects which remain available. A tool that returned without raising has not proved it did the right thing.',
    },
    {
      time: 'After corrective feedback',
      title: 'Lesson extraction',
      evidence: 'Your feedback, a corrective follow-up, or execution evidence',
      change: 'Record a provisional lesson',
      persists: 'A durable lesson row',
      detail: 'Unconfirmed lessons stay provisional. Corroborated lessons enter workspace memory.',
    },
    {
      time: 'After a corrected turn window',
      title: 'Turn reflection',
      evidence: 'Negative signal and recent turns',
      change: 'Write a focused reflection',
      persists: 'A reflection in workspace memory',
      detail: 'A window with no negative signal adds no reflection.',
    },
    {
      time: 'Across many turn windows',
      title: 'Scaffold evolution',
      evidence: 'A repeated pattern with recorded outcomes',
      change: 'Propose and validate a new agent loop',
      persists: 'A reversible scaffold version',
      detail: 'A proposal must pass validation and shadow evaluation before promotion. A rejected proposal does not replace the live scaffold, and a promoted version keeps a rollback path. More experience does not guarantee improvement.',
    },
  ] as const;
  const [activeIndex, setActiveIndex] = useState(0);
  const active = stages[activeIndex] ?? stages[0];
  return (
    <section id="evolution" data-evolution-stage={activeIndex} className={SECTION}>
      <RuleLabel>05 · Self-evolution</RuleLabel>
      <SectionTitle>The agent <Accent>evolves with use.</Accent></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[720px] text-[17px] leading-[1.6] p-text-3">When you correct the agent, it records a provisional lesson. Each tool run updates that tool's fitness score. A problem that keeps coming back can lead to a proposed change to the scaffold, the code that drives the agent loop.</p>
      <div className="grid overflow-hidden rounded-2xl border p-border p-surface lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="grid gap-px bg-[var(--c-border)] sm:grid-cols-2 lg:grid-cols-1">
          {stages.map((stage, index) => (
            <button
              type="button"
              key={stage.title}
              aria-pressed={activeIndex === index}
              onClick={() => setActiveIndex(index)}
              className={`flex min-h-[88px] items-center justify-between gap-4 p-5 text-left transition-colors ${activeIndex === index ? 'p-accent-subtle' : 'p-recessed hover:p-elevated'}`}
            >
              <span><span className="block font-mono text-[10px] uppercase tracking-[.13em] p-accent">{stage.time}</span><strong className="mt-1.5 block text-[13.5px] p-text">{stage.title}</strong></span>
              <span className={`font-mono text-sm ${activeIndex === index ? 'p-accent' : 'p-text-4'}`}>0{index + 1}</span>
            </button>
          ))}
        </div>
        <div className="flex min-h-[390px] flex-col justify-between p-5 sm:p-8">
          <div>
            <div className="mb-7 flex flex-wrap items-baseline justify-between gap-3"><div><div className="font-mono text-[10px] uppercase tracking-[.14em] p-accent">{active.time}</div><h3 className="mt-2 text-[24px] font-semibold tracking-[-.02em] p-text">{active.title}</h3></div><span className="rounded-full border p-border p-recessed px-3 py-1 font-mono text-[10px] p-text-4">evidence → durable state</span></div>
            <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="rounded-xl border p-border p-recessed p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-text-4">Evidence</span><p className="mt-3 text-[13px] leading-[1.55] p-text">{active.evidence}</p></div>
              <span aria-hidden="true" className="hidden self-center font-mono p-accent md:block">→</span>
              <div className="rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] p-accent-subtle p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-accent">Agent changes</span><p className="mt-3 text-[13px] leading-[1.55] p-text">{active.change}</p></div>
              <span aria-hidden="true" className="hidden self-center font-mono p-accent md:block">→</span>
              <div className="rounded-xl border p-border p-recessed p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-text-4">Persists</span><p className="mt-3 text-[13px] leading-[1.55] p-text">{active.persists}</p></div>
            </div>
          </div>
          <p className="mt-7 border-t border-dashed border-[var(--c-dash)] pt-5 text-sm leading-[1.65] p-text-3">{active.detail}</p>
        </div>
      </div>
      <a className="mt-6 inline-block text-sm font-semibold p-accent" href={REPOSITORY + '/blob/main/docs/EVOLUTION.md'} target="_blank" rel="noreferrer">How evolution works, and its limits →</a>
    </section>
  );
}

function SwarmSection(): ReactElement {
  return (
    <section id="swarm" className={SECTION}>
      <RuleLabel>06 · Swarms</RuleLabel>
      <SectionTitle>Explore several approaches in parallel <Accent>with swarms.</Accent></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[780px] text-[17px] leading-[1.6] p-text-3">A swarm is a tree search whose nodes are agents. Several candidates work on the same objective at once. A forked candidate keeps the parent conversation; a fresh one starts from the task and the parent's report.</p>
      <SwarmSearch />
      <p className="mt-6 max-w-[780px] text-sm leading-[1.7] p-text-3">With an objective and an executable verifier, measurements guide the search. Without an objective, the verification presets fall back to a judged sweep, which ranks candidates but measures nothing. Ideation returns unranked ideas. <a className="p-accent underline underline-offset-4" href={REPOSITORY + '/blob/main/docs/EXPLORATION.md'} target="_blank" rel="noreferrer">How exploration works</a></p>
    </section>
  );
}

function OpenSourceSection(): ReactElement {
  return (
    <section id="cta" className="border-t p-border bg-[linear-gradient(180deg,var(--c-surface)_0%,var(--c-bg)_100%)]">
      <div className={`${SHELL} grid items-center gap-10 py-20 lg:grid-cols-[1.2fr_1fr] lg:gap-14 lg:py-[100px]`}>
        <div><RuleLabel>07 · Open source</RuleLabel><SectionTitle>Open source, <Accent>end to end.</Accent></SectionTitle><p className="mb-9 mt-4 text-[17px] leading-[1.6] p-text-3">MIT-licensed: the agent, both backends, and the CLI.</p><div className="flex flex-wrap gap-3"><LandingActionLink external primary href={REPOSITORY}>Read the source →</LandingActionLink><LandingActionLink href="/login">Try cloud agents</LandingActionLink></div></div>
        <div className={`${CARD} px-[26px] py-1.5`}>
          {[['Licence', <span key="mit">MIT</span>], ['Source', <a key="source" href={REPOSITORY} target="_blank" rel="noreferrer" className="p-accent">github.com/AshishKumar4/kinu</a>], ['Backends', <span key="backends">Cloudflare Workers · POSIX</span>], ['Docs', <span key="docs" className="flex flex-wrap gap-3.5">{['ARCHITECTURE', 'EXPLORATION', 'EVOLUTION', 'DEPLOYMENT'].map((doc) => <a key={doc} href={`${REPOSITORY}/blob/main/docs/${doc}.md`} target="_blank" rel="noreferrer" className="p-accent">{doc.toLowerCase()}</a>)}</span>]].map(([label, value], index) => <div key={String(label)} className={`grid gap-2 py-[15px] sm:grid-cols-[96px_1fr] sm:gap-4 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}><span className="text-xs p-text-4">{label}</span><div className="min-w-0 [overflow-wrap:anywhere] font-mono text-[12.5px] p-text-2">{value}</div></div>)}
        </div>
      </div>
    </section>
  );
}

function Header(): ReactElement {
  const theme = useTheme();
  return (
    <header className="sticky top-0 z-20 border-b p-border bg-[color-mix(in_srgb,var(--c-bg)_90%,transparent)] backdrop-blur-[10px]">
      <div className={`${SHELL} flex h-[60px] items-center justify-between gap-5`}>
        <a href="#top" aria-label="Kinu home"><KinuLogo /></a>
        <nav className="flex items-center gap-1" aria-label="Landing sections">
          {[['platform', 'Cloud & local'], ['local', 'Smart CI'], ['plan', 'Plan'], ['slates', 'Slates'], ['evolution', 'Evolution'], ['swarm', 'Swarms']].map(([id, label]) => <a key={id} href={`#${id}`} className="hidden rounded-full px-3 py-2 text-[13px] p-text-3 transition-colors hover:p-text lg:block">{label}</a>)}
          <a href={REPOSITORY} target="_blank" rel="noreferrer" className="hidden items-center gap-1 rounded-full px-3 py-2 text-[13px] p-text-3 hover:p-text xl:flex">GitHub <ArrowUpRightIcon aria-hidden="true" size={13} /></a>
          <Button type="button" variant="ghost" size="sm" onClick={toggleMode} aria-label={`Switch to ${theme.mode === 'dark' ? 'light' : 'dark'} mode`} icon={theme.mode === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />} />
          <LandingActionLink href="/login" primary size="base">Try cloud agents</LandingActionLink>
        </nav>
      </div>
    </header>
  );
}

function Footer(): ReactElement {
  return (
    <footer className="border-t p-border p-recessed">
      <div className={`${SHELL} flex flex-wrap items-center gap-5 py-7`}><div className="flex items-center gap-2.5"><KinuLogo compact /><span className="text-xs p-text-4">絹 · the self-evolving agent platform</span></div><nav className="ml-auto flex flex-wrap gap-5 text-[13px] p-text-3"><a href={REPOSITORY}>GitHub</a><a href={`${REPOSITORY}/blob/main/QUICKSTART.md`}>Quickstart</a><a href={`${REPOSITORY}/blob/main/docs/USER-GUIDE.md`}>User guide</a><a href="/login">kinu.run</a></nav><span className="text-[12.5px] p-text-4">MIT © 2026</span></div>
    </footer>
  );
}

export function LandingPage({ install }: { install: string }): ReactElement {
  return (
    <div className="min-h-screen overflow-x-clip p-bg font-sans p-text">
      <Header />
      <main>
        <LandingHero install={install} />
        <div className={SHELL}><PlatformSection install={install} /></div>
        <LandingShowcases />
        <div className={SHELL}>
          <PlanSection />
          <SlatesSection />
          <EvolutionSection />
          <SwarmSection />
        </div>
        <OpenSourceSection />
      </main>
      <Footer />
    </div>
  );
}
