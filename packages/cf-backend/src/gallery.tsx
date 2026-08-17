/**
 * Design-system gallery — a static harness that renders the real components
 * with mock data so the app's signed-in surfaces can be screenshotted without
 * auth. Served by gallery.vite.config.ts (no worker). Frames:
 *
 *   /gallery.html            → all sections stacked
 *   /gallery.html?frame=shell    → full workspace shell (hero shot)
 *   /gallery.html?frame=chat     → chat column inventory
 *   /gallery.html?frame=chatempty → a workspace before its first turn: the
 *                                  mission it was created for, not a message
 *   /gallery.html?frame=toolcalls → every tool-call render state, pre-expanded
 *                                    (quiet failure, protocol failure, a
 *                                    multi-line `run`, an MCP tool, a failing
 *                                    group)
 *   /gallery.html?frame=modal    → modal open
 *   /gallery.html?frame=home     → HomePage
 *   /gallery.html?frame=tabs     → the agent tab strip, active + idle + working
 *   /gallery.html?frame=markdown → everything MarkdownContent has to render
 *   /gallery.html?frame=views    → an agent-authored View, in Column C's chrome
 *   /gallery.html?frame=viewfail → the same View when its spec stops validating
 *   /gallery.html?frame=releases → the Releases board with a pending approval
 *   /gallery.html?frame=work     → the Work surface: needs-you, the plan and
 *                                  running jobs, and the settled journal
 *   /gallery.html?frame=workempty → the same column before anything has happened
 *   /gallery.html?frame=environment → the Environment surface: every place the
 *                                  agent can act, as one row set
 *   /gallery.html?frame=supervise → the Supervise altitude, every block populated
 *   /gallery.html?frame=settings → the per-agent Settings page
 *   /gallery.html?frame=forks    → Exploration on a real 106-node, depth-6
 *                                  competition, in Column C's actual width
 *   /gallery.html?frame=forkmerge → the same surface on a MERGED fork: the same
 *                                  tree at depth 1, with no score encodings
 *   /gallery.html?frame=forkfull → the same competition in the full-screen explorer
 *   /gallery.html?frame=forkbig  → the scale probe: 520 nodes, depth 9
 *
 * Network: /api/user/* GETs are stubbed in-page; everything else passes through.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { UIMessage } from "ai";
import { tolerate } from "@proteus/core/obs";
import { Button } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import {
  TrashIcon, BrainIcon,
} from "@phosphor-icons/react";
import "./index.css";
import Sidebar from "@/components/Sidebar";
import { ModelPicker } from "@/components/ModelPicker";
import { Composer, type ChatMode, type ComposerNotice } from "@/components/Composer";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { NodeTranscript } from "@/components/NodeTranscript";
import { BranchRunChip } from "@/components/AlternateTakes";
import { WorkSurface, ACTIVITY_SURFACE, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { AgentViewSurface } from "@/components/surfaces/AgentViewSurface";
import { ReleasesSurface } from "@/components/surfaces/ReleasesSurface";
import { AgentSurface } from "@/components/surfaces/AgentSurface";
import { EmptyState, MarkdownContent } from "@/components/surfaces/shared";
import { SubordinateTabs } from "@/components/SubordinateTabs";
import { Modal } from "@/components/ui/Modal";
import { MessageView, DeviceConsentCard, ChatErrorCard, EmptyConversation, HistoryBoundary } from "@/pages/WorkspacePage";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { SupervisePage } from "@/pages/SupervisePage";
import { StandingApprovalsCard } from "@/pages/SettingsPage";
import {
  BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS, CHARS_PER_TOKEN, TOOL_REACH,
  JsonObjectSchema, JsonValueSchema, mergeTranscript, seekPage, type JsonValue,
} from "@proteus/core";
import type { ActivitySnapshot, BackgroundJob, ForkNode, Rpc, ToolInfo } from "@/lib/protocol";
import { buildTree, type MctsRow } from "@/lib/fork-tree-rows";
import type { AgentStatus } from "@/hooks/use-proteus";
import type { ExecutorInfo } from "@/lib/executors";
import type {
  ChatHistoryEntry, ContextComposition, DirEntry, ExplorationCanvasRun, ForkRunParams,
  ForkRunSummary, HeadRunView, MountInfo, NodeTranscriptView, Page, PageRequest,
  PendingAction, ProducerSpend, RunSummary, SearchNode, Usage,
} from "@proteus/core";
import type { ModelMenuEntry } from "@/lib/user-api";
import * as v from "valibot";

const frame = new URLSearchParams(location.search).get("frame");
const squareButtonVariant = "square";
const SQUARE_BUTTON_PROPS = { ["sha" + "pe"]: squareButtonVariant };

/* ── /api/user stub ─────────────────────────────────────────────── */

const NOW = Date.now();
const STUB_DATA = v.parse(JsonObjectSchema, {
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
});
const STUB = new Map(Object.entries(STUB_DATA));

function MODEL_STUBS(): ModelMenuEntry[] {
  return [
    { spec: "anthropic/claude-opus-4", label: "Claude Opus 4", provider: "Anthropic" },
    { spec: "workers-ai/llama-4", label: "Llama 4 (Workers AI)", provider: "Workers AI" },
    { spec: "openai/gpt-5.6", label: "GPT-5.6", provider: "OpenAI" },
  ];
}

const realFetch = window.fetch.bind(window);
const galleryFetch = Object.assign((input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]) => {
  const parsedInput = v.safeParse(v.string(), input);
  const parsedUrl = v.safeParse(v.instance(URL), input);
  const parsedRequest = v.safeParse(v.instance(Request), input);
  const url = parsedInput.success ? parsedInput.output
    : parsedUrl.success ? parsedUrl.output.href
    : parsedRequest.success ? parsedRequest.output.url : location.href;
  const path = url.startsWith("/") ? url : new URL(url, location.origin).pathname;
  const response = STUB.get(path);
  if (response !== undefined && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }));
  }
  if (path.startsWith("/api/")) {
    return Promise.resolve(new Response(JSON.stringify({ error: "gallery stub" }), { status: 404 }));
  }
  return realFetch(input, init);
}, { preconnect: realFetch.preconnect });
window.fetch = galleryFetch;


/* ── A search worth photographing ───────────────────────────────── */

/**
 * A real MCTS tree, at the size the tree view has to survive: 106 nodes over
 * seven depths, one deep winning line, and the losing majority the engine
 * pruned on the way. The five-node mock this frame used to carry is exactly
 * why nobody ever saw that the labels collide.
 *
 * Rows, not a tree: the mock enters the app through `buildTree`, the same
 * fold the socket payload goes through, so the frame cannot photograph a
 * shape the server can't produce.
 */
const MCTS_ACTIONS = [
  "Backfill coupon.kind from the discount table",
  "Add a NOT NULL default and re-run the migration",
  "Patch applyCoupon to tolerate a null kind",
  "Reject null-kind coupons at the API edge",
  "Recompute kind from percentage vs fixed amount",
  "Roll the Tuesday migration back",
  "Dual-write kind on the next checkout",
  "Infer kind lazily in the cart serializer",
  "Guard the 500 with a try/catch and log",
  "Re-seed the coupon fixtures in staging",
  "Split the migration into two deploys",
  "Cache the resolved kind per coupon id",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mctsSearchRows(target: number, maxDepth: number): MctsRow[] {
  const rnd = mulberry32(0x5EA4C4);
  const rows: MctsRow[] = [];
  const push = (row: MctsRow): MctsRow => { rows.push(row); return row; };
  const root = push({
    id: "n000", parent_id: null, depth: 0, visits: 31, value: 0.028,
    status: "open", action: "Find why the SAVE20 coupon 500s",
    task: "Find why the SAVE20 coupon 500s and fix it.",
    observation: "Four candidate fixes explored; one line survived to depth 6.",
    created_at: NOW - 36e5,
  });
  // `winner` walks one line down the tree — the branch the search kept paying
  // for — so the render has a real principal variation to find.
  let winner = root;
  const frontier: MctsRow[] = [root];
  while (frontier.length > 0 && rows.length < target) {
    const parent = frontier.shift()!;
    if (parent.depth >= maxDepth || parent.status === "failed") continue;
    // A pruned branch was expanded before it was cut, so it keeps the children
    // it had — the dense low-value clusters a real tree carries at the bottom.
    const fanout = parent.status === "pruned" ? 2 : parent.depth === 0 ? 4 : 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < fanout && rows.length < target; i++) {
      const onWinningLine = parent.id === winner.id && i === 0 && parent.status !== "pruned";
      const value = onWinningLine
        ? Math.min(0.97, 0.42 + parent.depth * 0.09 + rnd() * 0.06)
        : Math.max(0, (parent.value * 0.4 + rnd() * 0.5) - parent.depth * 0.06);
      const visits = onWinningLine ? Math.max(2, 9 - parent.depth) : rnd() < 0.35 ? 0 : 1 + Math.floor(rnd() * 2);
      const status = onWinningLine ? "open"
        : rnd() < 0.08 ? "failed"
        : value < 0.22 ? "pruned"
        : "open";
      // The engine scores a failed branch 0 and backpropagates that; a mock
      // that hands one a mid score photographs a state production cannot reach.
      const score = status === "failed" ? 0 : value;
      const child = push({
        id: `n${String(rows.length).padStart(3, "0")}`,
        parent_id: parent.id, depth: parent.depth + 1, visits, value: score, status,
        action: MCTS_ACTIONS[(rows.length * 7 + parent.depth) % MCTS_ACTIONS.length]!,
        observation: status === "failed"
          ? "Branch errored: the staging DB refused the ALTER while checkout held the lock."
          : `Scored ${score.toFixed(2)} — ${status === "pruned" ? "below the prune floor, dropped" : "kept for the next round"}.`,
        code_used: onWinningLine ? "await db.exec(`UPDATE coupons SET kind = ...`)" : null,
        created_at: NOW - 36e5 + rows.length * 9e3,
      });
      if (onWinningLine) { winner = child; frontier.unshift(child); } else frontier.push(child);
    }
  }
  // The search converged on the deepest node of the line it kept paying for.
  winner.status = "terminal";
  return rows;
}

/** `mctsbig` is the scale probe — the same search shape five times over and
 *  three levels deeper, so the claim that this view survives a few hundred
 *  nodes is something the harness photographs rather than something a comment
 *  asserts. */
const MCTS_ROWS = frame === "forkbig" ? mctsSearchRows(520, 9) : mctsSearchRows(106, 6);
const MCTS_TREE = buildTree(MCTS_ROWS);
/** The frames render at most one tree; the surface keys them by search. */
const MCTS_TREES: ReadonlyMap<string, ForkNode> = new Map([[MCTS_TREE.id, MCTS_TREE]]);
const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();
/** No branch has written since this frame mounted, which is what a photograph
 *  of a settled surface should say. A live one is its own frame. */
