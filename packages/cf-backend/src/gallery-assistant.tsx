/**
 * The personal assistant in the gallery: Home with it installed (`assistant-home`, `&moment=firstrun` for the first
 * minute after setup, `&at=/workspace/personal-assistant/activity` for its activity), its chat with nothing above it,
 * and any workspace in the focus layout (`focus-workspace`).
 * The pages are the product's own: Layout, WorkspacePage over the gallery's socket, AttentionStack in the composer;
 * only the reads are answered here. `&roster=assistant` gives the sidebar the workspaces the assistant runs.
 */
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import type { UIMessage } from "ai";
import {
  APP_ROUTES, buildDrainBatch, mainPanelAgent, PositionPageRequestSchema, workspaceGenesisSignal,
  type ChatHistoryEntry, type JsonObject, type JsonValue, type KinuEvent, type RosterEntry, type WorkspaceOverview,
} from "@kinu.run/core";
import { JsonObjectSchema, RECORDED_AT_METADATA_KEY } from "@kinu.run/core";
import Layout from "@/components/layout";
import WorkspacePage from "@/pages/WorkspacePage";
import { seedGalleryChat, serveGalleryRpc } from "@/gallery-agent-stub";
import { GALLERY_PICTURE } from "@/gallery-pictures";
import type { SocketCall } from "@/lib/workspace-rpc";

const NOW = Date.now();

const MIN = 60_000;

const HOUR = 60 * MIN;

/** The last `hh:mm` before now: the brief and the watches keep their clock times whenever the frame is opened. */
const at = (hh: number, mm: number) => {
  const today = new Date(new Date(NOW).setHours(hh, mm, 0, 0)).getTime();

  return today <= NOW ? today : today - 864e5;
};

/** `minutes` before now: the conversation is always the one just had. */
const ago = (minutes: number) => NOW - minutes * MIN;

const query = new URLSearchParams(location.search);

const ASSISTANT_WORKSPACE = "personal-assistant";

const MOMENT = v.parse(v.picklist(["morning", "firstrun"]), query.get("moment") ?? "morning");

const overview = (o: Partial<WorkspaceOverview> & Pick<WorkspaceOverview, "activity">): WorkspaceOverview => ({
  decisionsWaiting: 0, hasUpdates: false, awaitsSettings: false, latestRun: null, slates: [], shares: [], plan: null, ...o,
});

/** A slate the workspace keeps, with its latest capture (gallery-pictures.ts names each). */
const slate = (id: string, title: string, picture: string) => ({ id, title, picture, visibility: null });

const entry = (name: string, displayName: string, visited: number, o: WorkspaceOverview | null): RosterEntry => ({
  name, displayName, createdAt: NOW - 20 * 864e5, lastVisited: NOW - visited, overview: o, decisions: o?.decisionsWaiting ?? 0, logo: null,
});

/** The owner's workspaces as the assistant sees them on a Monday morning: two it runs, one waiting on a deploy. */
export const ASSISTANT_ROSTER: RosterEntry[] = [
  // Home's own workspace, as the roster lists it once installed and its first turn has reported: named as its assistant
  // is, since setup names both; the rail leaves it out.
  { ...entry(ASSISTANT_WORKSPACE, "Kinu", 0, overview({ activity: "idle" })), home: true },
  // Started by the assistant a few minutes ago, when Ashish asked for it in Home's chat.
  ...(MOMENT === "firstrun" ? [] : [entry("api-worker-v2", "API Worker v2 release", 2 * MIN, overview({
    activity: "working", latestRun: { status: "running", task: "Cut release/v2 from main and write the notes", run: null },
    plan: { title: "Cut release/v2, write the notes, get staging green", done: 1, total: 4 },
    slates: [slate("release", "Release v2", GALLERY_PICTURE.release)],
  }))]),
  entry("api-worker", "API Worker", 12 * MIN, overview({
    activity: "idle", decisionsWaiting: 1,
    latestRun: { status: "completed", task: "Read the sessions database as SESSIONS_DB, then deploy", run: null },
    plan: { title: "Read the sessions database as SESSIONS_DB", done: 4, total: 5 },
    slates: [slate("workers-health", "Workers health", GALLERY_PICTURE.deploys), slate("incident", "Incident: sessions 500s", GALLERY_PICTURE.incident)],
  })),
  entry("kinu-issues", "Issue triage · kinu-run/kinu", 40 * MIN, overview({
    activity: "working",
    latestRun: { status: null, task: "Label this week's issues and answer the easy ones", run: null },
    plan: { title: "Label this week's issues and answer the easy ones", done: 9, total: 14 },
    slates: [slate("pr-board", "PR review board", GALLERY_PICTURE.prBoard)],
  })),
  entry("do-sqlite", "Durable Objects SQLite report", 9 * HOUR, overview({
    activity: "idle",
    latestRun: { status: "completed", task: "What changed in Durable Objects SQLite storage this month", run: null },
    plan: { title: "What changed in Durable Objects SQLite storage this month", done: 6, total: 6 },
    slates: [slate("report", "Durable Objects SQLite report", GALLERY_PICTURE.report)],
  })),
  entry("kinu-website", "Kinu website", 2 * 864e5, overview({
    activity: "idle", latestRun: { status: "error", task: "Lighthouse check of kinu.run before the release", run: null },
  })),
  entry("router-firmware", "Router firmware in Ghidra", 4 * 864e5, overview({
    activity: "unfinished", latestRun: { status: "completed", task: "Map the update routine's signature check", run: null },
    slates: [slate("ghidra", "Update routine map", GALLERY_PICTURE.ghidra)],
  })),
];

