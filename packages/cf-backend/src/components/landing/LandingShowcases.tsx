import { Button } from '@cloudflare/kumo';
import { TUI_ADVERTISED_HINTS, TUI_COMPOSER_PLACEHOLDER, TUI_MARKS } from '@kinu.run/core';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { KinuLogo } from '@/components/ui/KinuLogo';

import { BugFixDemo } from './BugFixDemo';
import { WorkspacePreview } from './WorkspacePreview';

export function RuleLabel({ children }: { children: ReactNode }): ReactElement {
  return <div className="mb-4 flex items-center gap-3 text-[13px] font-semibold p-accent"><span className="h-px w-[22px] shrink-0 bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />{children}</div>;
}


function TuiPreview(): ReactElement {
  // `status` carries the real navigator's semantics (tui-shell NavigatorRow):
  // the dot marks RUNNING vs IDLE in accent vs muted ink — selection is the
  // left border and raised background, never the dot.
  const agents = {
    audit: {
      label: 'audit',
      location: 'local',
      status: 'idle',
      subordinate: 'reviewer · auditor',
      prompt: 'Audit the checkout flow, fix the coupon failure, and keep the tests green.',
      answer: 'The migration only filled fixed coupons. I patched the backfill, added the percentage case, and started the focused suite.',
      tools: [
        ['run · workspace', 'bun test coupon', '7 pass', 'coupon-kind.test.ts\n✓ fixed coupon kind\n✓ percent coupon kind\n✓ missing catalog row refused\n7 pass · 0 fail'],
        ['file', 'read 0042_coupon_kind.sql', '1.8 KB', 'The old backfill only handles fixed coupons.\nSAVE20 still has kind = NULL.'],
        ['file', 'edit 0042_coupon_kind.sql', 'saved', 'Backfill kind from coupon_catalog by coupon code.\nRefuse rows with no catalog entry.'],
        ['agents', 'three independent checks', 'settled', 'The focused suite rejects two candidates.\nThe catalog backfill with a missing-row check passes all seven cases.'],
      ],
    },
    migrations: {
      label: 'migrations',
      location: 'local',
      status: 'idle',
      subordinate: null,
      prompt: 'Review the migration plan and identify any destructive step.',
      answer: 'The plan now ships the backfill first, verifies both coupon kinds, then adds the constraint in a later release.',
      tools: [
        ['file', 'read migrations/0042.sql', '2.1 KB', 'Backfill first. Verify both coupon kinds before adding the constraint.'],
        ['agents', 'audit migration plan', '2 reports', 'Data review: preserve catalog kinds.\nRelease review: add the constraint after the backfill is verified.'],
        ['file', 'edit MIGRATION.md', 'saved', '1. Backfill from the catalog.\n2. Verify fixed and percent coupons.\n3. Add the constraint in a later release.'],
      ],
    },
    jarvis: {
      label: 'Jarvis',
      location: 'cloud',
      status: 'running',
      subordinate: null,
      prompt: 'Summarize the overnight research and flag the decision I need to make.',
      answer: 'The evidence supports staged rollout. Decide whether the first cohort should be 5% or 10%; the rest is ready.',
      tools: [
        ['web', 'compare three primary sources', '3 sources', 'The source comparison supports a staged rollout rather than a full release.'],
        ['agents', 'independent risk review', 'settled', 'Keep the initial cohort small. Observe failures before widening it.'],
        ['report', 'prepare owner decision', 'ready', 'Decision needed: start with 5% or 10%.\nThe remaining rollout steps are ready.'],
      ],
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
  const selectClass = (id: AgentId): string => (
    id === agentId
      ? 'border-l-2 border-[var(--c-accent)] p-elevated p-text'
      : 'border-l-2 border-transparent p-text-3 hover:p-text'
  );
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
  const agentRows = (ids: readonly AgentId[], onChoose: (id: AgentId) => void, filtered: boolean): ReactElement[] => (
    ids.filter((id) => !filtered || drawerMatches(id)).map((id) => (
      <div key={id}>
        <button type="button" onClick={() => onChoose(id)} className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs ${selectClass(id)}`}>
          <span><span className={agents[id].status === 'running' ? 'p-accent' : 'p-text-4'}>{agents[id].status === 'running' ? TUI_MARKS.activity.running : TUI_MARKS.activity.idle} </span>{agents[id].label}</span>
          {agents[id].location === 'cloud' && <span className="p-success">live</span>}
        </button>
        {agents[id].subordinate !== null && (
          <div className="ml-7 border-l p-border pl-2 text-[10px] leading-6 p-text-4">└ {agents[id].subordinate}</div>
        )}
      </div>
    ))
  );
  const groupHeader = (label: string, count: number, expanded: boolean, onToggle: () => void) => (
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="block w-full px-2 py-2 text-left text-[10px] uppercase tracking-[.16em] p-text-4 hover:p-text">
      {`${expanded ? '▾' : '▸'} ${label} · ${count}`}
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
  return (
    <div data-tui-agent={agentId} aria-label="Kinu terminal interface preview" className="overflow-hidden rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)] shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]">
      <div className="grid h-10 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--c-border-strong)] p-sidebar px-4 font-mono text-[10px] p-text-4">
        <div className="flex gap-2"><span className="size-2 rounded-full bg-[var(--c-danger)] opacity-70" /><span className="size-2 rounded-full bg-[var(--c-warning)] opacity-70" /><span className="size-2 rounded-full bg-[var(--c-success)] opacity-70" /></div>
        <span className="uppercase tracking-[.14em]">kinu tui · {agent.label}</span>
        <span className="justify-self-end uppercase tracking-[.1em]">terminal</span>
      </div>
      <div className="flex min-h-12 items-center justify-between gap-4 border-b border-[var(--c-border-strong)] p-recessed px-4 py-2 font-mono text-[11px] uppercase tracking-[.06em] p-text-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3.5">
          <KinuLogo compact />
          <span>{agent.label}</span>
          <span className="inline-flex items-center gap-2 p-accent"><span className="size-1.5 rounded-full p-dot-accent" />connected</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-4 sm:flex"><span>{agent.location}</span><span>general · default</span><span>Claude Opus 4</span></div>
          <button ref={drawerTriggerRef} type="button" aria-expanded={drawerOpen} aria-controls="landing-tui-workspaces" onClick={() => setDrawerOpen((open) => !open)} className="rounded-md border p-border px-2 py-1 p-text-3 hover:p-text lg:hidden">{TUI_ADVERTISED_HINTS[1].keys} {TUI_ADVERTISED_HINTS[1].label}</button>
        </div>
      </div>
      <div className="relative grid min-h-[600px] lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Pinned workspaces" className="hidden border-r border-[var(--c-border-strong)] bg-[var(--c-bg)] px-3 py-4 font-mono lg:block">
          <div className="mb-3 px-2 text-[10px] uppercase tracking-[.16em] p-text-4">Workspaces · 3 of 3</div>
          {workspaceGroups(false, setAgentId)}
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
              className="absolute inset-y-0 left-0 z-20 w-[220px] border-r border-[var(--c-border-strong)] bg-[var(--c-bg)] px-3 py-4 font-mono shadow-xl lg:hidden"
            >
              <div className="mb-3 flex items-center justify-between gap-2 px-2">
                <span className="text-[10px] uppercase tracking-[.16em] p-text-4">Workspaces</span>
                <button type="button" onClick={closeDrawer} aria-label="Close workspaces" className="p-text-4 hover:p-text">Esc</button>
              </div>
              <input
                autoFocus
                value={drawerFilter}
                onChange={(event) => setDrawerFilter(event.currentTarget.value)}
                aria-label="Filter workspaces"
                placeholder="Filter workspaces…"
                className="mb-4 w-full border p-border bg-[var(--c-input-bg)] px-2 py-1.5 text-xs p-text outline-none"
              />
              {workspaceGroups(filter !== '', chooseAgent)}
              {filter !== '' && !LOCAL_AGENTS.some(drawerMatches) && !CLOUD_AGENTS.some(drawerMatches) && <p className="px-2 text-xs p-text-3">No workspaces match this filter.</p>}
            </aside>
          </>
        )}
        <div className="flex min-h-[600px] min-w-0 flex-col font-mono text-xs leading-[1.65]">
          <div className="flex-1 overflow-hidden px-4 py-5 sm:px-7 sm:py-6">
            <div data-tui-role="user" className="mb-5 grid grid-cols-[52px_minmax(0,1fr)] gap-3">
              <span className="text-[10px] uppercase tracking-[.12em] p-accent">{TUI_MARKS.userGutter}</span>
              <p className="p-text">{agent.prompt}</p>
            </div>
            <div className="border-y border-[var(--c-border-strong)]">
              {agent.tools.map(([tool, action, result, output], index) => (
                <details key={`${tool}-${action}`} className={index > 0 ? 'group border-t border-dashed border-[var(--c-dash)]' : 'group'}>
                  <summary className="cursor-pointer list-none">
                  <div className="grid grid-cols-[14px_120px_minmax(0,1fr)] gap-3 px-1 pb-1 pt-2.5 sm:grid-cols-[14px_150px_minmax(0,1fr)]">
                    <span className="p-accent transition-transform group-open:rotate-90 motion-reduce:transition-none">{TUI_MARKS.toolCall}</span><strong className="font-normal p-text-2">{tool}</strong><span className="truncate p-text-4">{action}</span>
                  </div>
                  <div className="pb-2.5 pl-[17px] p-text-4">{TUI_MARKS.toolResult} <span className="p-success">{result}</span></div>
                  </summary>
                  <pre className="mb-3 ml-[17px] whitespace-pre-wrap break-words border-l p-border pl-3 text-[11px] leading-relaxed p-text-2">{output}</pre>
                </details>
              ))}
            </div>
            <div data-tui-role="assistant" className="mt-5 px-1">
              <p className="font-sans text-[13.5px] leading-[1.65] p-text">{agent.answer}</p>
            </div>
          </div>
          <div className="border-t border-[var(--c-border-strong)] p-recessed px-4 pb-3 pt-3">
            <div className="border border-[var(--c-border-strong)] bg-[var(--c-bg)] px-3 py-2.5 p-text-4"><span className="mr-2 p-accent">{TUI_MARKS.prompt}</span>{TUI_COMPOSER_PLACEHOLDER}</div>
            <div className="mt-2 flex flex-wrap justify-between gap-3 text-[10px] p-text-4"><span>auto · {agent.location} workspace · connected</span><span>{TUI_ADVERTISED_HINTS.map(({ keys, label }) => `${keys} ${label}`).join(' · ')}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
function CliPreview(): ReactElement {
  const [stage, setStage] = useState(0);
  const [sequence, setSequence] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStage(4);
      return;
    }
    const timers = [650, 1_250, 1_900, 2_600].map((delay, index) => (
      window.setTimeout(() => setStage(index + 1), delay)
    ));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sequence]);

  const lineClass = (visible: boolean): string => (
    `grid cursor-pointer list-none grid-cols-[16px_minmax(0,1fr)_auto] gap-3 py-2 transition-all duration-300 motion-reduce:transition-none ${visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`
  );
  return (
    <div data-cli-stage={stage} aria-label="Kinu command line preview" className="overflow-hidden rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)] font-mono text-xs shadow-[0_30px_90px_-50px_rgba(0,0,0,.8)]">
      <div className="flex h-11 items-center gap-2 border-b border-[var(--c-border-strong)] p-recessed px-4">
        <span className="size-2 rounded-full bg-[var(--c-danger)] opacity-70" />
        <span className="size-2 rounded-full bg-[var(--c-warning)] opacity-70" />
        <span className="size-2 rounded-full bg-[var(--c-success)] opacity-70" />
        <span className="ml-3 flex-1 text-center text-[10px] uppercase tracking-[.14em] p-text-4">kinu run · checkout</span>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase tracking-[.12em] ${stage < 4 ? 'p-accent' : 'p-success'}`}>{stage < 4 ? 'running' : 'exit 0'}</span>
          <Button type="button" size="sm" variant="ghost" aria-label="Replay CLI run" onClick={() => { setStage(0); setSequence((value) => value + 1); }} className="!h-7 !rounded-full !px-2.5 !text-[10px]">Replay</Button>
        </div>
      </div>
      <div className="min-h-[360px] p-5 sm:p-7">
        <div className="mb-6 p-text"><span className="mr-2 p-accent">$</span>kinu run checkout “Audit the coupon flow and fix it.”<span className={`ml-1 inline-block h-[1em] w-[7px] bg-[var(--c-accent)] ${stage === 0 ? 'motion-safe:animate-pulse' : 'opacity-0'}`} /></div>
        <div key={sequence} className="border-y border-[var(--c-border-strong)] px-1">
          <details inert={stage < 1}><summary className={lineClass(stage >= 1)}><span className="p-accent">›</span><span className="p-text-3">run · workspace &nbsp; reproduce coupon failure</span><span className="p-danger">exit 1</span></summary><pre className="mb-3 ml-7 whitespace-pre-wrap break-words border-l p-border pl-3 text-[11px] p-text-2">{'POST /api/cart/apply · SAVE20\nHTTP 500\nCoupon kind is NULL after migration 0042.'}</pre></details>
          <details inert={stage < 2} className="border-t border-dashed border-[var(--c-dash)]"><summary className={lineClass(stage >= 2)}><span className="p-accent">›</span><span className="p-text-3">file &nbsp; edit migration and handler</span><span className="p-success">saved</span></summary><pre className="mb-3 ml-7 whitespace-pre-wrap break-words border-l p-border pl-3 text-[11px] p-text-2">{'Read coupon_catalog by code.\nBackfill both coupon kinds.\nRefuse a missing catalog row instead of guessing.'}</pre></details>
          <details inert={stage < 3} className="border-t border-dashed border-[var(--c-dash)]"><summary className={lineClass(stage >= 3)}><span className="p-accent">›</span><span className="p-text-3">run · workspace &nbsp; bun test coupon</span><span className="p-success">7 pass</span></summary><pre className="mb-3 ml-7 whitespace-pre-wrap break-words border-l p-border pl-3 text-[11px] p-text-2">{'✓ percent kind\n✓ fixed kind\n✓ missing catalog row refused\n7 pass · 0 fail'}</pre></details>
        </div>
        <div className={`mt-6 grid grid-cols-[52px_minmax(0,1fr)] gap-3 transition-all duration-300 motion-reduce:transition-none ${stage >= 4 ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}>
          <span className="text-[10px] uppercase tracking-[.12em] p-accent">result</span>
          <p className="font-sans text-sm leading-[1.65] p-text">The percentage-coupon path is fixed. The migration now fills both coupon kinds, and all seven focused tests pass.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--c-border-strong)] p-recessed px-5 py-3 text-[10px] p-text-4"><span>one-shot run · final answer on stdout</span><span>also: kinu chat · kinu acp</span></div>
    </div>
  );
}

export function LandingShowcases({
  storageGb,
  sandboxVcpu,
  sandboxMemoryGb,
  sandboxDiskGb,
}: {
  readonly storageGb: number;
  readonly sandboxVcpu: number;
  readonly sandboxMemoryGb: number;
  readonly sandboxDiskGb: number;
}): ReactElement {
  return (
    <div className="landing-shell">
      <section data-showcase="workspace" className="pt-24">
        <div className="mx-auto mb-11 max-w-[760px] text-center">
          <h2 className="mb-3 text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Have your agents <span className="p-accent">live in the cloud.</span></h2>
          <p className="mx-auto max-w-[700px] text-base leading-[1.65] p-text-3">Each workspace keeps files, memory, and one conversation per agent. Attach Linux or your own machine.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2 font-mono text-[10.5px] p-text-3">
            <span className="rounded-full border p-border p-recessed px-3 py-1.5">{String(storageGb)} GB durable workspace</span>
            <span className="rounded-full border p-border p-recessed px-3 py-1.5">{String(sandboxVcpu)} vCPU · {String(sandboxMemoryGb)} GB RAM · {String(sandboxDiskGb)} GB disk sandbox</span>
            <span className="rounded-full border p-border p-recessed px-3 py-1.5">Secure device connection</span>
          </div>
        </div>
        <WorkspacePreview />
      </section>
      <section data-showcase="bugfix" className="pt-24">
        <div className="mb-9 grid items-end gap-6 md:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] md:gap-[52px]">
          <div><RuleLabel>One bug, end to end</RuleLabel><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">From bug report <span className="p-accent">to green tests.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3">Watch Kinu reproduce a failure, revise its plan, compare three patches, and run the focused suite.</p>
        </div>
        <BugFixDemo />
      </section>
      <section data-showcase="tui" className="pt-24">
        <div className="mb-9 grid items-end gap-6 md:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] md:gap-[52px]">
          <div><RuleLabel>The terminal</RuleLabel><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Let your agents live <span className="p-accent">locally.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3">Create local workspaces or open cloud workspaces from your terminal.</p>
        </div>
        <TuiPreview />
      </section>
      <section data-showcase="cli" className="py-24">
        <div className="mb-9 grid items-end gap-6 md:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] md:gap-[52px]">
          <div><RuleLabel>The CLI</RuleLabel><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Automate focused work <span className="p-accent">from any shell.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3"><code className="font-mono text-[.9em] p-text-2">kinu run</code> streams one task for scripts or CI, returns the answer, then exits with its status.</p>
        </div>
        <CliPreview />
      </section>
    </div>
  );
}
