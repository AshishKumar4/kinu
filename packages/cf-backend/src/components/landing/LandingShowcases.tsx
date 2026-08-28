import { Button, Tabs, type TabsItem } from '@cloudflare/kumo';
import { CHANGE_KIND_GLYPH, TUI_ADVERTISED_HINTS, TUI_COMPOSER_PLACEHOLDER, TUI_MARKS } from '@kinu.run/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { UIMessage } from 'ai';

import { KinuLogo } from '@/components/ui/KinuLogo';
import { MessageView } from '@/components/MessageView';

import { BugFixDemo } from './BugFixDemo';

const RUN_TABS: TabsItem[] = [{ value: 'run', label: 'Run' }, { value: 'supervise', label: 'Supervise' }];

const WORKSPACE_DEMO_MESSAGES: UIMessage[] = [
  {
    id: 'landing-workspace-user',
    role: 'user',
    parts: [{ type: 'text', text: 'Audit the checkout flow, find why the SAVE20 coupon 500s, and fix it. Deploy to staging when green.' }],
  },
  {
    id: 'landing-workspace-agent',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'The coupon path goes through /api/cart/apply. I should reproduce first, then inspect the handler and migration.' },
      { type: 'tool-run', toolCallId: 'landing-run', state: 'output-available', input: { runtime: 'sandbox', command: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: 'HTTP 500' },
      { type: 'tool-execute_tools', toolCallId: 'landing-query', state: 'output-available', input: { code: '// Inspect coupon rows to find the missing kind\nconst rows = await sql`SELECT code, kind, value FROM coupons`;\nreturn rows;' }, output: '[{"code":"SAVE20","kind":null,"value":20}]' },
      { type: 'text', text: "Tuesday's migration backfilled `kind` for fixed coupons only. I will patch the migration, add a regression test, and run the focused suite." },
      { type: 'tool-file', toolCallId: 'landing-read', state: 'output-available', input: { action: 'read', path: 'packages/checkout/migrations/0042_coupon_kind.sql' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-edit', state: 'output-available', input: { action: 'edit', path: 'packages/checkout/migrations/0042_coupon_kind.sql', edits: [{}, {}] }, output: { error: 'old_text not found or not unique' } },
      { type: 'tool-file', toolCallId: 'landing-write', state: 'output-available', input: { action: 'write', path: 'packages/checkout/tests/coupon-kind.test.ts' }, output: 'ok' },
      { type: 'tool-tasks', toolCallId: 'landing-task', state: 'output-available', input: { action: 'update', id: 't4', status: 'done' }, output: 'ok' },
    ],
  },
];

function WorkspacePreview(): ReactElement {
  const [altitude, setAltitude] = useState('run');
  const [decision, setDecision] = useState<'pending' | 'retried' | 'dismissed'>('pending');
  return (
    <div data-workspace-mode={altitude} aria-label="Kinu workspace interface preview" className="relative overflow-hidden rounded-2xl border p-border bg-[var(--c-bg)] shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]">
      <div className="flex min-h-[46px] flex-wrap items-center justify-between gap-3 border-b p-border p-recessed px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <KinuLogo compact />
          <span className="h-4 w-px p-fill" />
          <span className="text-[13px] font-semibold p-text">Jarvis</span>
          <span className="inline-flex items-center gap-1.5 text-[11.5px] p-text-4"><span className="size-[5px] rounded-full p-dot-accent" />Live</span>
          <span className="hidden text-[11.5px] p-text-4 sm:inline">deepseek-v4-pro</span>
        </div>
        <Tabs
          tabs={RUN_TABS}
          value={altitude}
          onValueChange={setAltitude}
          variant="segmented"
          activateOnFocus
          className="landing-tabs shrink-0 [&>div:first-child]:!h-9 [&>div:first-child]:!rounded-full [&>div:first-child]:!bg-[var(--c-fill)] [&_[role=tab]]:!my-0 [&_[role=tab]]:!h-[30px] [&_[role=tab]]:!rounded-full"
          listClassName="!h-9 !rounded-full !border !border-[var(--c-border-strong)] !bg-[var(--c-fill)] !p-[3px] !ring-0"
          indicatorClassName="!rounded-full !bg-[var(--c-accent)] !shadow-none !ring-0"
        />
      </div>
      <div className="grid min-h-[760px] grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px] lg:grid-cols-[190px_minmax(0,1fr)_330px]">
        <aside className="hidden border-r p-border p-recessed px-3 py-3.5 lg:block">
          <div className="px-2 pb-2.5 text-[11px] p-text-4">Workspaces</div>
          <div className="flex items-center gap-2 rounded-lg p-card-active px-2.5 py-2">
            <span className="size-[5px] rounded-full p-dot-accent" /><span className="flex-1 text-[12.5px] font-semibold">Jarvis</span><span className="text-[10.5px] p-text-4">4h</span>
          </div>
          <div className="ml-[18px] mt-0.5 border-l p-border pl-[9px]">
            <div className="flex justify-between px-2 py-1.5 text-xs"><span>Scout</span><span className="text-[10px] p-text-4">research</span></div>
            <div className="flex justify-between px-2 py-1.5 text-xs"><span>Sentry</span><span className="text-[10px] p-text-4">PR review</span></div>
          </div>
          <div className="mt-1.5 flex items-center gap-2 px-2.5 py-2 text-[12.5px] p-text-3"><span className="size-[5px] rounded-full p-fill" />checkout-svc</div>
        </aside>
        <div className="flex min-w-0 flex-col border-r p-border">
          <div className="flex h-10 shrink-0 items-end gap-1 border-b p-border p-recessed px-3">
            <span className="border-b-2 border-[var(--c-accent)] px-3 py-2 text-[11.5px] font-semibold p-text">Main</span>
            <span className="px-3 py-2 text-[11.5px] p-text-4">Coupon tester</span>
            <span className="px-3 py-2 text-[11.5px] p-text-4">Migration review</span>
          </div>
          <div data-workspace-panel={altitude} className="flex flex-1 flex-col gap-3.5 overflow-hidden px-4 py-5 sm:px-6">
            {altitude === 'run' ? (
              <div className="space-y-5">
                {WORKSPACE_DEMO_MESSAGES.map((message, index) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    isLast={index === WORKSPACE_DEMO_MESSAGES.length - 1}
                    isStreaming={false}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4"><div><div className="text-[11px] uppercase tracking-[.14em] p-gold">Supervise</div><h3 className="mt-1.5 text-lg font-semibold p-text">Three agents are working</h3></div><span className="rounded-full p-accent-subtle px-3 py-1 text-[11px] p-gold">2 active · 1 waiting</span></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[['Scout', 'Researching the hot path', '3 sources', 'active'], ['Builder', 'Editing the one-pass dedupe', 'src/dedupe.ts', 'active'], ['Verifier', 'Waiting for Builder', 'bun test summary', 'waiting']].map(([name, task, detail, state]) => (
                    <div key={name} className="rounded-xl border p-border p-surface p-4">
                      <div className="mb-3 flex items-center justify-between gap-3"><strong className="text-[13px] p-text">{name}</strong><span className={`text-[10px] uppercase tracking-[.1em] ${state === 'active' ? 'p-success' : 'p-warning'}`}>{state}</span></div>
                      <p className="text-[12.5px] leading-[1.55] p-text-2">{task}</p><code className="mt-2 block truncate text-[10.5px] p-text-4">{detail}</code>
                    </div>
                  ))}
                </div>
                <div className="mt-1 rounded-xl border p-border p-recessed p-4"><div className="mb-3 flex justify-between text-[11px] p-text-4"><span>Branch progress</span><span>2 of 3 settled</span></div><div className="h-1.5 overflow-hidden rounded-full p-fill"><span className="block h-full w-2/3 rounded-full p-dot-accent" /></div><p className="mt-3 text-[12.5px] leading-[1.55] p-text-3">Builder's patch will wake Verifier automatically. The best measured result returns to this conversation.</p></div>
              </>
            )}
          </div>
          <div className="border-t p-border p-recessed px-4 py-3">
            <div className="flex items-center gap-2.5 rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)] px-3.5 py-2.5">
              <span className="flex-1 text-[13px] p-text-4">Send a message…</span>
              <span className="rounded-full border p-border px-2.5 py-0.5 text-[11.5px] p-text-4">Auto</span>
              <span className="rounded-full p-btn px-3 py-1 text-[11.5px] font-semibold">Send</span>
            </div>
          </div>
        </div>
        <aside className="hidden min-w-0 flex-col p-recessed md:flex">
          <div className="flex gap-2.5 overflow-hidden border-b p-border px-3.5 pt-3">
            <span className="border-b-2 border-[var(--c-accent)] pb-2.5 text-[11.5px] font-semibold p-gold">Work</span>
            {['Exploration', 'Agent', 'Files'].map((tab) => <span key={tab} className="pb-2.5 text-[11.5px] p-text-4">{tab}</span>)}
          </div>
          <div className="flex flex-col gap-3.5 overflow-hidden p-3.5">
            <div data-decision-state={decision} className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_30%,transparent)] p-surface">
              {decision === 'pending' ? (
                <>
                  <div className="border-b border-dashed border-[var(--c-dash)] px-3.5 py-2 text-[11.5px] font-semibold p-gold">Needs you · 1</div>
                  <div className="px-3.5 py-3"><div className="mb-2 text-[12.5px]">Swarm search stopped early</div><div className="flex gap-2 text-[11px]"><button type="button" onClick={() => setDecision('retried')} className="rounded-full border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] px-2.5 py-0.5 p-gold">Retry</button><button type="button" onClick={() => setDecision('dismissed')} className="rounded-full border p-border px-2.5 py-0.5 p-text-4">Dismiss</button></div></div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3 px-3.5 py-3"><span className={`text-[11.5px] ${decision === 'retried' ? 'p-success' : 'p-text-4'}`}>{decision === 'retried' ? 'Search restarted' : 'Decision dismissed'}</span><button type="button" onClick={() => setDecision('pending')} className="text-[10.5px] p-gold">Reset</button></div>
              )}
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-semibold p-text-4">Now · 2 active</div>
              <div className="overflow-hidden rounded-xl border p-border p-surface">
                <div className="flex items-start gap-2.5 px-3.5 py-2.5"><span className="mt-1 size-2 rounded-full p-dot-accent" /><span className="flex-1 text-xs p-text-2">Patch the slow dedupe path</span></div>
                <div className="flex items-start gap-2.5 border-t border-dashed border-[var(--c-dash)] px-3.5 py-2.5"><span className="mt-1 size-2 rounded-full p-dot-success" /><span className="flex-1 text-xs p-text-2">Add the regression case</span></div>
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-semibold p-text-4">Journal</div>
              <div className="overflow-hidden rounded-xl border p-border p-surface">
                {[[CHANGE_KIND_GLYPH.tool, 'Crafted a tool: dedupe-bench', '2m'], [CHANGE_KIND_GLYPH.outcomes, 'Graded 2 turns', '18h'], [CHANGE_KIND_GLYPH.fact, 'Remembered the coupon schema', '19h']].map(([icon, label, age], index) => (
                  <div key={label} className={`flex items-baseline gap-2 px-3.5 py-2.5 ${index < 2 ? 'border-b border-dashed border-[var(--c-dash)]' : ''}`}><span className="text-[10px] p-gold">{icon}</span><span className="flex-1 text-xs p-text-2">{label}</span><span className="text-[10px] p-text-4">{age}</span></div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] p-text-4"><span>612 MB</span><span className="h-1 flex-1 overflow-hidden rounded-full p-fill"><span className="block h-full w-[6%] p-dot-accent" /></span><span>10 GB</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
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
      tools: [['run · workspace', 'bun test coupon', '7 pass'], ['file', 'read 0042_coupon_kind.sql', '1.8 KB'], ['file', 'edit 0042_coupon_kind.sql', 'saved'], ['agents', 'three independent checks', 'settled']],
    },
    migrations: {
      label: 'migrations',
      location: 'local',
      status: 'idle',
      subordinate: null,
      prompt: 'Review the migration plan and identify any destructive step.',
      answer: 'The plan now ships the backfill first, verifies both coupon kinds, then adds the constraint in a later release.',
      tools: [['file', 'read migrations/0042.sql', '2.1 KB'], ['agents', 'audit migration plan', '2 reports'], ['file', 'edit MIGRATION.md', 'saved']],
    },
    jarvis: {
      label: 'Jarvis',
      location: 'cloud',
      status: 'running',
      subordinate: null,
      prompt: 'Summarize the overnight research and flag the decision I need to make.',
      answer: 'The evidence supports staged rollout. Decide whether the first cohort should be 5% or 10%; the rest is ready.',
      tools: [['web', 'compare three primary sources', '3 sources'], ['agents', 'independent risk review', 'settled'], ['report', 'prepare owner decision', 'ready']],
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
          <span><span className={agents[id].status === 'running' ? 'p-gold' : 'p-text-4'}>{agents[id].status === 'running' ? TUI_MARKS.activity.running : TUI_MARKS.activity.idle} </span>{agents[id].label}</span>
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
        <span className="uppercase tracking-[.14em]">kinu tui — {agent.label}</span>
        <span className="justify-self-end uppercase tracking-[.1em]">terminal</span>
      </div>
      <div className="flex min-h-12 items-center justify-between gap-4 border-b border-[var(--c-border-strong)] p-recessed px-4 py-2 font-mono text-[11px] uppercase tracking-[.06em] p-text-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3.5">
          <KinuLogo compact />
          <span>{agent.label}</span>
          <span className="inline-flex items-center gap-2 p-gold"><span className="size-1.5 rounded-full p-dot-accent" />connected</span>
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
            </aside>
          </>
        )}
        <div className="flex min-h-[600px] min-w-0 flex-col font-mono text-xs leading-[1.65]">
          <div className="flex-1 overflow-hidden px-4 py-5 sm:px-7 sm:py-6">
            <div data-tui-role="user" className="mb-5 grid grid-cols-[52px_minmax(0,1fr)] gap-3">
              <span className="text-[10px] uppercase tracking-[.12em] p-gold">{TUI_MARKS.userGutter}</span>
              <p className="p-text">{agent.prompt}</p>
            </div>
            <div className="border-y border-[var(--c-border-strong)]">
              {agent.tools.map(([tool, action, result], index) => (
                <div key={`${tool}-${action}`} className={index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}>
                  <div className="grid grid-cols-[14px_120px_minmax(0,1fr)] gap-3 px-1 pb-1 pt-2.5 sm:grid-cols-[14px_150px_minmax(0,1fr)]">
                    <span className="p-gold">{TUI_MARKS.toolCall}</span><strong className="font-normal p-text-2">{tool}</strong><span className="truncate p-text-4">{action}</span>
                  </div>
                  <div className="pb-2.5 pl-[17px] p-text-4">{TUI_MARKS.toolResult} <span className="p-success">{result}</span></div>
                </div>
              ))}
            </div>
            <div data-tui-role="assistant" className="mt-5 px-1">
              <p className="font-sans text-[13.5px] leading-[1.65] p-text">{agent.answer}</p>
            </div>
          </div>
          <div className="border-t border-[var(--c-border-strong)] p-recessed px-4 pb-3 pt-3">
            <div className="border border-[var(--c-border-strong)] bg-[var(--c-bg)] px-3 py-2.5 p-text-4"><span className="mr-2 p-gold">{TUI_MARKS.prompt}</span>{TUI_COMPOSER_PLACEHOLDER}</div>
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
    `grid grid-cols-[16px_minmax(0,1fr)_auto] gap-3 py-2 transition-all duration-300 ${visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`
  );
  return (
    <div data-cli-stage={stage} aria-label="Kinu command line preview" className="overflow-hidden rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)] font-mono text-xs shadow-[0_30px_90px_-50px_rgba(0,0,0,.8)]">
      <div className="flex h-11 items-center gap-2 border-b border-[var(--c-border-strong)] p-recessed px-4">
        <span className="size-2 rounded-full bg-[var(--c-danger)] opacity-70" />
        <span className="size-2 rounded-full bg-[var(--c-warning)] opacity-70" />
        <span className="size-2 rounded-full bg-[var(--c-success)] opacity-70" />
        <span className="ml-3 flex-1 text-center text-[10px] uppercase tracking-[.14em] p-text-4">kinu run · checkout</span>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase tracking-[.12em] ${stage < 4 ? 'p-gold' : 'p-success'}`}>{stage < 4 ? 'running' : 'exit 0'}</span>
          <Button type="button" size="sm" variant="ghost" aria-label="Replay CLI run" onClick={() => { setStage(0); setSequence((value) => value + 1); }} className="!h-7 !rounded-full !px-2.5 !text-[10px]">Replay</Button>
        </div>
      </div>
      <div className="min-h-[360px] p-5 sm:p-7">
        <div className="mb-6 p-text"><span className="mr-2 p-gold">$</span>kinu run checkout “Audit the coupon flow and fix it.”<span className={`ml-1 inline-block h-[1em] w-[7px] bg-[var(--c-accent)] ${stage === 0 ? 'motion-safe:animate-pulse' : 'opacity-0'}`} /></div>
        <div className="border-y border-[var(--c-border-strong)] px-1">
          <div className={lineClass(stage >= 1)}><span className="p-gold">›</span><span className="p-text-3">run · workspace &nbsp; reproduce coupon failure</span><span className="p-danger">exit 1</span></div>
          <div className={`${lineClass(stage >= 2)} border-t border-dashed border-[var(--c-dash)]`}><span className="p-gold">›</span><span className="p-text-3">file &nbsp; edit migration and handler</span><span className="p-success">saved</span></div>
          <div className={`${lineClass(stage >= 3)} border-t border-dashed border-[var(--c-dash)]`}><span className="p-gold">›</span><span className="p-text-3">run · workspace &nbsp; bun test coupon</span><span className="p-success">7 pass</span></div>
        </div>
        <div className={`mt-6 grid grid-cols-[52px_minmax(0,1fr)] gap-3 transition-all duration-300 ${stage >= 4 ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}>
          <span className="text-[10px] uppercase tracking-[.12em] p-gold">result</span>
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
          <h2 className="mb-3 text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Have your agents <span className="p-gold">live in the cloud.</span></h2>
          <p className="mx-auto max-w-[700px] text-base leading-[1.65] p-text-3">Each workspace keeps durable files, memory, and one conversation per agent. Attach isolated Linux for heavier work, or connect your own machine.</p>
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
          <div><div className="mb-3.5 flex items-center gap-3 text-[13px] font-semibold p-gold"><span className="h-px w-[22px] bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />One bug, end to end</div><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">From bug report <span className="p-gold">to green tests.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3">A replay of one workspace session. Kinu reproduces a coupon failure, you annotate and approve its plan, three candidate patches race, and the focused suite picks the winner.</p>
        </div>
        <BugFixDemo />
      </section>
      <section data-showcase="tui" className="pt-24">
        <div className="mb-9 grid items-end gap-6 md:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] md:gap-[52px]">
          <div><div className="mb-3.5 flex items-center gap-3 text-[13px] font-semibold p-gold"><span className="h-px w-[22px] bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />The terminal</div><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Let your agents live <span className="p-gold">locally.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3">Create local workspaces in the full-featured TUI, or connect to cloud workspaces from your favorite terminal.</p>
        </div>
        <TuiPreview />
      </section>
      <section data-showcase="cli" className="py-24">
        <div className="mb-9 grid items-end gap-6 md:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] md:gap-[52px]">
          <div><div className="mb-3.5 flex items-center gap-3 text-[13px] font-semibold p-gold"><span className="h-px w-[22px] bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />The CLI</div><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Automate focused work <span className="p-gold">from any shell.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3">Use <code className="font-mono text-[.9em] p-text-2">kinu run</code> for one-shot tasks in scripts and CI. It streams tool activity, returns the final answer, and exits with the run status.</p>
        </div>
        <CliPreview />
      </section>
    </div>
  );
}
