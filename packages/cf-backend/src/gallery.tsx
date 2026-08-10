/**
 * Design-system gallery — a static harness that renders the real components
 * with mock data so the app's signed-in surfaces can be screenshotted without
 * auth. Served by gallery.vite.config.ts (no worker). Frames:
 *
 *   /gallery.html            → all sections stacked
 *   /gallery.html?frame=shell    → full workspace shell (hero shot)
 *   /gallery.html?frame=chat     → chat column inventory
 *   /gallery.html?frame=modal    → modal open
 *   /gallery.html?frame=home     → HomePage
 *   /gallery.html?frame=timeline → Run Timeline at Column B's real widths
 *
 * Network: /api/user/* GETs are stubbed in-page; everything else passes through.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { UIMessage } from "ai";
import { Button, Badge, InputArea, Loader } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import {
  PaperPlaneRightIcon, PaperclipIcon, ClockIcon, GearSixIcon, TrashIcon, BrainIcon,
} from "@phosphor-icons/react";
import "./index.css";
import Sidebar from "@/components/Sidebar";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { ModelPicker } from "@/components/ModelPicker";
import { RunTimeline } from "@/components/surfaces/RunTimeline";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
import { BrainSurface } from "@/components/surfaces/BrainSurface";
import { EmptyState } from "@/components/surfaces/shared";
import { Modal } from "@/components/ui/Modal";
import { MessageView, DeviceConsentCard, ChatErrorCard } from "@/pages/WorkspacePage";
import type { TimelineSpan, Rpc, ToolInfo } from "@/lib/protocol";
import type { AgentStatus } from "@/hooks/use-proteus";
import type { ModelMenuEntry } from "@/lib/user-api";

/* ── /api/user stub ─────────────────────────────────────────────── */

const NOW = Date.now();
const STUB: Record<string, unknown> = {
  "/api/user/profile": { email: "ashish@example.com", createdAt: NOW - 90 * 864e5, lastSeenAt: NOW },
  "/api/user/workspaces": [
    { name: "checkout-fixes", displayName: "Checkout coupon bug", createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3, archivedAt: null },
    { name: "perf-audit", displayName: "Perf audit — landing", createdAt: NOW - 3 * 864e5, lastVisited: NOW - 2 * 36e5, archivedAt: null },
    { name: "email-triage", displayName: "Email triage automation", createdAt: NOW - 30 * 864e5, lastVisited: NOW - 864e5, archivedAt: null },
    { name: "design-sys", displayName: "Design system v2", createdAt: NOW - 864e5, lastVisited: NOW - 5 * 864e5, archivedAt: null },
  ],
  "/api/user/models": MODEL_STUBS(),
};

function MODEL_STUBS(): ModelMenuEntry[] {
  return [
    { spec: "anthropic/claude-opus-4", label: "Claude Opus 4", provider: "Anthropic" },
    { spec: "workers-ai/llama-4", label: "Llama 4 (Workers AI)", provider: "Workers AI" },
    { spec: "openai/gpt-5.6", label: "GPT-5.6", provider: "OpenAI" },
  ];
}

const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = url.startsWith("/") ? url : new URL(url, location.origin).pathname;
  if (path in STUB && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify(STUB[path]), { headers: { "content-type": "application/json" } }));
  }
  if (path.startsWith("/api/")) {
    return Promise.resolve(new Response(JSON.stringify({ error: "gallery stub" }), { status: 404 }));
  }
  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;

/* ── Mock chat data ─────────────────────────────────────────────── */

// Single mock-data boundary cast: ai's UIMessage part union is generic over
// tool names; the gallery fabricates parts structurally.
function msg(m: Record<string, unknown>): UIMessage {
  return m as unknown as UIMessage;
}