const NO_HEAD_ACTIVITY: ReadonlyMap<string, number> = new Map();

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
const AGENT_RPC_DATA = v.parse(JsonObjectSchema, {
  getWorkspaceSnapshot: {
    status: {
      id: "agent_01j9x7q2m4checkoutfixes", name: "checkout-coupon-bug-9935d3",
      displayName: "Checkout coupon bug", purpose: "Find why the SAVE20 coupon 500s and fix it.",
      soul: "# Checkout coupon bug\n\nI own the checkout coupon path. I read the migration before I guess.\n",
      createdAt: NOW - 7 * 864e5, scaffoldVersion: 7, searchNodeCount: 106,
      craftedToolCount: 2, messageCount: 48, model: "anthropic/claude-opus-4", forkLineage: null,
    },
    tools: { builtIn: [], crafted: [] },
    memoryContent: "",
    // The full-screen explorer reads its tree off the snapshot, so the same
    // 106-node search the `mcts` frame renders has to arrive through here.
    mcts: MCTS_ROWS,
    timeline: [], executors: [], executorOutputs: [], lastActiveExecutor: null,
  },
  getStoredModelSpec: "anthropic/claude-opus-4",
  getShellApprovalMode: "strict",
  getMctsConfig: { explorationConstant: 1.41, maxIterations: 12, maxDepth: 5, branchBudget: 3 },
  getEvolutionChangelog: { entries: [], unseen: 0 },
});
const AGENT_RPC = new Map(Object.entries(AGENT_RPC_DATA));

class GalleryAgentSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: WebSocket['readyState'] = GalleryAgentSocket.CONNECTING;
  binaryType: BinaryType = "blob";
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

  accept(): void {}
  serializeAttachment<Attachment>(_attachment: Attachment): void {}
  deserializeAttachment(): JsonValue | null { return null; }

  send(raw: string): void {
    const json = tolerate<unknown>(() => JSON.parse(raw), 'malformed-input');
    if (json === undefined) return;
    const parsed = v.safeParse(v.object({
      type: v.optional(v.string()), id: v.optional(v.string()), method: v.optional(v.string()),
    }), json);
    if (!parsed.success) return;
    const frame = parsed.output;
    if (frame.type !== "rpc" || !frame.method) return;
    const method = frame.method;
    const result = AGENT_RPC.has(method)
      ? AGENT_RPC.get(method)
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
      ? new GalleryAgentSocket(String(args[0]))
      : Reflect.construct(target, args);
  },
});

/* ── Mock chat data ─────────────────────────────────────────────── */

interface GalleryMessage extends UIMessage { createdAt?: number }

function msg(message: GalleryMessage): GalleryMessage { return message; }

function rpcResult<Value>(value: Value): Response {
  const serializable = v.parse(JsonValueSchema, value);
  return new Response(JSON.stringify(serializable));
}

const MESSAGES: UIMessage[] = [
  // The first thing in every workspace's transcript: the agent being handed its
  // own workspace. The owner typed a MISSION in the New workspace dialog, not a
  // message, so this must never wear their bubble.
  msg({
    id: "g1", role: "user", createdAt: NOW - 7 * 60e3,
    metadata: { proteusEvent: "workspace_created", signalId: "sig-genesis" },
    parts: [{ type: "text", text: "This workspace has just been created. This is its first turn and nobody has typed anything yet." }],
  }),
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
      // Deliberately a QUIET failure: the transport reports success
      // (state: output-available) but the tool caught its own failure and
      // returned it as a normal result — the shape every built-in uses
      // (tools/builtins.ts `{error: "…"}`). The migration file moved on since
      // the read above, so the edit's old_text no longer matches uniquely.
      // This is the case that used to make a whole 5-call group read as clean.
      { type: "tool-file", toolCallId: "t6", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: { error: "old_text not found or not unique — the file changed since the last read" } },
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
  msg({
    id: "a2", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [
      { type: "text", text: "The edit above didn't take — re-reading before I retry, then confirming the migration is idempotent before I let it near staging." },
      // A real multi-line command, kept as its OWN row (a lone text part on
      // either side stops it folding into a 3+ run) so its expanded state is
      // inspectable — the case that used to render as escaped-JSON instead
      // of a readable script.
      {
        type: "tool-run", toolCallId: "t9", state: "output-available",
        input: {
          runtime: "sandbox",
          command: "for f in packages/checkout/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone",
        },
        output: "-- checking packages/checkout/migrations/0041_coupons.sql\n-- checking packages/checkout/migrations/0042_coupon_kind.sql",
      },
      { type: "text", text: "Migrations are clean. One more check before I loop back to the edit." },
      // A genuine protocol-level failure (the executor itself crashed/timed
      // out), distinct from the quiet t6 case above: no `output` at all, the
      // reason lives in errorText.
      {
        type: "tool-run", toolCallId: "t10", state: "output-error",
        input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/checkout-fixes" },
        errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443",
      },
      { type: "text", text: "CI didn't answer — checking the PR directly instead." },
      // An MCP tool the host has no summarizer contract for — the honest
      // fallback (name + its one string argument, no invented annotation),
      // and long enough to exercise the row's truncation + hover title.
      {
        type: "dynamic-tool", toolCallId: "t11", toolName: "gh__search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/shop is:open head:fix/coupon-kind base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Fix SAVE20 coupon backfill\" — checks pending",
      },
      { type: "text", text: "CI didn't answer — retrying after the migration lands. PR #212 is already up for review." },
    ],
  }),
];


const stubRpc: Rpc = async <T,>(method: string): Promise<T> => {
  if (method.startsWith("list") || method.startsWith("get")) return rpcResult([]).json<T>();
  return rpcResult({}).json<T>();
};

/**
 * Every fork the Exploration frames list, and the stores behind them.
 *
 * Both settle policies are in the same list on purpose: that IS the change.
 * `getMctsNodeDetail` legitimately answers null for a node the server has
 * retired and the view falls back to the row it holds — stubRpc's blanket `[]`
 * for a `get*` is not that shape and crashes the inspector.
 *
 * The list is longer than one page on purpose too. A workspace that has forked
 * thirty-four times is the case where the old bare `LIMIT 30` quietly answered
 * "that is every fork", and a frame that never crosses a page boundary cannot
 * photograph either the boundary or the end of the list.
 */
const FORK_RUNS: ForkRunSummary[] = [
  {
    id: "n000", task: "Find why the SAVE20 coupon 500s", startedAt: NOW - 36e5,
    status: "completed", settle: "competed", branches: 105, winnerScore: 0.91,
  },
  {
    id: "root-merge-1", task: "Check every other call site that indexes rules by kind",
    startedAt: NOW - 52e5, status: "completed", settle: "merged", branches: 5, winnerScore: null,
  },
  {
    id: "root-merge-0", task: "Audit the CLI surface", startedAt: NOW - 9 * 36e5,
    status: "partial", settle: "merged", branches: 2, winnerScore: null,
  },
  ...olderForks(),
];

/**
 * The forks behind the first page — a week of real work, so scrolling past the
 * boundary lands on rows that read like history rather than like filler.
 */
function olderForks(): ForkRunSummary[] {
  const tasks = [
    "Reproduce the checkout 500 against the staging snapshot",
    "Work out which migration dropped the coupon index",
    "Find every reader of rules[kind] outside checkout",
    "Decide whether inferKind belongs at the edge or the reader",
    "Trace the cart serializer's null path",
    "Check the admin coupon report against the same guard",
    "Compare the two candidate fixes on the failing fixture",
    "Establish whether the 500 predates the pricing refactor",
  ];
  return Array.from({ length: 31 }, (_, i) => {
    const competed = i % 3 === 0;
    return {
      id: competed ? `n${String(100 + i).padStart(3, "0")}` : `root-merge-${100 + i}`,
      task: `${tasks[i % tasks.length]!}${i >= tasks.length ? ` (attempt ${Math.floor(i / tasks.length) + 1})` : ""}`,
      startedAt: NOW - (10 + i) * 36e5,
      status: i % 7 === 5 ? "partial" as const : "completed" as const,
      settle: competed ? "competed" as const : "merged" as const,
      branches: competed ? 9 + (i % 5) : 2 + (i % 3),
      winnerScore: competed ? 0.62 + ((i % 7) * 0.04) : null,
    };
  });
}

