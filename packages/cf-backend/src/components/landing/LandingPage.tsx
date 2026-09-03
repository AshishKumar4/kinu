import { Button } from '@cloudflare/kumo';
import { ArrowUpRightIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { platformFact } from '@kinu.run/core';
import { useState, type ReactElement, type ReactNode } from 'react';

import { KinuLogo } from '@/components/ui/KinuLogo';
import { toggleMode, useTheme } from '@/hooks/use-theme';

import { LandingActionLink } from './LandingActionLink';
import { LandingHero } from './LandingHero';
import { LandingShowcases } from './LandingShowcases';

const REPOSITORY = 'https://github.com/AshishKumar4/kinu';
const storageLimit = platformFact('do.storage.bytes').limit;
const sandboxCpu = platformFact('container.instance.vcpu').limit;
const sandboxMemory = platformFact('container.instance.memory').limit;
const sandboxDisk = platformFact('container.instance.disk').limit;
if (storageLimit?.unit !== 'bytes') throw new Error('do.storage.bytes has no byte limit');
if (sandboxCpu?.unit !== 'count') throw new Error('container.instance.vcpu has no count');
if (sandboxMemory?.unit !== 'bytes') throw new Error('container.instance.memory has no byte limit');
if (sandboxDisk?.unit !== 'bytes') throw new Error('container.instance.disk has no byte limit');
const STORAGE_GB = storageLimit.value / 1_000_000_000;
const SANDBOX_VCPU = sandboxCpu.value;
const SANDBOX_MEMORY_GB = sandboxMemory.value / (1024 ** 3);
const SANDBOX_DISK_GB = sandboxDisk.value / 1_000_000_000;
const SHELL = 'landing-shell';
const SECTION = 'border-t p-border py-20 lg:py-[104px] lg:pb-24';
const CARD = 'min-w-0 rounded-[14px] border p-border p-surface';

const FEATURES = [
  ['Learns from feedback', 'Your corrections become corroborated lessons.'],
  ['Crafts its own tools', 'Recurring patterns become tools it builds and scores.'],
  ['Builds subagent DAGs', 'Specialists work in parallel and pass evidence onward.'],
  ['Your cloud, or ours', 'Use kinu.run or deploy to your Cloudflare account.'],
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
    ['Investigate repository events', 'A signed webhook wakes the workspace and stores the result with the run.'],
    ['Prepare changes while away', 'The agent can branch, build, and test while the durable workspace remains online.'],
  ] as const;
  return (
    <section id="platform" className={SECTION}>
      <RuleLabel>01 · The platform</RuleLabel>
      <SectionTitle>Close the laptop. <span className="p-gold">The agent keeps working.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[660px] text-[17px] leading-[1.6] p-text-3">Run durable workspaces in the cloud or keep agents on your terminal.</p>
      <div className="mb-10 overflow-hidden rounded-2xl border p-border p-surface">
        <div className="grid md:grid-cols-2">
          <article className="min-w-0 p-7 sm:p-8">
            <div className="mb-7 flex items-center justify-between gap-4"><span className="font-mono text-[10px] uppercase tracking-[.16em] p-gold">Cloud</span><span className="font-mono text-[10px] p-text-4">Durable · cloud hosted</span></div>
            <h3 className="mb-3 text-[24px] font-semibold tracking-[-.025em]">Hosted workspaces and sandboxes</h3>
            <p className="max-w-[480px] text-[15px] leading-[1.7] p-text-3">Start a task and close the browser. Schedules and webhooks keep it running.</p>
          </article>
          <article className="min-w-0 border-t p-border p-7 sm:p-8 md:border-l md:border-t-0">
            <div className="mb-7 flex items-center justify-between gap-4"><span className="font-mono text-[10px] uppercase tracking-[.16em] p-gold">Local</span><span className="font-mono text-[10px] p-text-4">Files stay on your machine</span></div>
            <h3 className="mb-3 text-[24px] font-semibold tracking-[-.025em]">TUI, CLI, or your editor</h3>
            <p className="max-w-[480px] text-[15px] leading-[1.7] p-text-3">Create a local workspace, or open a cloud workspace from the TUI.</p>
          </article>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-border p-recessed px-7 py-4 font-mono text-[11px] p-text-4"><span>ONE CORE · CLOUD AND LOCAL</span><span>web · TUI · CLI · ACP</span></div>
      </div>
      <div className="grid border-y p-border md:grid-cols-3">
        {examples.map(([title, body], index) => <div key={title} className={`py-6 md:px-7 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)] md:border-l md:border-t-0' : 'md:pl-0'} ${index === examples.length - 1 ? 'md:pr-0' : ''}`}><h3 className="mb-2.5 text-[13px] font-semibold p-gold">{title}</h3><p className="text-sm leading-[1.65] p-text-3">{body}</p></div>)}
      </div>
    </section>
  );
}

