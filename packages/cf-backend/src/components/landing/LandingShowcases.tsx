import { Tabs, type TabsItem } from '@cloudflare/kumo';
import { useState, type ReactElement } from 'react';

import { KinuLogo } from '@/components/ui/KinuLogo';

const RUN_TABS: TabsItem[] = [{ value: 'run', label: 'Run' }, { value: 'supervise', label: 'Supervise' }];

function WorkspacePreview(): ReactElement {
  const [altitude, setAltitude] = useState('run');
  return (
    <div aria-label="Kinu workspace interface preview" className="relative overflow-hidden rounded-2xl border p-border bg-[var(--c-bg)] shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]">
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
          className="shrink-0 [&>div:first-child]:!h-8 [&>div:first-child]:!rounded-full [&>div:first-child]:!bg-[var(--c-fill)]"
          listClassName="!h-8 !rounded-full !border !border-[var(--c-border)] !bg-[var(--c-fill)] !p-[3px] !ring-0"
          indicatorClassName="!rounded-full !bg-[var(--c-accent)] !shadow-none !ring-0"
        />
      </div>
      <div className="grid min-h-[452px] grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] lg:grid-cols-[172px_minmax(0,1fr)_300px]">
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
          <div className="flex flex-1 flex-col gap-3.5 overflow-hidden px-4 py-5 sm:px-6">
            <div className="max-w-[76%] self-end rounded-xl border p-user-bubble px-3.5 py-2.5 text-[13px] leading-[1.55]">Find the slowest test in this repo and explain why.</div>
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 text-xs p-text-4">
              <span>▸</span><code className="p-text-2">run · laptop</code><code className="truncate">time bun test</code><span className="p-success">7 pass · 912 ms</span>
            </div>
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 text-xs p-text-4">
              <span>▸</span><code className="p-text-2">agents · swarm</code><code className="truncate">optimise · 3 branches</code><span className="p-gold">detached</span>
            </div>
            <p className="text-[13.5px] leading-[1.65] p-text"><strong>summary.test.ts</strong> takes ~864 ms of the suite's ~912 ms. The dedupe pass is O(n²). Each doubling quadruples runtime. A Map keyed by id reduces it to one pass.</p>
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--c-accent)_5%,transparent)] px-3.5 py-2.5 text-[12.5px] leading-[1.55] p-text-2"><strong className="p-gold">System</strong> · a background job settled while you were away and joined this turn.</div>
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
            <div className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_30%,transparent)] p-surface">
              <div className="border-b border-dashed border-[var(--c-dash)] px-3.5 py-2 text-[11.5px] font-semibold p-gold">Needs you · 1</div>
              <div className="px-3.5 py-3"><div className="mb-2 text-[12.5px]">Swarm search stopped early</div><div className="flex gap-2 text-[11px]"><span className="rounded-full border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] px-2.5 py-0.5 p-gold">Retry</span><span className="rounded-full border p-border px-2.5 py-0.5 p-text-4">Dismiss</span></div></div>
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-semibold p-text-4">Journal</div>
              <div className="overflow-hidden rounded-xl border p-border p-surface">
                {[['◈', 'Crafted a tool: dedupe-bench', '2m'], ['✓', 'Graded 2 turns', '18h'], ['✓', 'Mapped 7 packages', '19h']].map(([icon, label, age], index) => (
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
  return (
    <div aria-label="Kinu terminal interface preview" className="overflow-hidden rounded-2xl border p-border bg-[var(--c-input-bg)] shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]">
      <div className="flex min-h-11 items-center justify-between gap-4 border-b p-border p-recessed px-4 py-2 font-mono text-[11.5px] p-text-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3.5"><KinuLogo compact /><span>checkout</span><span className="inline-flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--c-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--c-accent)_6%,transparent)] px-2.5 py-1 p-gold"><span className="size-1.5 rounded-full border-2 border-[color-mix(in_srgb,var(--c-accent)_28%,transparent)] border-t-[var(--c-accent)] motion-safe:animate-spin" />Working</span></div>
        <div className="hidden items-center gap-3.5 sm:flex"><span>local</span><span>Claude Opus 4</span></div>
      </div>
      <div className="grid min-h-[420px] grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)]">
        <aside className="hidden border-r p-border bg-[var(--c-bg)] px-3 py-4 md:block">
          <div className="mx-2 mb-3 font-mono text-[10px] uppercase tracking-[.14em] p-text-4">Sessions</div>
          <div className="rounded-lg border-l-2 border-[var(--c-accent)] p-elevated px-2.5 py-2 text-xs">checkout audit</div>
          <div className="px-2.5 py-2 text-xs p-text-3">migration review</div>
          <div className="px-2.5 py-2 text-xs p-text-3">release notes</div>
        </aside>
        <div className="flex min-w-0 flex-col px-4 pb-3.5 pt-[22px] font-mono text-xs leading-[1.65] sm:px-[26px]">
          <div className="max-w-[88%] self-end rounded-[12px_12px_3px_12px] border p-user-bubble px-3 py-2 font-sans text-[13px] p-text sm:max-w-[74%]">Audit the checkout flow, fix the coupon failure, and keep the tests green.</div>
          <div className="my-4 border-l-2 border-[var(--c-border-strong)] pl-3 p-text-4 sm:mb-3.5 sm:mt-5">Thinking · I found the request path. I will reproduce the failure before I change the handler.</div>
          <div className="overflow-hidden rounded-[10px] border p-border p-recessed">
            {[['run · workspace', 'bun test coupon', '7 pass'], ['file', 'Edited 0042_coupon_kind.sql', 'saved'], ['agents', 'Delegated three independent checks', 'running']].map(([tool, action, state], index) => (
              <div key={tool} className={`grid grid-cols-[88px_minmax(0,1fr)] gap-3 px-3 py-2.5 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:gap-3.5 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}><strong className="font-normal p-text-2">{tool}</strong><span className="p-text-4">{action}</span><em className="hidden not-italic p-success sm:block">{state}</em></div>
            ))}
          </div>
          <p className="my-4 font-sans text-[13.5px] leading-[1.65] p-text">The migration only filled fixed coupons. I patched the backfill, added the percentage case, and started the focused suite.</p>
          <div className="mt-auto rounded-[10px] border border-[var(--c-border-strong)] bg-[var(--c-bg)] px-3 py-2.5 p-text-4">Send a message…</div>
          <div className="mt-3 flex flex-wrap justify-between gap-3 text-[10px] p-text-4"><span>Auto · workspace connected</span><span>ctrl+k commands · esc cancel</span></div>
        </div>
      </div>
    </div>
  );
}

export function LandingShowcases(): ReactElement {
  return (
    <div className="landing-shell">
      <section data-showcase="workspace" className="pt-24">
        <div className="mx-auto mb-11 max-w-[620px] text-center">
          <h2 className="mb-3 text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">Every run leaves a clear record.</h2>
          <p className="text-base leading-[1.6] p-text-3">See each file change, running job, and tool the agent creates. When it needs a decision, it asks you here.</p>
        </div>
        <WorkspacePreview />
      </section>
      <section data-showcase="tui" className="pb-2 pt-24">
        <div className="mb-9 grid items-end gap-6 md:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] md:gap-[52px]">
          <div><div className="mb-3.5 flex items-center gap-3 text-[13px] font-semibold p-gold"><span className="h-px w-[22px] bg-[color-mix(in_srgb,var(--c-accent)_55%,transparent)]" />The terminal</div><h2 className="text-[clamp(28px,3.2vw,40px)] font-semibold leading-[1.06] tracking-[-.03em] text-pretty">The same workspace, <span className="p-gold">without the browser.</span></h2></div>
          <p className="max-w-[580px] text-base leading-[1.65] p-text-3">Open the full-screen TUI over SSH or on your own machine. It keeps the same sessions, tools, background work, and approvals.</p>
        </div>
        <TuiPreview />
      </section>
    </div>
  );
}
