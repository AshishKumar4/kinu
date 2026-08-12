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
 *   /gallery.html?frame=tabs     → the agent tab strip, active + idle + working
 *   /gallery.html?frame=markdown → everything MarkdownContent has to render
 *   /gallery.html?frame=views    → an agent-authored View, in Column C's chrome
 *   /gallery.html?frame=viewfail → the same View when its spec stops validating
 *   /gallery.html?frame=releases → the Releases board with a pending approval
 *   /gallery.html?frame=supervise → the Supervise altitude, every block populated
 *   /gallery.html?frame=settings → the per-agent Settings page
 *
 * Network: /api/user/* GETs are stubbed in-page; everything else passes through.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { UIMessage } from "ai";
import { Button, Badge, InputArea, Loader } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import {
  PaperPlaneRightIcon, PaperclipIcon, GearSixIcon, TrashIcon, BrainIcon,
} from "@phosphor-icons/react";
import "./index.css";
import Sidebar from "@/components/Sidebar";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { ModelPicker } from "@/components/ModelPicker";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
import { AgentViewSurface } from "@/components/surfaces/AgentViewSurface";
import { ReleasesSurface } from "@/components/surfaces/ReleasesSurface";
import { SelfSurface } from "@/components/surfaces/SelfSurface";
import { EmptyState, MarkdownContent } from "@/components/surfaces/shared";
import { SubordinateTabs } from "@/components/SubordinateTabs";
import { Modal } from "@/components/ui/Modal";
import { MessageView, DeviceConsentCard, ChatErrorCard } from "@/pages/WorkspacePage";
import { SupervisePage } from "@/pages/SupervisePage";
import { BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS } from "@proteus/core";
import type { BackgroundJob, Rpc, ToolInfo } from "@/lib/protocol";
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
  // The endpoint returns a ModelMenu, not a bare array. Stubbing the array
  // made `menu.models.length` throw and HomePage rendered as a blank canvas,
  // so the one page a signed-in user lands on was never actually looked at.
  "/api/user/models": { models: MODEL_STUBS(), failures: [] },
  // Settings' Device access card reads both, and a 404 photographs its failure
  // state instead of the consent-scope control that card exists for.
  "/api/user/devices": [
    {
      id: "dev_1", label: "ashish-mbp", os: "darwin", hostname: "ashish-mbp.local",
      connected: true, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 90e3,
      expiresAt: NOW + 50 * 864e5,
    },
  ],
  "/api/user/devices/consents": [
    {
      agentName: "checkout-fixes", deviceId: "dev_1", policy: "remembered",
      scope: "consented_folder", lastMethod: "exec", lastSummary: "bun test packages/core",
    },
  ],
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


/* ── Agent socket stub ──────────────────────────────────────────── */

/**
 * The Agents-SDK RPC transport, answered in-page.
 *
 * SettingsPage gates its whole body on a live agent connection, so with no
 * worker the only photographable thing was its spinner. This is the same idea
 * as the `/api/user` fetch stub above, one layer down: open the socket, answer
 * `{type:"rpc"}` frames from a table, and the real page renders against mock
 * data. Sockets that are not an agent connection (vite's HMR channel) fall
 * through to the real WebSocket untouched.
 */
const AGENT_RPC: Record<string, unknown> = {
  getWorkspaceSnapshot: {
    status: {
      id: "agent_01j9x7q2m4checkoutfixes", name: "checkout-coupon-bug-9935d3",
      displayName: "Checkout coupon bug", purpose: "Find why the SAVE20 coupon 500s and fix it.",
      soul: "# Checkout coupon bug\n\nI own the checkout coupon path. I read the migration before I guess.\n",
      createdAt: NOW - 7 * 864e5, scaffoldVersion: 7, searchNodeCount: 12,
      craftedToolCount: 2, messageCount: 48, model: "anthropic/claude-opus-4", forkLineage: null,
    },
    tools: { tools: [], crafted: [] },
    memoryContent: "",
    mcts: [], timeline: [], executors: [], executorOutputs: [], lastActiveExecutor: null,
  },
  getStoredModelSpec: "anthropic/claude-opus-4",
  getShellApprovalMode: "strict",
  getMctsConfig: { explorationConstant: 1.41, maxIterations: 12, maxDepth: 5, branchBudget: 3 },
  getEvolutionChangelog: { entries: [], unseen: 0 },
};

class GalleryAgentSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      this.readyState = this.OPEN;
      const open = new Event("open");
      this.onopen?.(open);
      this.dispatchEvent(open);
    });
  }

  send(raw: string): void {
    let frame: { type?: string; id?: string; method?: string };
    try { frame = JSON.parse(raw) as typeof frame; } catch { return; }
    if (frame.type !== "rpc" || !frame.method) return;
    const method = frame.method;
    const result = method in AGENT_RPC
      ? AGENT_RPC[method]
      : method.startsWith("list") || method.startsWith("get") ? [] : {};
    queueMicrotask(() => {
      const message = new MessageEvent("message", {
        data: JSON.stringify({ type: "rpc", id: frame.id, success: true, result }),
      });
      this.onmessage?.(message);
      this.dispatchEvent(message);
    });
  }

  close(): void {
    this.readyState = this.CLOSED;
    const close = new CloseEvent("close", { code: 1000, wasClean: true });
    this.onclose?.(close);
    this.dispatchEvent(close);
  }
}

const RealWebSocket = window.WebSocket;
window.WebSocket = new Proxy(RealWebSocket, {
  construct(target, args: [string, (string | string[])?]) {
    return String(args[0]).includes("/agents/")
      ? (new GalleryAgentSocket(String(args[0])) as unknown as WebSocket)
      : Reflect.construct(target, args) as WebSocket;
  },
});

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
      { type: "tool-run", toolCallId: "t1", state: "output-available", input: { runtime: "sandbox", command: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: "HTTP 500\n{\"error\":\"TypeError: Cannot read properties of undefined (reading 'percent')\"}" },
      { type: "tool-execute_tools", toolCallId: "t2", state: "output-available", input: { code: "const rows = await sql`SELECT code, kind, value FROM coupons WHERE code LIKE 'SAVE%'`;\nreturn rows;" }, output: '[{"code":"SAVE10","kind":"fixed","value":10},{"code":"SAVE20","kind":null,"value":20}]' },
      { type: "text", text: "Found it. Tuesday's migration backfilled `kind` for fixed coupons only — percentage coupons have `kind: null`, and `applyCoupon` dereferences `rules[kind].percent`.\n\n```ts\nconst rule = rules[coupon.kind ?? inferKind(coupon)];\n```\n\nI'll patch the migration, add a regression test, and run the suite." },
      // A real repair is a RUN of calls, not one — this is the case the chat
      // has to survive without becoming a wall of identical rows.
      { type: "tool-file", toolCallId: "t4", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "t5", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
      { type: "tool-file", toolCallId: "t6", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: "ok" },
      { type: "tool-file", toolCallId: "t7", state: "output-available", input: { action: "write", path: "packages/checkout/tests/coupon-kind.test.ts" }, output: "ok" },
      { type: "tool-agents", toolCallId: "t8", state: "output-available", input: { action: "fork", forks: [{}, {}, {}], settle: "merge", task: "Check every other call site that indexes `rules` by kind" }, output: "3 forks merged" },
      { type: "tool-run", toolCallId: "t3", state: "input-available", input: { runtime: "sandbox", command: "bun test packages/checkout" } },
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


const stubRpc: Rpc = async <T,>(method: string): Promise<T> => {
  if (method.startsWith("list") || method.startsWith("get")) return [] as unknown as T;
  return {} as unknown as T;
};

/* ── Compositions (markup mirrors WorkspacePage) ────────────────── */

function ChatHeader() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 @[26rem]:py-3.5 border-b p-border">
      <div className="flex min-w-0 basis-full @[26rem]:basis-0 @[26rem]:flex-1 items-center gap-3">
        <ConnectionIndicator status="connected" />
        <span className="font-medium text-sm p-text truncate">Checkout coupon bug</span>
        <span className="shrink-0 inline-flex items-center gap-1.5 px-1.5 @[34rem]:px-2 py-0.5 rounded-full p-accent-subtle" title="The agent is working">
          <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
          <span className="hidden @[34rem]:inline p-meta p-accent font-medium">working</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2 ml-auto">
        <ModelPicker models={MODEL_STUBS()} value="anthropic/claude-opus-4" onChange={() => {}} size="xs" className="shrink-0 w-32 @[30rem]:w-36 @[42rem]:w-44" />
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
      {/* Mirrors components/layout.tsx — a harness that photographs a
          different surface than the app renders is worse than no harness. */}
      <aside className="hidden w-64 shrink-0 h-full p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <div className="h-full flex flex-col">
          <div className="flex items-center px-4 py-1.5 border-b p-border shrink-0">
            <span className="text-xs p-text-2 font-medium truncate">Checkout coupon bug</span>
            <div className="ml-auto flex items-center gap-0.5 p-recessed rounded-md p-0.5">
              <button className="px-2.5 py-1 text-[11px] rounded capitalize transition-colors p-fill p-text font-medium">run</button>
              <button className="px-2.5 py-1 text-[11px] rounded capitalize transition-colors p-text-3 hover:p-text-2">supervise</button>
            </div>
          </div>
          <div className="flex-1 flex min-h-0">
            <div className="@container flex flex-col h-full border-r p-border" style={{ width: "42%" }}>
              <ChatHeader />
              <ChatMessages />
              <Composer />
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

/* The chat column at the width Column A actually gets — 42% of the shell, so
   roughly 540px on a laptop. Rendering it full-bleed would flatter every
   truncation and every line length the real column does not have. */
function ChatFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <SubordinateTabs
          workspace="checkout-fixes" subordinates={SUBORDINATES} activeName={undefined}
          onSpawn={async () => ({ name: "x", displayName: "x" })} onDismiss={async () => {}}
        />
        <ChatHeader />
        <ChatMessages />
        <Composer />
      </div>
    </div>
  );
}