const MESSAGES: UIMessage[] = [
  msg({
    id: "u1", role: "user", createdAt: NOW - 6 * 60e3,
    parts: [{ type: "text", text: "Audit the checkout flow, find why the SAVE20 coupon 500s, and fix it. Deploy to staging when green." }],
  }),
  msg({
    id: "a1", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [
      { type: "reasoning", text: "The coupon path goes through /api/cart/apply. I should reproduce first, then bisect: the handler, the pricing service, then the migration that landed Tuesday. The 500 with SAVE20 but not SAVE10 suggests a percentage-vs-fixed branch." },
      { type: "tool-run", toolCallId: "t1", state: "output-available", input: { runtime: "sandbox", cmd: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: "HTTP 500\n{\"error\":\"TypeError: Cannot read properties of undefined (reading 'percent')\"}" },
      { type: "tool-execute_tools", toolCallId: "t2", state: "output-available", input: { code: "const rows = await sql`SELECT code, kind, value FROM coupons WHERE code LIKE 'SAVE%'`;\nreturn rows;" }, output: '[{"code":"SAVE10","kind":"fixed","value":10},{"code":"SAVE20","kind":null,"value":20}]' },
      { type: "text", text: "Found it. Tuesday's migration backfilled `kind` for fixed coupons only — percentage coupons have `kind: null`, and `applyCoupon` dereferences `rules[kind].percent`.\n\n```ts\nconst rule = rules[coupon.kind ?? inferKind(coupon)];\n```\n\nI'll patch the migration, add a regression test, and run the suite." },
      { type: "tool-run", toolCallId: "t3", state: "input-available", input: { runtime: "sandbox", cmd: "bun test packages/checkout" } },
    ],
  }),
  msg({
    id: "bg1", role: "user",
    metadata: { proteusEvent: "background_job", kind: "test-suite", status: "completed" },
    parts: [{ type: "text", text: "background job completed" }],
  }),
  msg({
    id: "d1", role: "user",
    metadata: { proteusEvent: "event_drain" },
    parts: [{ type: "text", text: "While you were idle:\n- [subordinate_report] from subordinate (coupon-tester): All 14 checkout regression tests green after the migration patch. [the sender awaits your answer]\n- [webhook] from github (AshishKumar4/shop): PR #212 review requested" }],
  }),
];

const SPANS: TimelineSpan[] = [
  { ts: NOW - 340e3, kind: "llm-turn", label: "Turn: fix SAVE20 coupon", detail: "claude-opus-4", elapsedMs: 48000, source: "run", refId: "r1" },
  { ts: NOW - 330e3, kind: "tool-call", label: "run · curl /api/cart/apply", elapsedMs: 900, source: "run", refId: "r2" },
  { ts: NOW - 320e3, kind: "runtime-exec", label: "sandbox: bun test packages/checkout", elapsedMs: 14200, source: "run", refId: "r3" },
  { ts: NOW - 300e3, kind: "mcts", label: "think(mcts): bisect migration", detail: "12 nodes · best 0.82", source: "mcts", refId: "m1" },
  { ts: NOW - 280e3, kind: "error", label: "provider stream reset", detail: "retried in 1.2s", source: "run", refId: "r4" },
  { ts: NOW - 275e3, kind: "recovery", label: "turn resumed from step 3", source: "run", refId: "r5" },
  { ts: NOW - 200e3, kind: "scaffold", label: "scaffold mutation accepted", detail: "+ pre-flight migration check", source: "evolution", refId: "e1" },
  { ts: NOW - 120e3, kind: "curriculum", label: "curriculum: db-migration drills", source: "evolution", refId: "e2" },
  { ts: NOW - 60e3, kind: "trigger", label: "webhook: github PR #212", source: "background", refId: "b1" },
];

const stubRpc: Rpc = async <T,>(method: string): Promise<T> => {
  if (method.startsWith("list") || method.startsWith("get")) return [] as unknown as T;
  return {} as unknown as T;
};

/* ── Compositions (markup mirrors WorkspacePage) ────────────────── */

function ChatHeader() {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b p-border">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ConnectionIndicator status="connected" />
        <span className="font-medium text-sm p-text truncate">Checkout coupon bug</span>
        <span className="shrink-0 inline-flex items-center gap-1.5 px-1.5 @[34rem]:px-2 py-0.5 rounded-full p-accent-subtle" title="The agent is working">
          <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
          <span className="hidden @[34rem]:inline p-meta p-accent font-medium">working</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ModelPicker models={MODEL_STUBS()} value="anthropic/claude-opus-4" onChange={() => {}} size="xs" className="shrink-0 w-28 @[30rem]:w-36 @[42rem]:w-44" />
        <button className="p-1 rounded transition-colors cursor-pointer p-text-3 hover:p-text-2" aria-label="Toggle run timeline"><ClockIcon size={14} /></button>
        <Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={12} />} aria-label="Clear history" />
        <span className="p-text-2"><GearSixIcon size={14} /></span>
      </div>
    </div>
  );
}

