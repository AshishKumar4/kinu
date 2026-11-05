/** What more than one of the gallery's frame groups draws or answers with: its shells, transcripts and RPC answers. */
import type { SessionRecord, TerminalSession } from "@kinu.run/devbox";
import { Result } from 'effect';
import { useCallback, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import type { UIMessage } from "ai";
import { mainPanelAgent, type PanelAgent, type WorkspaceGitHubView, type ModelMenuEntry, type RosterCounts, type RosterEntry, type RosterPage } from "@kinu.run/core";
import { followJobOutput, RECORDED_AT_METADATA_KEY, TURN_END_METADATA_KEY, TURN_FAILURE_METADATA_KEY, JOB_OUTPUT_EVENT, type JobOutputTail, type BranchTurnResult, type CompactOutcome } from "@kinu.run/core";
import { COMPLETION_GATE_EVENT, FORK_INTERRUPTED_SIGNAL, OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT, OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT, OWNER_ANSWER_SIGNAL, TASK_REMINDER_EVENT, TASK_REMINDER_OPEN_KEY } from "@kinu.run/core";
import { KinuError, refusalOf } from "@kinu.run/core/obs";
import { codenameFor, mintAgentName, WorkspaceTerminalInputSchema } from "@kinu.run/core";
import { ephemeralSlateAddress, type SlateCallResult, READS_CHANGED_EVENT, readsWrittenBy, seededRandom } from "@kinu.run/core";
import { OwnerAnswersSchema, PositionPageRequestSchema } from "@kinu.run/core";
import type { AlternateTakeSet, AskingAgent, OwedOwnerIntent, OwnerAnswer, TakePickOutcome } from "@kinu.run/core";
import { OwedOwnerIntentSchema } from "@kinu.run/core";
import Sidebar from "@/components/Sidebar";
import { ModelPicker } from "@/components/ModelPicker";
import { Composer, useProviderWaitNotice, type ComposerNotice } from "@/components/Composer";
import type { WorkMode } from "@kinu.run/core";
import { WorkspaceBarActions, WorkspaceHeader, type ChatTab } from "@/components/WorkspaceHeader";
import { ASSISTANT_ROSTER } from "./gallery-assistant";
import { type SurfaceKind } from "@kinu.run/core";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
import { SLATE_GALLERY_URL } from "@/gallery-slate-fallback";
import { longTurnNamePhases } from "@/gallery-long-turn-view";

import { admitReviewAnnotations, reviewFeedbackText } from "@kinu.run/core";
import { rosterBucket, rosterMatches, type AgentTaskTree } from "@kinu.run/core";
import { DeviceOfflineRow, MessageView } from "@/components/MessageView";
import { ADVISOR_HEADER, ADVISOR_NOTE_METADATA_KEY, ADVISOR_SEVERITIES, ADVISOR_SEVERITY_LABEL, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND, buildDrainBatch, CLEAR_NEEDS_IDLE, inspectWork, TURN_CLAIM_FRAME, JsonObjectSchema, missingSubagentHistory, FILES_PAGE_ENTRIES, seekPage, shownEntries, SubagentInspectionRequestSchema, type AdvisorSeverity, type JsonObject, type JsonValue, type PlanReview, type ReviewAnnotation, type OwedIntent, type PlanReviewDecision, type SubagentInspectionRequest, type SubagentInspectionResult } from "@kinu.run/core";
import type { ForkNode } from "@kinu.run/core";
import { answeringRpc, wireOf, type WorkspaceAnswer, type WorkspaceAnswers, type WorkspaceRpc } from "@/lib/workspace-rpc";
import { QUIET_ACTIVITY, UNRATED_WEEK } from "@/components/landing/landing-fixtures";
import type { ComputerSizeState } from "@/computer-size";
import { BoxSizeSchema, type BoxSize } from "@kinu.run/devbox/sizes";
import type { BackgroundJob, SubagentView } from "@kinu.run/core/protocol";
import { buildTree, type MctsRow } from "@kinu.run/core";
import type { ChatHistoryEntry, ChatHistoryPage, DirEntry, ExplorationCanvasRun, ForkRunSummary, HeadRunView, NodeTranscriptView, Page, PageRequest, FilesPage, InspectedWork, PendingAction, PendingDeviceConsent, SearchTreeRow } from "@kinu.run/core";
import * as v from "valibot";
import { galleryClearChat, galleryServerPush, seededGalleryChatRows } from "@/gallery-agent-stub";
import { AGENTS_PANEL, ANNOTATION_SAVES, ASKS_HELD, BACKGROUND_JOBS, BOARD_FULL, BUILD_JOB_ID, BUILD_LINES, CHANGELOG, CREATE_FAILS, ConsentSettleSchema, DRAIN_BATCHES, DecisionsSchema, EMPTY_TREES, EXTRA_WORKSPACE, FILES_REQUEST_ARGS, FIRST_DRIVE, FORK_PARAMS, GALLERY_ASK, GALLERY_DEVICE_SESSIONS, GALLERY_KEPT_PAGES, GALLERY_LOGO, GALLERY_MAIN_TITLE, GALLERY_PLAN_CONTENT, GALLERY_PLAN_STATUS, GALLERY_PLAN_THREAD, GALLERY_PLAN_TITLE_NOTE, GALLERY_PLAN_VARIANT, GALLERY_ROSTER, GALLERY_SESSIONS, GALLERY_SUBS, GALLERY_WORKSPACE_SESSIONS, HISTORY_HELD, HISTORY_LATENCY_MS, HISTORY_PICTURE, HISTORY_ROWS, HISTORY_UNEVEN, SEED_SERIES, IDLE_TURN, JOBS_RUNNING, JobsAnswerSchema, LATE_ASKS, MCTS_ACTIONS, MERGED_RUN, NOW, NO_GALLERY_FIGURES, NO_HEAD_ACTIVITY, OWED_CLAIM, OWED_EFFECT, OWED_TURNS, OWNER_REMINDER, PARKED_ASKS, PC_CONSENTED_ROOT, PC_SEGMENT, PENDING_ACTIONS, PROMPT, PROVE_ROWS, PTY_SCREENS, REFUSED_ROWS, RENAME_FAILS, RESTED_AGENTS, REVERT_CHECKPOINT, REVERT_LISTING, ROSTER_ASKED, RUNNING_ROWS, SHELL_COMPUTER, SHELL_GRANTS, SHELL_MACHINES, SHELL_PC, SNAPSHOT_FAILS, STOCK_OVERVIEWS, SWARM_ROWS, TAKE_COUNT, TWO_CONSENTS, WORKSPACE_PAGE_NAME, frame } from "@/gallery-data";

const STUB_DATA = v.parse(JsonObjectSchema, {
  // Every field the client's `UserProfileSchema` requires; a fixture that type-checks can still fail that parse.
  // The assistant's Important picks, as the shell's Mail icon and Home's Today read them (lib/mail-api.ts).
  "/api/user/mail/important": { enabled: true, unread: 2, items: [] },
  "/api/user/profile": {
    email: "ashish@example.com", displayName: "Ashish",
    createdAt: NOW - 90 * 864e5, lastSeenAt: NOW, onboardedAt: NOW - 90 * 864e5,
    // `&operator=1`: an operator's account, whose menu offers the control plane.
    workspaceCount: GALLERY_ROSTER.total, controlPlane: new URLSearchParams(location.search).get("operator") === "1",
  },
  // A ModelMenu, not a bare array.
  "/api/user/models": { models: MODEL_STUBS(), failures: [] },
  // Account settings' Devices card reads both; a 404 photographs its failure state.
  "/api/user/devices": [
    {
      id: "dev_1", label: "ashish-mbp", os: "darwin", hostname: "ashish-mbp.local",
      connected: true, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 90e3,
      expiresAt: NOW + 50 * 864e5,
      replacedAt: null, revokedAt: null, unstoppedAt: null, cloneDetectedAt: null, wholeMachine: false,
      sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, detail: null, gpu: [] },
      desktop: { state: "none" },
      version: null, servedVersion: null, update: "unreported", updateRefusal: null,
    },
  ],
  "/api/user/devices/consents": [
    {
      agentName: "api-worker", deviceId: "dev_1", policy: "remembered",
      lastMethod: "exec", lastSummary: "bun test packages/core",
    },
  ],
});

export const galleryRoster: RosterEntry[] = ROSTER_ASKED === "assistant"
  // The workspaces the personal assistant runs and watches (gallery-assistant.tsx).
  ? ASSISTANT_ROSTER.map((entry) => ({ ...entry, logo: entry.name === "api-worker" ? GALLERY_LOGO : entry.logo }))
  : [
    ...GALLERY_ROSTER.entries,
    ...(EXTRA_WORKSPACE ? [{
      name: "audit-sweep", displayName: "Audit sweep", createdAt: NOW - 14 * 864e5, lastVisited: NOW - 36e5,
    }] : []),
  ].map((entry) => {
    const overview = STOCK_OVERVIEWS.get(entry.name) ?? null;

    return { ...entry, overview, decisions: overview?.decisionsWaiting ?? 0, logo: entry.name === "api-worker" ? GALLERY_LOGO : null };
  });

export function galleryRosterCounts(): RosterCounts {
  const counts: RosterCounts = { all: galleryRoster.length, needs: 0, working: 0, idle: 0, unreported: 0, decisions: 0 };

  for (const entry of galleryRoster) {
    counts[rosterBucket(entry.overview?.activity ?? null, entry.decisions)] += 1;
    counts.decisions += entry.decisions;
  }

  return counts;
}

export function rosterAnswer(search: URLSearchParams): RosterPage {
  const bucket = search.get("bucket");
  const q = search.get("q") ?? "";

  const entries = galleryRoster.filter((entry) => rosterMatches(entry, q)
    && (bucket === null || rosterBucket(entry.overview?.activity ?? null, entry.decisions) === bucket));

  return { entries, total: entries.length, nextCursor: null, counts: galleryRosterCounts() };
}

export const STUB = new Map(Object.entries(STUB_DATA));

/** KINU-060: every WorkspaceRosterProvider mount is held; StrictMode mounts twice, so holding only the first read would let the second publish the ordinary fixture. */
export const rosterAuthorityHold = Promise.withResolvers<Response>();

export function MODEL_STUBS(): ModelMenuEntry[] {
  return [
    { spec: "opencode-go/muse-spark-1.3-contributor", label: "Muse Spark 1.3", provider: "OpenCode Go", reasoningEfforts: ["low", "medium", "high"] },
    { spec: "workers-ai/llama-4", label: "Llama 4 (Workers AI)", provider: "Workers AI" },
    { spec: "openai/gpt-5.6", label: "GPT-5.6", provider: "OpenAI" },
  ];
}

/** The screen a PTY lane replays as it opens: the computer's session's, or a PC's shell; none for the workspace's lane. */
function ptyScreen(query: URLSearchParams): string | undefined {
  const executor = query.get("executor");

  if (executor === "device") return PTY_SCREENS.device;

  if (executor !== "computer") return undefined;

  return Object.entries(PTY_SCREENS).find(([session]) => session === (query.get("session") ?? "shell"))?.[1];
}

/** `computer=asleep`: the computer sleeps until its terminal opens, as a page that read it before then finds it. */
let computerAwake = new URLSearchParams(location.search).get("computer") !== "asleep";

export class GalleryShellSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private line = "";

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    window.__kinuTerminalInput = [];
    const query = new URL(this.url, location.href).searchParams;
    window.__kinuTerminalWindow = { cols: Number(query.get("cols")), rows: Number(query.get("rows")) };

    // A PTY's lanes (the computer's sessions, a PC) carry the screen as bytes; the workspace's, as frames.
    const screen = ptyScreen(query);

    // The runtime replays its screen before ready; the computer is awake once its terminal opens.
    const open = () => {
      if (query.get("executor") === "computer") computerAwake = true;
      this.readyState = 1;
      const opened = new Event("open");
      this.onopen?.(opened);
      this.dispatchEvent(opened);

      if (screen !== undefined) this.onmessage?.(new MessageEvent("message", { data: new TextEncoder().encode(screen).buffer }));
      else this.emit({ type: "output", data: PROMPT });
      this.emit({ type: "ready" });
    };

    // Held, a socket connects for as long as the page's layout takes to settle around it.
    if (new URLSearchParams(location.search).get("terminalopen") === "held") window.__kinuOpenTerminals = open;
    else queueMicrotask(open);
  }

  send(raw: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // A native PTY's keystrokes are bytes; this shell reads the workspace's JSON frames.
    if (typeof raw !== "string") return;
    const parsed = v.safeParse(WorkspaceTerminalInputSchema, JSON.parse(raw));

    if (!parsed.success) return;

    if (parsed.output.type === "resize") {
      window.__kinuTerminalWindow = { cols: parsed.output.cols, rows: parsed.output.rows };

      return;
    }

    window.__kinuTerminalInput?.push(parsed.output.data);

    for (const char of parsed.output.data) {
      // xterm hands a paste over with newlines already CR, so CR is the only line end.
      if (char === "\r") this.run();
      else {
        this.line += char;
        this.emit({ type: "output", data: char });
      }
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "", wasClean: true }));
  }

  private run(): void {
    const command = this.line;

    this.line = "";
    this.emit({ type: "output", data: `\r\nran: ${command}\r\n${PROMPT}` });
  }

  private emit(message: { type: "output"; data: string } | { type: "ready" }): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

function mctsSearchRows(target: number, maxDepth: number): MctsRow[] {
  const rnd = seededRandom(0x5EA4C4);
  const rows: MctsRow[] = [];

  const push = (row: MctsRow): MctsRow => { rows.push(row);

 return row; };

  const root = push({
    id: "n000", parent_id: null, depth: 0, visits: 31, value: 0.028, own_score: 0.028,
    status: "open", action: "Find why /api/health 500s",
    task: "Find why /api/health 500s and fix it.",
    observation: "Four candidate fixes explored; one line survived to depth 6.",
    created_at: NOW - 36e5,
  });

  // A pruned branch keeps the children it had before it was cut.
  const fanoutOf = (node: MctsRow): number => {
    if (node.status === "pruned") return 2;

    if (node.depth === 0) return 4;

    return 2 + Math.floor(rnd() * 3);
  };

  const visitsOf = (onWinningLine: boolean, depth: number): number => {
    if (onWinningLine) return Math.max(2, 9 - depth);

    return rnd() < 0.35 ? 0 : 1 + Math.floor(rnd() * 2);
  };

  const statusOf = (onWinningLine: boolean, value: number): MctsRow["status"] => {
    if (onWinningLine) return "open";

    if (rnd() < 0.08) return "failed";

    if (value < 0.22) return "pruned";

    return "open";
  };

  let winner = root;
  const frontier: MctsRow[] = [root];

  while (rows.length < target) {
    const parent = frontier.shift();

    if (parent === undefined) break;

    if (parent.depth >= maxDepth || parent.status === "failed") continue;
    const fanout = fanoutOf(parent);

    for (let i = 0; i < fanout && rows.length < target; i++) {
      const onWinningLine = parent.id === winner.id && i === 0 && parent.status !== "pruned";

      const value = onWinningLine
        ? Math.min(0.97, 0.42 + parent.depth * 0.09 + rnd() * 0.06)
        : Math.max(0, (parent.value * 0.4 + rnd() * 0.5) - parent.depth * 0.06);

      const visits = visitsOf(onWinningLine, parent.depth);
      const status = statusOf(onWinningLine, value);

      // The engine scores a failed branch 0 and backpropagates it.
      const score = status === "failed" ? 0 : value;

      const child = push({
        id: `n${String(rows.length).padStart(3, "0")}`,
        parent_id: parent.id, depth: parent.depth + 1, visits, value: score, own_score: score, status,
        action: MCTS_ACTIONS[(rows.length * 7 + parent.depth) % MCTS_ACTIONS.length],
        observation: status === "failed"
          ? "Branch errored: staging refused the migration while the old Worker still held its binding."
          : `Scored ${score.toFixed(2)} — ${status === "pruned" ? "below the prune floor, dropped" : "kept for the next round"}.`,
        created_at: NOW - 36e5 + rows.length * 9e3,
      });

      if (onWinningLine) { winner = child; frontier.unshift(child); } else frontier.push(child);
    }
  }

  winner.status = "terminal";

  return rows;
}

/** The scale probe: the same search shape five times over and three levels deeper. */
export const MCTS_ROWS = frame === "forkbig" ? mctsSearchRows(520, 9) : mctsSearchRows(106, 6);

const MCTS_TREE = buildTree(MCTS_ROWS);

export const MCTS_TREES: ReadonlyMap<string, ForkNode> = new Map([[MCTS_TREE.id, MCTS_TREE]]);

type WorkspaceSnapshot = WorkspaceAnswer<"getWorkspaceSnapshot">;

/** The workspace as its snapshot opens it. Non-agent sockets (vite HMR) fall through to the real WebSocket. */
const WORKSPACE_SNAPSHOT: WorkspaceSnapshot = {
  status: {
    name: "api-worker-health-9935d3",
    displayName: "API Worker", purpose: "The api Worker on Cloudflare: keep it deployed, healthy and fast.",
    soul: "# API Worker\n\nI look after the api Worker: its deploys, its database and its logs. I read the logs before I guess.\n",
    createdAt: NOW - 7 * 864e5, scaffoldVersion: 7, searchNodeCount: 106,
    messageCount: 48, model: "opencode-go/muse-spark-1.3-contributor", forkLineage: null, reasoningEffort: "medium",
    layout: "workbench", roleId: "default", tierId: "default", context: null,
  },
  tools: { builtIn: [], crafted: [], executors: [] },
  memoryContent: "",
  executors: SHELL_COMPUTER || SHELL_PC !== null ? SHELL_MACHINES.executors : [], executorOutputs: [],
  lastActiveExecutor: SHELL_COMPUTER ? "computer" : null,
  // Mirrors the server snapshot: the load replaces state wholesale, so an omitted field is `undefined`.
  chat: {
    name: "api-worker-health-9935d3", actorId: "agent_01j9x7q2m4apiworker", displayName: "API Worker", role: "default",
    mission: "The api Worker on Cloudflare: keep it deployed, healthy and fast.",
    model: { model: "opencode-go/muse-spark-1.3-contributor", source: "workspace" }, reasoningEffort: "medium",
    activePlan: null, messageCount: 48, pendingSteers: [],
  },
  branchRuns: [],
  tabPresence: { explorations: true, work: true },
  slates: [],
  turnClaim: { kind: "settled" },
};