/** One trigger as the assistant's Durable Object lists it (`listTriggers`). */
const watching = (id: string, kind: string, label: string, next: number | null) => ({
  id, kind, spec: { label }, creator_trust: "owner", state: "active", created_at: NOW - 3 * 864e5,
  paused_at: null, revoked_at: null, rate_limit_per_min: 60, next_fire_at: next, last_fire_at: null, fire_count: 0,
});

/** What the assistant watches: its brief each morning, its checks, and its mail, which arrives rather than fires. The
 *  bar under its name counts them and names the next one due (`watchingLine`). */
const WATCHES = [
  // Its next 08:00, a day on where that falls before the GitHub check: the bar names the check next at any hour.
  watching("t-brief", "timer_cron", "Daily brief", at(8, 0) + (at(8, 0) + 864e5 - NOW < 10 * MIN ? 2 : 1) * 864e5),
  watching("t-github", "timer_cron", "GitHub check", NOW + 9 * MIN),
  watching("t-cloudflare", "timer_cron", "Cloudflare check", NOW + 38 * MIN),
  watching("t-mail", "email_route", "Mail", null),
];

const said = (text: string) => [{ type: "text" as const, text }];

type Message = UIMessage & { createdAt?: number };

const drained = (id: string, createdAt: number, event: KinuEvent): Message => ({
  id, role: "user", createdAt, metadata: { kinuEvent: "event_drain" }, parts: said(buildDrainBatch([event])?.text ?? ""),
});

const EVENT = {
  trace_id: "trace-a", caused_by: null, trust: "external", priority: "background", payload_visibility: "full",
  received_at: 0, reply_channel: null, dedupe_key: null,
} as const;

const BRIEF = `Two things wait on you this morning, and the rest moved overnight.

**Waiting on you**
- **API Worker** has the \`SESSIONS_DB\` fix on staging: 2,140 requests since 06:10, no 500s. It wants to deploy to production; the approval is in its chat.
- [#4120 Web search chain](https://github.com/kinu-run/kinu/pull/4120) on kinu-run/kinu needs your review. CI is green; it is 1,182 lines, mostly the provider registry.

**Mail**: three Important. Priya Shah wants a Dynamic Workers demo this week; Thursday afternoon has nothing on it in your mail.

**Overnight**
- Issue triage labelled 9 new issues on kinu-run/kinu and answered 4. Two need you: a crash report from a CLI on Windows, and a request for Ghidra MCP support.
- The Durable Objects SQLite report is done: 11 changes this month, 3 that touch Kinu.
- Kinu website's Lighthouse check failed at 03:10: LCP is 3.9 s on /pricing.
- On Cloudflare, api-worker's 5xx rate held at 0.02% and kinu-staging deployed at 07:40.`;

/** A program the assistant ran, its answer carrying the host's record of what it changed (core `call-effects.ts`). */
function program(id: string, code: string, result: string, operations: Readonly<Record<string, number>>): Message["parts"][number] {
  return {
    type: "tool-eval", toolCallId: id, state: "output-available", input: { code },
    output: { result, effects: { call: id, files: [], commands: [], operations } },
  };
}

/** The line the model wrote for a turn, which its activity entry leads with. */
const titled = (turn: string): JsonObject => ({ kinuTurnTitle: turn });