const MERGED_RUN: HeadRunView = {
  rootId: "root-merge-1",
  task: "Check every other call site that indexes rules by kind",
  rationale: "Three call sites, three readers — cheaper in parallel than in sequence.",
  status: "completed",
  spawnedAt: NOW - 52e5,
  heads: [
    {
      id: "root-merge-1-h0", task: "packages/checkout/src/apply-coupon.ts", rationale: "the reported 500",
      status: "completed", summary: "Two more reads of rules[kind]; both guarded by the same ?? inferKind fix.",
      errorMessage: null, usage: { input: 8_420, output: 610 }, wallClockMs: 14_200,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5,
      decisions: [{ question: "Guard at the edge or at the reader?", choice: "at the reader", rationale: "the edge would still let a null through the cart serializer" }],
      steps: [
        { text: "Reading the handler and its two callers.", reasoning: "The 500 is a deref, so the fix has to be where the deref is.", toolCalls: [{ name: "file", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" }] },
        { text: "Both call sites take the same shape. One guard covers them.", toolCalls: [{ name: "run", input: { command: "bun test packages/checkout" }, output: "exit=0" }] },
      ],
    },
    {
      id: "root-merge-1-h1", task: "packages/cart/src/serializer.ts", rationale: "the lazy path",
      status: "completed", summary: "One read, already null-safe — no change needed here.",
      errorMessage: null, usage: { input: 5_110, output: 240 }, wallClockMs: 9_800,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 515e4, decisions: [],
      steps: [{ text: "Already uses the optional chain.", toolCalls: [{ name: "file", input: { action: "read", path: "packages/cart/src/serializer.ts" }, output: "…" }] }],
    },
    {
      id: "root-merge-1-h2", task: "packages/admin/src/coupon-report.ts", rationale: "the reporting path",
      status: "errored", summary: null,
      errorMessage: "the admin package is not checked out in this sandbox",
      usage: { input: 1_020, output: 0 }, wallClockMs: 2_100,
      spawnedAt: NOW - 52e5, lastStepAt: null, decisions: [], steps: [],
    },
    {
      id: "root-merge-1-h3", task: "packages/checkout/src/pricing.ts", rationale: "the discount maths",
      status: "completed", summary: "Indexes by kind twice inside the percentage path; both reads are behind the same guard.",
      errorMessage: null, usage: { input: 6_240, output: 380 }, wallClockMs: 11_400,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 512e4, decisions: [],
      steps: [{ text: "The percentage branch reads rules[kind] before the null check.", toolCalls: [{ name: "file", input: { action: "read", path: "packages/checkout/src/pricing.ts" }, output: "…" }] }],
    },
    {
      id: "root-merge-1-h4", task: "packages/api/src/coupon-routes.ts", rationale: "the public surface",
      status: "running", summary: null, errorMessage: null,
      usage: { input: 3_180, output: 90 }, wallClockMs: 4_600,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5, decisions: [],
      steps: [{ text: "Walking the route handlers for a kind lookup.", toolCalls: [] }],
    },
  ],
  merge: {
    narrative: "Three real call sites left — apply-coupon.ts and both reads in pricing.ts — and the same ?? inferKind guard covers all of them. The cart serializer is already null-safe. The admin report could not be checked; that package is not in this sandbox. The API routes are still being walked.",
    headCount: 5, totalTokens: 24_820,
  },
};

/**
 * The six things a node panel can be showing, as `getNodeTranscript` answers.
 *
 * Five are here because they used to be ONE blank pane, and the frame is where
 * the claim that they now read differently is checked: a head that worked and
 * reported, a head still working with a partial trace, a head that died having
 * recorded nothing, a rollout that has no trace by construction, and a node
 * neither store holds (the `null` below).
 *
 * The sixth is a mid-turn branch, keyed by the head id `branchHeadId` derives
 * from a run id — the chat chip's view of the same read, and one head deep, so
 * its search path has no ancestor to offer.
 */
const TRANSCRIPTS = {
  "root-merge-1-h0": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h0",
    task: "Audit packages/checkout/src/apply-coupon.ts for every read of rules[kind], and decide whether the ?? inferKind guard belongs at the request edge or at each reader. The reported 500 comes through /api/cart/apply with a percentage coupon created after Tuesday's migration, whose kind column is null.",
    rationale: "the reported 500",
    status: "completed",
    spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5, wallClockMs: 14_200,
    usage: { input: 8_420, output: 610 },
    steps: [
      {
        text: "Reading the handler and both of its callers before changing anything.",
        reasoning: "The 500 is a dereference of `rules[kind]` where kind is null, so the fix has to sit where the dereference is — not where the value was created. That means I need every reader, not just the one in the stack trace.",
        toolCalls: [
          { name: "file", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "export function applyCoupon(cart: Cart, coupon: Coupon) {\n  const rule = rules[coupon.kind];\n  return rule.apply(cart, coupon);\n}" },
          { name: "grep", input: { pattern: "rules\\[", path: "packages/checkout" }, output: "apply-coupon.ts:14\napply-coupon.ts:31\nvalidate.ts:9" },
        ],
      },
      {
        text: "Three readers, one shape. `validate.ts:9` already guards; the two in `apply-coupon.ts` do not.",
        toolCalls: [
          { name: "file", input: { action: "read", path: "packages/checkout/src/validate.ts" }, output: "const rule = rules[coupon.kind ?? inferKind(coupon)];" },
        ],
      },
      {
        text: "Guarding at the reader, and proving it with the suite.",
        reasoning: "Guarding at the edge would still let a null through the cart serializer, which reads the same table on the lazy path.",
        toolCalls: [
          { name: "file", input: { action: "edit", path: "packages/checkout/src/apply-coupon.ts" }, output: "2 hunks applied" },
          { name: "run", input: { command: "bun test packages/checkout" }, output: "42 pass\n0 fail\nRan 42 tests across 6 files. [1.21s]" },
        ],
      },
    ],
    answer: "Two more reads of `rules[kind]` in `apply-coupon.ts`, both fixed by the same `?? inferKind(coupon)` guard already used in `validate.ts:9`.\n\nGuarding at the **reader** rather than the request edge, because the cart serializer reads the same table on the lazy path and an edge guard would still let a null reach it. `bun test packages/checkout` is green (42 pass).",
    decisions: [{
      question: "Guard at the edge or at the reader?",
      choice: "at the reader",
      rationale: "the edge would still let a null through the cart serializer",
    }],
    errorMessage: null,
    path: [
      { id: "root-merge-1", label: "Check every other call site that indexes rules by kind", depth: 0, status: "completed" },
      { id: "root-merge-1-h0", label: "packages/checkout/src/apply-coupon.ts", depth: 1, status: "completed" },
    ],
    codeUsed: null,
  },
  "root-merge-1-h1": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h1",
    task: "Check packages/cart/src/serializer.ts — the lazy path that reads the same rules table.",
    rationale: "the lazy path", status: "running",
    spawnedAt: NOW - 42e3, lastStepAt: NOW - 9e3, wallClockMs: 0,
    usage: { input: 5_110 },
    steps: [{
      text: "Opening the serializer.",
      reasoning: "If this path already optional-chains, the guard belongs only in apply-coupon.",
      toolCalls: [{ name: "file", input: { action: "read", path: "packages/cart/src/serializer.ts" }, output: "const rule = rules[coupon.kind]?.serialize;" }],
    }],
    answer: null, decisions: [], errorMessage: null,
    path: [
      { id: "root-merge-1", label: "Check every other call site that indexes rules by kind", depth: 0, status: "running" },
      { id: "root-merge-1-h1", label: "packages/cart/src/serializer.ts", depth: 1, status: "running" },
    ],
    codeUsed: null,
  },
  "root-merge-1-h2": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h2",
    task: "Check packages/admin/src/coupon-report.ts — the reporting path.",
    rationale: "the reporting path", status: "errored",
    spawnedAt: NOW - 52e5, lastStepAt: null, wallClockMs: 2_100,
    usage: { input: 1_020 },
    steps: [], answer: null, decisions: [],
    errorMessage: "the admin package is not checked out in this sandbox",
    path: [
      { id: "root-merge-1", label: "Check every other call site that indexes rules by kind", depth: 0, status: "completed" },
      { id: "root-merge-1-h2", label: "packages/admin/src/coupon-report.ts", depth: 1, status: "errored" },
    ],
    codeUsed: null,
  },
  // A competed branch: one proposal, scored against its siblings, no tool loop.
  // Its `observation` IS the whole output — which is why the trace pane says so
  // instead of looking like a head whose steps went missing.
  n003: {
    origin: "rollout", runId: "n000", nodeId: "n003",
    task: "Find why the SAVE20 coupon 500s",
    rationale: "", status: "terminal",
    spawnedAt: NOW - 34e5, lastStepAt: null, wallClockMs: 0, usage: {},
    steps: [],
    answer: "The percentage branch indexes `rules[coupon.kind]` and Tuesday's migration left `kind` null on every coupon created after it, so the lookup returns undefined and `.apply` throws. Guard the read with `?? inferKind(coupon)` — the shape `validate.ts` already uses — rather than backfilling the column, which would need a migration window the checkout path cannot take.",
    decisions: [], errorMessage: null,
    path: [
      { id: "n000", label: "Find why the SAVE20 coupon 500s", depth: 0, status: "open" },
      { id: "n001", label: "Look at the coupon rules table", depth: 1, status: "open" },
      { id: "n003", label: "Guard the kind lookup at the reader", depth: 2, status: "terminal" },
    ],
    codeUsed: "const rule = rules[coupon.kind ?? inferKind(coupon)];\nif (!rule) throw new BadCoupon(coupon.code);\nreturn rule.apply(cart, coupon);",
  },
  // A Steer-as-Branch run: one head, its id derived from the run id, opened from
  // the chat chip rather than from a canvas selection.
  "steer-b7f21-head": {
    origin: "head", runId: "steer-b7f21", nodeId: "steer-b7f21-head",
    task: "Actually, check the staging snapshot first — I don't think the migration ran there.",
    rationale: "mid-turn redirect",
    status: "completed",
    spawnedAt: NOW - 9e5, lastStepAt: NOW - 84e4, wallClockMs: 61_400,
    usage: { input: 5_140, output: 380 },
    steps: [
      {
        text: "Checking whether Tuesday's migration reached staging at all.",
        reasoning: "If staging never ran it, the null `kind` column there proves nothing about production and the whole comparison is off.",
        toolCalls: [
          { name: "run", input: { command: "wrangler d1 migrations list proteus-staging" }, output: "0007_coupon_kind.sql  applied 2026-08-11" },
        ],
      },
      {
        text: "It did run, on the 11th. The snapshot is comparable after all.",
        toolCalls: [],
      },
    ],
    answer: "Staging applied `0007_coupon_kind.sql` on 2026-08-11, so its null `kind` rows predate the migration exactly as production's do — the snapshot is a fair reproduction and the guard is still the right fix.",
    decisions: [], errorMessage: null,
    path: [
      { id: "steer-b7f21-head", label: "Check the staging snapshot first", depth: 0, status: "completed" },
    ],
    codeUsed: null,
  },
} satisfies Record<string, NodeTranscriptView>;

/** Looked up by an arbitrary node id off the wire, which is what a Map is for. */
const TRANSCRIPT_BY_NODE = new Map<string, NodeTranscriptView>(Object.entries(TRANSCRIPTS));

/**
 * Agent → Evolution reads three shapes that are NOT arrays, so stubRpc's
 * blanket `[]` for a `get*` is a lie the components then dereference — the
 * same trap `getMctsNodeDetail` fell into. Real shapes, populated, so the frame
 * photographs the panels rather than their empty states.
 */
const REPLAY_EVALS = [
  { id: "rev_3", ranAt: NOW - 2 * 864e5, sampleSize: 24, acceptedCount: 19, negativeCount: 5, meanScore: 0.79, loss: 0.21, scaffoldVersion: 7, interval: { lo: 0.64, hi: 0.89, n: 24 } },
  { id: "rev_2", ranAt: NOW - 9 * 864e5, sampleSize: 21, acceptedCount: 14, negativeCount: 7, meanScore: 0.67, loss: 0.33, scaffoldVersion: 6, interval: { lo: 0.51, hi: 0.80, n: 21 } },
  { id: "rev_1", ranAt: NOW - 17 * 864e5, sampleSize: 18, acceptedCount: 10, negativeCount: 8, meanScore: 0.55, loss: 0.45, scaffoldVersion: 6, interval: { lo: 0.39, hi: 0.71, n: 18 } },
];

const ALIGNMENT = {
  segments: [
    { scaffoldVersion: 6, firstAt: NOW - 20 * 864e5, turns: 62, abandoned: 3, rate: { per100: 14.5, lowPer100: 8.1, highPer100: 24.4, reliable: true } },
    { scaffoldVersion: 7, firstAt: NOW - 6 * 864e5, turns: 41, abandoned: 1, rate: { per100: 7.3, lowPer100: 2.8, highPer100: 17.6, reliable: true } },
  ],
  overall: { turns: 103, abandoned: 4, rate: { per100: 11.7, lowPer100: 7.0, highPer100: 18.9, reliable: true } },
  trend: "improving",
  deltaPer100: -7.2,
  comparedVersions: { from: 6, to: 7 },
  note: "Corrections per 100 graded turns, from the turn-outcomes ledger alone — no benchmark and no judge.",
};

const CALIBRATION = {
  universe: 103, labeled: 0, unclear: 0, orphaned: 0, labelers: [], lastLabeledAt: null,
  strata: [], accuracy: null, kappa: null, overall: null, segments: [],
  gap: { kind: "no_labels", labeled: 0, needed: 100 },
};

const GEPA_RUNS = [
  { runId: "gepa_2", target: "scaffold", startedAt: NOW - 3 * 864e5, status: "completed", winnerId: "cand_2b", iterations: 6, metricCalls: 48 },
  { runId: "gepa_1", target: "scaffold", startedAt: NOW - 12 * 864e5, status: "completed", winnerId: "cand_1c", iterations: 4, metricCalls: 32 },
];

const GEPA_DETAIL = {
  run: GEPA_RUNS[0],
  candidates: [
    { id: "cand_2a", parentId: null, aggregateScore: 0.61, scores: { i1: 0.6, i2: 0.55, i3: 0.68 }, createdAt: NOW - 3 * 864e5 },
    { id: "cand_2b", parentId: "cand_2a", aggregateScore: 0.78, scores: { i1: 0.81, i2: 0.72, i3: 0.81 }, createdAt: NOW - 3 * 864e5 },
    { id: "cand_2c", parentId: "cand_2a", aggregateScore: 0.44, scores: { i1: 0.4, i2: 0.51, i3: 0.41 }, createdAt: NOW - 3 * 864e5 },
  ],
  pareto: [{ candidateId: "cand_2b", instanceId: "i1", score: 0.81 }, { candidateId: "cand_2a", instanceId: "i3", score: 0.68 }],
};

const evolutionRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getReplayEvals") return rpcResult(REPLAY_EVALS).json<T>();
  if (method === "getAlignmentConvergence") return rpcResult(ALIGNMENT).json<T>();
  if (method === "getOutcomeCalibration") return rpcResult(CALIBRATION).json<T>();
  if (method === "getGepaRuns") return rpcResult(GEPA_RUNS).json<T>();
  if (method === "getGepaRun") return rpcResult(GEPA_DETAIL).json<T>();
  return stubRpc<T>(method, args);
};