function Composer() {
  return (
    <div className="px-5 py-3 border-t p-border lg:px-7">
      <div className="flex items-end gap-2.5 p-composer p-2.5">
        <button className="p-text-3 hover:p-text transition-colors p-1.5 mb-0.5 cursor-pointer" aria-label="Attach files"><PaperclipIcon size={16} /></button>
        <InputArea value="" onValueChange={() => {}} placeholder="Send a message..." rows={1}
          className="flex-1 resize-none max-h-40 overflow-y-auto !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none" />
        <button className="p-btn rounded-lg p-2 mb-0.5 cursor-pointer" aria-label="Send"><PaperPlaneRightIcon size={16} /></button>
      </div>
    </div>
  );
}

function ChatMessages() {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
      {MESSAGES.map((m, i) => (
        <MessageView key={m.id} message={m} isLast={i === MESSAGES.length - 1} isStreaming={false} onFork={() => {}} />
      ))}
      <DeviceConsentCard
        consent={{ consentId: "c1", deviceLabel: "ashish-laptop", command: "git push origin fix/coupon-kind", requestedAt: NOW } as never}
        onResolve={() => {}}
      />
      <ChatErrorCard message="fetch failed: provider stream reset before completion (anthropic/claude-opus-4)" streaming={false} onRetry={() => {}} onDismiss={() => {}} />
    </div>
  );
}