function All() {
  return (
    <div className="p-bg p-text min-h-screen">
      <Section title="Chat column"><div className="@container max-w-3xl border p-border rounded-lg overflow-hidden"><ChatHeader /><ChatMessages /><Composer /></div></Section>
      <Section title="Controls">{<Controls />}</Section>
    </div>
  );
}

/* ── Agent tab strip ────────────────────────────────────────────── */

const SUBORDINATES = [
  { name: "coupon-tester", displayName: "Coupon tester", role: "QA", status: "working", currentTask: "Running the checkout regression suite" },
  { name: "migration-review", displayName: "Migration review", role: "Reviewer", status: "awaiting_input", currentTask: "Needs a call on the backfill order" },
  { name: "docs", displayName: "Release notes", role: "Writer", status: "idle", currentTask: null },
] as unknown as Parameters<typeof SubordinateTabs>[0]["subordinates"];

/* The strip sits at the top of Column A, on the chat column's own ground —
   photographing it anywhere else hides the seam that the complaint is about. */
function TabsFrame() {
  return (
    <div className="p-bg min-h-screen p-8 space-y-8">
      {[520, 380].map((w) => (
        <div key={w} className="flex flex-col border p-border overflow-hidden" style={{ width: w, height: 190 }}>
          <SubordinateTabs
            workspace="checkout-fixes" subordinates={SUBORDINATES} activeName={undefined}
            onSpawn={async () => ({ name: "x", displayName: "x" })} onDismiss={async () => {}}
          />
          <div className="flex-1 px-5 py-4 p-row-text p-text-3">Main chat body</div>
        </div>
      ))}
      <div className="flex flex-col border p-border overflow-hidden" style={{ width: 520, height: 190 }}>
        <SubordinateTabs
          workspace="checkout-fixes" subordinates={SUBORDINATES} activeName="coupon-tester"
          onSpawn={async () => ({ name: "x", displayName: "x" })} onDismiss={async () => {}}
        />
        <div className="flex-1 px-5 py-4 p-row-text p-text-3">Subordinate chat body</div>
      </div>
    </div>
  );
}

/* ── Markdown ───────────────────────────────────────────────────── */