const MORNING_THREAD: Message[] = [
  { id: "y-u1", role: "user", createdAt: at(18, 4) - 864e5, parts: said("Keep an eye on #4120 overnight and tell me in the morning if CI goes red.") },
  { id: "y-a1", role: "assistant", createdAt: at(18, 5) - 864e5, parts: said("Will do. I'll check it with the GitHub watch every 15 minutes and put it in tomorrow's brief.") },
  drained("ev-brief", at(8, 0), { ...EVENT, id: "ev-timer-brief", ingress: "timer_alarm", variant: "timer", payload: { label: "Morning brief", trigger_id: "w-brief", scheduled_fire_at: at(8, 0) } }),
  {
    id: "a-brief", role: "assistant", createdAt: at(8, 1), metadata: titled("Wrote this morning's brief"),
    parts: [program("b-read", "await brief.gather(['mail', 'github', 'cloudflare']);", "14 messages, 9 issues, 2 deploys", {}), ...said(BRIEF)],
  },
  drained("ev-mail", ago(30), {
    ...EVENT, id: "ev-mail-priya", ingress: "email_inbound", variant: "email",
    payload: {
      from: "priya@cloudflare.com", to: "ashish@kinu.run", subject: "Dynamic Workers demo on Thursday?", body_text: "Could you show the Kinu Dynamic Workers flow to the team this week?",
      message_id: null, in_reply_to: null, references: null, attachments: [],
    },
  }),
  {
    id: "a-mail", role: "assistant", createdAt: ago(29), metadata: titled("Drafted a reply to Priya"),
    parts: [program("m-draft", "await mail.draft({ to: 'priya@cloudflare.com', subject: 'Re: Dynamic Workers demo on Thursday?' });", "draft saved", { "mail.saveDraft": 1 }), ...said("Priya asked for the Dynamic Workers demo this week. I drafted a reply offering Thursday at 16:00, after your release review, with the demo in three parts: a Worker built from chat, the slate it ships, and its logs read back. It's in your Drafts.")],
  },
  { id: "u-release", role: "user", createdAt: ago(4), parts: said("Make it 16:30. And start a workspace for the API Worker v2 release: cut the release branch, write the notes from the merged PRs, and get staging green.") },
  {
    id: "a-release", role: "assistant", createdAt: ago(3), metadata: titled("Started API Worker v2 release"),
    parts: [program("r-start", "await agent.createWorkspace({ title: 'API Worker v2 release' }); await mail.draft({ at: '16:30' });", "started api-worker-v2-release", { "agent.createWorkspace": 1, "mail.saveDraft": 1 }), ...said("The draft says 16:30 now; it's yours to send from Drafts.\n\nI started **API Worker v2 release**, a workspace of its own, so its branch, logs and approvals stay there and this chat stays yours. It's cutting release/v2 from main now and writing the notes from the PRs merged since v1.9. It asks you before deploying to production, and I'll check on it in each brief.")],
  },
];

const GENESIS = workspaceGenesisSignal("Be Ashish's personal assistant: read his mail, GitHub and Cloudflare, brief him each morning, and run larger work in workspaces of their own.");

const FIRST_RUN_THREAD: Message[] = [
  { id: "genesis", role: "user", createdAt: NOW - 2 * MIN, metadata: { kinuEvent: GENESIS?.kind ?? "", signalId: "sig-genesis" }, parts: said(GENESIS?.text ?? "") },
  {
    id: "a-hello", role: "assistant", createdAt: NOW - MIN, parts: said(`Hi Ashish, I'm Kinu. I'll keep your days moving: I read your mail, GitHub and Cloudflare, brief you each morning at 8:00, and run anything bigger in a workspace of its own that I check on for you.

**What I can reach**
- **Mail**: ashish@kinu.run comes to me, and I read the Gmail you connected. I draft; you send.
- **GitHub**: kinu-run's repositories, your reviews and mentions. I read; anything I'd write waits for you.
- **Cloudflare**: kinu-run's Workers, their errors and deploys, read-only.

**Where I'd start**
1. Triage the 23 open issues on kinu-run/kinu, label them, and draft answers for the easy ones.
2. Watch the API Worker's production logs and tell you when 5xx passes 1% for five minutes.
3. Write up what changed in Durable Objects SQLite storage this month, and what it means for Kinu.

Say a number, or tell me what's on your mind. Your first brief arrives tomorrow at 8:00.`),
  },
];

/** The assistant's own snapshot: Kinu, in the focus layout, on the brief it was given. */
function assistantSnapshot(snapshot: JsonObject): JsonObject {
  const status = v.parse(JsonObjectSchema, snapshot.status);
  const chat = v.parse(JsonObjectSchema, snapshot.chat);
  const mission = "Ashish's personal assistant: his mail, GitHub and Cloudflare, a brief each morning, and larger work in workspaces of its own.";

  return {
    ...snapshot,
    status: { ...status, name: ASSISTANT_WORKSPACE, displayName: "Kinu", purpose: mission, soul: `# Kinu\n\n## Mission\n${mission}\n`, layout: "focus" },
    chat: { ...chat, name: ASSISTANT_WORKSPACE, displayName: "Kinu", mission, activePlan: null, messageCount: MOMENT === "firstrun" ? 2 : 41 },
  };
}