function QuickstartSection(): ReactElement {
  const clients = [
    ['In the browser', 'Web', 'Sign in and create a cloud workspace. Open it from any client.', <a key="web" href="/login" className="text-[13px] font-semibold p-gold">Sign in →</a>],
    ['In the terminal', 'TUI', 'kinu chat opens the full-screen app for cloud or local workspaces.', <code key="tui" className="rounded-[10px] border p-border p-recessed px-3.5 py-2.5 text-xs p-text-2"><span className="p-gold">$</span> kinu chat triage</code>],
    ['In the terminal', 'CLI', 'Install Kinu on Linux, create a workspace, and run a task.', <code key="cli" className="rounded-[10px] border p-border p-recessed px-3.5 py-2.5 text-xs leading-[1.9] p-text-2"><span className="p-gold">$</span> kinu create triage</code>],
  ] as const;
  return (
    <section id="quickstart" className={SECTION}>
      <RuleLabel>02 · Quickstart</RuleLabel>
      <SectionTitle>Start in the cloud, <span className="p-gold">or entirely on your own machines.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[620px] text-[17px] leading-[1.6] p-text-3">Use cloud workspaces from any client. Use local workspaces from the terminal.</p>
      <div className="grid gap-5 md:grid-cols-3">
        {clients.map(([eyebrow, title, body, action]) => <div key={title} className={`${CARD} flex flex-col gap-3 p-7`}><div className="text-xs p-text-4">{eyebrow}</div><h3 className="text-xl font-semibold tracking-[-.02em]">{title}</h3><p className="flex-1 text-sm leading-[1.65] p-text-3">{body}</p>{action}</div>)}
      </div>
      <p className="mt-7 text-[13px] p-text-4">Cloud workspaces keep their files, agents, conversations, and search history.</p>
    </section>
  );
}