/* Everything the agent actually emits: fenced blocks in several languages, a
   line far wider than the column, inline code inside prose, a table, nested
   lists, a quote — the cases that have to survive a 420px chat column. */
const MARKDOWN_SAMPLE = `Here is what the migration is doing wrong, and the patch.

The handler reads \`rules[coupon.kind]\` before \`kind\` is backfilled, so a percentage coupon dereferences \`undefined.percent\`. Fix is one line in \`apply-coupon.ts\` plus a guard in the migration.

\`\`\`ts
export function applyCoupon(cart: Cart, coupon: Coupon): Cart {
  const kind = coupon.kind ?? inferKind(coupon);
  const rule = rules[kind];
  if (!rule) throw new CouponError(\`no pricing rule for kind=\${kind}\`, { code: coupon.code });
  return rule.kind === "percent" ? discountByPercent(cart, rule.percent) : discountByAmount(cart, rule.amount);
}
\`\`\`

\`\`\`sql
UPDATE coupons SET kind = CASE WHEN value <= 100 AND code LIKE '%PCT%' THEN 'percent' ELSE 'fixed' END WHERE kind IS NULL;
\`\`\`

\`\`\`bash
bun test packages/checkout --reporter=verbose && bunx wrangler deploy --env staging --var COUPON_STRICT:1
\`\`\`

\`\`\`
plain fence, no language — this is the one that used to render as an unstyled grey slab
\`\`\`

| Coupon | Kind | Value | Status |
| --- | --- | ---: | --- |
| SAVE10 | fixed | 10 | ok |
| SAVE20 | null | 20 | **500** |

1. Patch the migration
2. Add the regression test
   - one for \`percent\`
   - one for the \`null\` legacy row
3. Re-run the suite

> The backfill ran before the enum existed, which is why nothing failed in CI.

See [the migration](https://example.com/migrations/0042) for the original.`;