function Shell() {
  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      <aside className="hidden w-64 shrink-0 h-full p-elevated border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <div className="h-full flex flex-col">
          <div className="flex items-center px-4 py-1.5 border-b p-border shrink-0">
            <span className="text-xs p-text-2 font-medium truncate">Checkout coupon bug</span>
            <div className="ml-auto flex items-center gap-0.5 p-recessed rounded-md p-0.5">
              <button className="px-2.5 py-1 text-[11px] rounded capitalize transition-colors p-elevated p-text font-medium">run</button>
              <button className="px-2.5 py-1 text-[11px] rounded capitalize transition-colors p-text-3 hover:p-text-2">supervise</button>
            </div>
          </div>
          <div className="flex-1 flex min-h-0">
            <div className="@container flex flex-col h-full border-r p-border" style={{ width: "40%" }}>
              <ChatHeader />
              <ChatMessages />
              <Composer />
            </div>
            <div className="flex flex-col h-full border-r p-border" style={{ width: "22%" }}>
              <RunTimeline spans={SPANS} selectedRef="m1" onSelect={() => {}} follow onToggleFollow={() => {}} onClose={() => {}} />
            </div>
            <div className="flex-1 min-w-0">
              <WorkSurface
                surface="Output" onSurface={() => {}} pinnedPorts={[]} agentStatus={null} tools={[]}
                memory={[]} memoryContent="" onSearchMemory={() => {}} mctsTree={null} isStreaming={false}
                executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                backgroundJobs={[]} runningTaskCount={2} onRefreshTasks={() => {}} changelogUnseen={3} rpc={stubRpc}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* The timeline at the widths Column B actually gets: the resizable panel's
   minSize (15% ≈ 216px at 1440) through its comfortable width. */
function TimelineWidths() {
  return (
    <div className="p-bg min-h-screen p-6 flex gap-6 items-start">
      {[216, 260, 320].map((w) => (
        <div key={w}>
          <div className="p-eyebrow mb-2">{w}px</div>
          <div className="border p-border rounded-[10px] overflow-hidden" style={{ width: w, height: 420 }}>
            <RunTimeline spans={SPANS} selectedRef="m1" onSelect={() => {}} follow onToggleFollow={() => {}} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b p-border">
      <h2 className="px-6 pt-6 pb-2 text-xs font-semibold uppercase tracking-wider p-text-3">{title}</h2>
      <div className="px-6 pb-8">{children}</div>
    </section>
  );
}

function Controls() {
  return (
    <div className="space-y-6 max-w-2xl">
      {/* The button hierarchy as it now ships. Kumo's `primary` and
          `destructive` are absent on purpose: they force `!text-white`, which
          measures 2.4:1 on brass, so every call site uses p-btn/p-btn-danger.
          Kumo's secondary and ghost stay and inherit the palette. */}
      <div className="flex flex-wrap items-center gap-3">
        <button className={`p-btn ${btnSmCls}`}>p-btn</button>
        <button className={`p-btn-danger ${btnSmCls}`}>p-btn-danger</button>
        <Button variant="secondary" size="sm">Kumo secondary</Button>
        <Button variant="ghost" size="sm">Kumo ghost</Button>
        <button className="p-btn-quiet inline-flex h-6.5 items-center gap-1 px-2 text-xs">p-btn-quiet</button>
        <button className="p-btn-ghost inline-flex h-6.5 items-center gap-1 px-2 text-xs">p-btn-ghost</button>
        <button className="p-btn inline-flex h-9 items-center gap-2 px-3 text-sm font-medium">p-btn at 36px</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono p-badge-neutral">workspace</span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono p-badge-info">nimbus</span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono p-badge-success">sandbox</span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono p-badge-warning">laptop</span>
        <span className="px-1.5 py-0.5 rounded text-[10px] p-badge-danger">failed</span>
        <span className="size-1.5 rounded-full p-dot-success animate-pulse" title="working" />
        <span className="size-1.5 rounded-full p-dot-accent" title="unseen" />
      </div>
      <div className="space-y-2">
        <div className="p-notice-success text-xs rounded-md px-3 py-2">Deployed to staging — 14 tests green.</div>
        <div className="p-notice-warning text-xs rounded-md px-3 py-2">The laptop runtime is not provisioned yet.</div>
        <div className="p-notice-danger text-xs rounded-md px-3 py-2">Could not remove: workspace has a live turn.</div>
        <div className="p-notice-info text-xs rounded-md px-3 py-2">Evolution changelog has 3 unseen entries.</div>
      </div>
      <div className="max-w-md space-y-2">
        <input className="w-full px-3 py-1.5 rounded-md border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]" placeholder="raw input (fork modal style)" />
        <textarea rows={2} className="block w-full resize-y rounded-md border p-border p-bg px-3 py-3 text-sm leading-7 p-text outline-none placeholder:p-text-3 transition-all focus:border-[var(--c-accent)] focus:ring-2 focus:ring-[var(--c-accent-subtle)]" placeholder="mission textarea (home page style)" />
      </div>
      <EmptyState icon={<BrainIcon size={32} />} title="No exploration trees yet" hint="Exploration trees appear when the agent uses think(strategy:'mcts') to investigate subproblems." />
    </div>
  );
}

function All() {
  return (
    <div className="p-bg p-text min-h-screen">
      <Section title="Chat column"><div className="@container max-w-3xl border p-border rounded-lg overflow-hidden"><ChatHeader /><ChatMessages /><Composer /></div></Section>
      <Section title="Run timeline"><div className="max-w-sm h-96 border p-border rounded-lg overflow-hidden"><RunTimeline spans={SPANS} selectedRef="m1" onSelect={() => {}} follow onToggleFollow={() => {}} /></div></Section>
      <Section title="Controls">{<Controls />}</Section>
    </div>
  );
}

function GalleryModal() {
  return (
    <div className="p-bg min-h-screen">
      <Modal
        title="Remove workspace"
        icon={<TrashIcon size={18} className="p-danger" />}
        onClose={() => {}}
        footer={<>
          <Button size="sm" variant="ghost">Cancel</Button>
          <button className={`p-btn-danger ${btnSmCls}`}>Remove</button>
        </>}
      >
        <p className="text-xs p-text-2 leading-relaxed">
          Remove <span className="font-medium p-text">Checkout coupon bug</span> and clear its server-side state? This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

/* ── Palette plate — the design language rendered, not listed ───── */

const SURFACE_STEPS = [
  ["recessed", "--c-recessed"], ["base", "--c-bg"], ["panel", "--c-sidebar"],
  ["card", "--c-surface"], ["raised", "--c-elevated"], ["overlay", "--c-overlay"],
] as const;
const TEXT_STEPS = [
  ["ink", "--c-text", "15.4 / 15.7"], ["mid", "--c-text-2", "8.8 / 7.3"],
  ["dim", "--c-text-3", "5.7 / 5.1"], ["accent-ink", "--c-accent-fg", "10.7 / 6.7"],
] as const;
const STATUS_STEPS = [
  ["success", "--c-success", "8.5 / 5.4"], ["warning", "--c-warning", "9.4 / 5.8"],
  ["danger", "--c-danger", "6.8 / 6.1"], ["info", "--c-info", "8.3 / 5.6"],
] as const;

function Palette() {
  return (
    <div className="p-bg min-h-screen p-8 space-y-8 max-w-3xl">
      <div>
        <div className="p-eyebrow mb-1">Proteus v2 · Workshop at night</div>
        <h1 className="p-title p-text" style={{ fontSize: 22, lineHeight: "28px" }}>Surface ladder, text roles, brass intent, status</h1>
        <p className="p-meta p-text-3 mt-1">Contrast ratios shown as dark / light vs the base surface. All text roles are WCAG AA or better.</p>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Surfaces — six warm steps</div>
        <div className="flex rounded-[10px] overflow-hidden border p-border">
          {SURFACE_STEPS.map(([name, v]) => (
            <div key={name} className="flex-1 h-24 flex items-end p-2" style={{ background: `var(${v})` }}>
              <span className="p-meta p-text-3">{name}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Text roles</div>
        <div className="space-y-1.5">
          {TEXT_STEPS.map(([name, v, ratio]) => (
            <div key={name} className="flex items-baseline gap-3">
              <span className="p-body" style={{ color: `var(${v})` }}>The agent resumed turn 41 from step 3 — {name}</span>
              <span className="p-num text-[11px] p-text-3">{ratio}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Brass carries intent only</div>
        <div className="flex items-center gap-3 flex-wrap">
          <button className="p-btn px-3.5 h-9 p-row-text inline-flex items-center gap-2">Primary action</button>
          <button className="p-btn-quiet px-3.5 h-8 p-row-text inline-flex items-center">Secondary</button>
          <button className="p-btn-ghost px-3 h-8 p-row-text inline-flex items-center">Ghost</button>
          <a className="p-accent p-row-text underline underline-offset-2" href="#top">A link</a>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full p-accent-subtle">
            <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
            <span className="p-meta p-accent font-medium">working</span>
          </span>
        </div>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Status — AA in both modes</div>
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_STEPS.map(([name, v, ratio]) => (
            <span key={name} className={`px-2 py-0.5 p-badge-${name}`}>{name} <span className="p-num">{ratio}</span></span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Landing v2 sketch — the app's tokens ARE the landing's tokens ── */

function LandingV2() {
  return (
    <div className="p-bg min-h-screen flex flex-col">
      <header className="flex h-16 items-center justify-between px-6 border-b p-border">
        <span className="flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-md p-accent-bg p-accent font-mono text-[13px] font-bold">P</span>
          <span className="font-mono text-[13px] font-semibold tracking-[0.14em] p-text">PROTEUS</span>
        </span>
        <nav className="flex items-center gap-2">
          <button className="p-btn-ghost px-3 h-8 p-row-text">Install CLI</button>
          <button className="p-btn px-3.5 h-9 p-row-text inline-flex items-center">Sign in</button>
        </nav>
      </header>
      <main className="flex-1 grid content-center px-6 py-16 max-w-4xl">
        <div className="p-eyebrow mb-4" style={{ color: "var(--c-accent-fg)" }}>Persistent agents for serious work</div>
        <h1 className="p-text" style={{ fontSize: "clamp(40px, 7vw, 72px)", lineHeight: 1.02, fontWeight: 700, letterSpacing: "-0.025em" }}>
          Agents that keep<br />working after you close<br />the tab.
        </h1>
        <p className="p-body p-text-2 mt-5 max-w-xl" style={{ fontSize: 17, lineHeight: 1.55 }}>
          Proteus agents hold state across sessions, run from the dashboard or your terminal, and use your own machine when local access matters.
        </p>
        <div className="flex items-center gap-3 mt-8">
          <button className="p-btn px-4 h-10 p-body inline-flex items-center font-semibold">Sign in</button>
          <button className="p-btn-quiet px-4 h-10 p-body inline-flex items-center">Install CLI</button>
        </div>
        {/* The product's signature — a run timeline as brand motif */}
        <div className="mt-14 border p-border rounded-[10px] p-surface p-4 max-w-xl">
          <div className="p-eyebrow mb-2.5">A live run, right now</div>
          {[
            ["p-dot-accent", "Turn: fix SAVE20 coupon", "48.0s"],
            ["p-dot-neutral", "sandbox: bun test packages/checkout", "14.2s"],
            ["p-dot-info", "think(mcts): bisect migration", "12 nodes"],
            ["p-dot-success", "deploy: staging green", "checks passed"],
          ].map(([dot, label, meta]) => (
            <div key={label} className="flex items-center gap-2.5 py-1">
              <span className={`size-1.5 rounded-full ${dot}`} />
              <span className="p-row-text p-text-2">{label}</span>
              <span className="ml-auto p-num text-[11px] p-text-3">{meta}</span>
            </div>
          ))}
        </div>
      </main>
      <footer className="flex h-14 items-center justify-between px-6 border-t p-border">
        <span className="p-meta p-text-3">Proteus on GitHub</span>
        <span className="p-meta p-text-3">Durable agents, local execution, user-controlled automation.</span>
      </footer>
    </div>
  );
}

/* The Brain surface: the collapsible sections and the native/code-mode
   exposure badge, at the width Column C actually gets. */
const BRAIN_TOOLS: ToolInfo[] = [
  { name: "run", description: "Execute a command on a chosen runtime (workspace, sandbox, a linked device).", learned: false, exposure: "native", qualityScore: 1, usageCount: 0 },
  { name: "file", description: "Read, write, edit and search files in the workspace.", learned: false, exposure: "native", qualityScore: 1, usageCount: 0 },
  { name: "memory", description: "Durable recall — notes, facts and searchable history.", learned: false, exposure: "native", qualityScore: 1, usageCount: 0 },
  { name: "web", description: "Search the web and fetch a page as markdown.", learned: false, exposure: "native", qualityScore: 1, usageCount: 0 },
  { name: "execute_tools", description: "Run a JavaScript program against every capability namespace.", learned: false, exposure: "native", qualityScore: 1, usageCount: 0 },
  { name: "bisect_migration", description: "Walk a migration's revisions to find the one that changed a column's shape.", learned: true, exposure: "codemode", qualityScore: 0.82, usageCount: 14 },
  { name: "coupon_replay", description: "Replay a checkout against a coupon code and diff the response.", learned: true, exposure: "codemode", qualityScore: 0.61, usageCount: 3 },
];

const BRAIN_STATUS = {
  id: "agent_01j9x7q2m4checkoutfixes", name: "checkout-fixes", displayName: "Checkout coupon bug",
  purpose: "Find why the SAVE20 coupon 500s and fix it.", model: "anthropic/claude-opus-4",
  scaffoldVersion: 7, searchNodeCount: 12, craftedToolCount: 2, messageCount: 48,
  createdAt: NOW - 7 * 864e5,
} as unknown as AgentStatus;

function BrainFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[520px] border-x p-border min-h-screen p-5">
        <BrainSurface
          agentStatus={BRAIN_STATUS} tools={BRAIN_TOOLS} memory={[]}
          memoryContent={"## Checkout\n\n- The coupon path goes through `/api/cart/apply`.\n- Percentage coupons carry `kind: null` after Tuesday's migration.\n"}
          onSearchMemory={() => {}} rpc={stubRpc}
        />
      </div>
    </div>
  );
}

const frame = new URLSearchParams(location.search).get("frame");

async function mount() {
  let node: React.ReactNode;
  if (frame === "shell") node = <Shell />;
  else if (frame === "modal") node = <GalleryModal />;
  else if (frame === "palette") node = <Palette />;
  else if (frame === "landing2") node = <LandingV2 />;
  else if (frame === "timeline") node = <TimelineWidths />;
  else if (frame === "panels") node = <BrainFrame />;
  else if (frame === "home") {
    const { default: HomePage } = await import("@/pages/HomePage");
    node = <div className="h-screen p-bg p-text"><HomePage /></div>;
  } else node = <All />;
  createRoot(document.getElementById("root")!).render(
    <StrictMode><MemoryRouter>{node}</MemoryRouter></StrictMode>,
  );
}
void mount();