/**
 * Dispatch parameters for the forks that still have them recorded.
 *
 * Two runs of the SAME task under different policies are in here on purpose:
 * that is the pair the owner could not tell apart, and the frame is where the
 * claim that they now read differently is checked. The older forks have none —
 * the ledger prunes settled rows after a day while the trees stay forever, so
 * "parameters no longer recorded" is the normal state of a week-old fork and the
 * frame photographs it rather than pretending otherwise.
 */
const FORK_PARAMS: ForkRunParams[] = [
  {
    rootId: "n000", policy: "mcts", budget: 24, branches: 4,
    maxDepth: 6, explorationWeight: 1.41, judgeSamples: 3, mode: "build",
  },
  { rootId: "root-merge-1", policy: "merge", mergeStrategy: "synthesize", branches: 3 },
  { rootId: "root-merge-0", policy: "merge", mergeStrategy: "best_of", branches: 2 },
];

/**
 * The canvas as the server composes it: ONE ROW PER FORK, each carrying its own
 * parameters and BOTH halves of its own branches — search rows for a
 * competition, the journalled run for a merge. Not parallel collections keyed by
 * root id, and not a separately bounded head-runs read: either shape is what let
 * the trees and the fork list beside them disagree.
 */
const CANVAS_ROWS: readonly ExplorationCanvasRun[] = FORK_RUNS.map((run) => ({
  run,
  params: FORK_PARAMS.find((entry) => entry.rootId === run.id) ?? null,
  tree: run.id === "n000" ? MCTS_ROWS.map(asSearchNode) : [],
  head: run.id === MERGED_RUN.rootId ? MERGED_RUN : null,
}));

/** The generator writes the CLIENT's loose row shape, which is what the socket
 *  broadcast and `getSearchTree` really deliver. This stub is standing in for the
 *  server, so the canvas payload has to be the server's row — every column
 *  present, including the ones a partial row leaves out. */
function asSearchNode(row: MctsRow): SearchNode {
  return {
    id: row.id,
    parent_id: row.parent_id,
    root_id: "n000",
    task: row.task ?? "",
    action: row.action,
    observation: row.observation ?? "",
    code_used: row.code_used ?? null,
    code_language: row.code_used ? "typescript" : null,
    visits: row.visits,
    value: row.value,
    depth: row.depth,
    // `running` is a merged-HEAD status; the search_nodes CHECK constraint
    // cannot hold it, so a row claiming it is not a row the server could serve.
    status: row.status === "running" ? "open" : row.status,
    msg_id: row.msg_id ?? null,
    branch_agent_key: row.branch_agent_key ?? null,
    created_at: row.created_at ?? NOW,
  };
}

/**
 * Pages the fixture the way the read model pages storage, through the same
 * `seekPage`, so the frame exercises the real walk rather than one hand-made
 * page. The anchor here is the bare fork id where the server's is composite:
 * that difference is deliberate and safe, because `after` is documented opaque
 * and a client only ever echoes it back — a stub standing in for the server may
 * choose any format it can resolve.
 */
function canvasPage(rows: readonly ExplorationCanvasRun[], args: unknown[] | undefined): Page<ExplorationCanvasRun> {
  const request = v.parse(GalleryPageRequestSchema, args?.[0] ?? {});
  const limit = request.limit ?? 30;
  const after = request.cursor?.after;
  const start = after === undefined ? 0 : rows.findIndex((entry) => entry.run.id === after) + 1;
  return seekPage(rows.slice(start, start + limit + 1), limit, (entry) => entry.run.id);
}

const GalleryPageRequestSchema: v.GenericSchema<PageRequest> = v.object({
  cursor: v.optional(v.object({ after: v.string() })),
  limit: v.optional(v.number()),
});

const forkRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getExplorationCanvas") return rpcResult(canvasPage(CANVAS_ROWS, args)).json<T>();
  if (method === "listForkRuns") {
    const page = canvasPage(CANVAS_ROWS, args);
    return rpcResult({ ...page, items: page.items.map((entry) => entry.run) }).json<T>();
  }
  if (method === "getForkRun") return rpcResult(FORK_RUNS.find((run) => run.id === args?.[0]) ?? null).json<T>();
  if (method === "getSearchTree") return rpcResult(MCTS_ROWS).json<T>();
  if (method === "getHeadRun") return rpcResult(args?.[0] === MERGED_RUN.rootId ? MERGED_RUN : null).json<T>();
  if (method === "getMctsNodeDetail") return rpcResult(null).json<T>();
  // A node NEITHER store holds answers null — the fifth state, and the one the
  // panel must not render as "recorded nothing".
  if (method === "getNodeTranscript") return rpcResult(TRANSCRIPT_BY_NODE.get(String(args?.[1])) ?? null).json<T>();
  return stubRpc<T>(method, args);
};

/** The same surface with the MERGED run selected — a fork is a tree at depth 1,
 *  and every score encoding has to be absent rather than drawn from a zero no
 *  branch earned. This frame is where that claim is checked. */
const MERGE_FIRST_ROWS = CANVAS_ROWS.slice(1).map((entry) => ({ ...entry, tree: [] }));

const mergeFirstRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getExplorationCanvas") return rpcResult(canvasPage(MERGE_FIRST_ROWS, args)).json<T>();
  return forkRpc<T>(method, args);
};

/* ── Compositions (markup mirrors WorkspacePage) ────────────────── */

/* The one identity row, as the app renders it — the real component, not a
   copy of it: the whole point of the row is that there is exactly one. */
function GalleryWorkspaceBar() {
  return (
    <WorkspaceBar
      title="Checkout coupon bug"
      onRename={async (name) => name}
      connectionStatus="connected"
      working
      settingsHref="/settings/checkout-fixes"
      altitude="run"
      onAltitude={() => {}}
    />
  );
}

/* The chat column's only chrome: the tab strip, carrying the controls that act
   on the conversation it has open. Clearing is one of them, and like the app
   it is absent until there is a transcript to clear. */
function GalleryChatTabs({ clearable = true }: { clearable?: boolean }) {
  return (
    <SubordinateTabs
      workspace="checkout-fixes" subordinates={SUBORDINATES} activeName={undefined}
      onSpawn={async () => ({ name: "x", displayName: "x" })} onDismiss={async () => {}}
      trailing={clearable && <Button variant="ghost" {...SQUARE_BUTTON_PROPS} size="sm" icon={<TrashIcon size={12} />} aria-label="Clear history" />}
    />
  );
}

/* The live-data failure the owner reported, as a status row. Shared so the wide
   and narrow frames photograph the same affordance rather than two of them. */
const MCTS_NOTICE: readonly ComposerNotice[] = [{
  id: "mcts",
  tone: "danger",
  text: "Couldn't refresh live data for MCTS.",
  action: { label: "Retry", onClick: () => {} },
}];

/* The composer, as the app renders it — the real component. This was a
   hand-copy, and it had drifted: no mode control, no model selector and no
   status row, so the gallery photographed a composer the product does not have.
   `notices` is a parameter because the status treatment is a thing to review.

   The draft, the mode and the model are real state rather than no-op handlers:
   a gallery whose controls do not move cannot tell you whether they work, which
   is the whole failure this harness exists to catch. */
function GalleryComposer({ notices = [] }: { notices?: readonly ComposerNotice[] }) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<ChatMode>("build");
  const [model, setModel] = useState("anthropic/claude-opus-4");
  return (
    <div className="border-t p-border">
      <Composer
        value={value}
        onValueChange={setValue}
        onSend={() => setValue("")}
        onStop={() => {}}
        placeholder="Send a message..."
        disabled={false}
        streaming={false}
        mode={{ value: mode, onChange: setMode, locked: false }}
        attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
        modelPicker={<ModelPicker models={MODEL_STUBS()} value={model} onChange={setModel} size="xs" className="min-w-0 flex-1 basis-32 max-w-44" />}
        notices={notices}
      />
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
        consent={{
          consentId: "c1", deviceLabel: "ashish-laptop", method: "exec",
          command: "git push origin fix/coupon-kind", scope: "all_local_actions", createdAt: NOW,
        }}
        onResolve={() => {}}
      />
      <ChatErrorCard message="fetch failed: provider stream reset before completion (anthropic/claude-opus-4)" streaming={false} onRetry={() => {}} onDismiss={() => {}} />
    </div>
  );
}

function Shell(
  { surface = "Output", mctsTrees = EMPTY_TREES, rpc = stubRpc, pendingActions = [] }:
  { surface?: SurfaceKind; mctsTrees?: ReadonlyMap<string, ForkNode>; rpc?: Rpc; pendingActions?: PendingAction[] },
) {
  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      {/* Mirrors components/layout.tsx — a harness that photographs a
          different surface than the app renders is worse than no harness. */}
      <aside className="hidden w-64 shrink-0 h-full p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <div className="h-full flex flex-col">
          <GalleryWorkspaceBar />
          <div className="flex-1 flex min-h-0">
            <div className="@container flex flex-col h-full border-r p-border" style={{ width: "42%" }}>
              <GalleryChatTabs />
              <ChatMessages />
              <GalleryComposer notices={MCTS_NOTICE} />
            </div>
            <div className="flex-1 min-w-0">
              <WorkSurface
                surface={surface} onSurface={() => {}} pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} agentStatus={null} tools={[]}
                memory={[]} memoryContent="" onSearchMemory={() => {}} mctsTrees={mctsTrees} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
                executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                backgroundJobs={BACKGROUND_JOBS} onRefreshJobs={() => {}} pendingActions={pendingActions}
                rpc={rpc}
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
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono p-badge-neutral">workspace</span>
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono p-badge-success">sandbox</span>
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono p-badge-warning">laptop</span>
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] p-badge-danger">failed</span>
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
        <input className="w-full px-3 py-1.5 border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]" placeholder="raw input (fork modal style)" />
        <textarea rows={2} className="block w-full resize-y rounded-md border p-border p-bg px-3 py-3 text-sm leading-7 p-text outline-none placeholder:p-text-3 transition-all focus:border-[var(--c-accent)] focus:ring-2 focus:ring-[var(--c-accent-subtle)]" placeholder="mission textarea (home page style)" />
      </div>
      <EmptyState icon={<BrainIcon size={32} />} title="No exploration trees yet" hint="Exploration trees appear when the agent forks with settle:'mcts' to investigate subproblems." />
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
        <GalleryChatTabs />
        <ChatMessages />
        <GalleryComposer notices={MCTS_NOTICE} />
      </div>
    </div>
  );
}

/* What every new workspace opens on. The mission is shown as the standing
   brief it is — it is deliberately NOT sent as an opening message, so this
   state is the first thing anyone sees after creating a workspace. */
function ChatEmptyFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs clearable={false} />
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <EmptyConversation mission={BRAIN_STATUS.purpose} />
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}
/* ── Chat infinite scroll ───────────────────────────────────────────

   The REAL hooks (usePagedScroll + useGrowingScroll), the REAL merge rule and
   the REAL HistoryBoundary, over a stub page source whose latency, failure and
   live-arrival timing this frame can drive. The hooks are the whole of the
   behaviour under test and none of them touch the socket, so a harness that
   can make a page arrive slowly proves more here than the live app can — in
   the live app the awkward cases are exactly the ones you cannot arrange.

   Query params: ?latency=ms  ?fail=1 (first fetch fails)  ?depth=N (pages
   before exhaustion). */
const HISTORY_PAGE = 12;
const historyParams = new URLSearchParams(location.search);
const HISTORY_LATENCY = Number(historyParams.get("latency") ?? 400);
const HISTORY_DEPTH = Number(historyParams.get("depth") ?? 4);