function MarkdownFrame() {
  return (
    <div className="p-bg min-h-screen p-8 flex flex-wrap gap-8 items-start">
      {[420, 720].map((w) => (
        <div key={w}>
          <div className="p-eyebrow mb-2">{w}px</div>
          <div className="border p-border p-4 overflow-hidden" style={{ width: w }}>
            <div className="prose-chat p-text"><MarkdownContent content={MARKDOWN_SAMPLE} /></div>
          </div>
        </div>
      ))}
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

/* The Self surface: the collapsible sections and the native/code-mode
   exposure badge, at the width Column C actually gets. */
/* The real docstrings, from the registry the orchestrator serves them from.
   Mocking short ones is how the Tools list shipped as a wall of prose without
   anyone seeing it: nine builtins carry ~2,400 tokens of contract between
   them, and a harness that photographs one-liners photographs a surface the
   app does not have. */
const BRAIN_TOOLS: ToolInfo[] = [
  ...BUILTIN_TOOLS.map((name) => ({
    name,
    summary: BUILTIN_TOOL_SPECS[name].summary,
    description: BUILTIN_TOOL_DESCRIPTIONS[name],
    learned: false,
    exposure: (name === "release" ? "codemode" : "native") as ToolInfo["exposure"],
    qualityScore: 1,
    usageCount: 0,
  })),
  { name: "bisect_migration", summary: "Walk a migration's revisions to find the one that changed a column's shape.", description: "Walk a migration's revisions to find the one that changed a column's shape.", learned: true, exposure: "codemode", qualityScore: 0.82, usageCount: 14 },
  { name: "coupon_replay", summary: "Replay a checkout against a coupon code and diff the response.", description: "Replay a checkout against a coupon code and diff the response.", learned: true, exposure: "codemode", qualityScore: 0.61, usageCount: 3 },
];

const BRAIN_STATUS = {
  id: "agent_01j9x7q2m4checkoutfixes", name: "checkout-coupon-bug-9935d3", displayName: "Checkout coupon bug",
  purpose: "Find why the SAVE20 coupon 500s and fix it.", model: "anthropic/claude-opus-4",
  scaffoldVersion: 7, searchNodeCount: 12, craftedToolCount: 2, messageCount: 48,
  createdAt: NOW - 7 * 864e5,
} as unknown as AgentStatus;

/* ── Agent-authored view ────────────────────────────────────────── */

// A spec of the shape `workspace.createView` accepts, over a release board of
// the shape `getReleaseBoard` returns. Both are real: the frame below exercises
// the production renderer, not a mock of it.
const VIEW_SPEC = {
  v: 1,
  title: "Deploy health",
  subtitle: "Everything I have shipped this week, and what is waiting on you.",
  refreshMs: 15000,
  blocks: [
    { type: "stat", label: "Open changes", source: { rpc: "getReleaseBoard", path: "changes" }, agg: "count" },
    { type: "stat", label: "Deployments", source: { rpc: "getReleaseBoard", path: "deployments" }, agg: "count" },
    { type: "stat", label: "Jobs running", source: { rpc: "listBackgroundJobs" }, agg: "count" },
    {
      type: "table", title: "Recent changes",
      source: { rpc: "getReleaseBoard", path: "changes", limit: 5 },
      columns: [
        { field: "userPrompt", label: "Change" },
        { field: "status", label: "Status", as: "badge" },
        { field: "updatedAt", label: "Updated", as: "time" },
      ],
    },
    {
      type: "section", title: "Background work",
      blocks: [
        { type: "list", title: "Jobs", source: { rpc: "listBackgroundJobs" }, field: "label" },
        {
          type: "kv", title: "Latest deployment",
          source: { rpc: "getReleaseBoard", path: "deployments.0" },
          rows: [
            { field: "environment", label: "Environment" },
            { field: "versionId", label: "Version" },
            { field: "status", label: "Status" },
          ],
        },
      ],
    },
    { type: "markdown", text: "Two checks are still red on `chg_4f2`. I have not requested approval for it." },
  ],
};

const VIEW_BOARD = {
  changes: [
    { id: "chg_4f2", userPrompt: "Warm up the empty-state copy", status: "deployed", updatedAt: NOW - 36e5 },
    { id: "chg_9a1", userPrompt: "Collapse the duplicate model picker", status: "awaiting_approval", updatedAt: NOW - 72e5 },
    { id: "chg_2c8", userPrompt: "Stop the timeline flickering on reconnect", status: "preview_ready", updatedAt: NOW - 108e5 },
    { id: "chg_7b3", userPrompt: "Retire the second markdown pipeline", status: "failed", updatedAt: NOW - 20e5 },
  ],
  deployments: [{ environment: "production", versionId: "a8d02b4f", status: "deployed" }],
};

const VIEW_JOBS = [
  { label: "bun test packages/core (2,454 tests)" },
  { label: "GEPA pass over the release prompt" },
  { label: "replay eval — 40 turns" },
];

const viewRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getAgentView") return { ok: true, version: 3, spec: VIEW_SPEC } as unknown as T;
  if (method === "getReleaseBoard") return VIEW_BOARD as unknown as T;
  if (method === "listBackgroundJobs") return VIEW_JOBS as unknown as T;
  return stubRpc<T>(method, args);
};

const VIEW_TABS = [
  { slug: "deploy-health", title: "Deploy health", subtitle: null, version: 3, writtenAt: NOW - 36e5 },
  { slug: "coupon-drift", title: "Coupon drift", subtitle: null, version: 1, writtenAt: NOW - 72e5 },
];

/** Column C at its real width, so the agent tab group is seen where it lives:
 *  after the six host surfaces, behind a divider, marked with a sparkle. */
function ViewsFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] h-screen border-x p-border">
        <WorkSurface
          surface="view:deploy-health" onSurface={() => {}}
          agentViews={VIEW_TABS}
          pinnedPorts={[]} agentStatus={null} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTree={null} isStreaming={false}
          executors={[]} executorOutputs={new Map()}
          onExecute={async () => ({})}
          backgroundJobs={[]} onRefreshTasks={() => {}}
          rpc={viewRpc}
        />
      </div>
    </div>
  );
}

/** What the owner sees when the live spec no longer validates — the shape of a
 *  view whose file was rewritten on disk after it was published. */
