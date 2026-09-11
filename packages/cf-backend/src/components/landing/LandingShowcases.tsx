import { Button, Tabs } from '@cloudflare/kumo';
import { TUI_ADVERTISED_HINTS, TUI_COMPOSER_PLACEHOLDER, TUI_MARKS } from '@kinu.run/core';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';

import { useCopy } from '@/hooks/use-copy';

/**
 * The one way a section opens: a rule label, the heading, and the one lead
 * paragraph under it. Every section on the page reads through this, so the
 * distance from label to heading to lead is the same distance everywhere.
 * `tight` is for a head that shares its row with something else and needs
 * the lead's margin, not the section's.
 */
export function SectionHead({ label, lead, tight = false, children }: {
  label?: string;
  lead: ReactNode;
  tight?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={tight ? 'mb-9' : 'mb-10 lg:mb-12'}>
      {label && <div className="mb-4 flex items-center gap-3 text-[13px] font-semibold p-accent"><span className="h-px w-[22px] shrink-0 bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />{label}</div>}
      <h2 className="max-w-[900px] text-[clamp(30px,3.4vw,44px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">{children}</h2>
      <p className="mt-4 max-w-[720px] text-[17px] leading-[1.65] p-text-3">{lead}</p>
    </div>
  );
}

function TuiPreview(): ReactElement {
  // Every row here has a counterpart in the real shell (packages/cli/src/tui):
  // the status bar's segments, NavigatorRow's marks, the transcript's tool
  // group and the composer box. Compared against a real pty grid at 160 and
  // 80 columns; a row the terminal does not draw is not drawn here.
  const agents = {
    audit: {
      label: 'audit',
      location: 'local',
      status: 'idle',
      subordinate: 'reviewer · auditor',
      prompt: 'Audit the checkout flow, fix the coupon failure, and keep the tests green.',
      answer: 'The migration only filled fixed coupons. I patched the backfill, added the percentage case, and started the focused suite.',
      tools: [['run', '{"runtime":"workspace","command":"bun test coupon"}', '7 pass'], ['file', '{"action":"read","path":"0042_coupon_kind.sql"}', '1.8 KB'], ['file', '{"action":"edit","path":"0042_coupon_kind.sql"}', 'saved'], ['agents', '{"action":"swarm","preset":"prove","task":"three independent checks"}', 'settled']],
    },
    migrations: {
      label: 'migrations',
      location: 'local',
      status: 'idle',
      subordinate: null,
      prompt: 'Review the migration plan and identify any destructive step.',
      answer: 'The plan now ships the backfill first, verifies both coupon kinds, then adds the constraint in a later release.',
      tools: [['file', '{"action":"read","path":"migrations/0042.sql"}', '2.1 KB'], ['agents', '{"action":"swarm","preset":"audit","task":"audit migration plan"}', '2 reports'], ['file', '{"action":"edit","path":"MIGRATION.md"}', 'saved']],
    },
    jarvis: {
      label: 'Jarvis',
      location: 'cloud',
      status: 'running',
      subordinate: null,
      prompt: 'Summarize the overnight research and flag the decision I need to make.',
      answer: 'The evidence supports staged rollout. Decide whether the first cohort should be 5% or 10%; the rest is ready.',
      tools: [['web', '{"action":"fetch","url":"https://example.com/rollout-study"}', '3 sources'], ['agents', '{"action":"swarm","preset":"redteam","task":"independent risk review"}', 'settled'], ['report', '{"action":"write","title":"Owner decision"}', 'ready']],
    },
  } as const;

  type AgentId = keyof typeof agents;

  const LOCAL_AGENTS: readonly AgentId[] = ['audit', 'migrations'];
  const CLOUD_AGENTS: readonly AgentId[] = ['jarvis'];
  const [agentId, setAgentId] = useState<AgentId>('audit');
  const [checkoutOpen, setCheckoutOpen] = useState(true);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState('');
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const agent = agents[agentId];
  // The open agent's section never renders collapsed.
  const cloudExpanded = cloudOpen || agentId === 'jarvis';
  const checkoutExpanded = checkoutOpen || agentId !== 'jarvis';

  const closeDrawer = () => {
    setDrawerOpen(false);
    queueMicrotask(() => drawerTriggerRef.current?.focus());
  };

  const chooseAgent = (id: AgentId) => {
    setAgentId(id);
    closeDrawer();
  };

  const filter = drawerFilter.trim().toLowerCase();

  const drawerMatches = (id: AgentId) => (
    `${agents[id].label} ${agents[id].location}`.toLowerCase().includes(filter)
  );

  // NavigatorRow: the selected row carries the `›` marker on the raised ground;
  // the dot says running (accent) or idle (muted), never selection.
  const agentRows = (ids: readonly AgentId[], onChoose: (id: AgentId) => void, filtered: boolean): ReactElement[] => (
    ids.filter((id) => !filtered || drawerMatches(id)).map((id) => (
      <div key={id}>
        <button type="button" onClick={() => onChoose(id)} className={`block w-full whitespace-pre px-2 text-left leading-6 ${id === agentId ? 'p-elevated p-text' : 'p-text-2 hover:p-text'}`}>
          <span className={id === agentId ? 'p-accent' : 'p-text-4'}>{id === agentId ? '› ' : '  '}</span>
          <span className={agents[id].status === 'running' ? 'p-accent' : 'p-text-4'}>{agents[id].status === 'running' ? TUI_MARKS.activity.running : TUI_MARKS.activity.idle} </span>
          {agents[id].label}
        </button>
        {agents[id].subordinate !== null && (
          <div className="whitespace-pre px-2 leading-6 p-text-4"><span className="p-text-4">    └ </span>{agents[id].subordinate}</div>
        )}
      </div>
    ))
  );

  const groupHeader = (label: string, count: number, expanded: boolean, onToggle: () => void) => (
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="block w-full whitespace-pre px-2 text-left leading-6 p-text-2 hover:p-text">
      <span className="p-text-4">{`  ${expanded ? '▾' : '▸'} `}</span><strong className="font-semibold">{label}</strong><span className="p-text-4">{` · ${String(count)}`}</span>
    </button>
  );

  const workspaceGroups = (filtered: boolean, onChoose: (id: AgentId) => void) => (
    <>
      {groupHeader('checkout', LOCAL_AGENTS.length, checkoutExpanded, () => setCheckoutOpen(!checkoutExpanded))}
      {(filtered || checkoutExpanded) && agentRows(LOCAL_AGENTS, onChoose, filtered)}
      {groupHeader('Cloud', CLOUD_AGENTS.length, cloudExpanded, () => setCloudOpen(!cloudExpanded))}
      {(filtered || cloudExpanded) && agentRows(CLOUD_AGENTS, onChoose, filtered)}
    </>
  );

  const hint = TUI_ADVERTISED_HINTS[1];

  return (
    <div data-tui-agent={agentId} aria-label="Kinu terminal interface preview" className="overflow-hidden rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)] font-mono text-xs leading-6 shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]">
      <div className="grid h-10 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--c-border-strong)] p-sidebar px-4 text-[10px] p-text-4">
        <div className="flex gap-2"><span className="size-2 rounded-full bg-[var(--c-danger)] opacity-70" /><span className="size-2 rounded-full bg-[var(--c-warning)] opacity-70" /><span className="size-2 rounded-full bg-[var(--c-success)] opacity-70" /></div>
        <span className="uppercase tracking-[.14em]">kinu tui · {agent.label}</span>
        <span className="justify-self-end uppercase tracking-[.1em]">terminal</span>
      </div>
      {/* status-bar.tsx: name, location, then the model with its key, context and effort. */}
      <div className="flex min-h-8 items-center justify-between gap-4 whitespace-pre px-2 p-text-2">
        <div className="min-w-0 truncate">kinu <span className="p-accent">{TUI_MARKS.prompt}</span> <strong className="font-semibold p-text">{agent.label}</strong> <span className="p-text-4">{agent.location}</span></div>
        <div className="flex items-center gap-3">
          <div className="hidden truncate p-text-4 sm:block">Claude Opus 4 <span className="p-text-4">[Ctrl+L]</span>  ctx ~68/1.1M  effort medium <span className="p-success">●</span></div>
          <button ref={drawerTriggerRef} type="button" aria-expanded={drawerOpen} aria-controls="landing-tui-workspaces" onClick={() => setDrawerOpen((open) => !open)} className="rounded-md border p-border px-2 leading-5 p-text-3 hover:p-text lg:hidden">{hint.keys} {hint.label}</button>
        </div>
      </div>
      <div className="relative flex items-center border-t border-[var(--c-border-strong)] pr-3 text-right"><span className="hidden w-full text-[11px] p-text-4 lg:block">{hint.keys} hide workspaces</span></div>
      <div className="relative grid min-h-[600px] lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Pinned workspaces" className="hidden flex-col border-r border-[var(--c-border-strong)] p-sidebar py-2 lg:flex">
          <div className="px-2"><strong className="font-semibold p-text">Workspaces</strong></div>
          <div className="px-2 p-text-4">3 of 3 · checkout</div>
          <div className="mt-2">{workspaceGroups(false, setAgentId)}</div>
          <div className="mt-auto px-2 leading-5 p-text-4">Create a workspace from a mission.</div>
        </aside>
        {drawerOpen && (
          <>
            <button type="button" tabIndex={-1} aria-label="Close workspace drawer" onClick={closeDrawer} className="absolute inset-0 z-10 bg-black/60" />
            <aside
              id="landing-tui-workspaces"
              role="dialog"
              aria-modal="true"
              aria-label="Workspaces"
              onKeyDown={(event) => { if (event.key === 'Escape') closeDrawer(); }}
              className="absolute inset-y-0 left-0 z-20 w-[240px] border-r border-[var(--c-border-strong)] p-sidebar py-2 shadow-xl lg:hidden"
            >
              <div className="flex items-center justify-between gap-2 px-2">
                <strong className="font-semibold p-text">Workspaces</strong>
                <button type="button" onClick={closeDrawer} aria-label="Close workspaces" className="p-text-4 hover:p-text">Esc close</button>
              </div>
              <input
                autoFocus
                value={drawerFilter}
                onChange={(event) => setDrawerFilter(event.currentTarget.value)}
                aria-label="Filter workspaces"
                placeholder="Filter workspaces…"
                className="mx-2 my-2 w-[calc(100%-1rem)] border p-border bg-[var(--c-input-bg)] px-2 py-1 text-xs p-text outline-none"
              />
              {workspaceGroups(filter !== '', chooseAgent)}
            </aside>
          </>
        )}
        <div className="flex min-h-[600px] min-w-0 flex-col">
          <div className="flex-1 overflow-hidden px-2 py-2 sm:px-3">
            <p className="p-text-4">Connected to {agent.label}. Type a message or /help for commands.</p>
            <div data-tui-role="user" className="mt-6 grid grid-cols-[3ch_minmax(0,1fr)] gap-2">
              <span className="p-accent">{TUI_MARKS.userGutter}</span>
              <p className="p-text">{agent.prompt}</p>
            </div>
            <div className="mt-6 grid grid-cols-[1ch_minmax(0,1fr)] gap-1">
              <span aria-hidden="true" className="border-l p-border" />
              <div className="min-w-0">
                <p className="p-text-3">Agent activity · {agent.tools.length} calls</p>
                {agent.tools.map(([tool, args, result], index) => (
                  <div key={`${tool}-${args}`}>
                    {index > 0 && <p aria-hidden="true" className="overflow-hidden whitespace-nowrap p-text-4">{'┄'.repeat(160)}</p>}
                    <p className="truncate"><span className="p-accent">{TUI_MARKS.toolCall}</span> <span className="p-text">{tool}</span> <span className="p-text-4">{args}</span></p>
                    <p className="pl-[2ch] p-text-4">{TUI_MARKS.toolResult} <span className="p-success">{result}</span></p>
                  </div>
                ))}
              </div>
            </div>
            <div data-tui-role="assistant" className="mt-6">
              <p className="p-text">{agent.answer}</p>
            </div>
          </div>
          <div className="px-2 pb-2 sm:px-3">
            <div className="rounded-md border border-[var(--c-border-strong)] px-3 py-1 p-text-4">{TUI_COMPOSER_PLACEHOLDER}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CliPreview(): ReactElement {
  const { status, copy } = useCopy();
  const [mode, setMode] = useState('run');

  const command = mode === 'run'
    ? 'kinu run workshop "Review this diff. Check the changed paths and report evidence." --mode json'
    : 'kinu exec --workspace workshop --json "Review this diff. Check the changed paths and report evidence."';

  return (
    <div data-cli-mode={mode} aria-label="Kinu command line preview" className="overflow-hidden rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-border p-recessed px-5 py-3">
        <span className="font-mono text-[11px] p-text-4">Example invocation · not a recorded run</span>
        <Tabs tabs={[{ value: 'run', label: 'Terminal' }, { value: 'ci', label: 'CI runner' }]} value={mode} onValueChange={setMode} variant="segmented" activateOnFocus />
      </div>
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0">
          <div className="mb-4 flex items-center justify-between gap-3"><span className="font-mono text-[11px] uppercase tracking-[.1em] p-accent">{mode === 'run' ? 'One task' : 'Non-interactive runner'}</span><Button type="button" variant="ghost" size="sm" aria-label="Copy task command" onClick={() => copy(command)}>{status === 'copied' ? 'Copied' : status === 'failed' ? 'Retry copy' : 'Copy'}</Button></div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.9] p-text"><code>{command}</code></pre>
          <p className="mt-5 text-xs leading-[1.7] p-text-4">Needs a configured workspace, a checkout its executor can reach, and provider credentials.</p>
        </div>
        <div className="border-t p-border pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <h3 className="text-base font-semibold">{mode === 'run' ? 'One task, then exit' : 'Runs without prompts'}</h3>
          <p className="mt-3 text-sm leading-[1.7] p-text-3">{mode === 'run' ? 'kinu run streams one task and exits. Omit the prompt to open chat. Use --mode json for event output; text is the default.' : 'kinu exec runs the same one-shot turn. It denies any device access you did not approve in advance, and --json emits line-delimited events.'}</p>
          <p className="mt-4 text-sm leading-[1.7] p-text-3">Exit 0 means the turn completed with no error and no denied consent. Your own test and deploy steps still decide what merges.</p>
        </div>
      </div>
    </div>
  );
}

export function LandingShowcases(): ReactElement {
  return (
    <div className="landing-shell">
      <section data-showcase="tui" className="border-t p-border py-20 lg:py-24">
        <SectionHead lead="Interactive TUI demo. Select an agent to see its work.">
          Or have them <span className="p-accent">run locally.</span>
        </SectionHead>
        <TuiPreview />
      </section>
      <section id="local" data-showcase="cli" className="border-t p-border py-20 lg:py-24">
        <SectionHead label="02 · Smart CI" lead="Run the agent as a step in your CI pipeline with kinu exec. Your existing tests and pipeline rules still decide what merges.">
          Give CI an agent.
        </SectionHead>
        <CliPreview />
      </section>
    </div>
  );
}