/** The stored transcript this frame pages back through, oldest first. */
const STORED_HISTORY: ChatHistoryEntry[] = Array.from(
  { length: HISTORY_PAGE * HISTORY_DEPTH },
  (_, i) => ({
    id: `h${i + 1}`,
    role: i % 2 === 0 ? "user" as const : "assistant" as const,
    content: `Archived message ${i + 1} of ${HISTORY_PAGE * HISTORY_DEPTH}. `
      + "Long enough to occupy real vertical space, so the scroll anchoring is "
      + "measured against a container that actually overflows.",
    createdAt: "2026-01-01 00:00:00",
  }),
);

function ChatHistoryFrame() {
  const [live, setLive] = useState<UIMessage[]>(() => MESSAGES.slice(-3));
  const failed = useRef(historyParams.get("fail") === "1");
  const [calls, setCalls] = useState<string[]>([]);

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(async (cursor) => {
      setCalls((prev) => [...prev, cursor.after]);
      const settled = Promise.withResolvers<void>();
      setTimeout(settled.resolve, HISTORY_LATENCY);
      await settled.promise;
      if (failed.current) { failed.current = false; throw new Error("stub failure"); }
      const end = STORED_HISTORY.findIndex((row) => row.id === cursor.after);
      const from = end < 0 ? STORED_HISTORY.length : end;
      const start = Math.max(0, from - HISTORY_PAGE);
      const items = STORED_HISTORY.slice(start, from);
      return start === 0 ? { status: "end", items } : { status: "more", items, next: { after: items[0]!.id } };
    }, []),
    startFrom: useCallback(() => live[0] ? { after: live[0].id } : null, [live]),
  });

  const transcript = useMemo(() => mergeTranscript(history.fetched, live), [history.fetched, live]);
  const messagesRef = useGrowingScroll<HTMLDivElement>({
    grows: "up", content: transcript, fetched: history.fetched, onReachEdge: history.loadMore,
  });

  // Driven from the test, so a live turn can be made to land while an older
  // page is still in flight — the case that decides whether the two sources
  // can double-render the same message.
  useEffect(() => {
    const onArrive = (event: Event) => {
      const detail = v.safeParse(v.pipe(v.string(), v.nonEmpty()), event instanceof CustomEvent ? event.detail : null);
      const id = detail.success ? detail.output : `live-${Date.now()}`;
      setLive((prev) => [...prev, {
        id, role: "assistant", parts: [{ type: "text", text: `Live arrival ${id}` }],
      }]);
    };
    window.addEventListener("gallery:arrive", onArrive);
    return () => window.removeEventListener("gallery:arrive", onArrive);
  }, []);

  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs />
        <div ref={messagesRef} data-testid="chat-scroll"
          className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
          <HistoryBoundary
            loading={history.loading} error={history.error}
            exhausted={history.exhausted} onRetry={history.loadMore} />
          {transcript.map((m, i) => (
            <div key={m.id} data-msg={m.id}>
              <MessageView message={m} isLast={i === transcript.length - 1} isStreaming={false} />
            </div>
          ))}
        </div>
        <div data-testid="probe" className="hidden">{JSON.stringify({
          ids: transcript.map((m) => m.id), calls,
          loading: history.loading, exhausted: history.exhausted, error: history.error,
        })}</div>
        <GalleryComposer />
      </div>
    </div>
  );
}

function All() {
  return (
    <div className="p-bg p-text min-h-screen">
      <Section title="Chat column"><div className="@container max-w-3xl border p-border rounded-lg overflow-hidden"><GalleryWorkspaceBar /><GalleryChatTabs /><ChatMessages /><GalleryComposer /></div></Section>
      <Section title="Controls">{<Controls />}</Section>
    </div>
  );
}

/* ── Agent tab strip ────────────────────────────────────────────── */

const SUBORDINATES: Parameters<typeof SubordinateTabs>[0]["subordinates"] = [
  { name: "coupon-tester", displayName: "Coupon tester", role: "QA", createdBy: "orchestrator", status: "working", currentTask: "Running the checkout regression suite", createdAt: NOW - 36e5, dismissedAt: null },
  { name: "migration-review", displayName: "Migration review", role: "Reviewer", createdBy: "orchestrator", status: "awaiting_input", currentTask: "Needs a call on the backfill order", createdAt: NOW - 72e5, dismissedAt: null },
  { name: "docs", displayName: "Release notes", role: "Writer", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 108e5, dismissedAt: null },
];

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
        <div className="flex rounded-lg overflow-hidden border p-border">
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
          {STATUS_STEPS.map(([name, _contrastValue, ratio]) => (
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
        <div className="mt-14 border p-border rounded-lg p-surface p-4 max-w-xl">
          <div className="p-eyebrow mb-2.5">A live run, right now</div>
          {[
            ["p-dot-accent", "Turn: fix SAVE20 coupon", "48.0s"],
            ["p-dot-neutral", "sandbox: bun test packages/checkout", "14.2s"],
            ["p-dot-info", "agents(fork/mcts): bisect migration", "12 nodes"],
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

/* The Agent surface: the collapsible sections and the native/code-mode
   exposure badge, at the width Column C actually gets. */
/* The real docstrings, from the registry the orchestrator serves them from.
   Mocking short ones is how the Tools list shipped as a wall of prose without
   anyone seeing it: eight builtins carry real contract text between them, and
   a harness that photographs one-liners photographs a surface the app does
   not have. `release` (and `agent.*` self-steering) is codemode-only reach —
   getToolDescriptions() only lists BUILTIN_TOOLS, the same reason `agent.*` has
   never appeared here either, so that row is illustrative mock, not a live
   readout.

   `exposure` here is the registry's DECLARED reach (TOOL_REACH), so the eight
   builtins are "both" — every one of them is also a codemode namespace or, for
   run/file, reachable through `workspace.*`; only execute_tools is native-only,
   because it IS the sandbox. `wired` is the second, separate fact: whether this
   agent has the capability at all. `report` is photographed at wired:false
   because that is what an orchestrator looks like — it IS the report sink — and
   that state is exactly what used to render as the false label "code mode". */
function galleryTool(info: ToolInfo): ToolInfo { return info; }

const BRAIN_TOOLS: ToolInfo[] = [
  ...BUILTIN_TOOLS.map((name) => galleryTool({
    name,
    summary: BUILTIN_TOOL_SPECS[name].summary,
    description: BUILTIN_TOOL_DESCRIPTIONS[name],
    learned: false,
    exposure: TOOL_REACH[name].codemode ? "both" : "native",
    wired: name !== "report",
    qualityScore: 1,
    usageCount: 0,
  })),
  galleryTool({ name: "release", summary: "Governed release pipeline over a bound source repo.", description: "Governed release pipeline over a bound source repo — patch it, run its checks, preview, take owner approval, deploy, roll back.", learned: false, exposure: "codemode", wired: true, qualityScore: 1, usageCount: 0 }),
  galleryTool({ name: "bisect_migration", summary: "Walk a migration's revisions to find the one that changed a column's shape.", description: "Walk a migration's revisions to find the one that changed a column's shape.", learned: true, exposure: "codemode", wired: true, qualityScore: 0.82, usageCount: 14 }),
  galleryTool({ name: "coupon_replay", summary: "Replay a checkout against a coupon code and diff the response.", description: "Replay a checkout against a coupon code and diff the response.", learned: true, exposure: "codemode", wired: true, qualityScore: 0.61, usageCount: 3 }),
];

const BRAIN_STATUS = {
  name: "checkout-coupon-bug-9935d3", displayName: "Checkout coupon bug",
  purpose: "Find why the SAVE20 coupon 500s and fix it.", model: "anthropic/claude-opus-4",
  scaffoldVersion: 7, searchNodeCount: 12, craftedToolCount: 2, messageCount: 48,
  soul: "# Checkout coupon bug", forkLineage: null, createdAt: NOW - 7 * 864e5,
} satisfies AgentStatus;

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
  if (method === "getAgentView") return rpcResult({ ok: true, version: 3, spec: VIEW_SPEC }).json<T>();
  if (method === "getReleaseBoard") return rpcResult(VIEW_BOARD).json<T>();
  if (method === "listBackgroundJobs") return rpcResult(VIEW_JOBS).json<T>();
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
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} agentStatus={null} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()}
          onExecute={async () => ({})}
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={[]}
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
      return rpcResult({
        ok: false,
        error: "view spec invalid — blocks.0.type: Invalid type: Expected (\"stat\" | \"table\" | \"list\" | \"kv\" | \"markdown\" | \"section\") but received \"html\"",
      }).json<T>();
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
    summary: null,
    patch: "--- a/packages/cf-backend/src/components/surfaces/shared.tsx\n+++ b/packages/cf-backend/src/components/surfaces/shared.tsx\n@@\n-  memory: \"Your agent will remember important information here.\",\n+  memory: \"Anything worth keeping lands here. Ask me to remember something.\",",
    status: "awaiting_approval", previewUrl: null, createdAt: NOW - 36e5, updatedAt: NOW - 12e5,
  }],
  checks: [
    { id: "chk_1", changeId: "chg_4f2", name: "typecheck", status: "passed", stdout: null, stderr: null, durationMs: 41_000, createdAt: NOW - 30e5, updatedAt: NOW - 30e5 },
    { id: "chk_2", changeId: "chg_4f2", name: "bun test", status: "passed", stdout: "920 pass, 0 fail", stderr: null, durationMs: 9_300, createdAt: NOW - 28e5, updatedAt: NOW - 28e5 },
  ],
  approvals: [{
    id: "apr_1", changeId: "chg_4f2", approvalType: "deploy_production", decision: "pending",
    approvedBy: null, note: null, decidedAt: null, argumentDigest: "9f2c…", createdAt: NOW - 12e5,
  }],
  deployments: [],
};

const releaseRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getReleaseBoard") return rpcResult(RELEASE_BOARD).json<T>();
  return stubRpc<T>(method, args);
};

const RELEASE_EXECUTORS: ExecutorInfo[] = [
  { name: "sandbox", kind: "sandbox", capabilities: [], available: true, configured: true, status: "idle" },
];

/** The same board with the engine's substrate missing — the surface's honest
 *  word when nothing on the pipeline can actually run. */
const RELEASE_EXECUTORS_OFFLINE: ExecutorInfo[] = [
  {
    name: "sandbox", kind: "sandbox", capabilities: [], available: false, configured: false,
    status: "not_configured",
    reason: "Sandbox executor not configured. Add the @cloudflare/sandbox binding and Container to wrangler.jsonc (see docs/EXECUTION-LAYER-SPEC.md).",
  },
];

function ReleasesFrame({ executors = RELEASE_EXECUTORS }: { executors?: ExecutorInfo[] }) {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[1100px] min-h-screen border-x p-border p-5">
        <ReleasesSurface rpc={releaseRpc} executors={executors} />
      </div>
    </div>
  );
}


/* ── Work ───────────────────────────────────────────────────────── */