function ViewFailFrame() {
  const failRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === "getAgentView") {
      return {
        ok: false,
        error: "view spec invalid — blocks.0.type: Invalid type: Expected (\"stat\" | \"table\" | \"list\" | \"kv\" | \"markdown\" | \"section\") but received \"html\"",
      } as unknown as T;
    }
    return viewRpc<T>(method, args);
  };
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] min-h-screen border-x p-border p-5">
        <AgentViewSurface slug="deploy-health" rpc={failRpc} />
      </div>
    </div>
  );
}

/** The renderer alone, wide, for reading the block vocabulary. */
function ViewBlocksFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] min-h-screen border-x p-border p-5">
        <AgentViewSurface slug="deploy-health" rpc={viewRpc} />
      </div>
    </div>
  );
}

/* ── Releases ───────────────────────────────────────────────────── */

// A board with one pending approval, so the row that carries the Approve button
// is the thing under the lens: the digest binds the source's deployTarget, and
// this frame is where you check that the owner can actually read it first.
const RELEASE_BOARD = {
  bindings: [{
    id: "src_1", kind: "local", label: "proteus", repoUrl: null, defaultBranch: "main",
    localDeviceId: null, localRoot: "~/Proteus", deployTarget: "bunx wrangler deploy --env production",
    createdAt: NOW - 9 * 864e5, updatedAt: NOW - 9 * 864e5,
  }],
  changes: [{
    id: "chg_4f2", bindingId: "src_1", agentName: "jarvis",
    userPrompt: "Warm up the empty-state copy", plan: "Rewrite the six EMPTY_HINTS in the owner's voice.",
    patch: "--- a/packages/cf-backend/src/components/surfaces/shared.tsx\n+++ b/packages/cf-backend/src/components/surfaces/shared.tsx\n@@\n-  memory: \"Your agent will remember important information here.\",\n+  memory: \"Anything worth keeping lands here. Ask me to remember something.\",",
    status: "awaiting_approval", previewUrl: null, commitSha: "a8d02b4f", createdAt: NOW - 36e5, updatedAt: NOW - 12e5,
  }],
  checks: [
    { id: "chk_1", changeId: "chg_4f2", name: "typecheck", status: "passed", exitCode: 0, output: null, createdAt: NOW - 30e5 },
    { id: "chk_2", changeId: "chg_4f2", name: "bun test", status: "passed", exitCode: 0, output: null, createdAt: NOW - 28e5 },
  ],
  approvals: [{
    id: "apr_1", changeId: "chg_4f2", approvalType: "deploy_production", decision: "pending",
    decidedBy: null, decidedAt: null, argumentDigest: "9f2c…", createdAt: NOW - 12e5,
  }],
  deployments: [],
};

const releaseRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getReleaseBoard") return RELEASE_BOARD as unknown as T;
  return stubRpc<T>(method, args);
};

function ReleasesFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[1100px] min-h-screen border-x p-border p-5">
        <ReleasesSurface rpc={releaseRpc} />
      </div>
    </div>
  );
}


/* ── Supervise ──────────────────────────────────────────────────── */

// The SUPERVISE altitude — the agent over time. Every block is fed so the type
// roles that carry it (`.p-meta` on the timestamps, the skill pills, the token
// counts) are actually on screen; an empty board photographs its empty states
// and tells you nothing about the scale it renders real rows at.
const SUPERVISE_TASKS = [
  {
    id: "cur_1", task: "Learn the checkout coupon schema well enough to fix the kind:null regression",
    rationale: "Three of the last five failures traced back to the same migration.",
    predictedSuccess: 0.72, targetsSkills: ["sql", "regression-triage"],
    proposedAt: NOW - 2 * 36e5, status: "pending",
  },
  {
    id: "cur_2", task: "Write a smoke check for the email-triage webhook",
    rationale: "The trigger has fired 41 times and nothing asserts its shape.",
    predictedSuccess: 0.44, targetsSkills: ["testing"],
    proposedAt: NOW - 9 * 36e5, status: "accepted",
  },
];