function ClientsSection(): ReactElement {
  const clients = [
    ['The browser', 'kinu.run shows your workspaces, agents, files, conversations, and searches.'],
    ['The terminal', 'kinu chat opens a conversation. kinu run executes one task and exits for scripts and CI.'],
    ['Your editor', 'kinu acp speaks the Agent Client Protocol, so editors such as Zed can drive a workspace.'],
    ['Webhooks', 'A signed webhook starts a turn from CI, an issue tracker, or another service.'],
  ] as const;
  return (
    <section id="clients" className={SECTION}>
      <RuleLabel>03 · One workspace, every client</RuleLabel>
      <SectionTitle>Work from the browser, the terminal, <span className="p-gold">or your editor.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[660px] text-[17px] leading-[1.6] p-text-3">Open the same files and history from a browser, terminal, editor, or SSH session.</p>
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


function SwarmDag(): ReactElement {
  const nodes = [
    { label: 'Agent', detail: 'delegates', x: 50, y: 8, tone: 'agent' },
    { label: 'Research', detail: 'sources', x: 10, y: 35, tone: 'node' },
    { label: 'Ideation', detail: 'options', x: 38, y: 35, tone: 'node' },
    { label: 'Audit', detail: 'risks', x: 68, y: 35, tone: 'node' },
    { label: 'Optimization', detail: 'benchmarks', x: 22, y: 64, tone: 'node' },
    { label: 'Planning', detail: 'sequence', x: 52, y: 64, tone: 'node' },
    { label: 'Implementation', detail: 'builds', x: 82, y: 64, tone: 'node' },
    { label: 'Integrated result', detail: 'evidence + answer', x: 50, y: 90, tone: 'result' },
  ] as const;
  return (
    <div className="overflow-hidden rounded-2xl border p-border p-surface">
      <div className="relative hidden h-[460px] md:block">
        <svg aria-hidden="true" viewBox="0 0 1000 460" preserveAspectRatio="none" className="absolute inset-0 size-full">
          <g fill="none" stroke="var(--c-border-strong)" strokeWidth="1.2">
            <path d="M500 65 C500 110 100 105 100 155" />
            <path d="M500 65 C500 110 380 105 380 155" />
            <path d="M500 65 C500 110 680 105 680 155" />
            <path d="M100 195 C100 245 220 245 220 275" />
            <path d="M380 195 C380 245 220 245 220 275" />
            <path d="M380 195 C380 245 520 245 520 275" />
            <path d="M680 195 C680 245 520 245 520 275" />
            <path d="M680 195 C680 245 820 245 820 275" />
            <path d="M220 320 C220 380 500 370 500 398" />
            <path d="M520 320 C520 360 500 370 500 398" />
            <path d="M820 320 C820 380 500 370 500 398" />
          </g>
          <g fill="var(--c-accent)">
            {[[500, 65], [100, 155], [380, 155], [680, 155], [220, 275], [520, 275], [820, 275], [500, 398]].map(([x, y]) => <circle key={`${String(x)}-${String(y)}`} cx={x} cy={y} r="3" />)}
          </g>
        </svg>
        {nodes.map((node) => (
          <div
            key={node.label}
            className={`absolute min-w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-xl border px-4 py-3 text-center ${node.tone === 'agent' ? 'border-[var(--c-accent)] p-accent-subtle' : node.tone === 'result' ? 'border-[var(--c-success)] bg-[var(--c-success-tint)]' : 'p-border p-recessed'}`}
            style={{ left: `${String(node.x)}%`, top: `${String(node.y)}%` }}
          >
            <div className={`text-[12.5px] font-semibold ${node.tone === 'agent' ? 'p-gold' : node.tone === 'result' ? 'p-success' : 'p-text'}`}>{node.label}</div>
            <div className="mt-1 font-mono text-[9.5px] p-text-4">{node.detail}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-px bg-[var(--c-border)] md:hidden">
        {nodes.map((node) => <div key={node.label} className="flex items-center justify-between gap-3 p-recessed px-4 py-3"><span className="text-[12.5px] p-text">{node.label}</span><span className="font-mono text-[10px] p-text-4">{node.detail}</span></div>)}
      </div>
      <div className="flex flex-wrap justify-between gap-3 border-t p-border p-recessed px-5 py-3 font-mono text-[10px] uppercase tracking-[.1em] p-text-4"><span>parallel branches</span><span>measured evidence</span><span>fan-in</span></div>
    </div>
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
      detail: 'Each finished run the scorer records updates the tool\u2019s fitness. Later turn evidence can revise the same score.',
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
      change: 'Evaluate a change to the agent loop',
      persists: 'A reversible scaffold version',
      detail: 'Promotion requires the configured checks. Every accepted scaffold keeps a rollback path.',
    },
  ] as const;
  const [activeIndex, setActiveIndex] = useState(0);
  const active = stages[activeIndex] ?? stages[0];
  return (
    <section id="evolution" data-evolution-stage={activeIndex} className={SECTION}>
      <RuleLabel>04 · Self-evolution</RuleLabel>
      <SectionTitle>The agent learns at <span className="p-gold">four different speeds.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[720px] text-[17px] leading-[1.6] p-text-3">A tool result can change the next choice. Repeated evidence can change the agent loop itself. Select a timescale to see the full path.</p>
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
              <span><span className="block font-mono text-[10px] uppercase tracking-[.13em] p-gold">{stage.time}</span><strong className="mt-1.5 block text-[13.5px] p-text">{stage.title}</strong></span>
              <span className={`font-mono text-sm ${activeIndex === index ? 'p-gold' : 'p-text-4'}`}>0{index + 1}</span>
            </button>
          ))}
        </div>
        <div className="flex min-h-[390px] flex-col justify-between p-5 sm:p-8">
          <div>
            <div className="mb-7 flex flex-wrap items-baseline justify-between gap-3"><div><div className="font-mono text-[10px] uppercase tracking-[.14em] p-gold">{active.time}</div><h3 className="mt-2 text-[24px] font-semibold tracking-[-.02em] p-text">{active.title}</h3></div><span className="rounded-full border p-border p-recessed px-3 py-1 font-mono text-[10px] p-text-4">evidence → durable state</span></div>
            <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="rounded-xl border p-border p-recessed p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-text-4">Evidence</span><p className="mt-3 text-[13px] leading-[1.55] p-text">{active.evidence}</p></div>
              <span aria-hidden="true" className="hidden self-center font-mono p-gold md:block">→</span>
              <div className="rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] p-accent-subtle p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-gold">Agent changes</span><p className="mt-3 text-[13px] leading-[1.55] p-text">{active.change}</p></div>
              <span aria-hidden="true" className="hidden self-center font-mono p-gold md:block">→</span>
              <div className="rounded-xl border p-border p-recessed p-4"><span className="font-mono text-[9.5px] uppercase tracking-[.14em] p-text-4">Persists</span><p className="mt-3 text-[13px] leading-[1.55] p-text">{active.persists}</p></div>
            </div>
          </div>
          <p className="mt-7 border-t border-dashed border-[var(--c-dash)] pt-5 text-sm leading-[1.65] p-text-3">{active.detail}</p>
        </div>
      </div>
    </section>
  );
}

function SwarmSection(): ReactElement {
  return (
    <section id="swarm" className={SECTION}>
      <RuleLabel>05 · Subagent DAGs</RuleLabel>
      <SectionTitle>Your agent can assemble <span className="p-gold">the specialists a task needs.</span></SectionTitle>
      <p className="mb-10 mt-3.5 max-w-[780px] text-[17px] leading-[1.6] p-text-3">Your agent can build a DAG for research, optimisation, planning, review, and implementation. Nodes work in parallel and pass evidence onward.</p>
      <SwarmDag />
    </section>
  );
}

function DeploySection(): ReactElement {
  const steps = [
    ['Step one', 'Bring the account.', 'Workers Paid plan, a zone, and a Wrangler login.', 'bun run infra:provision'],
    ['Step two', 'Deploy.', 'The deploy ships the Worker, Durable Objects, and container.', 'bun run deploy'],
    ['Step three', 'Finish provisioning.', 'The second pass installs secrets after the Worker exists.', 'bun run infra:provision'],
    ['Step four', 'Prove the account.', 'The infra gate checks every declared resource and binding.', 'bun run gate:infra'],
  ] as const;
  const values = [
    ['Isolated workspaces', 'Each workspace owns its files and agents. Idle workspaces use no compute.'],
    [`${String(STORAGE_GB)} GB file plane, each`, `Each paid-plan workspace stores up to ${String(STORAGE_GB)} GB of durable files and shell state (do.storage.bytes).`],
    ['Linux on demand', 'Attach a Linux sandbox through Cloudflare Containers.'],
    ['Your own devices', 'Connect a PC once per workspace. Kinu remembers your choice.'],
  ] as const;
  return (
    <section id="deploy" className={SECTION}>
      <RuleLabel>06 · Self-host</RuleLabel>
      <div className="mb-5 grid items-start gap-10 lg:grid-cols-[1fr_1.12fr] lg:gap-14">
        <div><SectionTitle>Host Kinu agents <span className="p-gold">yourself.</span></SectionTitle><p className="mb-7 mt-3.5 text-[17px] leading-[1.6] p-text-3">Deploy Kinu to your Cloudflare account. Your agents, files, and model spend stay there.</p><div className="flex flex-wrap gap-3"><LandingActionLink external primary href="https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu">Deploy to Cloudflare →</LandingActionLink><LandingActionLink external href={`${REPOSITORY}/blob/main/docs/SELF-HOSTING.md`}>Self-hosting guide</LandingActionLink></div></div>
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
        <LandingShowcases
          storageGb={STORAGE_GB}
          sandboxVcpu={SANDBOX_VCPU}
          sandboxMemoryGb={SANDBOX_MEMORY_GB}
          sandboxDiskGb={SANDBOX_DISK_GB}
        />
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