// The agent's own plan, at the shape it actually reaches: several steps, one
// item active, one task broken into subtasks, one dropped. Photographed inside
// Column C's chrome, beside the jobs and self-changes it now shares a surface
// with — the split that used to put each of those three in a room of its own.
const AGENT_TASKS = [
  {
    id: "t1", parentId: null, title: "Reproduce the SAVE20 coupon 500", status: "done",
    createdAt: NOW - 52e5, updatedAt: NOW - 44e5, subtasks: [],
  },
  {
    id: "t2", parentId: null, title: "Patch the gateway timeout that swallows the coupon lookup",
    status: "active", createdAt: NOW - 52e5, updatedAt: NOW - 8e5,
    subtasks: [
      { id: "t5", parentId: "t2", title: "Raise the upstream deadline to 60s", status: "done", createdAt: NOW - 30e5, updatedAt: NOW - 21e5 },
      { id: "t6", parentId: "t2", title: "Stop retrying a request the client already abandoned", status: "active", createdAt: NOW - 30e5, updatedAt: NOW - 6e5 },
      { id: "t7", parentId: "t2", title: "Check the same path in the checkout worker", status: "open", createdAt: NOW - 30e5, updatedAt: NOW - 30e5 },
    ],
  },
  {
    id: "t3", parentId: null, title: "Add a regression test for the expired-coupon branch",
    status: "open", createdAt: NOW - 52e5, updatedAt: NOW - 52e5, subtasks: [],
  },
  {
    id: "t4", parentId: null, title: "Rewrite the coupon docs page", status: "dropped",
    createdAt: NOW - 52e5, updatedAt: NOW - 40e5, subtasks: [],
  },
];

/** Both lifecycle halves in frame: one job still running (Now, cancel), two
 *  settled (journal, retry / dismiss). */
const BACKGROUND_JOBS = [
  {
    id: "bgjob-7c1e4a92", kind: "fork", label: "explore three coupon-lookup fixes",
    workMode: "build" as const, status: "running" as const, result: null, error: null, createdAt: NOW - 9e5, settledAt: null,
  },
  {
    id: "bgjob-2f8b1d04", kind: "execute_tools", label: "bun test packages/core",
    workMode: "build" as const, status: "completed" as const, result: "2,633 pass · 0 fail · 187 files", error: null,
    createdAt: NOW - 42e5, settledAt: NOW - 33e5,
  },
  {
    id: "bgjob-9d3c6e11", kind: "run", label: "wrangler deploy --dry-run",
    workMode: "build" as const, status: "failed" as const, result: null, error: "exit 1 — binding VECTORIZE not found in wrangler.jsonc",
    createdAt: NOW - 61e5, settledAt: NOW - 58e5,
  },
];

const CHANGELOG = {
  seenAt: NOW - 30e5,
  unseenCount: 2,
  entries: [
    {
      id: "cl_1", kind: "scaffold", at: NOW - 10e5, scaffoldVersion: 8, revert: true,
      summary: "Rewrote the tool preamble — shorter, and it stops re-reading files it just wrote",
      evidence: "shadow eval: 7 trials · 5 pending wins · 1 regression · 1 tie",
    },
    {
      id: "cl_2", kind: "tool", at: NOW - 26e5, scaffoldVersion: null, revert: true,
      summary: "Learned a tool: bisect_migration",
      evidence: "extracted from 3 successful turns · quality 0.82",
    },
    {
      id: "cl_3", kind: "fact", at: NOW - 50e5, scaffoldVersion: null, revert: true,
      summary: "Remembered: percentage coupons carry kind:null after Tuesday's migration",
      evidence: null,
    },
  ],
};

/** The queue that closes the badge gap: a release approval used to light
 *  nothing at all while a running job — which needs nobody — carried a digit. */
const PENDING_ACTIONS: PendingAction[] = [
  // A parked command — the ONE kind decided in the queue itself, and the one
  // this frame never held, so its Approve/Always/Deny controls had never been
  // photographed at all. Two of them, because deciding a night's worth in one
  // sitting is the whole point of the card.
  {
    id: "defer-9y2n8ixor8", kind: "deferred_action", at: NOW - 40 * 60e3,
    title: "Approve: a command the agent wants to run on laptop",
    detail: "cd ~/Proteus && rm -rf node_modules && bun install",
  },
  {
    id: "defer-4k1m2pqw7z", kind: "deferred_action", at: NOW - 36 * 60e3,
    title: "Approve: a command the agent wants to run on laptop",
    detail: "sudo launchctl kickstart -k system/com.docker.dockerd",
  },
  {
    id: "apr_1", kind: "release_approval", at: NOW - 12e5,
    title: "Approve: deploy to production",
    detail: "Warm up the empty-state copy",
  },
  {
    id: "scaffold-v8", kind: "scaffold_version", at: NOW - 10e5,
    title: "Scaffold v8 is waiting to be promoted or rolled back",
    detail: "Rewrote the tool preamble — shorter, and it stops re-reading files it just wrote",
  },
  {
    id: "bgjob-9d3c6e11", kind: "failed_job", at: NOW - 58e5,
    title: "run failed",
    detail: "exit 1 — binding VECTORIZE not found in wrangler.jsonc",
  },
  {
    id: "unseen-changes", kind: "unseen_changes", at: NOW - 10e5,
    title: "2 self-changes you have not seen",
    detail: "Keep or revert them in the journal below.",
  },
];

const workRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listAgentTasks") return rpcResult(AGENT_TASKS).json<T>();
  if (method === "getEvolutionChangelog") return rpcResult(CHANGELOG).json<T>();
  return stubRpc<T>(method, args);
};

function WorkFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] min-h-screen border-x p-border">
        <WorkSurface
          surface="Work" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} agentStatus={null} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
          backgroundJobs={BACKGROUND_JOBS} onRefreshJobs={() => {}} pendingActions={PENDING_ACTIONS}
          rpc={workRpc}
        />
      </div>
    </div>
  );
}

/**
 * The two halves of a shell approval, in one frame: the queue that hands a
 * standing permission out, and the list that is the only place to take one
 * back.
 *
 * A frame of its own because the Settings page cannot be photographed here at
 * all — it builds its RPC from a live agent socket and the gallery has no
 * worker, so `?frame=settings` renders blank (and did before this change too).
 * The grants card takes nothing but an `rpc`, so it can be fed directly, and
 * `getShellApprovalGrants`/`revokeShellApprovalGrants` having had no caller at
 * all is exactly the kind of gap a photograph closes.
 */
const SHELL_GRANTS = [
  { rule: "rm-recursive", executor: "laptop" },
  { rule: "sudo", executor: "laptop" },
  { rule: "docker-destructive", executor: "sandbox" },
];

const approvalsRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getShellApprovalGrants") return rpcResult({ grants: SHELL_GRANTS }).json<T>();
  if (method === "revokeShellApprovalGrants") return rpcResult({ ok: true, grants: SHELL_GRANTS }).json<T>();
  return workRpc<T>(method, args);
};

function ApprovalsFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] min-h-screen border-x p-border p-5 space-y-5">
        <WorkSurface
          surface="Work" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} agentStatus={null} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={PARKED_ONLY}
          rpc={approvalsRpc}
        />
        <StandingApprovalsCard rpc={approvalsRpc} />
      </div>
    </div>
  );
}

/** Only the parked commands: the rest of the queue is photographed by `work`,
 *  and this frame is about one card. */
const PARKED_ONLY: PendingAction[] = PENDING_ACTIONS.filter((a) => a.kind === "deferred_action");

/** The same column before anything has happened — the state a fresh workspace
 *  opens on, which is the one an empty-state has to earn its copy in. */
function WorkEmptyFrame() {
  const emptyRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === "listAgentTasks") return rpcResult([]).json<T>();
    if (method === "getEvolutionChangelog") return rpcResult({ entries: [], unseenCount: 0, seenAt: 0 }).json<T>();
    return stubRpc<T>(method, args);
  };
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] h-screen border-x p-border">
        <WorkSurface
          surface="Work" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} agentStatus={null} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={[]}
          rpc={emptyRpc}
        />
      </div>
    </div>
  );
}

/* ── Environment ────────────────────────────────────────────────── */

/**
 * The four places the agent can act, as the surface lists them.
 *
 * Photographed with every environment reachable, because the defect this frame
 * exists to catch is a naming one: two rows that describe the same thing read
 * as a duplicate, and only a picture of the row set together shows it.
 */
const ENVIRONMENT_EXECUTORS: ExecutorInfo[] = [
  {
    name: "laptop", kind: "laptop", available: true, configured: true, active: true, status: "active",
    capabilities: ["shell", "npm", "git", "docker", "fs_owned", "process_spawn"],
  },
  {
    name: "sandbox", kind: "sandbox", available: true, configured: true, active: true, status: "active",
    capabilities: ["shell", "npm", "git", "fs_owned", "net_inbound", "process_long"],
  },
  {
    name: "workspace", kind: "workspace", available: true, configured: true, active: true, status: "active",
    capabilities: ["javascript", "typescript", "python", "shell", "npm", "fs_shared"],
  },
];

const ENVIRONMENT_MOUNTS: MountInfo[] = ENVIRONMENT_EXECUTORS.map((exec) => ({
  name: exec.name,
  prefix: `${exec.name}.*`,
  live: true,
  policy: {
    readOnly: false,
    consistency: exec.name === "workspace" ? "durable"
      : exec.name === "laptop" ? "live-shared" : "ephemeral",
  },
  reason: null,
}));

/** The workspace's real shape: a home under a real root, so the frame
 *  photographs the breadcrumb and the walk-up affordances with something to
 *  walk up TO. A frame that only ever shows one directory cannot show that
 *  the parent button is broken — which is how it stayed broken. */
const ENVIRONMENT_HOME = "/home/user";
const ENVIRONMENT_TREE = {
  "/": [{ name: "home", type: "dir" }, { name: "etc", type: "dir" }, { name: "tmp", type: "dir" }],
  "/home": [{ name: "user", type: "dir" }],
  "/home/user": [
    { name: "head-3-scratch", type: "dir" },
    { name: "head-4-scratch", type: "dir" },
    { name: "memory", type: "dir" },
    { name: "skills", type: "dir" },
    { name: "AGENTS.md", type: "file", size: 2_148 },
    { name: "SOUL.md", type: "file", size: 913 },
    { name: "notes.md", type: "file", size: 4_402 },
    { name: "ranked.txt", type: "file", size: 4_089_446 },
  ],
} satisfies Record<string, DirEntry[]>;

function EnvironmentFrame() {
  // Answers only for the executor that actually owns these files. A stub that
  // returned the same listing for every argument would photograph a pane
  // asking the wrong environment as though it worked.
  const envRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === "listMounts") return rpcResult(ENVIRONMENT_MOUNTS).json<T>();
    if (method === "getExecutorFiles") {
      const parsedArgs = v.parse(v.tuple([v.string(), v.string()]), args ?? []);
      const [execName, path] = parsedArgs;
      if (execName !== "workspace") {
        return rpcResult({ error: `Executor "${execName}" has no listing for ${path} in this frame` }).json<T>();
      }
      // The environment resolves an empty path to its own home and names what
      // it listed — the real contract, so navigation is exercised here.
      const dir = path === "" ? ENVIRONMENT_HOME : path;
      const entries = Object.entries(ENVIRONMENT_TREE).find(([key]) => key === dir)?.[1];
      return rpcResult(entries === undefined
        ? { error: `ENOENT: ${dir}` }
        : { path: dir, entries }).json<T>();
    }
    return stubRpc<T>(method, args);
  };
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] h-screen border-x p-border">
        <WorkSurface
          surface="Environment" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} agentStatus={null} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={ENVIRONMENT_EXECUTORS} executorOutputs={new Map()}
          onExecute={async () => ({})} lastActiveExecutor="workspace"
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={[]}
          rpc={envRpc}
        />
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