const SUPERVISE_RUNS = [
  {
    runId: "run_9c1", startedAt: NOW - 45 * 60e3, causedBy: "chat",
    userMessage: "Why does the percentage coupon drop off at checkout?",
    status: "completed", tokensIn: 184_320, tokensOut: 9_140, tokensCached: 121_400, eventCount: 62,
  },
  {
    runId: "run_9b7", startedAt: NOW - 6 * 36e5, causedBy: "timer",
    userMessage: null, status: "completed",
    tokensIn: 42_100, tokensOut: 1_880, tokensCached: 0, eventCount: 18,
  },
];

const SUPERVISE_TRIGGERS = [
  {
    id: "trg_wh1", kind: "webhook", state: "active", created_at: NOW - 12 * 864e5,
    spec: { path: "/hooks/deploy-failed" }, rate_limit_per_min: 30, fire_count: 41,
    last_fire_at: NOW - 3 * 36e5, next_fire_at: null,
  },
  {
    id: "trg_tm1", kind: "timer_cron", state: "active", created_at: NOW - 30 * 864e5,
    spec: { cron: "0 9 * * 1" }, fire_count: 4,
    last_fire_at: NOW - 3 * 864e5, next_fire_at: NOW + 4 * 864e5,
  },
];

const SUPERVISE_JOBS: BackgroundJob[] = [
  {
    id: "bgjob-71ae4c02", kind: "heads", label: "Audit the CLI surface", status: "running",
    result: null, error: null, createdAt: NOW - 4 * 60e3, settledAt: null,
  },
  {
    id: "bgjob-70bd19f7", kind: "mcts", label: "Pick a migration-backfill approach",
    status: "completed", result: "Settled on the backfill-on-read approach", error: null,
    createdAt: NOW - 50 * 60e3, settledAt: NOW - 41 * 60e3,
  },
];

const superviseRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listCurriculumTasks") return { tasks: SUPERVISE_TASKS } as unknown as T;
  if (method === "getRunSummaries") return SUPERVISE_RUNS as unknown as T;
  if (method === "listTriggers") return { triggers: SUPERVISE_TRIGGERS } as unknown as T;
  if (method === "listBackgroundJobs") return SUPERVISE_JOBS as unknown as T;
  return stubRpc<T>(method, args);
};

function SuperviseFrame() {
  return (
    <div className="p-bg p-text min-h-screen">
      <SupervisePage rpc={superviseRpc} onRunTask={() => {}} onOpenTasks={() => {}} />
    </div>
  );
}

function SelfFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[740px] border-x p-border min-h-screen p-5">
        <SelfSurface
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
  let entries = ["/"];
  if (frame === "shell") node = <Shell />;
  else if (frame === "modal") node = <GalleryModal />;
  else if (frame === "palette") node = <Palette />;
  else if (frame === "landing2") node = <LandingV2 />;
  else if (frame === "tabs") node = <TabsFrame />;
  else if (frame === "markdown") node = <MarkdownFrame />;
  else if (frame === "chat") node = <ChatFrame />;
  else if (frame === "panels") node = <SelfFrame />;
  else if (frame === "views") node = <ViewsFrame />;
  else if (frame === "viewblocks") node = <ViewBlocksFrame />;
  else if (frame === "viewfail") node = <ViewFailFrame />;
  else if (frame === "releases") node = <ReleasesFrame />;
  else if (frame === "supervise") node = <SuperviseFrame />;
  else if (frame === "settings") {
    const { default: SettingsPage } = await import("@/pages/SettingsPage");
    // Routed, not bare: the page reads `agentId` off the route, and every
    // back-link and breadcrumb it renders is built from it.
    entries = ["/workspace/checkout-fixes/settings"];
    node = (
      <Routes>
        <Route
          path="/workspace/:agentId/settings"
          element={<div className="min-h-screen p-bg p-text"><SettingsPage /></div>}
        />
      </Routes>
    );
  }
  else if (frame === "home") {
    const { default: HomePage } = await import("@/pages/HomePage");
    node = <div className="h-screen p-bg p-text"><HomePage /></div>;
  } else node = <All />;
  createRoot(document.getElementById("root")!).render(
    <StrictMode><MemoryRouter initialEntries={entries}>{node}</MemoryRouter></StrictMode>,
  );
}
void mount();
