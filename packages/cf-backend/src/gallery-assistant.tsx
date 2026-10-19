/**
 * The personal assistant in the gallery: Home with it installed (`assistant-home`, `&moment=firstrun` for the first
 * minute after setup, `&today=<tile>` with a tile open), and any workspace in the focus layout (`focus-workspace`).
 * The pages are the product's own: Layout, WorkspacePage over the gallery's socket, AttentionStack in the composer;
 * only the reads are answered here. `&roster=assistant` gives the sidebar the workspaces the assistant runs.
 */
import { Route, Routes } from "react-router-dom";
import { CloudIcon, EnvelopeSimpleIcon, GithubLogoIcon, SunHorizonIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import type { UIMessage } from "ai";
import {
  APP_ROUTES, buildDrainBatch, mainPanelAgent, workspaceGenesisSignal,
  type JsonObject, type JsonValue, type KinuEvent, type PendingAction, type RosterEntry, type WorkspaceOverview,
} from "@kinu.run/core";
import { JsonObjectSchema } from "@kinu.run/core";
import Layout from "@/components/layout";
import WorkspacePage from "@/pages/WorkspacePage";
import { Today, whenNext, type TodayTile, type Watch } from "@/components/assistant/Today";
import type { ImportantMail } from "@/lib/mail-api";
import { seedGalleryChat, serveGalleryRpc } from "@/gallery-agent-stub";
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

export const ASSISTANT_WORKSPACE = "personal-assistant";

const MOMENT = v.parse(v.picklist(["morning", "firstrun"]), query.get("moment") ?? "morning");

const overview = (o: Partial<WorkspaceOverview> & Pick<WorkspaceOverview, "activity">): WorkspaceOverview => ({
  decisionsWaiting: 0, hasUpdates: false, awaitsSettings: false, latestRun: null, slates: [], shares: [], plan: null, ...o,
});

const entry = (name: string, displayName: string, visited: number, o: WorkspaceOverview | null): RosterEntry => ({
  name, displayName, createdAt: NOW - 20 * 864e5, lastVisited: NOW - visited, overview: o, decisions: o?.decisionsWaiting ?? 0, logo: null,
});

/** The owner's workspaces as the assistant sees them on a Monday morning: two it runs, one waiting on a deploy. */
export const ASSISTANT_ROSTER: RosterEntry[] = [
  entry("api-worker", "API Worker", 12 * MIN, overview({
    activity: "idle", decisionsWaiting: 1,
    latestRun: { status: "completed", task: "Read the sessions database as SESSIONS_DB, then deploy", run: null },
    plan: { title: "Read the sessions database as SESSIONS_DB", done: 4, total: 5 },
  })),
  entry("kinu-issues", "Issue triage · kinu-run/kinu", 40 * MIN, overview({
    activity: "working",
    latestRun: { status: null, task: "Label this week's issues and answer the easy ones", run: null },
    plan: { title: "Label this week's issues and answer the easy ones", done: 9, total: 14 },
  })),
  entry("do-sqlite", "Durable Objects SQLite report", 9 * HOUR, overview({
    activity: "idle",
    latestRun: { status: "completed", task: "What changed in Durable Objects SQLite storage this month", run: null },
    plan: { title: "What changed in Durable Objects SQLite storage this month", done: 6, total: 6 },
  })),
  entry("kinu-website", "Kinu website", 2 * 864e5, overview({
    activity: "idle", latestRun: { status: "error", task: "Lighthouse check of kinu.run before the release", run: null },
  })),
  entry("router-firmware", "Router firmware in Ghidra", 4 * 864e5, overview({
    activity: "unfinished", latestRun: { status: "completed", task: "Map the update routine's signature check", run: null },
  })),
];

/** The ones the assistant made and checks on. */
const GOALS = MOMENT === "firstrun" ? [] : ["kinu-issues", "api-worker", "do-sqlite"];

const MAIL: readonly ImportantMail[] = [
  {
    thread: "t-dw-demo", from: { name: "Priya Shah", address: "priya@cloudflare.com" }, to: "ashish@kinu.run",
    subject: "Dynamic Workers demo on Thursday?", reason: "Asks for a demo this week, and the release review is the only thing you said you'd do Thursday.", at: ago(31), unread: true,
  },
  {
    thread: "t-gh-4120", from: { name: "GitHub", address: "notifications@github.com" }, to: "ashish@kinu.run",
    subject: "[kinu-run/kinu] Review requested: Web search chain (#4120)", reason: "You are the only reviewer, and the release waits on it.", at: at(6, 31), unread: true,
  },
  {
    thread: "t-cf-quota", from: { name: "Cloudflare", address: "noreply@notify.cloudflare.com" }, to: "ashish@kinu.run",
    subject: "Workers Paid: kinu-staging is at 82% of its Durable Objects storage", reason: "Staging fills up by Friday at this week's rate.", at: at(5, 2), unread: false,
  },
];

const WATCHING: readonly Watch[] = [
  {
    id: "w-brief", label: "Morning brief", what: "weekdays", icon: <SunHorizonIcon size={13} />,
    found: MOMENT === "firstrun" ? null : "Sent at 8:00: 2 waiting on you, 3 important.", last: MOMENT === "firstrun" ? null : at(8, 0), next: at(8, 0) + 864e5,
  },
  {
    id: "w-github", label: "GitHub", what: "kinu-run/kinu reviews and mentions", icon: <GithubLogoIcon size={13} />,
    found: MOMENT === "firstrun" ? null : "1 review requested, 3 mentions in issues.", last: MOMENT === "firstrun" ? null : ago(9), next: NOW + 6 * MIN,
  },
  {
    id: "w-mail", label: "Mail", what: "ashish@kinu.run and Gmail", icon: <EnvelopeSimpleIcon size={13} />,
    found: MOMENT === "firstrun" ? null : "14 since yesterday, 3 important.", last: MOMENT === "firstrun" ? null : ago(30), next: null,
  },
  {
    id: "w-cloudflare", label: "Cloudflare", what: "kinu-run's Workers: errors and deploys", icon: <CloudIcon size={13} />,
    found: MOMENT === "firstrun" ? null : "api-worker 5xx at 0.02%; kinu-staging deployed at 07:40.", last: MOMENT === "firstrun" ? null : ago(4), next: NOW + 6 * MIN,
  },
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

const BRIEF = `Good morning, Ashish. Two things wait on you, and the rest moved overnight.

**Waiting on you**
- **API Worker** has the \`SESSIONS_DB\` fix on staging: 2,140 requests since 06:10, no 500s. It wants to deploy to production; the approval is in its chat.
- **#4120 Web search chain** on kinu-run/kinu needs your review. CI is green; it is 1,182 lines, mostly the provider registry.

**Mail**: three Important. Priya Shah wants a Dynamic Workers demo this week; Thursday afternoon has nothing on it in your mail.

**Overnight**
- Issue triage labelled 9 new issues on kinu-run/kinu and answered 4. Two need you: a crash report from a CLI on Windows, and a request for Ghidra MCP support.
- The Durable Objects SQLite report is done: 11 changes this month, 3 that touch Kinu.
- Kinu website's Lighthouse check failed at 03:10: LCP is 3.9 s on /pricing.
- On Cloudflare, api-worker's 5xx rate held at 0.02% and kinu-staging deployed at 07:40.`;

const MORNING_THREAD: Message[] = [
  { id: "y-u1", role: "user", createdAt: at(18, 4) - 864e5, parts: said("Keep an eye on #4120 overnight and tell me in the morning if CI goes red.") },
  { id: "y-a1", role: "assistant", createdAt: at(18, 5) - 864e5, parts: said("Will do. I'll check it with the GitHub watch every 15 minutes and put it in tomorrow's brief.") },
  drained("ev-brief", at(8, 0), { ...EVENT, id: "ev-timer-brief", ingress: "timer_alarm", variant: "timer", payload: { label: "Morning brief", trigger_id: "w-brief", scheduled_fire_at: at(8, 0) } }),
  { id: "a-brief", role: "assistant", createdAt: at(8, 1), parts: said(BRIEF) },
  drained("ev-mail", ago(30), {
    ...EVENT, id: "ev-mail-priya", ingress: "email_inbound", variant: "email",
    payload: {
      from: "priya@cloudflare.com", to: "ashish@kinu.run", subject: "Dynamic Workers demo on Thursday?", body_text: "Could you show the Kinu Dynamic Workers flow to the team this week?",
      message_id: null, in_reply_to: null, references: null, attachments: [],
    },
  }),
  { id: "a-mail", role: "assistant", createdAt: ago(29), parts: said("Priya asked for the Dynamic Workers demo this week. I drafted a reply offering Thursday at 16:00, after your release review, with the demo in three parts: a Worker built from chat, the slate it ships, and its logs read back. It's in your Drafts.") },
  { id: "u-release", role: "user", createdAt: ago(4), parts: said("Make it 16:30. And start a workspace for the API Worker v2 release: cut the release branch, write the notes from the merged PRs, and get staging green.") },
  { id: "a-release", role: "assistant", createdAt: ago(3), parts: said("The draft says 16:30 now; it's yours to send from Drafts.\n\nThe release gets a workspace of its own, so its branch, logs and approvals stay there and this chat stays yours. I proposed it below: what it is for, the repository and Worker it may touch, and that it asks you before deploying to production. Once you create it I'll start it, and check on it in each brief.") },
];

const GENESIS = workspaceGenesisSignal("Be Ashish's personal assistant: read his mail, GitHub and Cloudflare, brief him each morning, and run larger work in workspaces of their own.");

const FIRST_RUN_THREAD: Message[] = [
  { id: "genesis", role: "user", createdAt: NOW - 2 * MIN, metadata: { kinuEvent: GENESIS?.kind ?? "", signalId: "sig-genesis" }, parts: said(GENESIS?.text ?? "") },
  {
    id: "a-hello", role: "assistant", createdAt: NOW - MIN, parts: said(`Hi Ashish, I'm Kinu. I'll keep your days moving: I read your mail, GitHub and Cloudflare, brief you each weekday at 8:00, and run anything bigger in a workspace of its own that I check on for you.

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

const ASKS: PendingAction[] = MOMENT === "firstrun" ? [] : [
  {
    id: "proposal-v2", kind: "workspace_proposal", title: "Create workspace “API Worker v2 release”", at: ago(3),
    detail: "Cut release/v2 from main, write the notes from the PRs merged since v1.9, and get staging green. Asks before deploying to production.",
    proposal: {
      name: "API Worker v2 release",
      brief: "Cut release/v2, write the notes from the merged PRs, get staging green.",
      soul: "# API Worker v2 release\n\n## Mission\nShip v2 of the api Worker: cut release/v2 from main in kinu-run/api-worker, write the release notes from every PR merged since v1.9, and get staging green with `wrangler deploy --env staging`.\n\nAsk Ashish before deploying to production. Report each morning to his assistant.",
    },
  },
];

/** The assistant's own snapshot: Kinu, in the focus layout, on the brief it was given. */
function assistantSnapshot(snapshot: JsonObject): JsonObject {
  const status = v.parse(JsonObjectSchema, snapshot.status);
  const chat = v.parse(JsonObjectSchema, snapshot.chat);
  const mission = "Ashish's personal assistant: his mail, GitHub and Cloudflare, a brief each morning, and larger work in workspaces of its own.";

  return {
    ...snapshot,
    status: { ...status, name: ASSISTANT_WORKSPACE, displayName: "Personal assistant", purpose: mission, soul: `# Kinu\n\n## Mission\n${mission}\n`, layout: "focus" },
    chat: { ...chat, name: ASSISTANT_WORKSPACE, displayName: "Kinu", mission, activePlan: null, messageCount: MOMENT === "firstrun" ? 2 : 41 },
  };
}

/** The workspace's own answers over the gallery's, as the assistant's Durable Object would give them. */
function assistantRpc(base: SocketCall): SocketCall {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const answer = (value: JsonValue) => new Response(JSON.stringify(value)).json<T>();

    if (method === "getWorkspaceSnapshot") return answer(assistantSnapshot(v.parse(JsonObjectSchema, await base<JsonValue>(method, args))));

    if (method === "listPendingActions") return answer(v.parse(v.array(JsonObjectSchema), ASKS));

    if (method === "listWorkspaceAgents") return answer(v.parse(v.array(JsonObjectSchema), [mainPanelAgent({ label: "Kinu", activity: "idle", actorId: `actor-${ASSISTANT_WORKSPACE}` })]));

    if (method === "listSubordinates" || method === "listBackgroundJobs" || method === "inspectWork") return answer([]);

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

/** The part of the day it is, as a greeting. */
function greetingOf(now: number): string {
  const hour = new Date(now).getHours();

  if (hour < 12) return "Good morning";

  return hour < 18 ? "Good afternoon" : "Good evening";
}

/** What the bar says of Kinu: what it watches, and when it next speaks up. */
function AssistantLine() {
  const brief = WATCHING.find((watch) => watch.id === "w-brief");

  return <>Watching {WATCHING.length}{brief?.next !== null && brief?.next !== undefined && <> · brief {whenNext(brief.next, NOW)}</>}</>;
}

function AssistantHome() {
  const opened = v.parse(v.nullable(v.picklist(["needs", "mail", "workspaces", "watching"])), query.get("today")) satisfies TodayTile | null;

  return (
    <WorkspacePage workspace={ASSISTANT_WORKSPACE} identity={{ label: "Kinu", line: <AssistantLine /> }}
      above={(
        <Today now={NOW} assistant="Kinu" greeting={MOMENT === "firstrun" ? "Welcome, Ashish" : `${greetingOf(NOW)}, Ashish`} opened={opened}
          own={ASKS.map((ask) => ({ title: ask.title, detail: ask.detail, glance: ask.proposal === undefined ? ask.title : `New: ${ask.proposal.name}` }))}
          roster={MOMENT === "firstrun" ? [] : ASSISTANT_ROSTER} goals={GOALS}
          mail={MOMENT === "firstrun" ? { unread: 0, items: [] } : { unread: MAIL.filter((mail) => mail.unread).length, items: MAIL }}
          watching={WATCHING} />
      )} />
  );
}

/** Home with the assistant installed, in the product's own shell. */
export function assistantHomeFrame(base: SocketCall) {
  serveGalleryRpc(assistantRpc(base));
  seedGalleryChat(MOMENT === "firstrun" ? FIRST_RUN_THREAD : MORNING_THREAD);

  return {
    entries: [APP_ROUTES.home],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<AssistantHome />} />
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