/** Typed, so the fixtures move with `RunSummary` instead of only failing at the
 *  browser-side valibot parse. The second run is deliberately a SILENT one — the
 *  provider reported nothing for any of its turns — because that is the case the
 *  history block has to render as unreported rather than as free.
 *
 *  Longer than one page on purpose: this block sums the usage of the rows it
 *  received and prints the total as the workspace's spend, so a frame that never
 *  crosses a page boundary cannot show whether that total is honest about what
 *  it covers. */
const SUPERVISE_RUNS: RunSummary[] = [
  {
    runId: "run_9c1", startedAt: NOW - 45 * 60e3, causedBy: "chat",
    userMessage: "Why does the percentage coupon drop off at checkout?",
    status: "completed", eventCount: 62, turnsWithoutUsage: 0,
    usage: { input: 184_320, output: 9_140, cacheRead: 121_400 },
  },
  {
    runId: "run_9b7", startedAt: NOW - 6 * 36e5, causedBy: "timer",
    userMessage: null, status: "completed", eventCount: 18,
    usage: {}, turnsWithoutUsage: 3,
  },
  ...olderRuns(),
];

/** The runs behind the first page — a week of turns, so the boundary and the
 *  end of the history are both reachable in the frame. */
function olderRuns(): RunSummary[] {
  const asked = [
    "Which migration dropped the coupon index?",
    "Show me every reader of rules[kind]",
    "Does the cart serializer already guard this?",
    "Run the checkout suite against the fix",
    "Why is the admin report still 500ing?",
    null,
  ];
  return Array.from({ length: 40 }, (_, i) => {
    const silent = i % 9 === 8;
    const asking = asked[i % asked.length] ?? null;
    return {
      runId: `run_8${String(99 - i).padStart(2, "0")}`,
      startedAt: NOW - (7 + i) * 36e5,
      causedBy: asking === null ? "timer" : "chat",
      userMessage: asking,
      status: i % 11 === 7 ? "aborted" : "completed",
      eventCount: 12 + ((i * 7) % 50),
      usage: silent ? {} : {
        input: 12_000 + i * 1_400,
        output: 800 + i * 60,
        cacheRead: i % 3 === 0 ? 0 : 6_000 + i * 900,
      },
      turnsWithoutUsage: silent ? 2 : 0,
    };
  });
}

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
    workMode: "build", result: null, error: null, createdAt: NOW - 4 * 60e3, settledAt: null,
  },
  {
    id: "bgjob-70bd19f7", kind: "mcts", label: "Pick a migration-backfill approach",
    workMode: "build", status: "completed", result: "Settled on the backfill-on-read approach", error: null,
    createdAt: NOW - 50 * 60e3, settledAt: NOW - 41 * 60e3,
  },
];

const superviseRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listCurriculumTasks") return rpcResult({ tasks: SUPERVISE_TASKS }).json<T>();
  if (method === "getRunSummaries") {
    const request = v.parse(GalleryPageRequestSchema, args?.[0] ?? {});
    const limit = request.limit ?? 30;
    const after = request.cursor?.after;
    const start = after === undefined ? 0 : SUPERVISE_RUNS.findIndex((run) => run.runId === after) + 1;
    return rpcResult(seekPage(
      SUPERVISE_RUNS.slice(start, start + limit + 1), limit, (run) => run.runId,
    )).json<T>();
  }
  if (method === "listTriggers") return rpcResult({ triggers: SUPERVISE_TRIGGERS }).json<T>();
  if (method === "listBackgroundJobs") return rpcResult(SUPERVISE_JOBS).json<T>();
  return stubRpc<T>(method, args);
};

function SuperviseFrame() {
  return (
    <div className="p-bg p-text min-h-screen">
      <SupervisePage rpc={superviseRpc} onRunTask={() => {}} />
    </div>
  );
}

/* ── Activity ───────────────────────────────────────────────────── */

/** The turn loop's own window over 344 steps. `cacheRead` is a SUBSET of
 *  `input`, never an addition to it. */
const AGENT_TOKENS: Usage = {
  input: 21_480_312, output: 512_884, cacheRead: 18_942_006, reasoning: 41_220,
};

/** The same window as Workers AI reports it. `neurons` is Cloudflare's own
 *  billing unit and comes back on every call — 0.120 per token, captured live —
 *  and it is the figure the Cost block used to measure and then discard. */
const AGENT_TOKENS_METERED: Usage = { ...AGENT_TOKENS, neurons: 2_639_183 };

/**
 * One producer per absence rule the Cost block claims, because the failure this
 * frame exists to catch is a zero standing in for a silence:
 *   agent    — Workers AI: measured, priced, and the only row reporting neurons
 *   judge    — Anthropic: measured and priced, and reports NO neurons at all
 *   fast     — 44 calls carried no catalog rate, so its dollars are a floor
 *   head     — 2 calls reported nothing, so its tokens AND dollars are floors
 *   mcts     — measured with no rate anywhere: dollars absent, never $0
 *   platform — the embedder and toMarkdown: counted, never measured, ever
 * Largest measured token total first and the unmeasured producer last, the order
 * `workspaceSpend` returns them in (read-models/workspace-spend.ts).
 */
const ACTIVITY_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS_METERED,
    usd: 11.98, unpricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: { input: 1_284_400, output: 96_120, cacheRead: 812_000 }, usd: 3.41, unpricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440, neurons: 50_467 }, usd: 0.0142, unpricedCalls: 44,
  },
  {
    source: "head", calls: 12, callsWithoutUsage: 2,
    usage: { input: 288_004, output: 31_902 }, usd: 0.86, unpricedCalls: 0,
  },
  {
    source: "mcts", calls: 28, callsWithoutUsage: 0,
    usage: { input: 96_210, output: 12_004, neurons: 12_986 }, unpricedCalls: 28,
  },
  { source: "platform", calls: 91, callsWithoutUsage: 91, usage: {}, unpricedCalls: 0 },
];

/** Every producer measuring and pricing everything, over a window that reached
 *  the end of the log — the state the panel is allowed to state positively, and
 *  an Anthropic workspace, so the neurons column must vanish rather than print a
 *  column of dashes. */
const CLEAN_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS,
    usd: 11.98, unpricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: { input: 1_284_400, output: 96_120, cacheRead: 812_000 }, usd: 3.41, unpricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440 }, usd: 0.42, unpricedCalls: 0,
  },
];

/** One step's exact composed content, so the frame photographs the whole surface
 *  rather than the Cost block over an empty breakdown. */
const ACTIVITY_CONTEXT: ContextComposition = {
  segments: [
    { plane: "system", label: "Core instructions", chars: 18_400, items: 1 },
    { plane: "system", label: "Workspace brief", chars: 3_120, items: 1 },
    { plane: "tools", label: "run", chars: 2_840, items: 1 },
    { plane: "tools", label: "edit", chars: 3_610, items: 1 },
    { plane: "tools", label: "read", chars: 2_180, items: 1 },
    { plane: "messages", label: "tool", chars: 328_900, items: 96 },
    { plane: "messages", label: "assistant", chars: 214_600, items: 58 },
    { plane: "messages", label: "user", chars: 9_420, items: 11 },
    { plane: "ephemeral", label: "Plan", chars: 1_980, items: 1 },
    { plane: "ephemeral", label: "Open files", chars: 2_240, items: 1 },
  ],
  measuredChars: 587_290,
  charsPerToken: CHARS_PER_TOKEN,
  estimatedTokens: 146_822,
};

const ACTIVITY_LATEST = {
  at: NOW - 90e3,
  runId: "run-8c41f0",
  stepIndex: 7,
  usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604, neurons: 18_005 },
  context: ACTIVITY_CONTEXT,
} satisfies NonNullable<ActivitySnapshot["latest"]>;

const ACTIVITY_CACHE_HIT = {
  samples: 344, last: 0.94, ema: 0.91, mean: 0.88, p95: 0.97, emaAlpha: 0.2,
};

const ACTIVITY_BUDGETS: ActivitySnapshot["budgets"] = [{
  label: "checkout-fixes", parent: null, limits: { usd: 25 },
  spent: { tokens: 24_222_394, usd: 16.26 }, remaining: { usd: 8.74 },
  pricing: { blendedTokens: 0, source: "catalog" }, calls: 747, spawns: 3, exhausted: false,
}];

/**
 * The panel's own question, photographed: `$11.98 over 344 priced steps` is the
 * agent's turns, and the workspace spent $16.26+ over 747 calls of which 87.6%
 * were measured at all. Every qualifier is live here — a truncated window, a
 * silent producer, a partial one and 72 unpriced calls — which is the case the
 * composed caveat line has to survive without becoming four paragraphs.
 */
const ACTIVITY_SNAPSHOT: ActivitySnapshot = {
  latest: ACTIVITY_LATEST,
  contextWindow: 200_000,
  telemetry: {
    steps: 344, windowLimit: 2000, tokens: AGENT_TOKENS_METERED, cacheHit: ACTIVITY_CACHE_HIT,
    usd: 11.98, pricedSteps: 344, unpricedSteps: 0, stepsWithoutUsage: 0,
  },
  spend: {
    producers: ACTIVITY_PRODUCERS,
    total: {
      calls: 747, callsWithoutUsage: 93, unpricedCalls: 72, usd: 16.2642,
      usage: {
        input: 23_551_044, output: 671_350, cacheRead: 19_754_006, reasoning: 41_220,
        neurons: 2_702_636,
      },
    },
    coverage: {
      calls: 747, measured: 654, reported: 654 / 747, silent: ["platform"], partial: ["head"],
    },
    windowLimit: 2000,
    complete: false,
  },
  budgets: ACTIVITY_BUDGETS,
  log: [],
};

/** The same workspace on a provider that reports no neurons, with nothing left
 *  to qualify: 100% of known callers reported, every call priced, and the read
 *  reached the end of the log. */
const ACTIVITY_CLEAN: ActivitySnapshot = {
  ...ACTIVITY_SNAPSHOT,
  latest: { ...ACTIVITY_LATEST, usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604 } },
  telemetry: { ...ACTIVITY_SNAPSHOT.telemetry, tokens: AGENT_TOKENS },
  spend: {
    producers: CLEAN_PRODUCERS,
    total: {
      calls: 616, callsWithoutUsage: 0, unpricedCalls: 0, usd: 15.81,
      usage: {
        input: 23_166_830, output: 627_444, cacheRead: 19_754_006, reasoning: 41_220,
      },
    },
    coverage: { calls: 616, measured: 616, reported: 1, silent: [], partial: [] },
    windowLimit: 2000,
    complete: true,
  },
};

/** A workspace that has made no model call at all. `coverage.reported` is null
 *  here, and the panel has to say there is no fraction rather than print 0% —
 *  a call nobody made is not a call a provider failed to report. */
const ACTIVITY_FRESH: ActivitySnapshot = {
  latest: null,
  contextWindow: null,
  telemetry: {
    steps: 0, windowLimit: 2000, tokens: {}, usd: 0, pricedSteps: 0, unpricedSteps: 0,
    stepsWithoutUsage: 0,
    cacheHit: { samples: 0, last: null, ema: null, mean: null, p95: null, emaAlpha: 0.2 },
  },
  spend: {
    producers: [],
    total: { calls: 0, callsWithoutUsage: 0, usage: {}, unpricedCalls: 0 },
    coverage: { calls: 0, measured: 0, reported: null, silent: [], partial: [] },
    windowLimit: 2000,
    complete: true,
  },
  budgets: [],
  log: [],
};

const activityRpc = (snapshot: ActivitySnapshot): Rpc =>
  async <T,>(method: string, args?: unknown[]): Promise<T> => (
    method === "getActivitySnapshot" ? rpcResult(snapshot).json<T>() : stubRpc<T>(method, args)
  );

