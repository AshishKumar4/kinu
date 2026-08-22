import { Button } from '@cloudflare/kumo';
import { ArrowUpRightIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { platformFact } from '@kinu.run/core';
import type { ReactElement, ReactNode } from 'react';

import { KinuLogo } from '@/components/ui/KinuLogo';
import { toggleMode, useTheme } from '@/hooks/use-theme';

import { LandingActionLink } from './LandingActionLink';
import { LandingHero } from './LandingHero';
import { LandingShowcases } from './LandingShowcases';

const REPOSITORY = 'https://github.com/AshishKumar4/kinu';
const storageLimit = platformFact('do.storage.bytes').limit;
if (storageLimit?.unit !== 'bytes') throw new Error('do.storage.bytes has no byte limit');
const STORAGE_GB = storageLimit.value / (1024 ** 3);
const SHELL = 'landing-shell';
const SECTION = 'border-t p-border py-20 lg:py-[104px] lg:pb-24';
const CARD = 'min-w-0 rounded-[14px] border p-border p-surface';

const FEATURES = [
  ['Learns from use', 'Every turn is graded against your next message. Lessons that later turns confirm persist.'],
  ['Crafts its own tools', 'Recurring patterns become tools it builds, scores, and calls on its own.'],
  ['Commands agent swarms', 'A hard task forks a scored tree of whole agents. The best attempt wins.'],
  ['Your cloud, or yours alone', 'Run it on kinu.run today, or deploy the same Worker into your own account.'],
] as const;

function RuleLabel({ children }: { children: ReactNode }): ReactElement {
  return <div className="mb-4 flex items-center gap-3 text-[13px] font-semibold p-gold"><span className="h-px w-[22px] shrink-0 bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />{children}</div>;
}

function SectionTitle({ children, className = '' }: { children: ReactNode; className?: string }): ReactElement {
  return <h2 className={`text-[clamp(30px,3.4vw,44px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty ${className}`}>{children}</h2>;
}

function FeatureStrip(): ReactElement {
  return (
    <div className={SHELL}>
      <div data-feature-strip className="grid grid-cols-1 border-y p-border py-2 sm:grid-cols-2 lg:grid-cols-4 lg:py-8">
        {FEATURES.map(([title, body], index) => (
          <div key={title} className={`py-5 sm:px-6 lg:py-0 lg:first:pl-0 lg:last:pr-0 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)] sm:border-l sm:border-t-0' : ''}`}>
            <h3 className="mb-2 text-[13px] font-semibold p-gold">{title}</h3>
            <p className="text-[13.5px] leading-[1.6] p-text-3">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformSection(): ReactElement {
  const examples = [
    ['Research, overnight', 'Hand it a question in the evening. The sourced brief is ready in the morning.'],
    ['Review every pull request', 'A webhook wakes the workspace and posts the review before you open the PR.'],
    ['Ship while you are away', 'Describe the change. The agent branches, builds, tests, and opens the pull request.'],
  ] as const;
  return (
    <section id="platform" className={SECTION}>
      <RuleLabel>01 · The platform</RuleLabel>
      <SectionTitle>Close the laptop. <span className="p-gold">The agent keeps working.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[660px] text-[17px] leading-[1.6] p-text-3">Kinu runs durable cloud workspaces and fully local agents through the same core. Start in either place, then open the workspace from the client you prefer.</p>
      <div className="mb-10 overflow-hidden rounded-2xl border p-border p-surface">
        <div className="grid md:grid-cols-2">
          <article className="min-w-0 p-7 sm:p-8">
            <div className="mb-7 flex items-center justify-between gap-4"><span className="font-mono text-[10px] uppercase tracking-[.16em] p-gold">Cloud</span><span className="font-mono text-[10px] p-text-4">Durable · always reachable</span></div>
            <h3 className="mb-3 text-[24px] font-semibold tracking-[-.025em]">Hosted workspaces and sandboxes</h3>
            <p className="max-w-[480px] text-[15px] leading-[1.7] p-text-3">Start a task, close the browser, and return to the result. Schedules and webhooks keep the workspace active while you are away.</p>
          </article>
          <article className="min-w-0 border-t p-border p-7 sm:p-8 md:border-l md:border-t-0">
            <div className="mb-7 flex items-center justify-between gap-4"><span className="font-mono text-[10px] uppercase tracking-[.16em] p-gold">Local</span><span className="font-mono text-[10px] p-text-4">Files stay on your machine</span></div>
            <h3 className="mb-3 text-[24px] font-semibold tracking-[-.025em]">TUI, CLI, or your editor</h3>
            <p className="max-w-[480px] text-[15px] leading-[1.7] p-text-3">Create a local workspace in the terminal, or connect the TUI to a cloud workspace. The same sessions and tools follow.</p>
          </article>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-border p-recessed px-7 py-4 font-mono text-[11px] p-text-4"><span>ONE BACKEND-AGNOSTIC CORE</span><span>web · TUI · CLI · ACP</span></div>
      </div>
      <div className="grid border-y p-border md:grid-cols-3">
        {examples.map(([title, body], index) => <div key={title} className={`py-6 md:px-7 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)] md:border-l md:border-t-0' : 'md:pl-0'} ${index === examples.length - 1 ? 'md:pr-0' : ''}`}><h3 className="mb-2.5 text-[13px] font-semibold p-gold">{title}</h3><p className="text-sm leading-[1.65] p-text-3">{body}</p></div>)}
      </div>
    </section>
  );
}

function QuickstartSection(): ReactElement {
  const clients = [
    ['In the browser', 'Web', 'Sign in and create a workspace. Nothing to install, and the same workspace opens from every client.', <a key="web" href="/login" className="text-[13px] font-semibold p-gold">Sign in →</a>],
    ['In the terminal', 'TUI', 'kinu chat opens the full-screen app. Pick a workspace, talk, and watch it work.', <code key="tui" className="rounded-[10px] border p-border p-recessed px-3.5 py-2.5 text-xs p-text-2"><span className="p-gold">$</span> kinu chat triage</code>],
    ['In the terminal', 'CLI', 'One command installs Kinu on macOS or Linux. Create a workspace, then hand it a task.', <code key="cli" className="rounded-[10px] border p-border p-recessed px-3.5 py-2.5 text-xs leading-[1.9] p-text-2"><span className="p-gold">$</span> kinu create triage</code>],
  ] as const;
  return (
    <section id="quickstart" className={SECTION}>
      <RuleLabel>02 · Quickstart</RuleLabel>
      <SectionTitle>Start in the cloud, <span className="p-gold">or entirely on your own machines.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[620px] text-[17px] leading-[1.6] p-text-3">Both use the same core. Reach one workspace from the web app, TUI, or CLI.</p>
      <div className="grid gap-5 md:grid-cols-3">
        {clients.map(([eyebrow, title, body, action]) => <div key={title} className={`${CARD} flex flex-col gap-3 p-7`}><div className="text-xs p-text-4">{eyebrow}</div><h3 className="text-xl font-semibold tracking-[-.02em]">{title}</h3><p className="flex-1 text-sm leading-[1.65] p-text-3">{body}</p>{action}</div>)}
      </div>
      <p className="mt-7 text-[13px] p-text-4">A workspace created in one client opens from the others with its files, sessions, and search history intact.</p>
    </section>
  );
}

function ClientsSection(): ReactElement {
  const clients = [
    ['The browser', 'kinu.run shows your workspaces, files, sessions, and searches.'],
    ['The terminal', 'kinu chat opens a conversation. kinu run executes one task and exits for scripts and CI.'],
    ['Your editor', 'kinu acp speaks the Agent Client Protocol, so editors such as Zed can drive a workspace.'],
    ['Webhooks', 'A signed webhook starts a turn from CI, an issue tracker, or another service.'],
  ] as const;
  return (
    <section id="clients" className={SECTION}>
      <RuleLabel>03 · One workspace, every client</RuleLabel>
      <SectionTitle>Work from the browser, the terminal, <span className="p-gold">or your editor.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[660px] text-[17px] leading-[1.6] p-text-3">Every client opens the same workspace with the same files and history. Start at your desk and check the result over SSH or from your editor.</p>
      <div className="mb-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {clients.map(([title, body]) => <div key={title} className={`${CARD} p-6`}><h3 className="mb-2.5 text-[12.5px] font-semibold p-gold">{title}</h3><p className="text-sm leading-[1.65] p-text-3">{body}</p></div>)}
      </div>
      <div className={`${CARD} p-6`}>
        <div className="mb-3.5 flex flex-wrap justify-between gap-2 text-xs p-text-4"><span>Recorded · <code>kinu run</code></span><span>workspace “film” · local backend</span></div>
        <div className="space-y-1 font-mono text-xs leading-[2] p-text-3"><div className="p-text-2"><span className="p-gold">$</span> kinu run film “Find the slowest test in this repo.”</div><div>▸ run · laptop &nbsp; 7 pass · 912 ms</div><div>▸ bench &nbsp; n=6000 43.8ms · n=12000 188.3ms · n=24000 827.3ms</div><p className="pt-2 font-sans text-[13.5px] leading-[1.65] p-text">The slowest test spends most of its time in an O(n²) dedupe pass. A Map keyed by id reduces it to one pass.</p></div>
      </div>
      <p className="mt-7 text-[13px] p-text-4">Schedules, webhooks, and finished background jobs start turns through the same path.</p>
    </section>
  );
}

function EvolutionSection(): ReactElement {
  const clocks = [
    ['Per step', 'Tool fitness', 'Every settled call updates the tool score from execution evidence.'],
    ['Per turn', 'Lesson extraction', 'The next message grades the answer. Confirmed lessons enter memory.'],
    ['Per session', 'Consolidation', 'Related lessons merge. Conflicts stay explicit until later evidence resolves them.'],
    ['Across sessions', 'Scaffold evolution', 'Repeated patterns can change the agent loop. Versions stay reversible.'],
  ] as const;
  return (
    <section id="evolution" className={SECTION}>
      <RuleLabel>04 · Self-evolution</RuleLabel>
      <SectionTitle>Evolution on <span className="p-gold">four timescales.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[640px] text-[17px] leading-[1.6] p-text-3">The shorter clocks feed the longer ones. Scoring, consolidation, and retirement run inside the workspace.</p>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {clocks.map(([time, title, body]) => <div key={title} className={`${CARD} p-[26px]`}><div className="mb-3.5 text-[11.5px] p-text-4">{time}</div><h3 className="mb-2.5 text-[12.5px] font-semibold p-gold">{title}</h3><p className="text-sm leading-[1.65] p-text-3">{body}</p></div>)}
      </div>
    </section>
  );
}

function SwarmSection(): ReactElement {
  return (
    <section id="swarm" className={SECTION}>
      <RuleLabel>05 · The tree of agents</RuleLabel>
      <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-14">
        <div><SectionTitle>Run one task <span className="p-gold">as a tree of agents.</span></SectionTitle><p className="mt-3.5 text-[17px] leading-[1.6] p-text-3">One tool call builds the tree. Each node attempts the task in its own directory. Weak branches are pruned, and the measured winner answers.</p><p className="mt-3.5 text-[17px] leading-[1.6] p-text-3">Kinu derives the objective and verifier from your request. You keep the winning result and the record behind it.</p></div>
        <div className={`${CARD} p-6 font-mono text-[12.5px] leading-[1.9] p-text-3`}><div className="mb-3.5 text-[11px] uppercase tracking-[.14em] p-text-4">One internal call</div><pre className="overflow-x-auto whitespace-pre-wrap">{`agents({\n  action: 'swarm',\n  preset: 'optimise',\n  task: 'make the p95 faster',\n  verify: { kind: 'command', spec: 'bun bench' }\n})`}</pre><div className="mt-4 border-t border-dashed border-[var(--c-dash)] pt-3.5 text-[11px] p-text-4">The shape follows the task. Ideation fans out; optimisation searches and measures; proof runs deeper.</div></div>
      </div>
    </section>
  );
}

function DeploySection(): ReactElement {
  const steps = [
    ['Step one', 'Bring the account.', 'Workers Paid plan, a zone, and a Wrangler login.', 'bun run infra:provision'],
    ['Step two', 'Deploy, then provision again.', 'The deploy ships the Worker, Durable Objects, and container.', 'bun run deploy'],
    ['Step three', 'Prove the account.', 'The infra gate checks every declared resource and binding.', 'bun run gate:infra'],
  ] as const;
  const values = [
    ['Isolated workspaces', 'Each workspace owns its files and sessions. Idle workspaces use no compute; stored data still uses storage.'],
    [`${String(STORAGE_GB)} GB file plane, each`, `Each paid-plan workspace can keep up to ${String(STORAGE_GB)} GB of durable files and shell state (do.storage.bytes).`],
    ['Linux on demand', 'An agent can attach a full Linux sandbox through Cloudflare Containers.'],
    ['Your own devices', 'Connect a PC and allow each remote access request explicitly.'],
  ] as const;
  return (
    <section id="deploy" className={SECTION}>
      <RuleLabel>06 · Self-host</RuleLabel>
      <div className="mb-5 grid items-start gap-10 lg:grid-cols-[1fr_1.12fr] lg:gap-14">
        <div><SectionTitle>Host Kinu agents <span className="p-gold">yourself.</span></SectionTitle><p className="mb-7 mt-3.5 text-[17px] leading-[1.6] p-text-3">The cloud platform deploys into your Cloudflare account. Your agents, files, and model spend stay with you.</p><div className="flex flex-wrap gap-3"><LandingActionLink external primary href="https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu">Deploy to Cloudflare →</LandingActionLink><LandingActionLink external href={`${REPOSITORY}/blob/main/docs/SELF-HOSTING.md`}>Self-hosting guide</LandingActionLink></div></div>
        <div className={`${CARD} overflow-hidden`}>{steps.map(([step, title, body, command], index) => <div key={step} className={`grid gap-2 px-5 py-5 sm:grid-cols-[96px_1fr] sm:gap-[18px] sm:px-[26px] ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}><span className="text-xs p-text-4">{step}</span><div><p className="text-sm leading-[1.6] p-text-3"><strong className="p-text">{title}</strong> {body}</p><code className="mt-2 block text-xs p-gold">{command}</code></div></div>)}</div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{values.map(([title, body]) => <div key={title} className={`${CARD} p-6`}><h3 className="mb-2.5 text-[12.5px] font-semibold p-gold">{title}</h3><p className="text-sm leading-[1.65] p-text-3">{body}</p></div>)}</div>
    </section>
  );
}

function OpenSourceSection(): ReactElement {
  return (
    <section id="cta" className="border-t p-border bg-[linear-gradient(180deg,var(--c-surface)_0%,var(--c-bg)_100%)]">
      <div className={`${SHELL} grid items-center gap-10 py-20 lg:grid-cols-[1.2fr_1fr] lg:gap-14 lg:py-[100px]`}>
        <div><RuleLabel>07 · Open source</RuleLabel><SectionTitle>Open source, <span className="p-gold">end to end.</span></SectionTitle><p className="mb-9 mt-4 text-[17px] leading-[1.6] p-text-3">MIT-licensed: the agent, both backends, and the CLI.</p><div className="flex flex-wrap gap-3"><LandingActionLink external primary href={REPOSITORY}>Read the source →</LandingActionLink><LandingActionLink href="/login">Try cloud agents</LandingActionLink></div></div>
        <div className={`${CARD} px-[26px] py-1.5`}>
          {[['Licence', <span key="mit">MIT</span>], ['Source', <a key="source" href={REPOSITORY} target="_blank" rel="noreferrer" className="p-gold">github.com/AshishKumar4/kinu</a>], ['Backends', <span key="backends">Cloudflare Workers · POSIX</span>], ['Docs', <span key="docs" className="flex flex-wrap gap-3.5">{['ARCHITECTURE', 'EXPLORATION', 'EVOLUTION', 'DEPLOYMENT'].map((doc) => <a key={doc} href={`${REPOSITORY}/blob/main/docs/${doc}.md`} target="_blank" rel="noreferrer" className="p-gold">{doc.toLowerCase()}</a>)}</span>]].map(([label, value], index) => <div key={String(label)} className={`grid gap-2 py-[15px] sm:grid-cols-[96px_1fr] sm:gap-4 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}><span className="text-xs p-text-4">{label}</span><div className="min-w-0 [overflow-wrap:anywhere] font-mono text-[12.5px] p-text-2">{value}</div></div>)}
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
          {['Platform', 'Quickstart', 'Clients', 'Evolution', 'Swarms', 'Self-host'].map((label) => <a key={label} href={`#${label === 'Swarms' ? 'swarm' : label === 'Self-host' ? 'deploy' : label.toLowerCase()}`} className="hidden rounded-full px-3 py-2 text-[13px] p-text-3 transition-colors hover:p-text lg:block">{label}</a>)}
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
        <FeatureStrip />
        <LandingShowcases />
        <div className={SHELL}>
          <PlatformSection />
          <QuickstartSection />
          <ClientsSection />
          <EvolutionSection />
          <SwarmSection />
          <DeploySection />
        </div>
        <OpenSourceSection />
      </main>
      <Footer />
    </div>
  );
}