/** The assistant's chat as its pages read it: its rows ending before the cursor, `limit` of them, oldest first. */
function historyPage(args: readonly unknown[] | undefined): JsonValue {
  const asked = v.parse(PositionPageRequestSchema, args?.[0] ?? {});

  const rows = ASSISTANT_THREAD.map((message, position) => {
    const createdAt = message.createdAt ?? NOW;

    // As the server pages a stored row: its time is the row's field and its drawn message's metadata both.
    return {
      id: message.id, position, role: message.role, turnId: null, parts: v.parse(v.array(JsonObjectSchema), message.parts), createdAt,
      metadata: { ...v.parse(v.optional(JsonObjectSchema, {}), message.metadata), [RECORDED_AT_METADATA_KEY]: createdAt },
    } satisfies ChatHistoryEntry;
  });

  const end = asked.cursor?.before ?? rows.length;
  const start = Math.max(0, end - (asked.limit ?? rows.length));
  const items = rows.slice(start, end);

  return start > 0 ? { status: "more", items, next: { before: start } } : { status: "end", items };
}

/** The workspace's own answers over the gallery's, as the assistant's Durable Object would give them. */
export function assistantRpc(base: SocketCall): SocketCall {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const answer = (value: JsonValue) => new Response(JSON.stringify(value)).json<T>();

    if (method === "getWorkspaceSnapshot") return answer(assistantSnapshot(v.parse(JsonObjectSchema, await base<JsonValue>(method, args))));

    if (method === "listWorkspaceAgents") return answer(v.parse(v.array(JsonObjectSchema), [mainPanelAgent({ label: "Kinu", activity: "idle", actorId: `actor-${ASSISTANT_WORKSPACE}` })]));

    if (method === "listTriggers") return answer({ triggers: WATCHES });

    if (method === "getChatHistoryPage") return answer(historyPage(args));

    // It asks nothing of its own: it creates workspaces itself, and only an external or cross-tenant step would ask.
    if (method === "listPendingActions" || method === "listSubagents" || method === "listBackgroundJobs" || method === "inspectWork") return answer([]);

    return base<T>(method, args);
  };
}

/** API Worker in the focus layout: the workspace the gallery's other frames show, its chat alone. */
function focusRpc(base: SocketCall): SocketCall {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method !== "getWorkspaceSnapshot") return base<T>(method, args);
    const snapshot = v.parse(JsonObjectSchema, await base<JsonValue>(method, args));

    return new Response(JSON.stringify({ ...snapshot, status: { ...v.parse(JsonObjectSchema, snapshot.status), layout: "focus" } })).json<T>();
  };
}

/** Home: the assistant's chat in the focus layout, with nothing above it. The brief arrives as a message in it, and the
 *  bar's line is the product's own, from the watches above. */
export function AssistantHome() {
  return <WorkspacePage workspace={ASSISTANT_WORKSPACE} />;
}

/** Home with the assistant installed, in the product's own shell. */
/** The assistant's chat as the frame's moment has it. */
export const ASSISTANT_THREAD = MOMENT === "firstrun" ? FIRST_RUN_THREAD : MORNING_THREAD;

export function assistantHomeFrame(base: SocketCall) {
  serveGalleryRpc(assistantRpc(base));
  seedGalleryChat(ASSISTANT_THREAD);

  return {
    entries: [new URLSearchParams(location.search).get("at") ?? APP_ROUTES.home],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<AssistantHome />} />
          <Route path="/workspace/:agentId/:view" element={<WorkspacePage />} />
          <Route path="*" element={<div className="h-full" data-gallery-blank />} />
        </Route>
      </Routes>
    ),
  };
}

/** A workspace in the focus layout, in the product's own shell. */
export function focusWorkspaceFrame(base: SocketCall, workspace: string) {
  serveGalleryRpc(focusRpc(base));

  return {
    entries: [`/workspace/${workspace}`],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/workspace/:agentId" element={<WorkspacePage />} />
          <Route path="/workspace/:agentId/agents/:subName" element={<WorkspacePage />} />
          <Route path="/workspace/:agentId/:view" element={<WorkspacePage />} />
          <Route path="*" element={<div className="h-full" data-gallery-blank />} />
        </Route>
      </Routes>
    ),
  };
}