/** `snapshot` with its workspace agent's chat changed by `patch`, as the server's snapshot carries it. */
export function withChat(snapshot: WorkspaceSnapshot, patch: Partial<WorkspaceSnapshot["chat"]>): WorkspaceSnapshot {
  return { ...snapshot, chat: { ...snapshot.chat, ...patch } };
}

/** The snapshot the page opens on: `&ws=handwrought-walnut-4166c321` is the untitled row, whose snapshot answers a blank displayName. */
export const OPENING_SNAPSHOT: WorkspaceSnapshot = WORKSPACE_PAGE_NAME === "handwrought-walnut-4166c321"
  ? withChat({
    ...WORKSPACE_SNAPSHOT,
    status: { ...WORKSPACE_SNAPSHOT.status, name: "handwrought-walnut-4166c321", displayName: "", soul: "" },
  }, { name: "handwrought-walnut-4166c321", displayName: "", mission: "" })
  : WORKSPACE_SNAPSHOT;

/** The Agents-SDK socket's own reads, answered in-page so socket-gated pages render without a worker. */
export const AGENT_ANSWERS: WorkspaceAnswers = {
  getWorkspaceSnapshot: () => OPENING_SNAPSHOT,
  getStoredModelSpec: () => ({ spec: "opencode-go/muse-spark-1.3-contributor" }),
  getShellApprovalMode: () => ({ mode: "strict" }),
  getEvolutionChangelog: () => ({ entries: [], unseenCount: 0, seenAt: 0 }),
};

interface GalleryMessage extends UIMessage { createdAt?: number }

export function msg(message: GalleryMessage): GalleryMessage { return message; }