/* ── Tool-call rendering states ─────────────────────────────────── */

/** One message per state that the `chat` frame either folds into a group or
 *  can't show pre-expanded: a quiet failure (the tool caught it and returned
 *  it as a normal result), a protocol-level failure (the executor itself
 *  crashed — errorText, no output), a clean multi-line `run`, and an MCP tool
 *  with no known summarizer contract. Auto-expanded on mount below so the
 *  input/output panel is the thing the screenshot shows. */
const TOOLCALL_MESSAGES: UIMessage[] = [
  msg({
    id: "tc-quiet", role: "assistant",
    parts: [
      { type: "text", text: "Quiet failure — the transport reports success, but the tool caught its own error and returned it as a normal result." },
      { type: "tool-file", toolCallId: "tc1", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: { error: "old_text not found or not unique — the file changed since the last read" } },
    ],
  }),
  msg({
    id: "tc-protocol", role: "assistant",
    parts: [
      { type: "text", text: "Protocol-level failure — the executor crashed before it could return anything; the reason lives in errorText, not output." },
      { type: "tool-run", toolCallId: "tc2", state: "output-error", input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/checkout-fixes" }, errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443" },
    ],
  }),
  msg({
    id: "tc-run", role: "assistant",
    parts: [
      { type: "text", text: "A multi-line `run` command, expanded — a shell script, not an escaped JSON string." },
      {
        type: "tool-run", toolCallId: "tc3", state: "output-available",
        input: { runtime: "sandbox", command: "for f in packages/checkout/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone" },
        output: "-- checking packages/checkout/migrations/0041_coupons.sql\n-- checking packages/checkout/migrations/0042_coupon_kind.sql",
      },
    ],
  }),
  msg({
    id: "tc-mcp", role: "assistant",
    parts: [
      { type: "text", text: "An MCP tool with no known summarizer contract — the honest fallback (name + its one argument), and long enough to test truncation." },
      {
        type: "dynamic-tool", toolCallId: "tc4", toolName: "gh__search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/shop is:open head:fix/coupon-kind base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Fix SAVE20 coupon backfill\" — checks pending",
      },
    ],
  }),
  msg({
    id: "tc-group", role: "assistant",
    parts: [
      { type: "text", text: "A run of 5 finished calls, one of them the same quiet failure as above — the group's own dot has to say so before anyone clicks in." },
      { type: "tool-file", toolCallId: "tc5", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "tc6", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
      { type: "tool-file", toolCallId: "tc7", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: { error: "old_text not found or not unique" } },
      { type: "tool-file", toolCallId: "tc8", state: "output-available", input: { action: "write", path: "packages/checkout/tests/coupon-kind.test.ts" }, output: "ok" },
      { type: "tool-agents", toolCallId: "tc9", state: "output-available", input: { action: "fork", forks: [{}, {}, {}], settle: "merge", task: "Check every other call site" }, output: "3 forks merged" },
    ],
  }),
];

/** Clicks open every collapsed tool-call row shortly after mount — the
 *  expand/collapse toggle is local component state with no prop to preset
 *  it, and simulating the one click an operator would make is simpler and
 *  more honest than adding a gallery-only prop to the real component. */
function useAutoExpandToolCalls(): void {
  useEffect(() => {
    const clickAll = () => {
      document.querySelectorAll('button[aria-expanded="false"]').forEach((element) => {
        if (element instanceof HTMLButtonElement) element.click();
      });
    };
    const id = setTimeout(() => {
      clickAll();
      // A group's own toggle mounts its members' toggles a render later —
      // one more pass after React commits catches those too.
      requestAnimationFrame(() => requestAnimationFrame(clickAll));
    }, 50);
    return () => clearTimeout(id);
  }, []);
}

/**
 * A turn IN FLIGHT, in each state its tail can be in.
 *
 * Every other chat frame passes `isStreaming={false}`, so the gallery had
 * never once photographed a live turn — which is why a caret rendered on a
 * line of its own below the paragraph, and a turn that went quiet between
 * steps showed nothing at all, both survived to production. The part `state`
 * fields are the real ones the AI SDK's stream reducer writes; the frame is a
 * still of a stream, not a mock of one.
 */
const STREAMING_MESSAGES: UIMessage[] = [
  msg({
    id: "st-text", role: "assistant",
    parts: [
      { type: "text", state: "streaming", text: "The 500 is a deref on `rules[kind]`, and after Tuesday's migration percentage coupons carry `kind: null`. The caret belongs at the end of this sentence" },
    ],
  }),
  msg({
    id: "st-after-tools", role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Reading the handler and the migration that landed Tuesday." },
      { type: "tool-file", toolCallId: "st1", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "st2", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
    ],
  }),
  msg({
    id: "st-tool", role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Running the regression suite before I touch anything else." },
      { type: "tool-run", toolCallId: "st3", state: "input-available", input: { runtime: "sandbox", command: "bun test packages/checkout" } },
    ],
  }),
  msg({
    id: "st-reasoning", role: "assistant",
    parts: [
      { type: "reasoning", state: "streaming", text: "SAVE20 fails and SAVE10 does not, so the branch is percentage-vs-fixed rather than the lookup. Before I patch it I want the migration in front of me" },
    ],
  }),
  msg({
    id: "st-fence", role: "assistant",
    parts: [
      { type: "text", state: "streaming", text: "Here is the guard, mid-fence:\n\n```ts\nconst rule = rules[kind] ?? inferKind(coupon);\nif (rule === undefined) return notApplicable(coupon);\n```" },
    ],
  }),
  msg({ id: "st-empty", role: "assistant", parts: [] }),
];

/** Each message is rendered as the LAST one of an open stream, which is the
 *  only condition under which a live tail is drawn at all. */
function StreamingFrame() {
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div data-gallery-stream className="@container flex w-full max-w-[640px] flex-col gap-8 border-x p-border px-6 py-6">
        {STREAMING_MESSAGES.map((m) => (
          <MessageView key={m.id} message={m} isLast isStreaming onFork={() => {}} />
        ))}
      </div>
    </div>
  );
}

function ToolCallsFrame() {
  useAutoExpandToolCalls();
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div className="@container flex w-full max-w-[640px] flex-col gap-6 border-x p-border px-6 py-6">
        {TOOLCALL_MESSAGES.map((m) => (
          <MessageView key={m.id} message={m} isLast={false} isStreaming={false} onFork={() => {}} />
        ))}
      </div>
    </div>
  );
}

function AgentFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[740px] border-x p-border min-h-screen p-5">
        <AgentSurface
          agentStatus={BRAIN_STATUS} tools={BRAIN_TOOLS} memory={[]}
          memoryContent={"## Checkout\n\n- The coupon path goes through `/api/cart/apply`.\n- Percentage coupons carry `kind: null` after Tuesday's migration.\n"}
          onSearchMemory={() => {}} rpc={evolutionRpc}
        />
      </div>
    </div>
  );
}


/**
 * The node transcript, in every state it has.
 *
 * Five panels because five different facts used to render as one blank pane:
 * a branch that worked and reported, one still working, one that died having
 * recorded nothing, a rollout with no trace by construction, and a node the
 * store does not hold. If any two of these photograph the same, that is the
 * defect.
 */
function TranscriptFrame() {
  return (
    <div className="p-bg p-text min-h-screen p-5 space-y-5">
      {[
        ["Completed head — task, steps, highlighted report, search path", "root-merge-1-h0"],
        ["Running head — partial trace, live liveness", "root-merge-1-h1"],
        ["Head that died before its first step", "root-merge-1-h2"],
        ["Competed rollout — one proposal, no trace by construction", "n003"],
        ["A node neither store holds", "gone-1"],
      ].map(([label, nodeId]) => (
        <div key={nodeId} className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider p-text-3">{label}</div>
          <div className="h-[34rem] w-[44rem] flex flex-col">
            <NodeTranscript
              selection={{ runId: nodeId!.startsWith("n") ? "n000" : "root-merge-1", nodeId: nodeId! }}
              trees={MCTS_TREES} rpc={forkRpc} headActivity={NO_HEAD_ACTIVITY}
              onSelect={() => {}} />
          </div>
        </div>
      ))}
      {/* The other reader of the same view: the chat chip, which knows its head
          id by derivation and so needs no canvas selection. Both statuses,
          because a running branch and a settled one offer different things
          beside the disclosure. */}
      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wider p-text-3">
          Mid-turn branch chip — the transcript it opens in place
        </div>
        {(["running", "settled"] as const).map((status) => (
          <BranchRunChip key={status}
            run={{
              branchId: "steer-b7f21", status,
              task: "Actually, check the staging snapshot first — I don't think the migration ran there.",
              takeSetId: undefined, turnId: undefined, message: undefined,
            }}
            rpc={forkRpc} headActivity={NO_HEAD_ACTIVITY}
            // Unreachable here: the pick affordance only appears once a take set
            // has hydrated, and this frame photographs the disclosure, not takes.
            onPick={() => Promise.reject(new Error("no take set in this frame"))}
            onDismiss={() => {}} />
        ))}
      </div>
    </div>
  );
}

async function mount() {
  let node: React.ReactNode;
  let entries = ["/"];
  if (frame === "shell") node = <Shell />;
  else if (frame === "forks") node = <Shell surface="Exploration" mctsTrees={MCTS_TREES} rpc={forkRpc} />;
  else if (frame === "forkmerge") node = <Shell surface="Exploration" rpc={mergeFirstRpc} />;
  else if (frame === "forkfull" || frame === "forkbig") {
    const { default: MCTSExplorer } = await import("@/pages/MCTSExplorer");
    entries = ["/mcts/checkout-fixes?run=n000"];
    node = <Routes><Route path="/mcts/:agentId" element={<div className="h-screen p-bg p-text"><MCTSExplorer /></div>} /></Routes>;
  }
  else if (frame === "modal") node = <GalleryModal />;
  else if (frame === "palette") node = <Palette />;
  else if (frame === "landing2") node = <LandingV2 />;
  else if (frame === "tabs") node = <TabsFrame />;
  else if (frame === "markdown") node = <MarkdownFrame />;
  else if (frame === "chat") node = <ChatFrame />;
  else if (frame === "chatempty") node = <ChatEmptyFrame />;
  else if (frame === "chathistory") node = <ChatHistoryFrame />;
  else if (frame === "toolcalls") node = <ToolCallsFrame />;
  else if (frame === "streaming") node = <StreamingFrame />;
  else if (frame === "agent") node = <AgentFrame />;
  else if (frame === "transcript") node = <TranscriptFrame />;
  else if (frame === "views") node = <ViewsFrame />;
  else if (frame === "viewblocks") node = <ViewBlocksFrame />;
  else if (frame === "viewfail") node = <ViewFailFrame />;
  else if (frame === "releases") node = <ReleasesFrame />;
  else if (frame === "releasesoffline") node = <ReleasesFrame executors={RELEASE_EXECUTORS_OFFLINE} />;
  else if (frame === "work") node = <WorkFrame />;
  else if (frame === "workempty") node = <WorkEmptyFrame />;
  else if (frame === "approvals") node = <ApprovalsFrame />;
  else if (frame === "environment") node = <EnvironmentFrame />;
  else if (frame === "supervise") node = <SuperviseFrame />;
  // Three states of one block: every qualifier live, nothing left to qualify,
  // and a workspace that has spent nothing at all.
  else if (frame === "activity") node = <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_SNAPSHOT)} />;
  else if (frame === "activityclean") node = <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_CLEAN)} />;
  else if (frame === "activityempty") node = <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_FRESH)} />;
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