export const MESSAGES: UIMessage[] = [
  // The owner typed a mission, not a message, so this must never wear their bubble.
  msg({
    id: "g1", role: "user", createdAt: NOW - 7 * 60e3,
    metadata: { kinuEvent: "workspace_created", signalId: "sig-genesis" },
    parts: [{ type: "text", text: "This workspace has just been created. This is its first turn and nobody has typed anything yet." }],
  }),
  msg({
    id: "u1", role: "user", createdAt: NOW - 6 * 60e3,
    parts: [{ type: "text", text: "Audit the api Worker, find why /api/health answers 500, and fix it. Deploy to staging when green." }],
  }),
  msg({
    id: "a1", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [
      { type: "reasoning", text: "**Reproducing the failure**\n\nEvery route that opens the database goes through `openDb`. I should reproduce first, then bisect." },
      { type: "reasoning", text: "**Bisecting**\n\nThe route, `openDb`, then the config change that landed Tuesday. A 500 on every route that reads a session, and none on the static ones, points at the database binding." },
      { type: "tool-run", toolCallId: "t1", state: "output-available", input: { runtime: "computer", command: "curl -s localhost:8787/api/health" }, output: "HTTP 500\n{\"error\":\"TypeError: Cannot read properties of undefined (reading 'prepare')\"}" },
      { type: "tool-eval", toolCallId: "t2", state: "output-available", input: { code: "// Which binding does the config give the database, and which does openDb read?\nconst config = JSON.parse(await fs.read(\"workers/api/wrangler.jsonc\"));\nreturn { configured: config.d1_databases.map((db) => db.binding), read: \"env.DB\" };" }, output: '{"configured":["SESSIONS_DB"],"read":"env.DB"}' },
      { type: "text", text: "Found it. Tuesday's config renamed the sessions database's binding to `SESSIONS_DB`, but `openDb` still returns `env.DB`, which is undefined now.\n\n```ts\nreturn env.SESSIONS_DB ?? env.DB;\n```\n\nI'll patch `openDb`, add a regression test, and run the suite." },
      // A run of calls, not one.
      { type: "tool-file", toolCallId: "t4", state: "output-available", input: { op: "read", path: "workers/api/src/db.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "t5", state: "output-available", input: { op: "read", path: "workers/api/wrangler.jsonc" }, output: "…" },
      // A quiet failure: state output-available, but the tool returned its own `{error}` (tools/builtins.ts); unsurfaced, it makes the group read clean.
      { type: "tool-file", toolCallId: "t6", state: "output-available", input: { op: "edit", path: "workers/api/src/db.ts", edits: [{}, {}] }, output: { error: "old_text not found or not unique — the file changed since the last read" } },
      { type: "tool-file", toolCallId: "t7", state: "output-available", input: { op: "write", path: "workers/api/test/integration/sessions-binding.test.ts" }, output: "ok" },
      { type: "tool-agents", toolCallId: "t8", state: "output-available", input: { op: "swarm", branches: 3, task: "Check every other route that reads `env.DB` itself" }, output: "3 forks merged" },
      { type: "tool-run", toolCallId: "t3", state: "input-available", input: { runtime: "computer", command: "bun test workers/api" } },
    ],
  }),
  msg({
    id: "bg1", role: "user",
    metadata: { kinuEvent: "background_job", kind: "test-suite", status: "completed" },
    parts: [{ type: "text", text: "background job completed" }],
  }),
  msg({
    id: "d1", role: "user",
    metadata: { kinuEvent: "event_drain" },
    parts: [{ type: "text", text: "While you were idle:\n- [subagent_report] from subagent (binding-tester): All 14 of the Worker's regression tests green after the binding fix. [the sender awaits your answer]\n- [webhook] from github (AshishKumar4/api-worker): PR #212 review requested" }],
  }),
  // Copied from production: written before the author stamp, so a bare UUID id and the event name are its only markers.
  msg({
    id: "f8798675-5e9a-4d13-aac2-293f4557f1c1", role: "user",
    metadata: { kinuEvent: "fork_interrupted", runs: ["6xrijuf933p0jclpctw59"], heads: 23 },
    parts: [{ type: "text", text: "23 head(s) across 6 fork run(s) were still marked running from an activation that has ended, so nothing is executing them and no report will arrive. They have been released; re-run the ones you still need." }],
  }),
  msg({
    id: "programmatic:completion-gate-1", role: "user",
    metadata: { kinuEvent: "completion_gate", kinuAuthor: "harness" },
    parts: [{ type: "text", text: "[Runtime check — a mechanical gate from Kinu, not written by the user.]\n\nYou said the task is done. Here is the current state of the working directory, read after you stopped." }],
  }),
  msg({
    id: "a2", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [
      { type: "reasoning", text: "The edit failed because old_text no longer matched after the formatter ran, so the file on disk is not the one I read; I should re-read it, apply the change against what is there now, then start the Worker against both binding names, because staging still binds the database as DB and production as SESSIONS_DB, and the fix must answer both until staging redeploys." },
      { type: "text", text: "The edit above didn't take — re-reading before I retry, then confirming the Worker starts against both binding names before I let it near staging." },
      // Its own row (a lone text part on either side stops it folding into a run) so its expanded state is inspectable.
      {
        type: "tool-run", toolCallId: "t9", state: "output-available",
        input: {
          runtime: "computer",
          command: "for f in workers/api/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone",
        },
        output: "-- checking workers/api/migrations/0006_users.sql\n-- checking workers/api/migrations/0007_sessions.sql",
      },
      { type: "text", text: "Migrations are clean. One more check before I loop back to the edit." },
      // A protocol-level failure: no `output`; the reason is in errorText.
      {
        type: "tool-run", toolCallId: "t10", state: "output-error",
        input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/api-worker" },
        errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443",
      },
      { type: "text", text: "CI didn't answer — checking the PR directly instead." },
      // No summarizer contract: name plus its one string argument; long enough to exercise truncation.
      {
        type: "dynamic-tool", toolCallId: "t11", toolName: "mcp_gh_search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/api-worker is:open head:fix/sessions-binding base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Read the sessions database by its new binding\" — checks pending",
      },
      // A crafted tool: the result line attributes it; builtins and `mcp_` tools never do.
      {
        type: "dynamic-tool", toolCallId: "t12", toolName: "bisect_config", state: "output-available",
        input: { config: "workers/api/wrangler.jsonc", key: "d1_databases" },
        output: "3f2a91c renamed the binding DB to SESSIONS_DB",
      },
      { type: "text", text: "CI didn't answer — retrying after the fix lands. PR #212 is already up for review." },
    ],
  }),
];

function galleryPlanInspection(request: SubagentInspectionRequest, plans: readonly PlanReview[]): SubagentInspectionResult {
  if (request.view === 'plans') return { view: 'plans', path: request.path, page: { status: 'end', items: plans } };

  if (request.view === 'children') {
    // Counted: a nested agent's column reads its roster once per identity, never once per render.
    const root = document.documentElement.dataset;
    root.galleryChildrenReads = String(Number(root.galleryChildrenReads ?? '0') + 1);

    return { view: 'children', path: request.path, page: { status: 'end', items: [] } };
  }

  if (request.view === 'planTasks') return { view: 'planTasks', path: request.path, tasks: [] };

  // Answers only the reference asked for; an unissued revision is `missing`, so a stale hint cannot paint a neighbouring plan.
  if (request.view === 'plan') {
    const plan = plans.find(item => item.id === request.id && item.revision === request.revision);

    return plan
      ? { view: 'plan', path: request.path, plan }
      : missingSubagentHistory(request.path);
  }

  throw new Error('Unexpected gallery plan inspection');
}

/**
 * Every read and act a frame may ask, each answered as the product answers it: empty where the product's type has an
 * empty, an act's own outcome where it echoes its input. A read with no honest empty (a snapshot, an opening) is not
 * here: the frame that draws it gives its own, and any other asking it is refused, never answered a shape it did not ask.
 */
export const GALLERY_ANSWERS: WorkspaceAnswers = {
  inspectSubagent: (request) => galleryPlanInspection(request, []),
  inspectWork: () => [],
  getExposedPorts: () => ({ ports: [] }),
  // `ExecutorDiffResult` (core read-models/workspace-diff.ts) always carries `files`; `vfs-baseline` is the answer for an empty `executors` prop.
  getExecutorDiff: () => ({ files: [], mode: "vfs-baseline" }),
  getExecutorChangeCount: () => ({ files: 0 }),
  getExecutorFiles: (_executor, path) => ({ path, entries: [] }),
  getExecutors: () => [],
  listMounts: () => [],
  listWorkspaceWork: () => ({ plans: [], tasks: [] }),
  getComputerSize: () => galleryComputerSize(null),
  startComputer: () => galleryComputerSize(null),
  stopStalledComputer: () => galleryComputerSize(null),
  resizeComputer: (size) => galleryResize(size),
  getComputerPreviewPublic: () => ({ public: null }),
  setComputerPreviewPublic: (_port, open) => ({ public: open }),
  listComputerSessions: () => GALLERY_SESSIONS.map((session) => ({ ...session, open: session.open && computerAwake })),
  openComputerSession: () => openGallerySession(GALLERY_SESSIONS, (count) => ({ id: `s${String(count + 2)}`, name: `shell ${String(count + 1)}`, cwd: "/workspace" })),
  renameComputerSession: (id, name) => renameGallerySession(GALLERY_SESSIONS, id, name),
  closeComputerSession: (id) => { closeGallerySession(GALLERY_SESSIONS, id); },
  listDeviceSessions: () => GALLERY_DEVICE_SESSIONS,
  openDeviceSession: () => openGallerySession(GALLERY_DEVICE_SESSIONS, (count) => ({ id: `pty-${String(count + 1)}`, name: `shell ${String(count + 1)}`, cwd: "" })),
  renameDeviceSession: (_device, id, name) => renameGallerySession(GALLERY_DEVICE_SESSIONS, id, name) ?? { id, name, cwd: "" },
  closeDeviceSession: (_device, id) => { closeGallerySession(GALLERY_DEVICE_SESSIONS, id); },
  listWorkspaceSessions: () => GALLERY_WORKSPACE_SESSIONS,
  openWorkspaceSession: () => openGallerySession(GALLERY_WORKSPACE_SESSIONS, (count) => ({ id: `w-${String(count + 1)}`, name: `shell ${String(count + 1)}`, cwd: "/home/main" })),
  renameWorkspaceSession: (id, name) => renameGallerySession(GALLERY_WORKSPACE_SESSIONS, id, name) ?? { id, name, cwd: "/home/main" },
  closeWorkspaceSession: (id) => { closeGallerySession(GALLERY_WORKSPACE_SESSIONS, id); },
  // Read as `result.builtIn.map(...)`; three halves, as the orchestrator answers it.
  getToolDescriptions: () => ({ builtIn: [], executors: [], crafted: [] }),
  getAlwaysActiveSkills: () => ({ names: [] }),
  listTriggers: () => ({ triggers: [] }),
  // None, as before the person has an address.
  agentMail: () => null,
  getActivePlanReview: () => null,
  getActivitySnapshot: () => QUIET_ACTIVITY,
  getChangeNotes: () => [],
  getEvolutionChangelog: () => ({ entries: [], unseenCount: 0, seenAt: 0 }),
  markChangelogSeen: () => ({ ok: true, seenAt: Date.now() }),
  getFacts: () => [],
  getForkRun: () => null,
  getHeadRun: () => null,
  getMemoryContent: () => "",
  getNodeTranscript: () => null,
  getQuality: () => [],
  getQualityWindow: () => UNRATED_WEEK,
  getSearchTree: () => [],
  getShellApprovalGrants: () => ({ grants: [] }),
  revokeShellApprovalGrants: () => ({ grants: [] }),
  listAlternateTakes: () => ({}),
  listBackgroundJobs: () => [],
  listOwedIntents: () => [],
  listPendingActions: () => [],
  listPendingConsents: () => [],
  listScaffoldVersions: () => [],
  listSlates: () => ({ slates: [], problems: [] }),
  listSubagents: () => [],
  listTurnFeedback: () => ({}),
  listWorkspaceAgents: () => [],
  readInstructionApproval: () => null,
  searchMemoryHybrid: () => [],
  answerOwnerQuestions: () => null,
  decideDeferredApprovals: () => ({ decided: [] }),
  dismissOwnerQuestions: () => ({ closed: 0 }),
  dismissSubagent: (name) => ({ ok: true, name, historyKept: true }),
  deleteExecutorFile: () => ({ ok: true }),
  renameExecutorFile: () => ({ ok: true }),
  namePhases: () => false,
  recoverStrandedTurn: () => ({ recovered: "none" }),
  regenerateWorkspaceLogo: () => ({ drawn: false, refusal: null }),
  renameMainChat: (title) => ({ title }),
  resolveDeviceConsent: () => ({ ok: true }),
  restoreWorkspaceBaseline: () => ({ ok: true, capturedAt: Date.now() }),
  setDisplayName: (displayName) => ({ displayName }),
  setLayout: (layout) => ({ layout }),
  setModel: (spec) => ({ ok: true, spec }),
  setShellApprovalMode: (mode) => ({ ok: true, mode }),
  setTurnFeedback: (messageId, feedback) => ({ ok: true, messageId, feedback }),
  clearConversation: () => {},
  revertConversation: () => {},
  send: () => {},
  stopSwarmWorker: () => {},
};

/** A frame's rpc: the gallery's answers, with its own in their place. */
export function galleryRpc(overrides: WorkspaceAnswers = {}): WorkspaceRpc {
  return answeringRpc({ ...GALLERY_ANSWERS, ...overrides });
}

/** The computer's size as its box reads it: running only while it is awake. */
function galleryComputerSize(running: BoxSize | null): ComputerSizeState {
  return { account: null, chosen: null, size: running ?? "medium", running: computerAwake ? running ?? "medium" : null, startRefused: null, stalled: null };
}

/** A resize restarts the computer at the size asked for; `resize=held` answers it only at `__kinuEndResize()`. */
async function galleryResize(size: string | null): Promise<ComputerSizeState> {
  if (new URLSearchParams(location.search).get("resize") === "held") await new Promise<void>((resolve) => { window.__kinuEndResize = resolve; });
  // As the server reads the size asked: a name no size has is no choice.
  const asked = v.safeParse(BoxSizeSchema, size);

  return galleryComputerSize(asked.success ? asked.output : null);
}

/** A session opened on `sessions`, named as its box names the next one. */
function openGallerySession(sessions: TerminalSession[], named: (count: number) => SessionRecord): SessionRecord {
  const record = named(sessions.length);

  sessions.push({ ...record, open: false, running: null, last: null, ports: [], branch: null, needsInput: false });

  return record;
}

/** `id` renamed on `sessions`, its record answered; null when there is no such session. */
function renameGallerySession(sessions: TerminalSession[], id: string, name: string): SessionRecord | null {
  const at = sessions.findIndex((session) => session.id === id);
  const found = sessions[at];

  if (found === undefined) return null;
  sessions[at] = { ...found, name };

  return { id, name, cwd: found.cwd };
}

function closeGallerySession(sessions: TerminalSession[], id: string): void {
  const at = sessions.findIndex((session) => session.id === id);

  if (at >= 0) sessions.splice(at, 1);
}

let createRefused = false;

function maybeRefuseCreate(): void {
  if (!CREATE_FAILS || createRefused) return;
  createRefused = true;
  throw new Error("the workspace refused the new agent", {
    cause: new Error("subagent quota exhausted"),
  });
}

/** A task and its steps as the store numbers them: `t` and the agent's next seq, steps taking the seqs after it. */
function galleryTask(seq: number, title: string, status: AgentTaskTree["status"], steps: readonly AgentTaskTree["status"][] = []): AgentTaskTree {
  const id = `t${String(seq)}`;

  return {
    id, parentId: null, title, status, updatedAt: 1, note: null,
    subtasks: steps.map((step, at) => ({ id: `t${String(seq + 1 + at)}`, parentId: id, title: `Step ${String(at + 1)}`, status: step, updatedAt: 1, note: null })),
  };
}

/** Derived from the name, so gate-stamped frames and the pane's snapshot id agree without a second fixture. */
export function galleryActorId(name: string): string {
  return `actor-${name}`;
}

/* `threads`: the next revision, carrying that exchange read-only; `replied`: the revision sent back, as the replies land. */
const GALLERY_PLAN_ANNOTATIONS: readonly ReviewAnnotation[] = new Map<string | null, readonly ReviewAnnotation[]>([
  ["annotated-heading", [GALLERY_PLAN_TITLE_NOTE]],
  ["threads", GALLERY_PLAN_THREAD.map((note) => ({ ...note, revision: 1 }))],
  ["replied", GALLERY_PLAN_THREAD],
]).get(GALLERY_PLAN_VARIANT) ?? [];

export let galleryAgentPlan: PlanReview = {
  id: "gallery-agent-plan",
  sessionId: "default",
  revision: GALLERY_PLAN_VARIANT === "threads" ? 2 : 1,
  content: GALLERY_PLAN_CONTENT,
  status: GALLERY_PLAN_STATUS,
  annotations: GALLERY_PLAN_ANNOTATIONS,
  feedback: null,
  handoffAccepted: false,
  createdAt: NOW,
  updatedAt: NOW,
};

/* The walk-back: two user turns, so there is a second message to revert to. `?transcript=revert` seeds it;
   `?checkpoints=1` adds a connected device and a checkpoint, the one condition that offers the device files too. */
export const REVERT_THREAD: UIMessage[] = [
  msg({
    id: "rv-u1", role: "user", createdAt: NOW - 8 * 60e3,
    parts: [{ type: "text", text: "Add the missing-binding regression test and run the Worker's suite." }],
  }),
  // The loop stopped mid-work after a settled call (a step ceiling), so only the turn's own end says it did not finish.
  msg({
    id: "rv-a1", role: "assistant", createdAt: NOW - 7 * 60e3, metadata: { [TURN_END_METADATA_KEY]: "incomplete" },
    parts: [{ type: "tool-shell", toolCallId: "rv-call-1", state: "output-available", input: { command: "bun test test/integration/sessions-binding.test.ts" }, output: "14 pass\n0 fail" }],
  }),
  msg({
    id: "rv-u2", role: "user", createdAt: NOW - 6 * 60e3,
    parts: [{ type: "text", text: "Now move the webhook routes onto openDb, so none reads the binding itself." }],
  }),
  msg({
    id: "rv-a2", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [
      { type: "tool-shell", toolCallId: "rv-call-2", state: "output-available", input: { command: "bun test workers/api/src/routes" }, output: "31 pass\n0 fail" },
      { type: "text", text: "Moved `routes/webhooks.ts` onto `openDb` and updated eleven call sites." },
    ],
  }),
];

const harnessTurn = (id: string, metadata: JsonObject, text: string) => msg({ id, role: "user", metadata: { kinuAuthor: "harness", ...metadata }, parts: [{ type: "text", text }] });

/** Every event a turn can open on that has no card of its own, each with the fields its producer keeps beside it and
 *  words in the shape the agent is handed them, which the card never shows. */
export const SYSTEM_EVENT_ROWS: UIMessage[] = [
  harnessTurn("event-task-reminder", { kinuEvent: TASK_REMINDER_EVENT, [TASK_REMINDER_OPEN_KEY]: [...OWNER_REMINDER?.titles ?? []] }, OWNER_REMINDER?.text ?? ""),
  harnessTurn("event-task-reminder-kept", { kinuEvent: TASK_REMINDER_EVENT }, OWNER_REMINDER?.text ?? ""),
  harnessTurn("event-continuation", { kinuEvent: OUTPUT_CONTINUATION_EVENT }, OUTPUT_CONTINUATION_TEXT),
  harnessTurn("event-overflow", { kinuEvent: OVERFLOW_RETRY_EVENT }, OVERFLOW_RETRY_TEXT),
  harnessTurn("event-gate", { kinuEvent: COMPLETION_GATE_EVENT }, "[Runtime check — a mechanical gate from Kinu, not written by the user.]\n\nThis run ends after your next reply."),
  harnessTurn("event-consent", { kinuEvent: "device_consent", ids: ["c1", "c2", "c3"], approved: 2, denied: 1 },
    "Your owner answered your device requests: 2 approved, 1 denied. Re-issue the approved commands to run them."),
  harnessTurn("event-sandbox", { kinuEvent: "sandbox_lifecycle_failure", incidentId: "inc-1", stage: "checkpoint", reason: "The snapshot upload timed out after 3 tries." },
    "The workspace container failed at the checkpoint stage. Work written inside the container since the last good checkpoint is NOT durable.\n\nIncident id: inc-1"),
  harnessTurn("event-plan-approved", { kinuEvent: "plan_approved", planId: "plan-1", revision: 2, decision: "approve", planTitle: "Read the database by its new binding" },
    "The owner approved plan plan-1 revision 2.\n\nImplement the exact approved plan below.\n\n<approved-plan>\n# Read the database by its new binding\n</approved-plan>"),
  harnessTurn("event-plan-feedback", { kinuEvent: "plan_feedback", planId: "plan-1", revision: 1, decision: "changes", planTitle: "Read the database by its new binding", feedback: "Split the staging config from the code change." },
    "The owner asked for changes to plan plan-1 revision 1.\n\nRevise the plan with targeted submit_plan edits. Do not implement or create previews."),
  harnessTurn("event-slate", { kinuEvent: "slate", slate: "deploy-board", said: "Which region should the canary go to?", ask: true },
    "Slate deploy-board: Which region should the canary go to?\nYour answer's text streams to slate deploy-board as you write it: answer it in prose."),
  harnessTurn("event-waits", { kinuEvent: "owner_waits_cleared", key: "plan:main:plan-1:2", what: "Read the database by its new binding" }, "Your owner has handled what you waited on: Read the database by its new binding"),
  harnessTurn("event-take", { kinuEvent: "take_pick" }, "While you answered, the user redirected and that redirect ran as a parallel branch. Comparing both answers, the user picked the branch's."),
  harnessTurn("event-fork", { kinuEvent: FORK_INTERRUPTED_SIGNAL, runs: ["6xrijuf933p0jclpctw59"], heads: 9 },
    "9 head(s) across 1 fork run(s) were still marked running from an activation that has ended, so nothing is executing them and no report will arrive."),
  harnessTurn("event-unknown", { kinuEvent: "a_kind_invented_tomorrow" }, "<instructions>Something only the agent should read.</instructions>"),
];

/* `?transcript=refused`: a turn the provider refused, as a reload reads it back. */
export const REFUSED_THREAD: UIMessage[] = [
  msg({ id: "rf-u1", role: "user", createdAt: NOW - 3 * 60e3, parts: [{ type: "text", text: "Plan the quarterly offsite." }] }),
  msg({
    id: "rf-a1", role: "assistant", createdAt: NOW - 3 * 60e3, parts: [],
    metadata: { [TURN_FAILURE_METADATA_KEY]: "opencode-go is rate-limited until 2026-10-17 00:18 UTC (in 8d 15h): Go usage limit exceeded" },
  }),
];

/** `&questions=open`: the questions wait in the stack; answering or dismissing them closes them, as the store would. */
function galleryQuestions(): AskingAgent[] {
  if (new URLSearchParams(location.search).get("questions") !== "open") return [];
  const closed = document.documentElement.dataset.galleryQuestions;
  const answers = v.parse(v.nullable(OwnerAnswersSchema), JSON.parse(document.documentElement.dataset.galleryAnswers ?? "null"));

  return [{
    agent: WORKSPACE_PAGE_NAME, actor: null,
    asked: {
      id: "q-1", actor: galleryActorId(WORKSPACE_PAGE_NAME), callId: "ask-1", turnId: "turn-ask", mode: "build", questions: GALLERY_ASK.questions,
      status: closed === "answered" || closed === "dismissed" ? closed : "open", answers, askedAt: NOW - 2 * 60e3,
    },
  }];
}

function galleryCloseQuestions(status: "answered" | "dismissed", answers: readonly OwnerAnswer[] | null): WorkspaceAnswer<"dismissOwnerQuestions"> {
  const root = document.documentElement.dataset;

  root.galleryQuestions = status;
  root.galleryAnswers = JSON.stringify(answers);
  queueMicrotask(() => { galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listOwnerQuestions"] })); });

  return { closed: 1 };
}

/** `&intent=decision|answers|retry` shows an intent waiting for the agent's next wake. Retry uses `transcript=refused`. */
export function galleryOwedIntents(): readonly OwedOwnerIntent[] {
  const replacement = document.documentElement.dataset.galleryOwedIntents;

  if (replacement !== undefined) return v.parse(v.array(OwedOwnerIntentSchema), JSON.parse(replacement));
  const kind = new URLSearchParams(location.search).get("intent");

  if (kind === "decision") return [{ id: "owed-decision", kind, target: galleryAgentPlan.id, actor: null }];

  if (kind === "answers") return [{ id: "owed-answers", kind, target: "q-1", actor: null }];

  if (kind === "retry") {
    const newest = REFUSED_THREAD.find((message) => message.role === "user");

    return newest === undefined ? [] : [{ id: "owed-retry", kind, target: newest.id, actor: null }];
  }

  return [];
}

function galleryOweIntent(intent: OwedOwnerIntent): OwedIntent {
  document.documentElement.dataset.galleryOwedIntents = JSON.stringify([...galleryOwedIntents(), intent]);
  galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listOwedIntents"] }));

  return { owed: intent.id };
}

/** As the Durable Object broadcasts it after the walk-back. */
function galleryRevertConversation(entryId: string): void {
  const from = REVERT_THREAD.findIndex((message) => message.id === entryId);
  const kept = from < 0 ? REVERT_THREAD : REVERT_THREAD.slice(0, from);

  galleryServerPush(JSON.stringify({ type: "cf_agent_chat_messages", messages: kept }));
}

type GalleryListing = { readonly kind: "held" } | { readonly kind: "listed"; readonly value: WorkspaceAnswer<"getExposedPorts"> };

function galleryPortListing(executor: string | undefined): GalleryListing | null {
  const flags = document.documentElement.dataset;

  if (flags.listingHeld === "1") return { kind: "held" };

  if (executor !== "computer") return null;

  if (flags.sandboxStarting === "1") return { kind: "listed", value: { ports: [], pending: "the computer is still restoring" } };

  // `data-sandbox-ports`: what the sandbox answers next. `failed`: an error; `forged`: a port whose address is not
  // a preview's; `none`: no ports at all.
  if (flags.sandboxPorts === "failed") return { kind: "listed", value: { ports: [], error: "Nimbus is temporarily unavailable" } };

  if (flags.sandboxPorts === "forged") return { kind: "listed", value: { ports: [{ port: 8130, url: "https://evil.example/", name: "Arrived app" }] } };

  if (flags.sandboxPorts === "none") return { kind: "listed", value: { ports: [] } };

  // Arrives after first paint.
  if (flags.previewArrived === "1") {
    return { kind: "listed", value: { ports: [{ port: 8130, url: "https://8130-sandbox-aaaaaaaaaaaaaaaa.preview.example.test/", name: "Arrived app" }] } };
  }

  return null;
}

/** `&slates=3`: three slates, whose tabs overflow the strip. */
function gallerySlates() {
  return {
    slates: [...["Board", "Notes", "Tally"].slice(0, Number(new URLSearchParams(location.search).get("slates") ?? 0))
      .map((title) => ({ id: title.toLowerCase(), title })), ...GALLERY_KEPT_PAGES],
    problems: [],
  };
}

let galleryTakes: AlternateTakeSet = {
  id: "take-1", turnId: "rv-a2", sessionId: "default", task: "Move the webhook routes onto openDb", winnerNodeId: "win",
  chosenNodeId: null, createdAt: NOW - 5 * 60e3,
  candidates: ([
    { nodeId: "win", text: "Moved `routes/webhooks.ts` onto `openDb` and updated eleven call sites.", origin: "live" },
    { nodeId: "alt", text: "Kept each route's own read and checked the binding at its three call sites.", origin: "branch" },
    { nodeId: "alt2", text: "Moved the binding check into middleware the webhook routes share; each reads the database it is handed.", origin: "branch" },
  ] satisfies AlternateTakeSet["candidates"]).slice(0, TAKE_COUNT),
};

function galleryPickTake(args?: unknown[]): TakePickOutcome {
  const [, nodeId] = v.parse(v.tuple([v.string(), v.string()]), args);
  const chosen = galleryTakes.candidates.find((candidate) => candidate.nodeId === nodeId);

  if (chosen === undefined) throw new Error(`gallery: no take ${nodeId}`);
  galleryTakes = { ...galleryTakes, chosenNodeId: nodeId };

  return { changedAnswer: nodeId !== galleryTakes.winnerNodeId, chosen, set: galleryTakes, continuationQueued: false };
}

export const annotationRelease: (() => void)[] = [];

let annotationSavesAsked = 0;

let annotationSavesInFlight = 0;

async function galleryAnnotationSave(args?: unknown[]): Promise<WorkspaceAnswer<"savePlanReviewAnnotations">> {
  const [, , annotations] = v.parse(v.tuple([v.string(), v.number(), v.array(v.looseObject({ text: v.optional(v.string()) }))]), args);
  // The store's own admission, so the gallery refuses what the workspace would.
  const carried = galleryAgentPlan.annotations.filter((note) => note.revision !== undefined);
  const admitted = admitReviewAnnotations({ value: annotations, kept: carried });

  if (Result.isFailure(admitted)) return { ok: false, error: admitted.failure.error, plan: galleryAgentPlan };
  const root = document.documentElement;

  annotationSavesAsked += 1;
  annotationSavesInFlight += 1;
  root.dataset.galleryAnnotationsMostInFlight = String(Math.max(annotationSavesInFlight, Number(root.dataset.galleryAnnotationsMostInFlight ?? "0")));

  if (ANNOTATION_SAVES === "held") {
    await new Promise<void>((resolve) => {
      annotationRelease.push(resolve);
      root.dataset.galleryAnnotationsWaiting = String(annotationRelease.length);
    });
  }

  annotationSavesInFlight -= 1;

  if (ANNOTATION_SAVES === "fail-first" && annotationSavesAsked === 1) return { ok: false, error: "the plan store is busy", plan: galleryAgentPlan };

  const landed = v.parse(v.array(v.array(v.string())), JSON.parse(root.dataset.galleryAnnotationsSaved ?? "[]"));

  root.dataset.galleryAnnotationsSaved = JSON.stringify([...landed, annotations.map((annotation) => annotation.text ?? "")]);
  galleryAgentPlan = { ...galleryAgentPlan, annotations: [...carried, ...admitted.success] };

  return { ok: true, plan: galleryAgentPlan };
}

type OwnedWork = WorkspaceAnswer<"listWorkspaceWork">["tasks"][number];

/** The workspace's own agent as Work names it: the owner is the workspace's name, as `createMain({ name: this.name })` registers it, never "main". */
const PAGE_OWNER: OwnedWork["owner"] = { actorId: galleryActorId(WORKSPACE_PAGE_NAME), name: WORKSPACE_PAGE_NAME, title: WORKSPACE_PAGE_NAME, retired: false, path: [] };

/** `dataset.workMoved`: a task written during an outage. */
const WORK_WRITTEN_IN_OUTAGE: OwnedWork = {
  owner: PAGE_OWNER, plan: null,
  tasks: [{ id: "t14", parentId: null, title: "Written during the outage", status: "active", updatedAt: 1, note: null, subtasks: [] }],
};

const WORK_BOARD: OwnedWork = {
  owner: PAGE_OWNER, plan: null,
  tasks: [
    galleryTask(1, "Read the database by its new binding in openDb", "active", ["done", "done", "active", "open"]),
    galleryTask(6, "Write the release note for the binding fix", "open", ["open", "open"]),
    galleryTask(9, "Alert when /api 5xx passes 1%", "open"),
    galleryTask(10, "Reproduce the /api/health 500", "done", ["done", "done", "done"]),
  ],
};

const AGENTS_WORK: OwnedWork[] = [{
  owner: { actorId: galleryActorId("binding-auditor"), name: "binding-auditor", title: "Binding auditor", retired: false, path: ["binding-auditor"] }, plan: null,
  tasks: [{ id: "t1", parentId: null, title: "Audit every route for env.DB", status: "active", updatedAt: 1, note: null, subtasks: [] }],
}, {
  owner: { actorId: "swarm-actor-h1", name: "root-merge-1-h1", title: "workers/api/src/routes/webhooks.ts", retired: false, path: null }, plan: null,
  tasks: [{ id: "t1", parentId: null, title: "Move the webhook route onto openDb", status: "active", updatedAt: 1, note: null, subtasks: [] }],
}];

/* The reads the first-visit inspector policy decides on, each typed as the workspace answers it. */
const PAGE_TABLE_ANSWERS: WorkspaceAnswers = {
  getExecutorFiles: (...args) => workspaceListing(args),
  namePhases: (...args) => longTurnNamePhases(args),
  listAlternateTakes: () => (TAKE_COUNT > 0 ? { [galleryTakes.turnId ?? ""]: galleryTakes } : {}),
  pickAlternateTake: (...args) => galleryPickTake(args),
  listSlates: gallerySlates,
  getActivePlanReview: () => galleryAgentPlan,
  // The Work tab draws this read, not `getActivePlanReview`. The owner is the workspace's name: `createMain({ name: this.name })` registers it, never "main".
  // `dataset.workMoved`: a task written during an outage.
  listWorkspaceWork: (): WorkspaceAnswer<"listWorkspaceWork"> => ({
    plans: [{ owner: PAGE_OWNER, plan: galleryAgentPlan, tasks: [] }],
    tasks: [
      ...document.documentElement.dataset.workMoved === "1" ? [WORK_WRITTEN_IN_OUTAGE] : [],
      ...BOARD_FULL ? [WORK_BOARD] : [],
      ...AGENTS_PANEL ? AGENTS_WORK : [],
    ],
  }),
  listWorkspaceAgents: galleryWorkspaceAgents,
  getWorkspaceGitHub: (refresh) => {
    const root = document.documentElement;
    root.dataset.galleryGitHubReads = `${root.dataset.galleryGitHubReads ?? ""}${refresh === true ? "R" : "r"}`;

    return GALLERY_GITHUB;
  },
  getShellApprovalGrants: () => ({ grants: SHELL_GRANTS }),
  regenerateWorkspaceLogo: () => {
    const root = document.documentElement;
    root.dataset.galleryLogoDraws = String(Number(root.dataset.galleryLogoDraws ?? "0") + 1);

    return { drawn: true, refusal: null };
  },
  renameMainChat: (title) => {
    GALLERY_MAIN_TITLE.value = title;
    rosterMoved();

    return { title: GALLERY_MAIN_TITLE.value };
  },
  // As the server does: the stopped worker settles aborted, which the panel reads as stopped, and the roster read moves.
  stopSwarmWorker: (headId) => {
    const at = GALLERY_AGENTS.findIndex((agent) => agent.open.kind === "node" && agent.open.nodeId === headId && agent.activity === "working");
    const agent = GALLERY_AGENTS[at];

    if (agent !== undefined) {
      GALLERY_AGENTS[at] = { ...agent, activity: "stopped" };
      queueMicrotask(() => { galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listWorkspaceAgents"] })); });
    }
  },
  // Without an answer the strip hides Work on first paint.
  getWorkspaceTabPresence: () => ({ work: true, explorations: true }),
  // Each slate's preview is its own page on the gallery's preview origin, served by a test or a capture. An answer's
  // page is served by the runner, so it reports its height; these slates stand for a server of their own.
  previewSlate: (id) => {
    return { ok: true, value: { url: new URL(id, SLATE_GALLERY_URL).href, port: 8789, sized: ephemeralSlateAddress(id) !== null } };
  },
  // An answer's page's own call, made as the page: the workspace's db, and its block's server, answered as their own.
  drawnSlateCall: (id, request): SlateCallResult => {
    const asked = v.parse(v.union([v.object({ path: v.array(v.string()), args: v.array(v.unknown()) }), v.object({ method: v.string(), args: v.array(v.unknown()) })]), request);

    if ("method" in asked) {
      return asked.method === "word" ? { ok: true, value: `${String(asked.args[0])} by route` } : { ok: false, ...refusalOf(new KinuError("bad_input", `no method ${asked.method}`)) };
    }

    if (asked.path.join(".") !== "db.count") return { ok: false, ...refusalOf(new KinuError("denied", `${asked.path.join(".")} is not answered here`)) };

    // Its arguments as the workspace's own db takes them, a program's: the table by name (`db.count(table, where)`).
    return asked.args.length === 1 && asked.args[0] === "errors"
      ? { ok: true, value: { id, count: 12 } }
      : { ok: false, ...refusalOf(new KinuError("bad_input", "db.count: \"table\": Invalid type. It takes: table, where.")) };
  },
  // Keeping an answer's page: the kept slate is listed under the page's title, and the listing moves.
  slate: (asked) => {
    const operation = v.parse(v.object({ op: v.literal("save"), page: v.string() }), asked);
    const kept = { id: "errors-by-route", title: operation.page === "pg-a1/errors" ? "500s by route" : operation.page };

    GALLERY_KEPT_PAGES.push(kept);
    queueMicrotask(() => { galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listSlates"] })); });

    return { ok: true, value: kept };
  },
  listPendingConsents: galleryConsents,
  decideDeferredApprovals: (...args) => galleryDecideDeferred(args),
  inspectWork: galleryOwedWork,
  listFileCheckpoints: () => REVERT_LISTING,
  planFileRestore: () => ({
    dir: REVERT_CHECKPOINT.dir, id: REVERT_CHECKPOINT.id,
    files: [{ path: "workers/api/src/routes/webhooks.ts", kind: "modify" }, { path: "workers/api/test/webhooks-db.test.ts", kind: "delete" }],
  }),
  restoreFileCheckpoint: () => ({
    dir: REVERT_CHECKPOINT.dir, id: REVERT_CHECKPOINT.id, files: [], preRestoreId: "5afe70",
  }),
};

/** The plan under review as the workspace answers its reads and decisions; each decision recorded on the page. */
const PLAN_ANSWERS: WorkspaceAnswers = {
  inspectSubagent: (request) => galleryPlanInspection(v.parse(SubagentInspectionRequestSchema, request), [galleryAgentPlan]),
  dismissPlanReview: () => {
    document.documentElement.dataset.galleryPlanDismissed = "1";
    galleryAgentPlan = { ...galleryAgentPlan, status: "dismissed", updatedAt: Date.now() };

    return { ok: true, plan: galleryAgentPlan };
  },
  decidePlanReview: (_id, _revision, decision, feedback) => galleryPlanDecided(decision, feedback),
};

/** What the store sends the agent on a decision: the revision's own comments, rendered by the review. */
function galleryPlanDecided(decision: PlanReviewDecision, feedback: string | undefined): WorkspaceAnswer<"decidePlanReview"> {
  const sent = decision === "request_changes" ? [reviewFeedbackText(galleryAgentPlan.annotations), feedback ?? ""].filter(Boolean).join("\n\n") : feedback ?? "";

  document.documentElement.dataset.galleryPlanFeedback = sent;
  galleryAgentPlan = {
    ...galleryAgentPlan,
    status: decision === "approve" ? "approved" : "changes_requested",
    feedback: sent === "" ? null : sent,
    handoffAccepted: true,
    updatedAt: Date.now(),
  };

  return { ok: true, plan: galleryAgentPlan, queued: true };
}

/** Named as the workspace names an owner's chat: from its opening words, else its role, numbered past every name had. */
function galleryChatName(opening: string | null): string {
  return mintAgentName({ brief: opening, role: "task" }, () => (name) => GALLERY_SUBS.some((sub) => sub.name === name));
}

/** A model or effort pick, recorded so a gate can read which actor it wrote. */
function noteModelCall(method: "setModel" | "setReasoningEffort", args: readonly unknown[]): void {
  const root = document.documentElement;
  const calls: unknown[] = JSON.parse(root.dataset.galleryModelCalls ?? "[]");

  calls.push({ method, args });
  root.dataset.galleryModelCalls = JSON.stringify(calls);
}

/** The workspace's subagent roster as the real page moves it: made, renamed, dismissed and read. */
const ROSTER_ANSWERS: WorkspaceAnswers = {
  listSubagents: () => [...GALLERY_SUBS],
  setModel: (...args) => {
    noteModelCall("setModel", args);

    return { ok: true, spec: args[0] };
  },
  setReasoningEffort: (...args) => {
    noteModelCall("setReasoningEffort", args);

    return { ok: true, effort: args[0] };
  },
  createSubagentAgent: (opening) => {
    maybeRefuseCreate();
    const name = galleryChatName(opening ?? null);

    const entry: SubagentView & { actorId: string } = {
      name, actorId: galleryActorId(name), displayName: codenameFor(name), role: "agent", nameOrigin: "auto", origin: "user", lifetime: "durable",
      status: "idle", currentTask: null, createdAt: NOW, dismissedAt: null,
    };

    GALLERY_SUBS.push(entry);
    rosterMoved();
    galleryAgentPlan = {
      ...galleryAgentPlan,
      status: "pending",
      annotations: GALLERY_PLAN_ANNOTATIONS,
      feedback: null,
      handoffAccepted: false,
      updatedAt: NOW,
    };

    return { name, displayName: "", subagent: entry };
  },
  renameSubagentAgent: (name, displayName) => {
    const entry = GALLERY_SUBS.find((sub) => sub.name === name);

    if (RENAME_FAILS) throw new Error("Connection closed");

    if (!entry) throw new Error(`gallery: no subagent "${name}"`);
    entry.displayName = displayName;
    rosterMoved();

    return { ok: true, name, displayName, subagent: { ...entry } };
  },
  dismissSubagent: (name, keepHistory) => {
    const index = GALLERY_SUBS.findIndex((sub) => sub.name === name);

    if (index >= 0) GALLERY_SUBS.splice(index, 1);
    rosterMoved();

    return { ok: true, name, historyKept: keepHistory ?? true };
  },
  // Answered by the root; the header renders the roster title, never `mission`.
  getActorSnapshot: (name) => {
    const latest = GALLERY_SUBS.find((sub) => sub.name === name) ?? GALLERY_SUBS.at(-1);
    // A fixture's agent (the binding auditor) is answered as itself, so its pane is its own actor's; no name is the workspace's own.
    const actor = latest?.name ?? name ?? WORKSPACE_PAGE_NAME;

    return {
      name: actor,
      actorId: galleryActorId(actor),
      displayName: latest?.displayName ?? "",
      role: "task",
      mission: "",
      model: { model: "opencode-go/muse-spark-1.3-contributor", source: "workspace" },
      reasoningEffort: "medium",
      activePlan: galleryAgentPlan,
      messageCount: 0,
      pendingSteers: [],
    };
  },
};

/** A stored row as the page reader draws a text-only one: its words as its one part, its time in its metadata too. */
export const textEntry = ({ content, ...entry }: Omit<ChatHistoryEntry, "parts"> & { readonly content: string }): ChatHistoryEntry => ({
  ...entry, parts: [{ type: "text", text: content }], metadata: { ...entry.metadata, [RECORDED_AT_METADATA_KEY]: entry.createdAt },
});

/** A long answer as the big-workspace eval writes them: a bold lead, about 150 words, and a two-line example. */
const LONG_ANSWER = "**Loyalty points: a second currency nobody ledgers.** " + "Points are money on the balance sheet, but they are built like a feature: an integer on the user row, incremented by a dozen flows and edited by support. ".repeat(4)
  + "\n\n```\nUPDATE users SET points = points + 200\nPoints liability off at audit; no reconstruction possible\n```";

/** A row of the chat `&transcript=seed-*` opens on: one-liners, or a long ask and its long answer. */
function seriesRow(index: number, id: string, createdAt: number): ChatHistoryEntry {
  const asked = index % 2 === 0;
  const row = { id, position: index, role: asked ? "user" as const : "assistant" as const, turnId: null, createdAt };

  if (SEED_SERIES === "short") return textEntry({ ...row, content: asked ? `Next ${String(index)}?` : `Done ${String(index)}.` });

  if (!asked) return textEntry({ ...row, content: LONG_ANSWER });

  return textEntry({ ...row, content: `Turn ${String(index)}. In about 150 words, explain one practical pitfall with ledgers in distributed systems, then give a two-line example. No tools.` });
}

export function historyRow(index: number): ChatHistoryEntry {
  const id = `hist-${String(index).padStart(5, "0")}`;
  const createdAt = NOW - (HISTORY_ROWS - index + 60) * 60e3;

  if (SEED_SERIES !== null) return seriesRow(index, id, createdAt);

  if (index % 2 === 0) return textEntry({ id, position: index, role: "user", turnId: null, content: `Question ${index}: what changed in openDb this time?`, createdAt });

  const kind = index % 10;
  let content = `Answer ${index}. openDb now reads the binding by its new name.`;

  if (kind === 1 || (HISTORY_UNEVEN && Math.floor(index / 40) % 2 === 0)) content += "\n\n" + "A longer explanation that wraps across several lines of the column. ".repeat(6);
  else if (kind === 3) content += "\n\n```ts\nexport function openDb(env: Env) {\n  if (env.SESSIONS_DB === undefined) throw new MissingBinding('SESSIONS_DB');\n  return env.SESSIONS_DB;\n}\n```";
  else if (kind === 5) content += `\n\n![chart ${index}](${HISTORY_PICTURE})`;
  else if (kind === 7) content += "\n\nslate://board";

  return textEntry({ id, position: index, role: "assistant", turnId: null, content, createdAt });
}

export function galleryReadFault(flag: string | undefined, message = "Network connection lost"): void {
  if (flag === "1") throw new Error(message);
}

async function galleryHistoryPage(args?: unknown[]): Promise<ChatHistoryPage> {
  const request = v.parse(v.tuple([PositionPageRequestSchema]), args);
  // A read naming no limit takes a whole drawn page, as the product's does (session/transcript.ts `DRAWN_PAGE_ROWS`).
  const { cursor, limit = 200 } = request[0];
  const asks = document.documentElement.dataset;

  asks.historyAsks = String(Number(asks.historyAsks ?? 0) + 1);
  asks.historyReads = `${asks.historyReads ?? ""} ${cursor === undefined ? "newest" : `${String(cursor.before - limit)}-${String(cursor.before)}`}`;

  // With no `&history=N` the seed is the whole conversation: a read of it is counted, and ends at once.
  if (HISTORY_ROWS === 0) return { status: "end", items: [] };
  const stored = asks.historyCleared === "1" ? 0 : HISTORY_ROWS;
  const held = Math.min(cursor?.before ?? stored, stored);
  const from = Math.max(0, held - limit);
  const items = Array.from({ length: held - from }, (_, offset) => historyRow(from + offset));
  const settled = Promise.withResolvers<void>();

  if (HISTORY_HELD) window.addEventListener("gallery:release-page", () => { settled.resolve(); }, { once: true });
  else setTimeout(settled.resolve, HISTORY_LATENCY_MS);
  await settled.promise;

  galleryReadFault(asks.historyFault);

  return from === 0 ? { status: "end", items } : { status: "more", items, next: { before: from } };
}

/** `&agents=panel`: chats, hires nested two deep, a swarm and a subagent. */
const GALLERY_GITHUB: WorkspaceGitHubView = {
  repos: [
    { repo: "acme/api-worker", remote: true, lastPush: { ref: "refs/heads/fix/sessions-binding", at: NOW - 2 * 36e5 }, fetchedAt: NOW - 3 * 36e5,
      branch: "fix/sessions-binding", ci: { state: "failure", at: NOW - 90 * 60e3 } },
    { repo: "acme/api-worker-docs", remote: true, lastPush: null, fetchedAt: NOW - 864e5, branch: "main", ci: { state: "success", at: NOW - 864e5 } },
  ],
  items: [
    { subject: "pr", repo: "acme/api-worker", number: 482, title: "Read the sessions database by its new binding", url: "https://github.com/acme/api-worker/pull/482",
      state: "open", actors: [galleryActorId(WORKSPACE_PAGE_NAME), galleryActorId("binding-auditor")], unattributed: false, lastAt: NOW - 2 * 36e5 },
    { subject: "issue", repo: "acme/api-worker", number: 477, title: "/api/health returns 500 after the Sept 22 deploy", url: "https://github.com/acme/api-worker/issues/477",
      state: "closed", actors: [], unattributed: true, lastAt: NOW - 3 * 36e5 },
    { subject: "pr", repo: "acme/api-worker-docs", number: 61, title: "Document the database bindings", url: "https://github.com/acme/api-worker-docs/pull/61",
      state: "merged", actors: [galleryActorId(WORKSPACE_PAGE_NAME)], unattributed: false, lastAt: NOW - 864e5 },
  ],
  observedAt: NOW - 3 * 60e3,
  refresh: "refreshed",
};

const GALLERY_AGENTS: PanelAgent[] = [
  mainPanelAgent({ activity: "working", actorId: galleryActorId(WORKSPACE_PAGE_NAME), figures: { tokens: 184_300, usd: 0.42, activeMs: 21 * 60_000, cacheEma: 0.94 } }),
  { colour: 1, key: galleryActorId("docs"), label: "Fix the /api/health 500s", category: "user", activity: "waiting", parent: "main", open: { kind: "chat", path: "docs" }, tab: true, input: true,
    figures: { tokens: 12_400, usd: 0.03, activeMs: 3 * 60_000, cacheEma: 0.88 } },
  { colour: 2, key: galleryActorId("perf"), label: "Should the nightly sweep move to a cron trigger?", category: "user", activity: "idle", parent: "main", open: { kind: "chat", path: "perf" }, tab: true, input: true,
    figures: { tokens: 31_000, usd: 0.07, activeMs: 9 * 60_000, cacheEma: 0.9 } },
  { colour: 3, key: galleryActorId("i18n"), label: "Read the overnight error logs", category: "user", activity: "failed", parent: "main", open: { kind: "chat", path: "i18n" }, tab: true, input: true,
    figures: { tokens: 8_200, activeMs: 2 * 60_000, cacheEma: null } },
  { colour: 4, key: galleryActorId("review"), label: "Review: payments refactor", category: "user", activity: "working", parent: "main", open: { kind: "chat", path: "review" }, tab: true, input: true,
    figures: { tokens: 22_600, usd: 0.05, activeMs: 4 * 60_000, cacheEma: 0.86 } },
  { colour: 5, key: "a-scout", label: "Binding auditor", category: "hired", activity: "working", parent: "main", open: { kind: "chat", path: "binding-auditor" }, tab: false, input: true,
    actorId: galleryActorId("binding-auditor"), figures: { tokens: 48_900, usd: 0.11, activeMs: 7 * 60_000, cacheEma: 0.91 } },
  { colour: 6, key: "a-check", label: "Binding tester", category: "hired", activity: "waiting", parent: "a-scout", open: { kind: "chat", path: "binding-auditor/tester" }, tab: false, input: true,
    figures: { tokens: 6_100, activeMs: 45_000, cacheEma: null } },
  { colour: 7, key: "a-copy", label: "Changelog writer", category: "hired", activity: "idle", parent: galleryActorId("docs"), open: { kind: "chat", path: "docs/changelog" }, tab: false, input: true,
    figures: { tokens: 2_100, activeMs: 30_000, cacheEma: null } },
  { colour: 0, key: "root-merge-1/root-merge-1-h0", label: "workers/api/src/db.ts", category: "swarm", activity: "done", parent: "main",
    open: { kind: "node", runId: "root-merge-1", nodeId: "root-merge-1-h0", owner: null }, tab: false, input: false,
    figures: { tokens: 9_800, activeMs: 94_000, cacheEma: null } },
  { colour: 0, key: "root-merge-1/root-merge-1-h1", label: "workers/api/src/routes/webhooks.ts", category: "swarm", activity: "working", parent: "main",
    open: { kind: "node", runId: "root-merge-1", nodeId: "root-merge-1-h1", owner: null }, tab: false, input: false, actorId: "swarm-actor-h1", figures: { activeMs: 0, cacheEma: null } },
  { colour: 0, key: "root-merge-1/root-merge-1-h3", label: "workers/api/src/router.ts", category: "swarm", activity: "working", parent: "main",
    open: { kind: "node", runId: "root-merge-1", nodeId: "root-merge-1-h3", owner: null }, tab: false, input: false, figures: { activeMs: 0, cacheEma: null } },
  { colour: 8, key: "a-refine", label: "Prompt refiner", category: "background", activity: "idle", parent: "main", open: { kind: "chat", path: "refiner" }, tab: false, input: false,
    figures: { tokens: 2_300, usd: 0.004, activeMs: 20_000, cacheEma: 0.5 } },
  { colour: 9, key: "a-sampler", label: "Prompt sampler", category: "hired", activity: "idle", parent: "a-refine", open: { kind: "chat", path: "refiner/sampler" }, tab: false, input: true,
    figures: { tokens: 900, activeMs: 8_000, cacheEma: null } },
];

function galleryWorkspaceAgents(): PanelAgent[] {
  const created = GALLERY_SUBS.map((sub, index): PanelAgent => ({
    colour: index + 1, key: sub.actorId, label: sub.displayName || codenameFor(sub.name), category: "user", activity: "idle", parent: "main",
    open: { kind: "chat", path: sub.name }, tab: true, input: true, actorId: sub.actorId, figures: NO_GALLERY_FIGURES,
  }));

  const main = mainPanelAgent({ label: GALLERY_MAIN_TITLE.value, activity: "idle", figures: NO_GALLERY_FIGURES });

  const listed = AGENTS_PANEL ? [...GALLERY_AGENTS, ...created.filter((agent) => !GALLERY_AGENTS.some((fixed) => fixed.key === agent.key))] : [main, ...created];

  return listed.map((agent) => (RESTED_AGENTS.has(agent.key) ? { ...agent, activity: "idle" } : agent));
}

function rosterMoved(): void {
  queueMicrotask(() => { galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listWorkspaceAgents", "listSubagents"] })); });
}

async function galleryRevert(args?: unknown[]): Promise<void> {
  // The choice the dialog sent: a chat-only rewind tells the agent what its turns left on the computer.
  const chosen = v.safeParse(v.object({ chatOnly: v.boolean() }), args?.[1]);
  const id = v.parse(v.string(), args?.[0]);

  document.documentElement.dataset.galleryRevertChatOnly = chosen.success ? String(chosen.output.chatOnly) : "unsaid";
  document.documentElement.dataset.galleryRevertedTo = id;
  galleryRevertConversation(id);
}

/** The owner's compaction, folded at once as a model with no server compaction folds it. */
function galleryCompact(): CompactOutcome {
  document.documentElement.dataset.galleryCompacted = "folded";

  return "folded";
}

/** A branch beside the live turn: the words it was asked with are kept; `data-gallery-branch-refuses` makes the agent
 *  refuse it, as one already running beside the turn does. */
function galleryBranch(args?: unknown[]): BranchTurnResult {
  const flags = document.documentElement.dataset;

  flags.galleryBranched = v.parse(v.string(), args?.[0]);

  return flags.galleryBranchRefuses === "1" ? { accepted: false, reason: "a branch already runs beside this turn" } : { accepted: true, branchId: "gallery-branch" };
}

/** The first `name` event whose detail parses as `schema` and is `mine`. */
function galleryEvent<Schema extends v.GenericSchema>(
  name: string, schema: Schema, mine: (asked: v.InferOutput<Schema>) => boolean,
): Promise<v.InferOutput<Schema>> {
  return new Promise((resolve) => {
    const listen = (event: Event) => {
      const asked = v.parse(schema, event instanceof CustomEvent ? event.detail : null);

      if (!mine(asked)) return;
      window.removeEventListener(name, listen);
      resolve(asked);
    };

    window.addEventListener(name, listen);
  });
}

/** The workspace's own plan awaiting review, as the queue lists it beside the work read's plan: `&asks=plan`. */
const PLAN_ASKS: PendingAction[] = [{
  id: `plan:${WORKSPACE_PAGE_NAME}:${galleryAgentPlan.id}:${String(galleryAgentPlan.revision)}`, kind: "plan_review",
  title: "Review the plan: Read the sessions database as SESSIONS_DB", detail: null, at: NOW - 300_000,
  planRef: { owner: WORKSPACE_PAGE_NAME, id: galleryAgentPlan.id, revision: galleryAgentPlan.revision }, raisedBy: galleryActorId(WORKSPACE_PAGE_NAME),
}];

/** `&asks=mixed`: one of each kind that waits on the owner. */
const MIXED_ASKS: PendingAction[] = [
  ...PARKED_ASKS,
  { id: "park-write", kind: "deferred_action", title: "Replace src/routes/webhooks.ts", detail: null, at: NOW - 150_000, write: { path: "src/routes/webhooks.ts" } },
  ...PLAN_ASKS,
  { id: "plan:binding-auditor:pa-1:1", kind: "plan_review", title: "Approve the plan · Audit the binding of every route", detail: "Submitted by binding-auditor", at: NOW - 200_000,
    planRef: { owner: "binding-auditor", id: "pa-1", revision: 1 }, raisedBy: galleryActorId("binding-auditor") },
];

/** A change a share of issue-triage made on the owner's access, for Sam, as the queue lists it. */
function effectAsk({ id, tool, server, root, payload, at }: {
  id: string; tool: string; server: string; root: Record<string, string>; payload: JsonValue; at: number;
}): PendingAction {
  return {
    id, kind: "deferred_action", at, title: `Approve: ${tool} on ${server}, for sam@example.com through a share of issue-triage`,
    detail: JSON.stringify(payload, null, 2), effect: { slate: "issue-triage", caller: "issue-triage", server, tool, root },
  };
}

/** `&asks=effect`: one change a shared slate asks on the owner's access; `&asks=effects`, two; `&asks=effect-mixed`, one beside a command. */
const EFFECT_ASKS: PendingAction[] = [
  effectAsk({ id: "effect-issue", tool: "create_issue", server: "mcp.github", root: { org: "acme" }, payload: { title: "Label sync is late" }, at: NOW - 20_000 }),
];

const EFFECTS_ASKS: PendingAction[] = [
  ...EFFECT_ASKS,
  effectAsk({ id: "effect-notes", tool: "fs.write", server: "workspace", root: {}, payload: { path: "notes/triage.md" }, at: NOW - 50_000 }),
];

/** `&asks=mail`: scout's reply to Dana, waiting to leave; `&asks=mail-mixed`, beside a parked command. */
const MAIL_ASKS: PendingAction[] = [{
  id: "mail-dana", kind: "deferred_action", at: NOW - 30_000, raisedBy: galleryActorId("scout"),
  title: "Send mail to dana@northwind.io: Re: Webhook deliveries to /hooks/v2 failing with 500", detail: null,
  mail: {
    by: "scout", from: "scout.api-worker.ashish@kinu.run", to: ["dana@northwind.io"], cc: ["priya@raman.dev"],
    subject: "Re: Webhook deliveries to /hooks/v2 failing with 500",
    text: "Hi Dana,\n\nThe 500s were ours: Tuesday's release renamed the binding the webhook route reads. The fix is on staging and reaches production within the hour; replay the failed deliveries after 16:00 UTC.\n\nscout, for Ashish Kumar Singh",
  },
}];

const ASK_SETS = new Map([
  ["two", PARKED_ASKS], ["mixed", MIXED_ASKS], ["plan", PLAN_ASKS], ["mail", MAIL_ASKS], ["mail-mixed", [...MAIL_ASKS, ...PARKED_ASKS]],
  ["effect", EFFECT_ASKS], ["effects", EFFECTS_ASKS], ["effect-mixed", [...EFFECT_ASKS, ...PARKED_ASKS.slice(0, 1)]],
]);

/** The workspace queue as `&asks=` sets it, less what the stack has decided. */
async function galleryPendingActions(): Promise<PendingAction[]> {
  const asked = new URLSearchParams(location.search).get("asks");
  const decided = (document.documentElement.dataset.galleryDecided ?? "").split(",");
  const arrived = document.documentElement.dataset.galleryArrived === "1" ? LATE_ASKS : [];
  const asks = [...(ASK_SETS.get(asked ?? "") ?? []), ...arrived];

  if (ASKS_HELD && decided.some((id) => id !== "")) {
    const released = Promise.withResolvers<void>();

    window.addEventListener("gallery:release-asks", () => { released.resolve(); }, { once: true });
    await released.promise;
  }

  return asks.filter((action) => !decided.includes(action.id));
}

/**
 * Each decision as the agent is sent it, in order (`data-gallery-decisions`); the queue then moves, as the store's write
 * moves it. `&decide=refused`: the first decision is refused, as a store that could not record it answers.
 */
function galleryDecideDeferred(args?: unknown[]): WorkspaceAnswer<"decideDeferredApprovals"> {
  const [ids, decision] = v.parse(v.tuple([v.array(v.string()), v.string()]), args);
  const root = document.documentElement.dataset;

  if (new URLSearchParams(location.search).get("decide") === "refused" && root.galleryDecideRefused !== "1") {
    root.galleryDecideRefused = "1";

    throw new Error("the approval store is unavailable");
  }

  root.galleryDecided = [root.galleryDecided ?? "", ...ids].filter((id) => id !== "").join(",");
  root.galleryDecisions = JSON.stringify([...v.parse(DecisionsSchema, JSON.parse(root.galleryDecisions ?? "[]")), ...ids.map((id) => [id, decision])]);
  queueMicrotask(() => {
    galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listPendingActions"] }));
    // The decision reaches the agent as its inbox wakes it (core safety/deferred-approval.ts `decide`).
    galleryServerPush(JSON.stringify({
      type: "signal_card", id: `sig-${ids.join("-")}`, state: "pending", at: Date.now(), text: `Your owner answered ${String(ids.length)} queued command(s): ${decision}.`,
      metadata: { kinuEvent: "deferred_approval", decision, count: ids.length, ids },
    }));
  });

  return { decided: ids };
}

/**
 * `&consent=waiting`: a device command already waiting. `&consent=spoofed`: one whose bidi and zero-width characters
 * would show a reader a different command. `&consent=two`: two devices' commands, each resolution held until
 * `gallery:consent-settle` `{ id, failed? }`, and a resolved one no longer listed.
 */
function galleryConsents(): PendingDeviceConsent[] {
  const asked = new URLSearchParams(location.search).get("consent");
  const root = document.documentElement.dataset;
  const resolved = (root.galleryConsentsResolved ?? "").split(",");

  root.galleryConsentReads = String(Number(root.galleryConsentReads ?? "0") + 1);

  if (asked === "two") return TWO_CONSENTS.filter((consent) => !resolved.includes(consent.consentId));

  if (asked !== "waiting" && asked !== "spoofed") return [];

  return [{ consentId: "c-1", deviceId: "dev-studio", deviceLabel: "studio", method: "exec", createdAt: 1,
    command: asked === "spoofed" ? "rm -rf ./build \u202E\u2066gpj.x\u200B" : "git push origin main" }];
}

async function galleryResolveConsent(args?: unknown[]): Promise<{ ok: boolean }> {
  const [id] = v.parse(v.tuple([v.string(), v.string()]), args);

  if (new URLSearchParams(location.search).get("consent") !== "two") return { ok: true };

  const settled = await galleryEvent("gallery:consent-settle", ConsentSettleSchema, (asked) => asked.id === id);

  if (settled.failed !== undefined) throw new Error(settled.failed);
  const root = document.documentElement.dataset;

  root.galleryConsentsResolved = `${root.galleryConsentsResolved ?? ""},${id}`;

  return { ok: true };
}

function heldJob(at: number, label: string | undefined): WorkspaceAnswer<"listBackgroundJobs"> {
  return [{
    id: `bgjob-held-${String(at)}`, kind: "shell", label: label ?? null, workMode: "build", status: "running",
    result: null, error: null, createdAt: NOW - 60e3, attemptStartedAt: NOW - 60e3, settledAt: null,
    epoch: 0, retriedBy: null, resumeAfter: null, serves: null,
  }];
}

/**
 * `&jobs=held`: one running job, `first build`, until `data-gallery-jobs-hold="1"`; from then each read waits for
 * `gallery:jobs-answer` `{ at, label?, failed? }`, `at` counting held reads from 0, and answers one running job named
 * `label` or fails with `failed`. Otherwise there are none.
 */
async function galleryJobsRead(): Promise<WorkspaceAnswer<"listBackgroundJobs">> {
  // `&jobs=running`: the jobs as the Work tab's own frame has them, one of them running, until `gallery:jobs` says.
  if (new URLSearchParams(location.search).get("jobs") === "running") return JOBS_RUNNING.at ? BACKGROUND_JOBS : BACKGROUND_JOBS.filter((job) => job.status !== "running");

  if (new URLSearchParams(location.search).get("jobs") !== "held") return [];
  const root = document.documentElement.dataset;

  if (root.galleryJobsHold !== "1") return heldJob(-1, "first build");
  const at = Number(root.galleryJobReads ?? "0");

  root.galleryJobReads = String(at + 1);

  const answer = await galleryEvent("gallery:jobs-answer", JobsAnswerSchema, (asked) => asked.at === at);

  if (answer.failed !== undefined) throw new Error(answer.failed);

  return heldJob(at, answer.label);
}

/**
 * The plan decision, as `&decision=` asks: `held` until `gallery:decision-answer`, or `fail-first` failing the first
 * attempt. `data-gallery-decisions` counts the decisions sent.
 */
async function galleryDecidePlan(args?: unknown[]): Promise<WorkspaceAnswer<"decidePlanReview">> {
  const root = document.documentElement.dataset;
  const sent = Number(root.galleryDecisions ?? "0") + 1;
  const asked = new URLSearchParams(location.search).get("decision");

  root.galleryDecisions = String(sent);

  if (asked === "held") await galleryEvent("gallery:decision-answer", v.unknown(), () => true);

  if (asked === "fail-first" && sent === 1) throw new Error("review-fixture-rpc-failed");

  const [target, , decision, feedback] = v.parse(v.tuple([v.string(), v.number(), v.picklist(["approve", "request_changes"]), v.optional(v.string())]), args);

  return asked === "owed" ? galleryOweIntent({ id: "owed-decision", kind: "decision", target, actor: null }) : galleryPlanDecided(decision, feedback);
}

async function galleryAnswerQuestions(args?: unknown[]): Promise<OwedIntent | null> {
  const [target, answers, actor] = v.parse(v.tuple([v.string(), OwnerAnswersSchema, v.optional(v.nullable(v.string()))]), args);

  if (new URLSearchParams(location.search).get("answer") === "owed") {
    return galleryOweIntent({ id: "owed-answers", kind: "answers", target, actor: actor ?? null });
  }

  galleryCloseQuestions("answered", answers);

  return null;
}

/** Settles a stranded turn as the server does: the claim frame says so, and `data-gallery-recoveries` counts the asks. */
async function galleryRecoverTurn(): Promise<WorkspaceAnswer<"recoverStrandedTurn">> {
  const root = document.documentElement.dataset;

  root.galleryRecoveries = String(Number(root.galleryRecoveries ?? "0") + 1);
  galleryServerPush(JSON.stringify({ type: TURN_CLAIM_FRAME, claim: { kind: "settled" } }));
  // The settling write names the reads it moves, as the server's statement does.
  galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: readsWrittenBy("UPDATE actor_turn_claims SET outcome = ?") }));

  // The stranded claim is sealed, its outcome unknown, as the server settles one nobody is executing.
  return { recovered: "sealed" };
}

/** `&owed=all`'s work read: one turn this activation runs and one it stranded on its third attempt until a recovery
 *  settles it, an agent's turn a restart cut that its isolate picks up again on its wake, and effects owed each way,
 *  folded by core's own projection as the workspace's read and the agent's own fold their stores. */
function galleryOwedWork(): readonly InspectedWork[] {
  if (new URLSearchParams(location.search).get("owed") !== "all") return [];
  const recovered = document.documentElement.dataset.galleryRecoveries !== undefined;

  return inspectWork({
    claims: OWED_TURNS.filter(({ claim }) => !recovered || claim.turnId !== "turn-stranded").map((owed) => ({ ...owed, actor: null })),
    agentTurns: [],
    executing: new Set(["turn-live"]),
    effects: [
      { effect: { ...OWED_EFFECT, key: "e-due", rawName: "turn_record", status: "pending", attempts: 1, nextAttemptAt: NOW - 1e3 }, actor: null },
      { effect: { ...OWED_EFFECT, key: "e-backoff", rawName: "follow_up_turn", status: "pending", attempts: 2, nextAttemptAt: NOW + 90e3 }, actor: null },
      { effect: { ...OWED_EFFECT, key: "e-parked", rawName: "drain", status: "parked", attempts: 1, nextAttemptAt: NOW }, actor: null },
      {
        effect: { ...OWED_EFFECT, key: "e-blocked", rawName: "retired_effect", status: "blocked", attempts: 4, nextAttemptAt: NOW, blocked: "this build does not implement retired_effect" },
        actor: null,
      },
    ],
    reported: inspectWork({
      claims: [{ claim: { ...OWED_CLAIM, turnId: "turn-resuming", epoch: 2 }, actor: "quiet-cove-f8c76035", attempt: 1 }],
      agentTurns: [], executing: new Set(), resuming: { at: NOW + 20e3 }, effects: [], now: NOW,
    }),
    now: NOW,
  });
}

/** What went to the running turn rather than opening one. */
async function galleryMidTurnSend(args?: unknown[]): Promise<void> {
  const asks = document.documentElement.dataset;

  asks.galleryMidTurnSends = `${asks.galleryMidTurnSends ?? ""}${v.parse(v.string(), args?.[0])}\n`;
}

/** Where a send landed: a turn read it, or none did while `data-gallery-handed-back` is set, as when a Stop came first. */
async function galleryAwaitSend(): Promise<WorkspaceAnswer<"awaitSend">> {
  if (document.documentElement.dataset.galleryHandedBack === "1") return { status: "none" };

  return { status: "settled", turnId: "gallery-turn", landed: "turn", outcome: "completed" };
}

/** Stop's cancel, held while `data-gallery-cancel-held` is set, until `gallery:release-cancel`. */
async function galleryCancelWork(): Promise<WorkspaceAnswer<"cancelCurrentWork">> {
  if (document.documentElement.dataset.galleryCancelHeld === "1") {
    await new Promise((released) => { window.addEventListener("gallery:release-cancel", released, { once: true }); });
  }

  return { ok: true, abortedTools: 0, deviceCommands: [] };
}

/** `&clear=refused`: a turn is running, so the server refuses and keeps every message. */
async function galleryClearConversation(): Promise<void> {
  if (new URLSearchParams(location.search).get("clear") === "refused") throw new Error(CLEAR_NEEDS_IDLE);
  galleryClearChat("");
}

/** The page's conversation writes, and the reads the gallery answers only after a wait it controls. */
/** The page's answers that wait on the page: a held read, a release, a decision arriving. */
const ASYNC_PAGE_ANSWERS: WorkspaceAnswers = {
  getChatHistoryPage: (...args) => galleryHistoryPage(args),
  savePlanReviewAnnotations: (...args) => galleryAnnotationSave(args),
  revertConversation: (...args) => galleryRevert(args),
  branchTurn: (...args) => galleryBranch(args),
  compactConversation: () => galleryCompact(),
  clearConversation: galleryClearConversation,
  send: (...args) => galleryMidTurnSend(args),
  awaitSend: galleryAwaitSend,
  cancelCurrentWork: galleryCancelWork,
  resolveDeviceConsent: (...args) => galleryResolveConsent(args),
  listBackgroundJobs: galleryJobsRead,
  listPendingActions: galleryPendingActions,
  listOwnerQuestions: galleryQuestions,
  listOwedIntents: galleryOwedIntents,
  answerOwnerQuestions: (...args) => galleryAnswerQuestions(args),
  dismissOwnerQuestions: () => galleryCloseQuestions("dismissed", null),
  decidePlanReview: (...args) => galleryDecidePlan(args),
  recoverStrandedTurn: galleryRecoverTurn,
};

/** The first read as `&terminal=denied`, `&snapshot=failed` or `&snapshot=held` asks for it: never, failing, or on release. */
async function snapshotGate(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const asks = document.documentElement.dataset;

  asks.gallerySnapshotReads = String(Number(asks.gallerySnapshotReads ?? "0") + 1);

  if (query.get("terminal") === "denied") await new Promise<never>(() => {});

  if (SNAPSHOT_FAILS) throw new Error("Network connection lost.");

  if (query.get("snapshot") !== "held" || document.documentElement.dataset.snapshotReleased === "1") return;

  await new Promise<void>((resolve) => {
    const released = new MutationObserver(() => {
      if (document.documentElement.dataset.snapshotReleased !== "1") return;
      released.disconnect();
      resolve();
    });

    released.observe(document.documentElement, { attributes: true, attributeFilter: ["data-snapshot-released"] });
  });
}

/** At the `HeadRunView.heads` shape; for an aggregate vertex the rationale is the only record that reaches a client. */
function swarmNode(
  id: string, task: string, rationale: string,
  extra: Partial<HeadRunView["heads"][number]> = {},
): HeadRunView["heads"][number] {
  return {
    id, task, rationale, status: "completed", summary: null, errorMessage: null,
    parentId: null, depth: 1,
    usage: { input: 6_200, output: 480 }, wallClockMs: 12_400,
    spawnedAt: NOW - 21e5, lastStepAt: NOW - 20e5, decisions: [],
    ...extra,
  };
}

/** For a preset run the run's `rationale` is the preset name: `journal.recordSplit` writes `resolved.label ?? resolved.preset`. */
const PROVE_RUN: HeadRunView = {
  rootId: "pv000",
  task: "Prove that the expiry sweep terminates for every session row, including expires_at = null.",
  rationale: "prove",
  status: "completed",
  spawnedAt: NOW - 78e5,
  heads: [
    swarmNode("pv001", "Discharge the termination goal", "expansion 1 of 3"),
    swarmNode("pv002", "Discharge the termination goal", "expansion 2 of 3"),
    swarmNode("pv004", "Discharge the termination goal", "expansion 3 of 3", {
      status: "errored", errorMessage: "Checker refused: unknown identifier `expiry_monotone`.",
      lastStepAt: null,
    }),
    swarmNode("pv003", "Discharge the termination goal", "the strongest accepted line so far"),
    swarmNode("pv005", "Discharge the termination goal", "close the remaining null case"),
  ],
  merge: null,
};

/** `fan-in over k parents of depth d` is quoted from `strategy/swarm-run.ts`: the surface parses the count out of it. */
const SWARM_RUN: HeadRunView = {
  rootId: "sw000",
  task: "Reduce /api p95 without regressing the health check.",
  rationale: "conflict-reconciling ensemble",
  status: "completed",
  spawnedAt: NOW - 22e5,
  heads: [
    swarmNode("sw001", "Reduce /api p95", "expansion 1 of 3"),
    swarmNode("sw002", "Reduce /api p95", "expansion 2 of 3"),
    swarmNode("sw003", "Reduce /api p95", "expansion 3 of 3"),
    swarmNode("sw004", "Reduce /api p95", "fan-in over 3 parents of depth 1"),
    swarmNode("sw005", "Reduce /api p95", "expansion 1 of 2"),
    swarmNode("sw006", "Reduce /api p95", "expansion 2 of 2"),
    swarmNode("sw007", "Reduce /api p95", "expansion 1 of 2"),
    swarmNode("sw008", "Reduce /api p95", "expansion 2 of 2"),
    swarmNode("sw009", "Reduce /api p95", "fan-in over 2 parents of depth 2"),
  ],
  merge: null,
};

const REFUSED_RUN: HeadRunView = {
  rootId: "rf000",
  task: "Find a session row that makes readSession throw after the migration.",
  rationale: "ideate",
  status: "errored",
  spawnedAt: NOW - 4e5,
  heads: [
    swarmNode("rf001", "Find a breaking session row", "expansion 1 of 5", {
      status: "errored", lastStepAt: null,
      errorMessage: "Every node failed to provision a home: the workspace filesystem "
        + "has no credential on this host, so no candidate could be measured.",
    }),
  ],
  merge: null,
};

export const RUNNING_RUN: HeadRunView = {
  rootId: "lv000",
  task: "Audit every reader of env.DB across the api Worker and report the ones "
    + "that can throw on a missing binding, with the call path and a suggested fix.",
  rationale: "audit",
  status: "running",
  spawnedAt: NOW - 42e4,
  heads: [
    swarmNode("lv001", "Walk the webhook route's database path", "expansion 1 of 5", {
      summary: "`handleWebhook` calls `env.DB.prepare` with no fallback — throws on "
        + "every request since the binding was renamed.",
      wallClockMs: 118_000, spawnedAt: NOW - 40e4, lastStepAt: NOW - 30e4,
    }),
    swarmNode("lv002", "Check the admin sessions report", "expansion 2 of 5", {
      summary: "The admin report already reads through openDb. No fix needed here.",
      wallClockMs: 96_000, spawnedAt: NOW - 40e4, lastStepAt: NOW - 26e4,
    }),
    swarmNode("lv003", "Trace the router refactor's readers", "expansion 3 of 5", {
      status: "running", wallClockMs: 0,
      spawnedAt: NOW - 40e4, lastStepAt: NOW - 4e3,
    }),
    swarmNode("lv004", "Audit the sessions report exporter", "expansion 4 of 5", {
      status: "running", wallClockMs: 0,
      spawnedAt: NOW - 40e4, lastStepAt: NOW - 11e3,
    }),
    swarmNode("lv005", "Read the API's request edge", "expansion 5 of 5", {
      status: "aborted", wallClockMs: 31_000,
      spawnedAt: NOW - 40e4, lastStepAt: NOW - 34e4,
      errorMessage: "Stopped by the operator while it was reading the request validator.",
    }),
    swarmNode("lv006", "Re-read the two unguarded readers together", "expansion 1 of 3", {
      status: "running", depth: 2, parentId: "lv001", wallClockMs: 0,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 9e3,
    }),
    swarmNode("lv007", "Draft the fix for handleWebhook", "expansion 2 of 3", {
      status: "running", depth: 2, parentId: "lv001", wallClockMs: 0,
      spawnedAt: NOW - 18e4, lastStepAt: null,
    }),
    swarmNode("lv008", "Check whether the fallback belongs at the entry", "expansion 3 of 3", {
      status: "errored", depth: 2, parentId: "lv002", wallClockMs: 7_400,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 15e4,
      errorMessage: "Turn stalled: the provider asked this turn to wait 61s against a 45s budget, "
        + "that wait was taken, and still nothing flowed.",
    }),
    swarmNode("lv009", "Fan the two guarded readers in", "fan-in over 2 parents of depth 1", {
      status: "running", depth: 2, parentId: "lv001", wallClockMs: 0,
      spawnedAt: NOW - 12e4, lastStepAt: NOW - 21e3,
    }),
    // `head_journal.status` has six words; `interrupted` is the non-terminal one (reconciled, resume not yet ruled).
    swarmNode("lv010", "Re-read the router end to end", "expansion 4 of 5", {
      status: "budget_exceeded", depth: 2, parentId: "lv002", wallClockMs: 214_000,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 6e4,
      errorMessage: "Ran out of the depth this search granted it before it could finish "
        + "reading the router.",
    }),
    swarmNode("lv011", "Diff the fix against the admin path", "expansion 5 of 5", {
      status: "interrupted", depth: 2, parentId: "lv002", wallClockMs: 0,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 12e4,
    }),
  ],
  merge: null,
};

/**
 * Every run the Exploration frames list, one per state the surface draws, and longer than one page so the boundary is photographable.
 * `getMctsNodeDetail` may answer null for a retired node; the blanket `[]` would crash the inspector.
 */
const FORK_RUNS: ForkRunSummary[] = [
  {
    // First: the surface focuses the newest. `branches` counts settled rows, so 2 while nine nodes exist.
    id: "lv000", name: "env.DB readers",
    task: "Audit every reader of env.DB across the api Worker",
    startedAt: NOW - 42e4, status: "running",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: RUNNING_ROWS.length - 1, winnerScore: null,
  },
  {
    // Derived: `forkbig` generates 520 rows for this same run.
    id: "n000", name: "/api/health 500s",
    task: "Find why /api/health 500s", startedAt: NOW - 36e5,
    // From the same stores as each row's halves: a swarm writes both.
    status: "completed", hasSearchTree: true, hasNodeTranscripts: false,
    branches: MCTS_ROWS.length - 1, winnerScore: 0.91,
  },
  {
    id: "sw000", name: "/api p95",
    task: "Reduce /api p95 without regressing the health check",
    startedAt: NOW - 22e5, status: "completed",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: SWARM_ROWS.length - 1, winnerScore: 0.93,
  },
  {
    id: "pv000", name: "expiry sweep terminates",
    task: "Prove that the expiry sweep terminates for every session row",
    startedAt: NOW - 78e5, status: "completed",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: PROVE_ROWS.length - 1, winnerScore: 0.94,
  },
  {
    // Branchless by construction: the root is the only row.
    id: "rf000", name: "throwing session row",
    task: "Find a session row that makes readSession throw",
    startedAt: NOW - 4e5, status: "failed",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: 0, winnerScore: null,
  },
  {
    id: "root-merge-1", name: "env.DB call sites",
    task: "Check every other call site that reads env.DB",
    startedAt: NOW - 52e5, status: "completed", hasSearchTree: false,
    hasNodeTranscripts: true, branches: 5, winnerScore: null,
  },
  {
    // The run whose lease outlived it; journal {@link STOPPED_RUN}, focused by `forkstopped`.
    id: "root-merge-0", name: "CLI surface audit",
    task: "Audit the CLI surface", startedAt: NOW - 9 * 36e5,
    status: "partial", hasSearchTree: false, hasNodeTranscripts: true,
    branches: 7, winnerScore: null,
  },
  ...olderForks(),
];

function olderForks(): ForkRunSummary[] {
  const tasks = [
    "Reproduce the /api 500 against the staging snapshot",
    "Work out which deploy renamed the database binding",
    "Find every reader of env.DB outside the api Worker",
    "Decide whether the fallback belongs at the entry or the reader",
    "Trace the webhook route's database path",
    "Check the admin sessions report against the same fix",
    "Compare the two candidate fixes on the failing fixture",
    "Establish whether the 500 predates the router refactor",
  ];

  return Array.from({ length: 31 }, (_, i) => {
    const searched = i % 3 === 0;

    return {
      id: searched ? `n${String(100 + i).padStart(3, "0")}` : `root-merge-${100 + i}`,
      // The read model's derivation: the task's first clause.
      name: (tasks[i % tasks.length] ?? "").split(" ").slice(0, 4).join(" "),
      task: `${tasks[i % tasks.length]}${i >= tasks.length ? ` (attempt ${Math.floor(i / tasks.length) + 1})` : ""}`,
      startedAt: NOW - (10 + i) * 36e5,
      status: i % 7 === 5 ? "partial" as const : "completed" as const,
      hasSearchTree: searched,
      hasNodeTranscripts: !searched,
      branches: searched ? 9 + (i % 5) : 2 + (i % 3),
      winnerScore: searched ? 0.62 + ((i % 7) * 0.04) : null,
    };
  });
}

/** A run whose lease outlived it: `read-models/fork-runs.ts` reports `partial` because the tree, not the ledger row still saying `running`, decides. */
const STOPPED_RUN: HeadRunView = {
  rootId: "root-merge-0",
  task: "Audit the CLI surface",
  rationale: "Seven surfaces, one head each — the audit is per-command.",
  status: "aborted",
  spawnedAt: NOW - 9 * 36e5,
  heads: [
    swarmNode("root-merge-0-h0", "packages/cli/src/commands/run.ts", "the command every user reaches first", {
      summary: "Three flags are accepted and never read: `--json`, `--quiet`, `--no-color`.",
      wallClockMs: 21_400, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 88 * 36e4,
    }),
    swarmNode("root-merge-0-h1", "packages/cli/src/commands/login.ts", "the credential path", {
      summary: "The token is written before the scope check, so a rejected scope still leaves a file.",
      wallClockMs: 18_900, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 87 * 36e4,
    }),
    swarmNode("root-merge-0-h2", "packages/cli/src/commands/logs.ts", "the streaming path", {
      status: "aborted", wallClockMs: 6_100, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 86 * 36e4,
      errorMessage: "The workspace was evicted while this head was reading the follow loop.",
    }),
    swarmNode("root-merge-0-h3", "packages/cli/src/commands/deploy.ts", "the release path", {
      status: "aborted", wallClockMs: 5_800, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 86 * 36e4,
      errorMessage: "The workspace was evicted while this head was reading the release gate.",
    }),
    swarmNode("root-merge-0-h4", "packages/cli/src/commands/agents.ts", "the fan-out path", {
      status: "aborted", wallClockMs: 4_300, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 86 * 36e4,
      errorMessage: "The workspace was evicted while this head was listing subagents.",
    }),
    swarmNode("root-merge-0-h5", "packages/cli/src/commands/files.ts", "the drive path", {
      status: "errored", wallClockMs: 3_100, spawnedAt: NOW - 9 * 36e5, lastStepAt: null,
      errorMessage: "No home could be provisioned for this head after the eviction.",
    }),
    swarmNode("root-merge-0-h6", "packages/cli/src/commands/config.ts", "the settings path", {
      status: "errored", wallClockMs: 2_400, spawnedAt: NOW - 9 * 36e5, lastStepAt: null,
      errorMessage: "No home could be provisioned for this head after the eviction.",
    }),
  ],
  merge: null,
};

/** The six things a node panel can show, as `getNodeTranscript` answers; each must read differently. The sixth is a mid-turn branch keyed by `branchHeadId`. */
const TRANSCRIPTS = {
  "root-merge-1-h0": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h0",
    task: "Audit workers/api/src/db.ts for every read of env.DB, and decide whether the ?? fallback belongs at the request entry or at each reader. The reported 500 comes through /api/health since Tuesday's deploy renamed the binding to SESSIONS_DB, so env.DB is undefined.",
    rationale: "the reported 500",
    status: "completed",
    spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5, wallClockMs: 14_200,
    usage: { input: 8_420, output: 610 },
    steps: { status: "end", items: [
      { parts: [
        { type: "reasoning", text: "The 500 is a `.prepare` on an undefined `env.DB`, so the fix has to sit where the binding is read — not where it was renamed. That means I need every reader, not just the one in the stack trace.", state: "done" },
        { type: "text", text: "Reading the handler and both of its callers before changing anything.", state: "done" },
        { type: "tool-file", toolCallId: "gallery-call-1", state: "output-available", input: { op: "read", path: "workers/api/src/db.ts" }, output: "export function openDb(env: Env): D1Database {\n  return env.DB;\n}" },
        { type: "tool-grep", toolCallId: "gallery-call-2", state: "output-available", input: { pattern: "env\\.DB", path: "workers/api/src" }, output: "db.ts:10\nrouter.ts:31\nhealth.ts:9" },
      ] },
      { parts: [
        { type: "text", text: "Three readers, one shape. `health.ts:9` already falls back; the two in `db.ts` and `router.ts` do not.", state: "done" },
        { type: "tool-file", toolCallId: "gallery-call-3", state: "output-available", input: { op: "read", path: "workers/api/src/routes/health.ts" }, output: "const db = env.SESSIONS_DB ?? env.DB;" },
      ] },
      { parts: [
        { type: "reasoning", text: "Fixing at the entry would still let the webhook route read the old name, which it does on the lazy path.", state: "done" },
        { type: "text", text: "Fixing at the reader, and proving it with the suite.", state: "done" },
        { type: "tool-file", toolCallId: "gallery-call-4", state: "output-available", input: { op: "edit", path: "workers/api/src/db.ts" }, output: "2 hunks applied" },
        { type: "tool-shell", toolCallId: "gallery-call-5", state: "output-available", input: { command: "bun test workers/api" }, output: "42 pass\n0 fail\nRan 42 tests across 6 files. [1.21s]" },
      ] },
    ] },
    stepCount: 3,
    toolCount: 5,
    answer: "Two more reads of `env.DB`, in `db.ts` and `router.ts`, both fixed by the same `?? env.DB` fallback already used in `health.ts:9`.\n\nFixing at the **reader** rather than the request entry, because the webhook route reads the binding on the lazy path and an entry fix would still let it read the old name. `bun test workers/api` is green (42 pass).",
    decisions: [{
      question: "Fix at the entry or at the reader?",
      choice: "at the reader",
      rationale: "the entry would still let the webhook route read the old name",
    }],
    errorMessage: null,
    path: [
      { id: "root-merge-1", label: "Check every other call site that reads env.DB", depth: 0, status: "completed" },
      { id: "root-merge-1-h0", label: "workers/api/src/db.ts", depth: 1, status: "completed" },
    ],
  },
  "root-merge-1-h1": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h1",
    task: "Check workers/api/src/routes/webhooks.ts — the lazy path that reads the same binding.",
    rationale: "the lazy path", status: "running",
    spawnedAt: NOW - 42e3, lastStepAt: NOW - 9e3, wallClockMs: 0,
    usage: { input: 5_110 },
    steps: { status: "end", items: [{ parts: [
                                      { type: "reasoning", text: "If this path already reads through openDb, the fix belongs only in db.ts.", state: "done" },
                                      { type: "text", text: "Opening the webhook route.", state: "done" },
                                      { type: "tool-file", toolCallId: "gallery-call-6", state: "output-available", input: { op: "read", path: "workers/api/src/routes/webhooks.ts" }, output: "const db = openDb(env);" },
                                    ] }] },
    stepCount: 1,
    toolCount: 1,
    answer: null, decisions: [], errorMessage: null,
    path: [
      { id: "root-merge-1", label: "Check every other call site that reads env.DB", depth: 0, status: "running" },
      { id: "root-merge-1-h1", label: "workers/api/src/routes/webhooks.ts", depth: 1, status: "running" },
    ],
  },
  "root-merge-1-h2": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h2",
    task: "Check workers/admin/src/sessions-report.ts — the reporting path.",
    rationale: "the reporting path", status: "errored",
    spawnedAt: NOW - 52e5, lastStepAt: null, wallClockMs: 2_100,
    usage: { input: 1_020 },
    steps: { status: "end", items: [] }, stepCount: 0, toolCount: 0, answer: null, decisions: [],
    errorMessage: "the admin Worker is not checked out on this computer",
    path: [
      { id: "root-merge-1", label: "Check every other call site that reads env.DB", depth: 0, status: "completed" },
      { id: "root-merge-1-h2", label: "workers/admin/src/sessions-report.ts", depth: 1, status: "errored" },
    ],
  },
  // A competed branch: no tool loop, its `observation` is the whole output.
  n003: {
    origin: "rollout", runId: "n000", nodeId: "n003",
    task: "Find why /api/health 500s",
    rationale: "", status: "terminal",
    spawnedAt: NOW - 34e5, lastStepAt: null, wallClockMs: 0, usage: {},
    steps: { status: "end", items: [] }, stepCount: 0, toolCount: 0,
    answer: "`openDb` reads `env.DB` and Tuesday's deploy renamed the binding to `SESSIONS_DB`, so the read returns undefined and `.prepare` throws. Read `env.SESSIONS_DB ?? env.DB` — the shape `health.ts` already uses — rather than binding the database twice, which would hide the rename from every reader.",
    decisions: [], errorMessage: null,
    path: [
      { id: "n000", label: "Find why /api/health 500s", depth: 0, status: "open" },
      { id: "n001", label: "Look at the Worker's bindings", depth: 1, status: "open" },
      { id: "n003", label: "Read the binding by its new name", depth: 2, status: "terminal" },
    ],
  },
  // A Steer-as-Branch run: one head, its id derived from the run id.
  "steer-b7f21-head": {
    origin: "head", runId: "steer-b7f21", nodeId: "steer-b7f21-head",
    task: "Actually, check staging first — I don't think the rename deployed there.",
    rationale: "mid-turn redirect",
    status: "completed",
    spawnedAt: NOW - 9e5, lastStepAt: NOW - 84e4, wallClockMs: 61_400,
    usage: { input: 5_140, output: 380 },
    steps: { status: "end", items: [
      { parts: [
        { type: "reasoning", text: "If staging never deployed it, its working health check proves nothing about production and the whole comparison is off.", state: "done" },
        { type: "text", text: "Checking whether Tuesday's rename reached staging at all.", state: "done" },
        { type: "tool-shell", toolCallId: "gallery-call-7", state: "output-available", input: { command: "bunx wrangler deployments list --env staging" }, output: "3f2a91c  2026-08-11  fix: rename the sessions binding" },
      ] },
      { parts: [
        { type: "text", text: "It did deploy, on the 11th. Staging is comparable after all.", state: "done" },
      ] },
    ] },
    stepCount: 2,
    toolCount: 1,
    answer: "Staging deployed the rename `3f2a91c` on 2026-08-11, so it reads the database by the new binding exactly as production does — staging is a fair reproduction and the fallback is still the right fix.",
    decisions: [], errorMessage: null,
    path: [
      { id: "steer-b7f21-head", label: "Check staging first", depth: 0, status: "completed" },
    ],
  },
  // Two nodes of the live run, reachable from the run pane's node list.
  lv001: {
    origin: "head", runId: "lv000", nodeId: "lv001",
    task: "Walk the webhook route's database path: every read of env.DB in workers/api/src/routes, and for each one say whether a missing binding can reach it and what the caller sees when it does.",
    rationale: "expansion 1 of 5",
    status: "completed",
    spawnedAt: NOW - 40e4, lastStepAt: NOW - 30e4, wallClockMs: 118_000,
    usage: { input: 9_180, output: 720 },
    steps: { status: "end", items: [
      { parts: [
        { type: "reasoning", text: "The task names one file but the router re-exports from two others, so grepping the folder is cheaper than reading it and less likely to miss a caller.", state: "done" },
        { type: "text", text: "Listing the readers before I judge any of them.", state: "done" },
        { type: "tool-shell", toolCallId: "gallery-call-8", state: "output-available", input: { command: "rg -n 'env\\.DB' workers/api/src/routes" }, output: "src/routes/webhooks.ts:88:  const db = env.DB;\nsrc/routes/webhooks.ts:141:  if (env.DB === undefined) {\nsrc/routes/admin.ts:52:  const rows = env.DB.prepare(query);" },
      ] },
      { parts: [
        { type: "text", text: "Three reads, two of them unguarded. `webhooks.ts:141` checks rather than calls, so a missing binding takes the early return and is fine.", state: "done" },
        { type: "tool-read", toolCallId: "gallery-call-9", state: "output-available", input: { path: "workers/api/src/routes/webhooks.ts", offset: 80, limit: 20 }, output: "  const db = env.DB;\n  return await db.prepare(INSERT_EVENT).bind(event.id).run();" },
      ] },
      { parts: [
        { type: "text", text: "Confirmed. `db` is undefined once the binding is renamed and `.prepare` throws before anything is returned to the caller.", state: "done" },
      ] },
    ] },
    stepCount: 3,
    toolCount: 2,
    answer: "`handleWebhook` reads `env.DB` with no fallback — it throws on every request since the binding was renamed. `admin.ts:52` has the same shape. `webhooks.ts:141` checks instead of calling and is safe. The fix belongs at both reads, spelled the way `openDb` now spells it: `env.SESSIONS_DB ?? env.DB`.",
    decisions: [], errorMessage: null,
    path: [
      { id: "lv000", label: "Audit every reader of env.DB", depth: 0, status: "running" },
      { id: "lv001", label: "Walk the webhook route's database path", depth: 1, status: "completed" },
    ],
  },
  lv003: {
    origin: "head", runId: "lv000", nodeId: "lv003",
    task: "Trace the router refactor's readers: which of them read env.DB themselves, and did the refactor introduce or remove a fallback.",
    rationale: "expansion 3 of 5",
    status: "running",
    spawnedAt: NOW - 40e4, lastStepAt: NOW - 4e3, wallClockMs: 0,
    usage: { input: 4_260, output: 190 },
    steps: { status: "end", items: [
      { parts: [
        { type: "reasoning", text: "A read that lost its fallback and a read that never had one need different fixes, and only the history tells them apart.", state: "done" },
        { type: "text", text: "Finding the refactor first — the fallback may have moved rather than gone.", state: "done" },
        { type: "tool-shell", toolCallId: "gallery-call-10", state: "output-available", input: { command: "git log --oneline -S'env.DB' -- workers/api/src" }, output: "8c1f20a1 refactor(api): one router, every route through openDb" },
      ] },
      { parts: [
        { type: "text", text: "Reading that commit.", state: "done" },
        { type: "tool-shell", toolCallId: "gallery-call-11", state: "input-available", input: { command: "git show 8c1f20a1 --stat" } },
      ] },
    ] },
    stepCount: 2,
    toolCount: 2,
    answer: null,
    decisions: [], errorMessage: null,
    path: [
      { id: "lv000", label: "Audit every reader of env.DB", depth: 0, status: "running" },
      { id: "lv003", label: "Trace the router refactor's readers", depth: 1, status: "running" },
    ],
  },
} satisfies Record<string, NodeTranscriptView>;

const TRANSCRIPT_BY_NODE = new Map<string, NodeTranscriptView>(Object.entries(TRANSCRIPTS));

/** Satisfaction per day, as `getQuality` answers: thirty UTC days, a few weekends nobody rated. */
export const QUALITY_DAYS = Array.from({ length: 30 }, (_, i) => {
  const day = new Date(NOW - (29 - i) * 864e5).toISOString().slice(0, 10);

  if ([2, 3, 9, 10, 16, 17, 23].includes(i)) {
    return { day, satisfaction: { mean: 0, lo: 0, hi: 0, n: 0 }, corrected: { mean: 0, lo: 0, hi: 0, n: 0 }, rated: 0, thumbs: 0, turns: 0 };
  }

  const mean = 3.1 + i * 0.045;
  const rated = 3 + (i % 4);

  return {
    day,
    satisfaction: { mean, lo: mean - 0.45, hi: Math.min(5, mean + 0.4), n: rated },
    corrected: { mean: Math.max(0, 0.3 - i * 0.01), lo: 0.05, hi: 0.5, n: rated },
    rated, thumbs: i % 3, turns: rated + 2,
  };
});

/** The last seven of those days summed, as `getQualityWindow` answers. */
export const QUALITY_WINDOW = {
  from: QUALITY_DAYS.at(-7)?.day ?? "", to: QUALITY_DAYS.at(-1)?.day ?? "",
  satisfaction: { mean: 4.2, lo: 3.8, hi: 4.5, n: 26 }, corrected: { mean: 0.12, lo: 0.04, hi: 0.3, n: 26 },
  rated: 26, thumbs: 6, turns: 35,
};

/** Keyed by the run's root id, the read model's key, so one run's tree cannot pair with another's journal. */
const SEARCH_ROWS_BY_ROOT: ReadonlyMap<string, readonly MctsRow[]> = new Map([
  ["n000", MCTS_ROWS],
  ["sw000", SWARM_ROWS],
  ["pv000", PROVE_ROWS],
  ["rf000", REFUSED_ROWS],
  ["lv000", RUNNING_ROWS],
]);

const JOURNAL_BY_ROOT: ReadonlyMap<string, HeadRunView> = new Map(
  [MERGED_RUN, SWARM_RUN, PROVE_RUN, REFUSED_RUN, RUNNING_RUN, STOPPED_RUN]
    .map((run) => [run.rootId, run]),
);

/** One row per run, as the server composes it, carrying every half it has: a swarm has both `search_nodes` and `head_journal`. */
export const CANVAS_ROWS: readonly ExplorationCanvasRun[] = FORK_RUNS.map((run) => ({
  run,
  params: FORK_PARAMS.find((entry) => entry.rootId === run.id) ?? null,
  tree: (SEARCH_ROWS_BY_ROOT.get(run.id) ?? []).map((row) => asSearchNode(row, run.id)),
  head: JOURNAL_BY_ROOT.get(run.id) ?? null,
  frontier: null,
}));

/** The stub stands in for the server, so the canvas payload must be the server's full row, not the client's loose shape. */
export function asSearchNode(row: MctsRow, rootId: string): SearchTreeRow {
  return {
    id: row.id,
    parent_id: row.parent_id,
    root_id: rootId,
    task: row.task ?? "",
    action: row.action,
    observation: row.observation ?? "",
    visits: row.visits,
    value: row.value,
    own_score: row.own_score,
    depth: row.depth,
    // `running` is a merged-head status the search_nodes CHECK constraint cannot hold.
    status: row.status === "running" ? "open" : row.status,
    created_at: row.created_at ?? NOW,
  };
}

/** Pages through the real `seekPage`. The anchor is the bare fork id, not the server's composite: `after` is opaque, so any resolvable format is valid. */
function canvasPage(rows: readonly ExplorationCanvasRun[], request: PageRequest | undefined): Page<ExplorationCanvasRun> {
  const limit = request?.limit ?? 30;
  const after = request?.cursor?.after;
  const start = after === undefined ? 0 : rows.findIndex((entry) => entry.run.id === after) + 1;

  return seekPage(rows.slice(start, start + limit + 1), limit, (entry) => entry.run.id);
}

/**
 * The exploration reads over `rows`, each as its read model answers it, for both transports (Column C's `Rpc` and the
 * explorer's socket); the blanket `[]` broke them.
 */
export function explorationAnswers(rows: readonly ExplorationCanvasRun[] = CANVAS_ROWS): WorkspaceAnswers {
  return {
    getExplorationCanvas: (request) => canvasPage(rows, request),
    listForkRuns: (request) => {
      const page = canvasPage(rows, request);

      return { ...page, items: page.items.map((entry) => entry.run) };
    },
    // The composed row `orchestrator.getForkRun` answers; the client reads `entry.run` off it.
    getForkRun: (id) => rows.find((entry) => entry.run.id === id) ?? null,
    // As the search_nodes read answers it: rows, not the tree's own nodes.
    getSearchTree: (rootId) => (SEARCH_ROWS_BY_ROOT.get(rootId) ?? []).map((row) => asSearchNode(row, rootId)),
    getHeadRun: (rootId) => JOURNAL_BY_ROOT.get(rootId) ?? null,
    // Both answer null; the panel must not render either as "recorded nothing".
    getMctsNodeDetail: () => null,
    getNodeTranscript: (_rootId, nodeId, request) => {
      const transcript = TRANSCRIPT_BY_NODE.get(nodeId) ?? null;

      return new URLSearchParams(location.search).get("olderSteps") === null ? transcript : stepAtATime(transcript, request?.cursor?.after);
    },
  };
}

/** `&olderSteps=1`: a node's journal a step a page, newest first, as a long one is read: each older page by its cursor. */
function stepAtATime(transcript: NodeTranscriptView | null, before: string | undefined): NodeTranscriptView | null {
  if (transcript === null) return null;
  const steps = transcript.steps.items;
  const at = (before === undefined ? steps.length : Number(before)) - 1;
  const step = steps.slice(at, at + 1);

  return { ...transcript, steps: at > 0 ? { status: "more", items: step, next: { after: String(at) } } : { status: "end", items: step } };
}

export const FORK_ANSWERS: WorkspaceAnswers = { ...GALLERY_ANSWERS, ...explorationAnswers() };

export const forkRpc = answeringRpc(FORK_ANSWERS);

/**
 * `&workspaceFault=`: the Files, snapshot and memory reads fail as `data-workspace-fault` says, and answer as
 * `data-workspace-revision` says once they recover; `empty`, the workspace remembers nothing.
 */
function faultedAnswers(): WorkspaceAnswers {
  const state = document.documentElement.dataset;
  const revision = () => state.workspaceRevision ?? "before";
  const memory = () => (revision() === "empty" ? "" : `Memory ${revision()}`);

  return {
    getExecutorFiles: () => {
      galleryReadFault(state.workspaceFault);

      return { path: "/", entries: [{ name: `${revision()}.txt`, type: "file", size: 12, mtimeMs: revision() === "before" ? 1 : 2 }] };
    },
    listMounts: () => [],
    getMemoryContent: () => {
      galleryReadFault(state.workspaceFault);

      return memory();
    },
    getWorkspaceSnapshot: () => {
      galleryReadFault(state.workspaceFault);

      return withChat({ ...OPENING_SNAPSHOT, memoryContent: memory() }, { activePlan: galleryAgentPlan });
    },
  };
}

/** A sandbox's ports as the frame's flags hold them (`galleryPortListing`); any other machine's, as the gallery answers. */
function exposedPorts(executor: string | undefined): Promise<WorkspaceAnswer<"getExposedPorts">> | WorkspaceAnswer<"getExposedPorts"> {
  const listing = galleryPortListing(executor);

  if (listing?.kind === "held") return new Promise(() => {});

  return listing?.kind === "listed" ? listing.value : { ports: [] };
}

/**
 * The workspace page's answers, each typed as the workspace answers it: the gallery's, the socket's own, the page's
 * table, its ports, roster and plan, and the reads that wait on the page, each over the one before.
 */
function pageAnswers(): WorkspaceAnswers {
  const shell = SHELL_COMPUTER || SHELL_PC !== null;

  const read: WorkspaceAnswers = {
  ...FORK_ANSWERS,
  ...AGENT_ANSWERS,
  listMounts: () => (shell ? SHELL_MACHINES.mounts : []),
  ...PAGE_TABLE_ANSWERS,
  getWorkspaceSnapshot: async () => {
    await snapshotGate();

    return withChat({ ...OPENING_SNAPSHOT, slates: gallerySlates().slates }, {
      activePlan: galleryAgentPlan,
      messageCount: HISTORY_ROWS > 0 ? seededGalleryChatRows() + HISTORY_ROWS : OPENING_SNAPSHOT.chat.messageCount,
    });
  },
  getExposedPorts: exposedPorts,
  ...ROSTER_ANSWERS,
  };

  const faulted = new URLSearchParams(location.search).has("workspaceFault") ? { ...read, ...faultedAnswers() } : read;

  return { ...faulted, ...PLAN_ANSWERS, ...ASYNC_PAGE_ANSWERS };
}

export const PAGE_ANSWERS = pageAnswers();

export const workspacePageWire = wireOf(PAGE_ANSWERS);

/** The bar over fixture chats: working, waiting, failed. */
const GALLERY_CHATS: readonly PanelAgent[] = [
  mainPanelAgent({ activity: "working" }),
  { colour: 1, key: galleryActorId("docs"), label: "Fix the /api/health 500s", category: "user", activity: "waiting", parent: "main", open: { kind: "chat", path: "docs" }, tab: true, input: true, figures: { activeMs: 0, cacheEma: null } },
  { colour: 2, key: galleryActorId("agent-4f2c"), label: "Read the overnight error logs", category: "user", activity: "failed", parent: "main", open: { kind: "chat", path: "agent-4f2c" }, tab: true, input: true, figures: { activeMs: 0, cacheEma: null } },
  { colour: 3, key: galleryActorId("review"), label: "Review: payments refactor", category: "user", activity: "working", parent: "main", open: { kind: "chat", path: "review" }, tab: true, input: true, figures: { activeMs: 0, cacheEma: null } },
];

export function GalleryWorkspaceHeader({ active = "main" }: { active?: string }) {
  return (
    <WorkspaceHeader
      workspace={{ name: "api-worker", title: "API Worker", to: "/workspace/api-worker/overview", editValue: "API Worker", rename: async () => {}, remove: () => {} }}
      chats={GALLERY_CHATS.map((agent): ChatTab => (agent.key === "main"
        ? { agent, to: "/workspace/api-worker", rename: async () => {} }
        : { agent, to: "/workspace/api-worker", rename: async () => {}, remove: () => {} }))}
      active={active}
      newChat="/workspace/api-worker/new"
      trailing={<WorkspaceBarActions workspace="api-worker" working={0} view={undefined} inspector={null} onAgents={() => {}} />}
    />
  );
}

/* The real composer over real draft/mode/model state; `notices` is a parameter so the status treatment can be reviewed. */
export function GalleryComposer({ notices = [] }: { notices?: readonly ComposerNotice[] }) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<WorkMode>("build");
  const [model, setModel] = useState("opencode-go/muse-spark-1.3-contributor");

  return (
    <div className="border-t p-border p-sidebar">
      <Composer
        value={value}
        onValueChange={setValue}
        onSend={() => setValue("")}
        onStop={() => {}}
        placeholder="Send a message..."
        disabled={false}
        liveness={IDLE_TURN}
        mode={{ value: mode, onChange: setMode }}
        attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
        modelPicker={<ModelPicker models={MODEL_STUBS()} value={model} onChange={setModel} size="xs" />}
        notices={notices}
      />
    </div>
  );
}

export function ChatMessages() {
  // Stubbed at the seam the test reads: the dataset records the write, the map is its visible result.
  const [feedback, setFeedback] = useState<Record<string, 'positive' | 'negative' | null>>({});

  const onFeedback = useCallback(async (messageId: string, value: 'positive' | 'negative' | null) => {
    const root = document.documentElement;
    const prior = root.dataset.galleryFeedbackCalls;

    const calls: Array<{ method: string; args: unknown[] }> =
      // SAFETY: this callback is the recorder's only writer, so the parsed shape is its own.
      prior === undefined ? [] : JSON.parse(prior);

    calls.push({ method: 'setTurnFeedback', args: [messageId, value] });

    root.dataset.galleryFeedbackCalls = JSON.stringify(calls);
    setFeedback((prev) => ({ ...prev, [messageId]: value }));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-7 space-y-5 lg:px-8 [&>*]:max-w-[780px] [&>*]:mx-auto" data-gallery-chat>
      {MESSAGES.map((m) => (
        <div key={m.id} data-chat-row={m.id}>
          <MessageView message={m} onFork={() => {}}
            feedback={feedback[m.id]} onFeedback={onFeedback} />
        </div>
      ))}
      <DeviceOfflineRow devices={[{ id: "dev-1", label: "ashish-device", lastSeenAt: NOW }]} />
    </div>
  );
}

export function Shell(
  {
    surface = "Work", mctsTrees = EMPTY_TREES, rpc = workRpc, pendingActions = SHELL_PENDING_ACTIONS,
    headActivity = NO_HEAD_ACTIVITY, backgroundJobs = BACKGROUND_JOBS, notices = [], providerWait = null,
  }:
  {
    surface?: SurfaceKind; mctsTrees?: ReadonlyMap<string, ForkNode>; rpc?: WorkspaceRpc;
    pendingActions?: PendingAction[];
    headActivity?: ReadonlyMap<string, number>;
    /** Empty is the liveness case: with no running job or streaming turn the fork list drops to its idle cadence. */
    backgroundJobs?: BackgroundJob[];
    /** Empty by default: only the provider-wait frame pins it. */
    providerWait?: { provider: string; untilMs: number } | null;
    /** Empty by default: a neighbour stuck in failure makes the photographed surface look broken. */
    notices?: readonly ComposerNotice[];
  },
) {
  const waitNotice = useProviderWaitNotice(providerWait);

  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      {/* Mirrors components/layout.tsx. */}
      <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="p-workbench min-h-0 flex-1 min-w-0 overflow-hidden">
        <div className="h-full flex flex-col">
          <GalleryWorkspaceHeader />
          <div className="flex-1 flex min-h-0">
            <div className="@container flex min-w-0 flex-1 flex-col h-full border-r p-border">
              <ChatMessages />
              <GalleryComposer notices={[...notices, ...waitNotice]} />
            </div>
            <div className="z-[2] -ml-[3px] w-[5px] shrink-0" />
            <div className="w-[430px] shrink-0 min-w-0">
              <WorkSurface
                surface={surface} onSurface={() => {}} pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} snapshot={{ status: "loading" }} onRetryLoad={() => {}}
                memory={[]} memoryContent="" onSearchMemory={() => {}} mctsTrees={mctsTrees} headActivity={headActivity} isStreaming={false}
                executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                backgroundJobs={backgroundJobs} inspectedWork={[]} onRefreshJobs={() => {}} pendingActions={pendingActions}
                rpc={rpc}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/** Gallery-only previewSlate fixture. It exercises SlateFrame, not a deployed preview origin. */
const SLATE_ANSWERS: WorkspaceAnswers = {
  previewSlate: () => ({ ok: true, value: { url: SLATE_GALLERY_URL, port: 8789, sized: false } }),
};

export const slateRpc = galleryRpc(SLATE_ANSWERS);

// The plan at its real shape: several steps, one active, one with subtasks, one dropped.
type WorkspaceWork = WorkspaceAnswer<"listWorkspaceWork">;

export const AGENT_TASKS: WorkspaceWork["tasks"][number]["tasks"] = [
  {
    id: "t1", parentId: null, title: "Reproduce the /api/health 500", status: "done",
    updatedAt: NOW - 44e5, note: null, subtasks: [],
  },
  {
    id: "t2", parentId: null, title: "Patch the gateway timeout that swallows the session lookup",
    status: "active", updatedAt: NOW - 8e5, note: null,
    subtasks: [
      { id: "t5", parentId: "t2", title: "Raise the upstream deadline to 60s", status: "done", updatedAt: NOW - 21e5, note: null },
      { id: "t6", parentId: "t2", title: "Stop retrying a request the client already abandoned", status: "active", updatedAt: NOW - 6e5, note: "Client already bails at 8s — retrying past that is burn, not robustness." },
      { id: "t7", parentId: "t2", title: "Check the same path in the admin Worker", status: "open", updatedAt: NOW - 30e5, note: null },
    ],
  },
  {
    id: "t3", parentId: null, title: "Add a regression test for the expired-session branch",
    status: "open", updatedAt: NOW - 52e5, note: null, subtasks: [],
  },
  {
    id: "t4", parentId: null, title: "Rewrite the API docs page", status: "dropped",
    updatedAt: NOW - 40e5, note: null, subtasks: [],
  },
];

/** Root plan and tasks plus one subagent's plan, so both owners' rows draw. */
const WORKSPACE_WORK: WorkspaceWork = {
  plans: [
    {
      owner: { actorId: "actor-main", name: "main", title: "main", retired: false, path: [] },
      plan: {
        id: "plan-gateway", sessionId: "default", revision: 3,
        content: "# Gateway timeout repair\n\nPatch the gateway timeout, then prove the expired-session branch.",
        status: "pending", annotations: [], feedback: null, handoffAccepted: false,
        createdAt: NOW - 53e5, updatedAt: NOW - 9e5,
      },
      tasks: AGENT_TASKS.filter((task) => task.id === "t2"),
    },
    {
      owner: { actorId: "actor-courier", name: "courier", title: "courier", retired: false, path: ["courier"] },
      plan: {
        id: "plan-courier", sessionId: "default", revision: 1,
        content: "# Courier rollout\n\nStage the rollout and verify the receipt.",
        status: "approved", annotations: [], feedback: null, handoffAccepted: true,
        createdAt: NOW - 60e5, updatedAt: NOW - 50e5,
      },
      tasks: [
        { id: "t8", parentId: null, title: "Stage the rollout", status: "done", updatedAt: NOW - 55e5, note: null, subtasks: [] },
      ],
    },
  ],
  tasks: [
    {
      owner: { actorId: "actor-main", name: "main", title: "main", retired: false, path: [] }, plan: null,
      tasks: AGENT_TASKS.filter((task) => task.id !== "t2"),
    },
  ],
};

const SHELL_PENDING_ACTIONS = PENDING_ACTIONS.filter((action) => action.kind === "plan_review");

export const WORK_ANSWERS: WorkspaceAnswers = {
  listWorkspaceWork: () => WORKSPACE_WORK,
  getEvolutionChangelog: () => CHANGELOG,
};

export const workRpc = galleryRpc(WORK_ANSWERS);

/** `lost[n]` is the bytes the sender dropped just before line n. */
function buildTail(lines: number, lost: readonly number[]): JobOutputTail {
  return BUILD_LINES.slice(0, lines).reduce<JobOutputTail | undefined>((tail, line, at) => followJobOutput(tail, {
    type: JOB_OUTPUT_EVENT, jobId: BUILD_JOB_ID, seq: at + 1, dropped: lost[at] ?? 0,
    chunks: [{ stream: line.startsWith("warn:") ? "stderr" : "stdout", text: `${line}\n`, ...((lost[at] ?? 0) > 0 && { omitted: lost[at] }) }],
  }), undefined) ?? { seq: 0, chunks: [], omitted: 0 };
}

function buildingJob(output: JobOutputTail): BackgroundJob {
  return {
    id: BUILD_JOB_ID, kind: "shell", label: "workspace: bun run build", workMode: "build", status: "running",
    result: null, error: null, createdAt: NOW - 95e3, attemptStartedAt: NOW - 95e3, settledAt: null, ...FIRST_DRIVE, output,
  };
}

export function useBuildingJob(): BackgroundJob {
  const params = new URLSearchParams(location.search);
  const live = params.get("live") === "1";
  const lost = (params.get("lost") ?? "").split(",").map((bytes) => Math.max(Number(bytes) || 0, 0));
  const [lines, setLines] = useState(Math.min(Math.max(Number(params.get("lines") ?? 4) || 4, 1), BUILD_LINES.length));

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { setLines((shown) => (shown >= BUILD_LINES.length ? 4 : shown + 1)); }, 1000);

    return () => { clearInterval(timer); };
  }, [live]);

  return buildingJob(buildTail(lines, lost));
}

/** Mutable so the gate can prove rename and delete; `binary-weights.bin` exercises the binary refusal. */
export function seedCompositeTree(offlineDevice: boolean): Map<string, DirEntry[]> {
  const tree = new Map<string, DirEntry[]>([
    // The workspace's places, as `read-models/files.ts` lists `/`: home's, `/slates` and each mount point.
    // The namespace's `/` as the server reads it: the workspace's places beside the machine's own, which are hidden.
    ["/", [
      ...["bin", "dev", "etc", "opt", "proc", "tmp", "usr", "var"].map((name) => ({ name, type: "dir" as const, mtimeMs: NOW - 5e3 })),
      { name: "computer", type: "dir", mtimeMs: NOW - 30 * 60e3 },
      { name: "context", type: "dir" },
      { name: "home", type: "dir", mtimeMs: NOW - 4 * 36e5 },
      ...(offlineDevice ? [] : [{ name: "pc", type: "dir" as const, mtimeMs: NOW - 60e3 }]),
      { name: "shared", type: "dir" },
      { name: "skills", type: "dir" },
      { name: "slates", type: "dir", mtimeMs: NOW - 2 * 864e5 },
    ]],
    ["/context", [{ name: "main", type: "dir" }]],
    ["/context/main", [{ name: "transcript.md", type: "file", size: 48_310, mtimeMs: NOW - 60e3 }]],
    ["/shared", [
      { name: "Reports", type: "dir", mtimeMs: NOW - 5 * 864e5 },
      { name: "brand-guidelines.pdf", type: "file", size: 2_401_118, mtimeMs: NOW - 12 * 864e5 },
    ]],
    ["/shared/Reports", [{ name: "q3-revenue.csv", type: "file", size: 12_904, mtimeMs: NOW - 5 * 864e5 }]],
    ["/skills", [{ name: "sql-triage", type: "dir", mtimeMs: NOW - 20 * 864e5 }]],
    ["/skills/sql-triage", [{ name: "SKILL.md", type: "file", size: 2_010, mtimeMs: NOW - 20 * 864e5 }]],
    ["/slates", [{ name: "errors-dashboard", type: "dir", mtimeMs: NOW - 2 * 864e5 }]],
    ["/slates/errors-dashboard", [{ name: "index.html", type: "file", size: 6_120, mtimeMs: NOW - 2 * 864e5 }]],
    ["/home", [{ name: "main", type: "dir", mtimeMs: NOW - 4 * 36e5 }]],
    ["/home/main", [
      { name: ".cache", type: "dir", mtimeMs: NOW - 12e5 },
      { name: ".env", type: "file", size: 214, mtimeMs: NOW - 2 * 864e5 },
      { name: "logs", type: "dir", mtimeMs: NOW - 60e3 },
      { name: "memory", type: "dir", mtimeMs: NOW - 26e5 },
      { name: "skills", type: "dir", mtimeMs: NOW - 20 * 864e5 },
      { name: "AGENTS.md", type: "file", size: 2_148, mtimeMs: NOW - 3 * 864e5 },
      { name: "SOUL.md", type: "file", size: 913, mtimeMs: NOW - 9 * 864e5 },
      { name: "notes.md", type: "file", size: 4_402, mtimeMs: NOW - 42e5 },
      { name: "binary-weights.bin", type: "file", size: 4_089_446, mtimeMs: NOW - 6 * 864e5 },
    ]],
    ["/home/main/memory", [{ name: "MEMORY.md", type: "file", size: 1_204, mtimeMs: NOW - 26e5 }]],
    // More than two pages: the folder lists its first, and Load more the rest.
    ["/home/main/logs", Array.from({ length: 1_234 }, (_, at) => ({
      name: `run-${String(at).padStart(4, "0")}.log`, type: "file" as const, size: 2_048 + at, mtimeMs: NOW - at * 60e3,
    }))],
    ["/home/main/skills", [{ name: "sql-triage.md", type: "file", size: 2_010, mtimeMs: NOW - 20 * 864e5 }]],
    ["/home/main/.cache", []],
    ["/computer", [{ name: "workspace", type: "dir", mtimeMs: NOW - 30 * 60e3 }]],
    ["/computer/workspace", [
      { name: "build.log", type: "file", size: 18_211, mtimeMs: NOW - 31 * 60e3 },
      { name: "dist", type: "dir", mtimeMs: NOW - 30 * 60e3 },
    ]],
    ["/computer/workspace/dist", [{ name: "app.js", type: "file", size: 220_114, mtimeMs: NOW - 30 * 60e3 }]],
  ]);

  if (!offlineDevice) {
    // `/pc/<name>` and `/pc/<name>/home` are absent: the machine's path guard refuses everything outside `PC_CONSENTED_ROOT`.
    tree.set("/pc", [{ name: PC_SEGMENT, type: "dir", mtimeMs: NOW - 36e5 }]);
    tree.set(PC_CONSENTED_ROOT, [
      { name: "quarterly-report.txt", type: "file", size: 8_412, mtimeMs: NOW - 2 * 36e5 },
      { name: "shot.png", type: "file", size: 1_204_002, mtimeMs: NOW - 5 * 36e5 },
      { name: "notes.html", type: "file", size: 402, mtimeMs: NOW - 36e5 },
    ]);
  }

  return tree;
}

/** A page of `entries` from `from`, as `getExecutorFiles` answers one: `next` while more follow. */
export function filesPage(dir: string, entries: readonly DirEntry[], from = 0) {
  const end = from + FILES_PAGE_ENTRIES;

  return { path: dir, entries: entries.slice(from, end), ...(end < entries.length && { next: end }) };
}

/** The workspace page's Files: the drive frame's tree, as it is before anything moves. */
const PAGE_TREE = seedCompositeTree(false);

function workspaceListing(args?: unknown[]): FilesPage {
  const [, path, { from, hidden }] = v.parse(FILES_REQUEST_ARGS, args ?? []);
  const dir = path === "" ? "/" : path;

  return filesPage(dir, shownEntries(PAGE_TREE.get(dir) ?? [], dir, hidden), from);
}

/** One per severity: `nit` stays quiet, `blocker` is the loudest thing in the column, all readable without a click. */
const ADVISOR_NOTES = {
  nit: "The commit message says 'fix typo' but the diff also renames two exported symbols. Split it or say so.",
  concern: "The retry loop in deploy.sh has no backoff cap. A stuck registry keeps it spinning for the whole turn budget.",
  blocker: "The config drops the DB binding while the old worker is still deployed. Roll the worker first or every session read 500s.",
} satisfies Record<AdvisorSeverity, string>;

/** Core's rank order, each as `sayAdvisorNote` writes it: its text the agent's, its note kept beside it. `blocker` is a
 *  row written before the note was kept, which its card reads out of the text. */
const ADVISOR_MESSAGES: UIMessage[] = ADVISOR_SEVERITIES.map((severity) => msg({
  id: `adv-${severity}`, role: "user",
  metadata: {
    kinuEvent: ADVISOR_SIGNAL_KIND, [ADVISOR_SEVERITY_METADATA_KEY]: severity,
    ...(severity !== "blocker" && { [ADVISOR_NOTE_METADATA_KEY]: ADVISOR_NOTES[severity] }),
  },
  parts: [{ type: "text", text: `${ADVISOR_HEADER}\n\n${ADVISOR_SEVERITY_LABEL[severity]}: ${ADVISOR_NOTES[severity]}` }],
}));

export const said = (text: string) => [{ type: "text" as const, text }];

/** The events with a card of their own, each as its producer writes it. */
export const EVENT_CARD_ROWS: UIMessage[] = [
  msg({ id: "job", role: "user", metadata: { kinuEvent: "background_job", kind: "research", status: "failed" }, parts: said("background job failed") }),
  msg({ id: "job-bare", role: "user", metadata: { kinuEvent: "background_job" }, parts: said("background job finished") }),
  msg({ id: "event-approval", role: "user", metadata: { kinuEvent: "deferred_approval", decision: "approved", count: 2, ids: ["q1", "q2"] }, parts: said("Your owner approved 2 queued commands.") }),
  ...ADVISOR_MESSAGES,
  msg({ id: "event-run", role: "user", metadata: { kinuEvent: "delivered_run", kinuMode: "build", kinuRun: "run-1" }, parts: said("Summarize yesterday's failed deploys.") }),
  msg({ id: "event-answer", role: "user", metadata: { kinuEvent: OWNER_ANSWER_SIGNAL, kinuAuthorship: "owner" }, parts: said("Region: eu-west-1") }),
  ...Object.entries(DRAIN_BATCHES).map(([id, events]) => msg({
    id: `drain-${id}`, role: "user", metadata: { kinuEvent: "event_drain" }, parts: said(buildDrainBatch(events)?.text ?? ""),
  })),
];

/** FilesSurface reads the open workspace for the raw-bytes route. `&offline=device` shows the disconnected row, `&wide=1` the ≥64rem side-panel preview,
 *  `&narrow=1` the column at whatever width the viewport gives it, as a phone does, `&inspector=340|480` the inspector's
 *  default width and one dragged wider. */
export interface MountedFrame { node: React.ReactNode; entries: string[] }

/** A module's frames, by `?frame=`: each draws its page when gallery.tsx mounts it, at once or once its module loads. */
export type FrameTable = Readonly<Record<string, () => MountedFrame | Promise<MountedFrame>>>;

/** A frame that is one element, opened at `entries` (the MemoryRouter's place; the root unless a route param is read). */
export function framed(node: React.ReactNode, entries: string[] = ["/"]): MountedFrame {
  return { node, entries };
}

export function routedPage(entry: string, path: string, page: React.ReactNode, height = "h-screen"): MountedFrame {
  return {
    entries: [entry],
    node: <Routes><Route path={path} element={<div className={`${height} p-bg p-text`}>{page}</div>} /></Routes>,
  };
}
