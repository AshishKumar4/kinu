/** The gallery's fixed data: the values its frames and stubs read, with nothing of their own to run. */
import type { TerminalSession } from "@kinu.run/devbox";
import { type TurnLiveness, type WorkspaceEntry } from "@kinu.run/core";
import { taskReminderOf } from "@kinu.run/core";
import { CHECKPOINTS_NO_DEVICE, CHECKPOINTS_UNAVAILABLE_NO_GIT, sanitizeWorkspaceLogoSvg } from "@kinu.run/core";
import { type WorkspaceOverview } from "@kinu.run/core";
import type { OwnedLiveShare } from "@kinu.run/core";
import { type AgentStatus, type KinuEvent, type PlanReview, type ReviewAnnotation } from "@kinu.run/core";
import type { ForkNode } from "@kinu.run/core";
import type { BackgroundJob, SubagentView } from "@kinu.run/core/protocol";
import { type MctsRow } from "@kinu.run/core";
import type { ExecutorInfo } from "@kinu.run/core";
import type { FileCheckpointEntry, FileCheckpointListing, ForkRunParams, HeadRunView, EnvironmentInfo, AccountSpend, ChangelogEntry, PendingAction, PendingDeviceConsent } from "@kinu.run/core";
import * as v from "valibot";

/** The two liveness values a static frame photographs. */
export const IDLE_TURN: TurnLiveness = { kind: "idle" };

export const frame = new URLSearchParams(location.search).get("frame") ?? "all";

/** `&env=computer`: the workspace shell with its computer up, so Environment shows its terminal and its desktop. */
export const SHELL_COMPUTER = (frame === "workspaceshell" || frame === "whole") && new URLSearchParams(location.search).get("env") === "computer";

/** The owner's PC in the Environment frames: the account's device row that `ENVIRONMENT_EXECUTORS`' device names. */
export const GALLERY_PC = { id: "dev-mac", label: "Ashish's MacBook" };

/** `&pc=granted|ungranted|offline`: the owner's account holds a PC, which this workspace holds or not (EnvironmentMachines). */
export const SHELL_PC = frame === "workspaceshell" || frame === "whole" ? new URLSearchParams(location.search).get("pc") : null;

/** The shell's machines under `&env=computer` or `&pc=`, as `listMounts` and the snapshot's executors answer them. */
export const SHELL_MACHINES = {
  mounts: [
    { name: "workspace", prefix: "workspace.*", live: true, policy: { readOnly: false, consistency: "durable" }, reason: null },
    { name: "computer", prefix: "computer.*", live: true, policy: { readOnly: false, consistency: "ephemeral" }, reason: null },
    ...(SHELL_PC === null ? [] : [{ name: "device", prefix: "device.*", live: SHELL_PC !== "offline", policy: { readOnly: false, consistency: "live-shared" }, reason: null } satisfies EnvironmentInfo]),
  ],
  executors: [
    ...(SHELL_PC === null ? [] : [{
      name: "device", kind: "device", available: SHELL_PC !== "offline", configured: true, active: SHELL_PC !== "offline", status: "active", label: GALLERY_PC.label,
      capabilities: ["shell", "npm", "git", "fs_owned", "process_spawn"],
    } satisfies ExecutorInfo]),
    {
      name: "computer", kind: "computer", available: true, configured: true, active: true, status: "active",
      capabilities: ["shell", "npm", "git", "fs_owned", "net_inbound", "process_long"],
    },
    {
      name: "workspace", kind: "workspace", available: true, configured: true, active: true, status: "active",
      capabilities: ["javascript", "typescript", "python", "shell", "npm", "fs_shared"],
    },
  ],
} satisfies { readonly mounts: EnvironmentInfo[]; readonly executors: ExecutorInfo[] };

export const NOW = Date.now();

const ROSTER = new URLSearchParams(location.search).get("roster") ?? "stock";

const STOCK_ROSTER = {
  entries: [
    { name: "api-worker", displayName: new URLSearchParams(location.search).get("frame") === "coderendering"
      ? "Investigate intermittent 500s after the sessions binding rename and verify the release on staging"
      : "API Worker", createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3 },
    { name: "perf-audit", displayName: "Dew", createdAt: NOW - 3 * 864e5, lastVisited: NOW - 2 * 36e5 },
    { name: "email-triage", displayName: "Support inbox", createdAt: NOW - 30 * 864e5, lastVisited: NOW - 864e5 },
    { name: "design-sys", displayName: "Kinu website", createdAt: NOW - 864e5, lastVisited: NOW - 5 * 864e5 },
    // First-run row: titled by its first prompt, so it has no title yet, only its slug.
    { name: "handwrought-walnut-4166c321", displayName: "", createdAt: NOW - 60e3, lastVisited: NOW - 30e3 },
  ],
  total: 5,
};

// Selected once so the profile's workspaceCount matches the list endpoint; the gate reads both.
export const GALLERY_ROSTER: { entries: WorkspaceEntry[]; total: number } =
    ROSTER === "empty" ? { entries: [], total: 0 }
  : STOCK_ROSTER;

/** `&snapshot=failed`: the workspace's first read fails, so nothing has loaded. */
export const SNAPSHOT_FAILS = new URLSearchParams(location.search).get("snapshot") === "failed";

/* One tile per card state; `gallery:overview` ({name, overview}) changes one and the roster socket carries it. */
export const STOCK_OVERVIEWS = new Map(Object.entries({
  "api-worker": { activity: "working", awaitsSettings: false, decisionsWaiting: 2, hasUpdates: false, latestRun: { status: "error", task: "Investigate intermittent 500s after the sessions binding rename", run: null }, slates: [{ id: "error-board", title: "Error board", picture: null, visibility: null }], shares: [] },
  "perf-audit": { activity: "working", awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: { status: null, task: "Make sync resume after a dropped connection", run: null }, slates: [], shares: [] },
  "email-triage": { activity: "idle", awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: { status: "completed", task: "Answer this week's refund requests", run: null }, slates: [], shares: [] },
  "design-sys": { activity: "unfinished", awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: { status: "error", task: "Kinu website", run: null }, slates: [], shares: [] },
  "handwrought-walnut-4166c321": { activity: "idle", awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [], shares: [] },
  "audit-sweep": { activity: "unfinished", awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: { status: "completed", task: "Recount the quarter's shares against the register", run: null }, slates: [], shares: [] },
} satisfies Record<string, WorkspaceOverview>));

/** A sixth entry whose last run is quiet, so 'Unfinished' can headline; the home roster's pins keep it off the stock five. */
export const EXTRA_WORKSPACE = new URLSearchParams(location.search).get("extraWorkspace") === "1";

export const GALLERY_LOGO = sanitizeWorkspaceLogoSvg(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='a' x1='0' y1='0' x2='1' y2"
  + "='1'><stop offset='0' stop-color='#2dd4bf'/><stop offset='1' stop-color='#0f766e'/></linearGradient><linearGradi"
  + "ent id='b' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#fcd34d'/><stop offset='1' stop-color='#d977"
  + "06'/></linearGradient></defs><rect x='4' y='8' width='56' height='12' rx='6' fill='url(#a)'/><g><animateTransfor"
  + "m attributeName='transform' type='translate' values='0 -2;0 8;0 -2' dur='4s' repeatCount='indefinite' calcMode='"
  + "spline' keySplines='.45 0 .55 1;.45 0 .55 1'/><path d='M12 14h40v40a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4z' fill='#f8fa"
  + "fc' stroke='#0f766e' stroke-width='3'/><rect x='18' y='24' width='28' height='5' rx='2.5' fill='#94a3b8'/><rect "
  + "x='18' y='33' width='18' height='5' rx='2.5' fill='#94a3b8'/><circle cx='42' cy='46' r='7' fill='url(#b)'><anima"
  + "te attributeName='r' values='6;7.5;6' dur='4s' repeatCount='indefinite'/></circle></g><rect x='4' y='8' width='5"
  + "6' height='7' rx='3.5' fill='#115e59'/></svg>",
);

// The whole app opens on the assistant's account unless `&roster=` names another.
export const ROSTER_ASKED = new URLSearchParams(location.search).get("roster") ?? (frame === "whole" ? "assistant" : null);

// Stands in for the runtime's terminal facet (core execution/workspace-terminal.ts): echoes input, runs a line at CR,
// ends output lines with CR LF like the runtime's `writeln`, and keeps every `input` frame for the gate.

export const PROMPT = "$ ";

/** A prompt as the computer's shell draws it: the box shown by its workspace's name (D93), the folder in blue. */
const COMPUTER_PROMPT = "\x1b[01;32mroot@api-worker\x1b[00m:\x1b[01;34m/workspace/api-worker\x1b[00m# ";

/**
 * What each of the computer's sessions shows when it is opened (`GALLERY_SESSIONS`), and a PC's shell: the screens a
 * person meets, so a frame shows its terminal as it is used rather than empty.
 */
export const PTY_SCREENS = {
  shell: [
    `${COMPUTER_PROMPT}git status`,
    "On branch main",
    "Your branch is up to date with 'origin/main'.",
    "",
    "Changes not staged for commit:",
    "  \x1b[31mmodified:   workers/api/src/db.ts\x1b[0m",
    "",
    `${COMPUTER_PROMPT}`,
  ].join("\r\n"),
  s2: [
    `${COMPUTER_PROMPT}npm run dev`,
    "",
    "> api@0.4.0 dev",
    "> vite",
    "",
    "  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.8\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m412\x1b[22m\x1b[2m ms\x1b[22m",
    "",
    "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m",
    "  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m",
    "\x1b[2m10:41:07\x1b[22m \x1b[36m\x1b[1m[vite]\x1b[22m\x1b[39m \x1b[32mhmr update \x1b[39m\x1b[2m/src/routes/health.ts\x1b[22m",
    "\x1b[2m10:42:31\x1b[22m \x1b[36m\x1b[1m[vite]\x1b[22m\x1b[39m \x1b[32mpage reload \x1b[39m\x1b[2msrc/db.ts\x1b[22m",
    "",
  ].join("\r\n"),
  s3: [
    `${COMPUTER_PROMPT}npx vitest run src/routes`,
    "",
    " \x1b[7m\x1b[1m\x1b[36m RUN \x1b[39m\x1b[22m\x1b[27m \x1b[36mv2.1.2 \x1b[39m\x1b[90m/workspace/api-worker\x1b[39m",
    "",
    " \x1b[32m✓\x1b[39m src/routes/users.test.ts \x1b[2m(6 tests)\x1b[22m \x1b[90m41\x1b[2mms\x1b[22m\x1b[39m",
    " \x1b[31m❯\x1b[39m src/routes/health.test.ts \x1b[2m(4 tests | \x1b[22m\x1b[31m1 failed\x1b[39m\x1b[2m)\x1b[22m \x1b[90m38\x1b[2mms\x1b[22m\x1b[39m",
    "   \x1b[31m×\x1b[39m reports the database as up",
    "     \x1b[31m→ expected 'down' to be 'up' // Object.is equality\x1b[39m",
    "",
    " \x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[90m (2)\x1b[39m",
    " \x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m9 passed\x1b[39m\x1b[22m\x1b[90m (10)\x1b[39m",
    " \x1b[2m   Duration \x1b[22m 1.12s",
    "",
    `${COMPUTER_PROMPT}`,
  ].join("\r\n"),
  "j-4f0c9a2e": [
    "\x1b[2m$ npm run deploy\x1b[0m",
    "",
    "> api@0.4.0 deploy",
    "> wrangler deploy --env production",
    "",
    " \x1b[33m⛅️ wrangler\x1b[39m 3.80.0",
    "\x1b[2m-------------------\x1b[22m",
    "Total Upload: 412.38 KiB / gzip: 96.12 KiB",
    "",
    "\x1b[33m?\x1b[39m \x1b[1mYou are about to deploy to production. Continue?\x1b[22m \x1b[2m(y/N)\x1b[22m ",
  ].join("\r\n"),
  device: "\x1b[1mashish@Ashishs-MacBook\x1b[0m api-worker % git pull\r\nAlready up to date.\r\n\x1b[1mashish@Ashishs-MacBook\x1b[0m api-worker % ",
} satisfies Record<string, string>;

/** A real swarm tree at the size the view must survive; rows, not a tree, so it enters through `buildTree` like the socket payload. */
export const MCTS_ACTIONS = [
  "Bind the sessions database under both names",
  "Read SESSIONS_DB in openDb, falling back to DB",
  "Fail by name when no binding is configured",
  "Roll the config back to the DB binding",
  "Move the webhook route onto openDb",
  "Redeploy staging with the new binding",
  "Read the binding once at the Worker's entry",
  "Answer the health check from a cached probe",
  "Guard the 500 with a try/catch and log",
  "Re-seed the sessions table on staging",
  "Split the rename into two deploys",
  "Tail production for reads of env.DB",
];

export const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();

export const NO_HEAD_ACTIVITY: ReadonlyMap<string, number> = new Map();

export const WORKSPACE_PAGE_NAME = new URLSearchParams(location.search).get("ws") ?? "api-worker";

/** The computer's sessions (D90) as its box keeps them: a shell, a dev server listening, a test run that failed. */
export const GALLERY_SESSIONS: TerminalSession[] = [
  { id: "shell", name: "shell", cwd: "/workspace/api-worker", open: true, running: null, last: { exit: 0, at: Date.now() - 20_000, command: "git status" }, ports: [], branch: "main", needsInput: false },
  { id: "s2", name: "dev server", cwd: "/workspace/api-worker", open: true, running: "node", last: null, ports: [5173], branch: "main", needsInput: false },
  { id: "s3", name: "tests", cwd: "/workspace/api-worker", open: true, running: null, last: { exit: 1, at: Date.now() - 70_000, command: "npx vitest run src/routes" }, ports: [], branch: "main", needsInput: false },
  // An agent's job (D95) at a prompt: it waits for the person, or for its agent, to answer.
  { id: "j-4f0c9a2e", name: "npm run deploy", cwd: "/workspace/api-worker", open: true, running: "node", last: null, ports: [], branch: "main", needsInput: true, job: "4f0c9a2e-77d1-4f5b-9a63-0b2f6f0e1c55" },
];

/** The workspace's terminals (1019-aa) as its Nimbus session lists them: its own shell and one opened beside it. */
export const GALLERY_WORKSPACE_SESSIONS: TerminalSession[] = [
  { id: "shell", name: "shell", cwd: "/home/main", open: true, running: null, last: null, ports: [], branch: null, needsInput: false },
  { id: "w-tests", name: "tests", cwd: "/home/main/app", open: true, running: "bun", last: null, ports: [], branch: null, needsInput: false },
];

/** The PC's sessions (1014-t) as its daemon lists them (1019-aa): its shell, a dev server on a port, and a deploy asking
 *  a question. Its daemon reads no last command: that needs the owner's shell rc. */
export const GALLERY_DEVICE_SESSIONS: TerminalSession[] = [
  { id: "pty-shell", name: "shell", cwd: "/Users/ashish/work/storefront", open: true, running: null, last: null, ports: [], branch: "main", needsInput: false },
  { id: "pty-build", name: "build", cwd: "/Users/ashish/work/storefront", open: true, running: "node", last: null, ports: [5173], branch: "main", needsInput: false },
  { id: "pty-deploy", name: "deploy", cwd: "/Users/ashish/work/storefront/infra", open: true, running: "npm", last: null, ports: [], branch: "main", needsInput: true },
];

/* `?createFails=1`: the first create rejects with a two-frame cause chain; the second succeeds. */
export const CREATE_FAILS = new URLSearchParams(location.search).get("createFails") === "1";

export const RENAME_FAILS = new URLSearchParams(location.search).get("renameFails") === "1";

/* The `workspacepage` frame's additional-agent roster, mutated by the real page; only the chat stays inert (`agentchats` covers send). */
export const GALLERY_SUBS: (SubagentView & { actorId: string })[] = [];

export const AGENTS_PANEL = new URLSearchParams(location.search).get("agents") === "panel";

/** `board=full`: Main's own tasks too, so the overview's board has a card in every lane, some with steps. */
export const BOARD_FULL = new URLSearchParams(location.search).get("board") === "full";

const GALLERY_PLAN_MARKDOWN = `# Read the sessions database as \`SESSIONS_DB\`

The api Worker fails every request that opens its database: yesterday's config renamed the D1 binding to \`SESSIONS_DB\`, but \`openDb\` still reads \`env.DB\`. This plan reads the database by its new name everywhere and keeps the health route's response.

## Scope

- Read the binding once, in \`openDb\`, by the name \`wrangler.jsonc\` gives it.
- Move every route that reads \`env.DB\` itself onto \`openDb\`.
- Keep \`/api/health\`'s response for the monitors that already poll it.

## Files

\`\`\`text
workers/
└── api/
    ├── wrangler.jsonc
    ├── src/
    │   ├── db.ts
    │   └── routes/webhooks.ts
    └── test/integration/sessions-binding.test.ts
\`\`\`

## Implementation

1. Read \`env.SESSIONS_DB\` in \`openDb\`, and fail with a clear error when the binding is missing.
2. Move \`routes/webhooks.ts\` onto \`openDb\`; it is the one route that reads the binding itself.
3. Leave the health route unchanged; it already reports what \`openDb\` answers.

## Verification

- Run the tests with the binding present and missing.
- Run \`wrangler dev\` and curl \`/api/health\` locally.
- Deploy to staging and watch \`wrangler tail\` for errors before production.

## Expected result

Every request opens the sessions database by its new binding, and \`/api/health\` answers \`ok\` with the database up.`;

/* `?plan=late-heading` (mid-document h1) and `?plan=annotated-heading` (anchor on the leading h1): the header must promote
   neither. `?plan=read-only` is a settled plan. `?plan=code-path` names a file and line inline, the text Plannotator's own
   inline renderer turns into a hover preview that fetches `/api/doc`. */
export const GALLERY_PLAN_VARIANT = new URLSearchParams(location.search).get("plan");

const GALLERY_PLAN_LATE_HEADING = `The config renamed the binding, so every request that still reads \`env.DB\` fails.

# Rejected: bind the database under both names

Binding it twice hides the rename and leaves the code reading a name the config no longer means.

## Scope

- Read the binding once, in \`openDb\`, by the name \`wrangler.jsonc\` gives it.`;

export const GALLERY_PLAN_TITLE_NOTE: ReviewAnnotation = {
  id: "gallery-plan-title-note",
  blockId: "block-0",
  startOffset: 0,
  endOffset: 10,
  type: "COMMENT",
  text: "Name the binding this reads.",
  originalText: "Read the s",
  createdA: NOW,
  author: "Owner",
};

const GALLERY_PLAN_CODE_PATH = `# Read the sessions database as \`SESSIONS_DB\`

Read the binding in \`workers/api/src/db.ts:12\` by the name the config gives it.

[Reference](https://example.test/reference) [Jump](#details) [Local](/readme.md) [Unsafe](javascript:alert(1))

4. First operation
5. Second operation

| Name | Value |
| --- | --- |
| Separator | alpha\\|beta |

\`\`\`mermaid
graph TD; A-->B
\`\`\`

![The binding, before and after](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)

<slate-ui name="binding-layout">
<div id="binding-layout">DB → SESSIONS_DB</div>
</slate-ui>

$$
\\frac{\\text{errors}}{\\text{requests}} \\le 0.001 \\quad \\href{javascript:alert(1)}{\\text{off}}
$$`;

const GALLERY_PLAN_CONTENTS = new Map([
  ["late-heading", GALLERY_PLAN_LATE_HEADING],
  ["code-path", GALLERY_PLAN_CODE_PATH],
]);

export const GALLERY_PLAN_CONTENT = GALLERY_PLAN_CONTENTS.get(GALLERY_PLAN_VARIANT ?? "") ?? GALLERY_PLAN_MARKDOWN;

/* A review the owner sent back: a comment on a passage and one on the whole plan, each answered by the agent. */
export const GALLERY_PLAN_THREAD: readonly ReviewAnnotation[] = [
  {
    id: "gallery-plan-scope", type: "COMMENT", blockId: "block-1", startOffset: 0, endOffset: 64, author: "Owner",
    originalText: "The api Worker fails every request that opens its database: yest",
    text: "Does this also cover the cron trigger, which opens the database outside a request?", createdA: NOW - 20 * 60e3,
  },
  { id: "gallery-plan-all", type: "GLOBAL_COMMENT", text: "Split the webhook change into its own step so it can ship later.", author: "Owner", createdA: NOW - 19 * 60e3 },
  {
    id: "gallery-plan-reply-scope", type: "REPLY", inReplyTo: "gallery-plan-scope", author: "agent", createdA: NOW - 2 * 60e3,
    text: "Yes: the cron handler opens the database through `openDb` too, so it reads the new binding with the routes. The revision says so in Scope.",
  },
  {
    id: "gallery-plan-reply-all", type: "REPLY", inReplyTo: "gallery-plan-all", author: "agent", createdA: NOW - 60e3,
    text: "The webhook route only moves onto `openDb`, so there is no step of its own to split; the revision folds it into Implementation.",
  },
];

export const GALLERY_PLAN_STATUS: PlanReview["status"] = new Map<string | null, PlanReview["status"]>([
  ["read-only", "superseded"],
  ["replied", "changes_requested"],
]).get(GALLERY_PLAN_VARIANT) ?? "pending";

const REVERT_CHECKPOINTS = new URLSearchParams(location.search).get("checkpoints");

export const REVERT_CHECKPOINT: FileCheckpointEntry = {
  id: "c0ffee1", dir: "/pc/ashish-device/work/api-worker", at: NOW - 6 * 60e3,
  turnId: "rv-u2", sessionId: "default", reason: "before turn",
};

/** Separate facts: an unreachable store says nothing about what a turn changed. */
const REVERT_LISTINGS = new Map<string | null, FileCheckpointListing>([
  ["1", { availability: { available: true }, entries: [REVERT_CHECKPOINT] }],
  ["none", { availability: { available: true }, entries: [] }],
  ["nogit", { availability: { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT }, entries: [] }],
]);

export const REVERT_LISTING: FileCheckpointListing = REVERT_LISTINGS.get(REVERT_CHECKPOINTS)
  ?? { availability: { available: false, reason: CHECKPOINTS_NO_DEVICE }, entries: [] };

/** The owner's reminder as core writes it: its text the agent's, its open task's title the card's. */
export const OWNER_REMINDER = taskReminderOf({
  open: { items: [{ id: "t1", parentId: null, title: "Store the full export in account-level memory", status: "open", updatedAt: 0, note: null, subtasks: [] }], total: 1 },
  state: "1-gallery", assistantText: "The export is in exports/settings.json.", workMode: "build", completed: true, resultOwed: false,
});

/** The pages the person kept, as `/slates` would list them. */
export const GALLERY_KEPT_PAGES: { id: string; title: string }[] = [];

/** What the workspace's agent asked its owner: a single choice with previews, and a multiple choice. */
export const GALLERY_ASK = {
  questions: [
    {
      id: "storage", header: "Binding", question: "How should the Worker read its database once the fix lands?", recommended: 0,
      options: [
        { label: "Fall back to DB", description: "Reads either name until every environment redeploys.", preview: "return env.SESSIONS_DB ?? env.DB;\n// staging keeps answering before it redeploys" },
        { label: "New name only", description: "Fails loudly wherever an environment still binds DB.", preview: "return env.SESSIONS_DB;\n// staging 500s until it redeploys" },
        { label: "Bind both names", description: "No code change; both names stay in the config.", preview: "\"d1_databases\": [\n  { \"binding\": \"DB\" },\n  { \"binding\": \"SESSIONS_DB\" }\n]" },
      ],
    },
    {
      id: "checks", header: "Checks", question: "Which checks should run before the staging deploy?", multi: true,
      options: [
        { label: "Health check", description: "Curl /api/health and read the database's state." },
        { label: "Session reads", description: "Sign in, then read the session back." },
        { label: "Old deployments", description: "A Worker still on the old binding still answers." },
      ],
    },
  ],
};

/* `&takes=3`: the revert thread's last answer ran beside two branched redirects, so there is a choice to compare;
   `&takes=1`: a set with one take, which offers nothing to compare. A pick is recorded and the set comes back with it. */
export const TAKE_COUNT = Number(new URLSearchParams(location.search).get("takes") ?? 0);

/* `&annotationSaves=held`: each annotation save waits for `gallery:annotation-save`; `=fail-first`: the first one is
   refused. Each landed save's comments are kept on the page, with the most that were ever in flight at once. */
export const ANNOTATION_SAVES = new URLSearchParams(location.search).get("annotationSaves");

/* `&history=N&historyLatency=ms`: N older rows, paged; `&historyHold=1` waits for `gallery:release-page`. */
export const HISTORY_ROWS = Number(new URLSearchParams(location.search).get("history") ?? 0);

export const HISTORY_LATENCY_MS = Number(new URLSearchParams(location.search).get("historyLatency") ?? 250);

export const HISTORY_HELD = new URLSearchParams(location.search).get("historyHold") === "1";

/** `&historyUneven=1`: pages alternate row heights. */
export const HISTORY_UNEVEN = new URLSearchParams(location.search).get("historyUneven") === "1";

export const HISTORY_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="220"><rect width="480" height="220" fill="#3a3530"/><text x="24" y="120" fill="#e8dcc4" font-size="28">chart</text></svg>')}`;

export const NO_GALLERY_FIGURES = { activeMs: 0, cacheEma: null };

/** Main, the page's chats, and the fixture's agents when asked for. */
/** Whether `&jobs=running`'s job runs: a `gallery:jobs` event (`{ running }`) settles or starts it, and says so. */
export const JOBS_RUNNING = { at: true };

/** Agents a `gallery:agent-rested` event brought to rest (`{ key }`), as the next read of the list has them. */
export const RESTED_AGENTS = new Set<string>();

export const GALLERY_MAIN_TITLE = { value: "Main" };

/** Two commands one turn parked, as the workspace queue lists them: `&asks=two`. */
export const PARKED_ASKS: PendingAction[] = [
  { id: "park-push", kind: "deferred_action", title: "Approve: a command the agent wants to run on workspace", detail: "git push --force origin release", at: NOW - 90_000 },
  { id: "park-publish", kind: "deferred_action", title: "Approve: a command the agent wants to run on workspace", detail: "npm publish --access public", at: NOW - 30_000 },
];

/** A plan submitted after the page opened, newer than every other: it joins the queue on `gallery:arrive-ask`. */
export const LATE_ASKS: PendingAction[] = [{
  id: "plan-late", kind: "plan_review", title: "Review the plan: Write the v2 release notes", detail: null, at: NOW,
  planRef: { owner: WORKSPACE_PAGE_NAME, id: "pl-late", revision: 1 },
}];

/** `&asksHold=1`: a read of the queue after the first decision waits for `gallery:release-asks`, as a slow one would. */
export const ASKS_HELD = new URLSearchParams(location.search).get("asksHold") === "1";

export const DecisionsSchema = v.array(v.tuple([v.string(), v.string()]));

export const TWO_CONSENTS: PendingDeviceConsent[] = [
  { consentId: "c-1", deviceId: "dev-studio", deviceLabel: "studio", method: "exec", createdAt: 1, command: "git push origin main" },
  { consentId: "c-2", deviceId: "dev-laptop", deviceLabel: "laptop", method: "exec", createdAt: 2, command: "bun run deploy" },
];

export const ConsentSettleSchema = v.object({ id: v.string(), failed: v.optional(v.string()) });

export const JobsAnswerSchema = v.object({ at: v.number(), label: v.optional(v.string()), failed: v.optional(v.string()) });

export const OWED_CLAIM = {
  actorId: "root", runId: "run-1", workMode: "build", status: "admitted", outcome: null, claimedAt: NOW - 60e3, withdrawnThrough: 0, answered: false,
  program: { kind: "builtin", version: 1, digest: null, build: null },
} as const;

export const OWED_EFFECT = { name: null, scope: "turn", seq: 0, input: "{}", blocked: null } as const;

export const OWED_TURNS = [{ claim: { ...OWED_CLAIM, turnId: "turn-live", epoch: 1 }, attempt: 1 }, { claim: { ...OWED_CLAIM, turnId: "turn-stranded", epoch: 3 }, attempt: 3 }];

/** A named-preset search. `prove` because its resolved axes are the least guessable from its name. */
// `lean/Api/Sessions.lean` is invented along with the sessions table; the module does not exist. Enrolled in `CITATION_ILLUSTRATIVE`.
export const PROVE_ROWS: MctsRow[] = [
  {
    id: "pv000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Prove the expiry sweep terminates",
    task: "Prove that the expiry sweep terminates for every session row, including expires_at = null.",
    observation: "The workspace as found: lean/Api/Sessions.lean, 3 sorries.",
    created_at: NOW - 78e5,
  },
  {
    id: "pv001", parent_id: "pv000", depth: 1, visits: 4, value: 0.31, own_score: 0.31, status: "open",
    action: "Induct on the session list", observation: "Checker accepted 1 of 3 goals.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv002", parent_id: "pv000", depth: 1, visits: 1, value: 0.12, own_score: 0.12, status: "pruned",
    action: "Case-split on expiry first", observation: "Below the prune floor after one rollout.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv003", parent_id: "pv001", depth: 2, visits: 3, value: 0.68, own_score: 0.68, status: "open",
    action: "Strengthen the induction hypothesis", observation: "Checker accepted 2 of 3 goals.",
    created_at: NOW - 76e5,
  },
  {
    id: "pv004", parent_id: "pv000", depth: 1, visits: 0, value: 0, own_score: 0, status: "failed",
    action: "Reduce to the existing monotonicity lemma",
    observation: "Branch errored: the lemma this cites was renamed and no longer resolves.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv005", parent_id: "pv003", depth: 3, visits: 5, value: 0.94, own_score: 0.94, status: "terminal",
    action: "Discharge the null case from the sweep",
    observation: "Checker accepted 3 of 3 goals. No sorries remain.",
    created_at: NOW - 75e5,
  },
];

/** A `custom` composition that fans in (`expand:'aggregate'`): `sw004` and `sw009` are the aggregate vertices, readable only from the journal. */
export const SWARM_ROWS: MctsRow[] = [
  {
    id: "sw000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Reconcile the three latency fixes",
    task: "Reduce /api p95 without regressing the health check.",
    observation: "The workspace as found: p95 = 412ms on the failing fixture.",
    created_at: NOW - 22e5,
  },
  {
    id: "sw001", parent_id: "sw000", depth: 1, visits: 3, value: 0.44, own_score: 0.44, status: "open",
    action: "Cache the opened database per request", observation: "p95 = 318ms.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw002", parent_id: "sw000", depth: 1, visits: 2, value: 0.37, own_score: 0.37, status: "open",
    action: "Prepare the session statements at load", observation: "p95 = 341ms.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw003", parent_id: "sw000", depth: 1, visits: 1, value: 0.19, own_score: 0.19, status: "pruned",
    action: "Precompute every route's query plan", observation: "p95 = 402ms — below the prune floor.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw004", parent_id: "sw001", depth: 2, visits: 4, value: 0.71, own_score: 0.71, status: "open",
    action: "Reconcile the cache with the load-time index",
    observation: "p95 = 244ms. Both parents' writes touched db.ts; this candidate is the merge.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw005", parent_id: "sw002", depth: 2, visits: 2, value: 0.52, own_score: 0.52, status: "open",
    action: "Narrow the statements to the session path", observation: "p95 = 296ms.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw006", parent_id: "sw002", depth: 2, visits: 1, value: 0.28, own_score: 0.28, status: "pruned",
    action: "Prepare every statement", observation: "p95 = 377ms — below the prune floor.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw007", parent_id: "sw004", depth: 3, visits: 6, value: 0.93, own_score: 0.93, status: "terminal",
    action: "Drop the redundant second lookup",
    observation: "p95 = 188ms. The health check's fixture still passes.",
    created_at: NOW - 19e5,
  },
  {
    id: "sw008", parent_id: "sw004", depth: 3, visits: 2, value: 0.61, own_score: 0.61, status: "open",
    action: "Warm the cache on first read", observation: "p95 = 271ms.",
    created_at: NOW - 19e5,
  },
  {
    id: "sw009", parent_id: "sw005", depth: 3, visits: 3, value: 0.66, own_score: 0.66, status: "open",
    action: "Reconcile the narrowed index with the warm cache",
    observation: "p95 = 258ms. Consumed both depth-2 candidates that scored.",
    created_at: NOW - 19e5,
  },
];

/**
 * A search that started and reached nothing (first wave errored, run failed): must render a refusal naming its cause, not an empty tree.
 * A refused call (`resolveSwarm` / `swarmValidity`) writes no root and cannot reach this surface.
 */
export const REFUSED_ROWS: MctsRow[] = [
  {
    id: "rf000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Find a session row that breaks the sweep",
    task: "Find a session row that makes readSession throw after the migration.",
    observation: "The workspace as found: 41 session fixtures.",
    created_at: NOW - 4e5,
  },
];

/**
 * A live swarm with nodes in every state. The stores disagree on purpose: `search_nodes` holds the root and settled nodes,
 * `head_journal` all nine; a node only in the journal is still working.
 */
export const RUNNING_ROWS: MctsRow[] = [
  {
    id: "lv000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Audit the Worker for reads of the old binding",
    task: "Audit every reader of env.DB across the api Worker and report the ones "
      + "that can throw on a missing binding, with the call path and a suggested fix.",
    observation: "The workspace as found: 41 routes, 9 readers.",
    created_at: NOW - 42e4,
  },
  {
    id: "lv001", parent_id: "lv000", depth: 1, visits: 1, value: 0.72, own_score: 0.72, status: "open",
    action: "Walk the webhook route's database path",
    observation: "Two readers call env.DB.prepare with no fallback.",
    created_at: NOW - 30e4,
  },
  {
    id: "lv002", parent_id: "lv000", depth: 1, visits: 1, value: 0.44, own_score: 0.44, status: "open",
    action: "Check the admin sessions report",
    observation: "One reader, already guarded by an early return.",
    created_at: NOW - 26e4,
  },
];

export const MERGED_RUN: HeadRunView = {
  rootId: "root-merge-1",
  task: "Check every other call site that reads env.DB",
  rationale: "Five call sites, five readers — cheaper in parallel than in sequence.",
  status: "completed",
  spawnedAt: NOW - 52e5,
  heads: [
    {
      id: "root-merge-1-h0", parentId: null, depth: 1, task: "workers/api/src/db.ts", rationale: "the reported 500",
      status: "completed", summary: "Two more reads of env.DB; both behind the same ?? fallback.",
      errorMessage: null, usage: { input: 8_420, output: 610 }, wallClockMs: 14_200,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5,
      decisions: [{ question: "Fix at the entry or at the reader?", choice: "at the reader", rationale: "the entry would still let the webhook route read the old name" }],
    },
    {
      id: "root-merge-1-h1", parentId: null, depth: 1, task: "workers/api/src/routes/webhooks.ts", rationale: "the lazy path",
      status: "completed", summary: "One read, already through openDb — no change needed here.",
      errorMessage: null, usage: { input: 5_110, output: 240 }, wallClockMs: 9_800,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 515e4, decisions: [],
    },
    {
      id: "root-merge-1-h2", parentId: null, depth: 1, task: "workers/admin/src/sessions-report.ts", rationale: "the reporting path",
      status: "errored", summary: null,
      errorMessage: "the admin Worker is not checked out on this computer",
      usage: { input: 1_020, output: 0 }, wallClockMs: 2_100,
      spawnedAt: NOW - 52e5, lastStepAt: null, decisions: [],
    },
    {
      id: "root-merge-1-h3", parentId: null, depth: 1, task: "workers/api/src/router.ts", rationale: "the request entry",
      status: "completed", summary: "Opens the database twice on the session path; both reads are behind the same fallback.",
      errorMessage: null, usage: { input: 6_240, output: 380 }, wallClockMs: 11_400,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 512e4, decisions: [],
    },
    {
      // Closed by the settle: `HeadJournal.cacheMerge` terminalizes in-flight heads in the same transition, so a settled run has none running.
      id: "root-merge-1-h4", parentId: null, depth: 1, task: "workers/api/src/routes/public.ts", rationale: "the public surface",
      status: "aborted", summary: null,
      errorMessage: "no report at the synthesis: the run merged what had arrived, and this head "
        + "was still in flight when it did",
      usage: { input: 3_180, output: 90 }, wallClockMs: 4_600,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5, decisions: [],
    },
  ],
  merge: {
    narrative: "Three real call sites left — db.ts and both reads in router.ts — and the same ?? fallback covers all of them. The webhook route already reads through openDb. The admin report could not be checked; that Worker is not in this sandbox. The public routes were still being walked when this merged, so they are unread.",
  },
};

/** Two runs of the same task under different policies must read differently; older forks have none (the ledger prunes settled rows after a day). */
export const FORK_PARAMS: ForkRunParams[] = [
  {
    rootId: "n000",
    search: {
      budget: 24, branches: 4, maxDepth: 6, explorationWeight: 1.41,
      // Clamped: `judgeSamples` shares its call pool with check generation, so asked twenty, ran three.
      judgeSamplesRequested: 20, judgeSamplesRealised: 3, mode: "build",
    },
    transcripts: null,
  },
  {
    rootId: "root-merge-1",
    search: null,
    transcripts: { mergeStrategy: "synthesize", branches: 3 },
  },
  {
    rootId: "root-merge-0",
    search: null,
    transcripts: { mergeStrategy: "best_of", branches: 2 },
  },
  {
    rootId: "lv000",
    search: {
      budget: 12, branches: 5, maxDepth: 2, explorationWeight: 1.41,
      judgeSamplesRequested: null, judgeSamplesRealised: null, mode: "build",
    },
    transcripts: null,
  },
];

export const BRAIN_STATUS = {
  name: "api-worker-health-9935d3", displayName: "API Worker",
  purpose: "The api Worker on Cloudflare: keep it deployed, healthy and fast.", model: "opencode-go/muse-spark-1.3-contributor",
  scaffoldVersion: 7, searchNodeCount: 12, messageCount: 48,
  soul: "# API Worker", forkLineage: null,
  layout: "workbench", createdAt: NOW - 7 * 864e5, reasoningEffort: "medium",
} satisfies AgentStatus;

/** A first drive: never interrupted, never retried, serving nothing. */
export const FIRST_DRIVE = { epoch: 0, retriedBy: null, resumeAfter: null, serves: null } as const;

export const BACKGROUND_JOBS: BackgroundJob[] = [
  {
    id: "bgjob-7c1e4a92", kind: "fork", label: "explore three session-lookup fixes",
    workMode: "build", status: "running", result: null, error: null, createdAt: NOW - 9e5, attemptStartedAt: NOW - 9e5, settledAt: null,
    ...FIRST_DRIVE,
  },
  {
    id: "bgjob-2f8b1d04", kind: "eval", label: "bun test packages/core",
    workMode: "build", status: "completed", result: "2,633 pass · 0 fail · 187 files", error: null,
    createdAt: NOW - 42e5, attemptStartedAt: NOW - 42e5, settledAt: NOW - 33e5, ...FIRST_DRIVE,
  },
  {
    id: "bgjob-9d3c6e11", kind: "shell", label: "wrangler deploy --dry-run",
    workMode: "build", status: "failed", result: null, error: "exit 1 — binding VECTORIZE not found in wrangler.jsonc",
    createdAt: NOW - 61e5, attemptStartedAt: NOW - 61e5, settledAt: NOW - 58e5, ...FIRST_DRIVE,
  },
];

/** The Agent tab's journal: a dream that changed how the agent works, one that changed nothing, and a fact it kept. */
export const CHANGELOG = {
  seenAt: NOW - 30e5,
  unseenCount: 2,
  entries: [
    {
      id: "refinement:refine-a1:applied", kind: "refinement", at: NOW - 10e5,
      summary: "I dreamt and changed how I work",
      evidence: "applied · workspace scope · five new turns since the last dream · reviewed 5 rated turns",
      items: [
        {
          id: "refinement:refine-a1:0", kind: "refinement", at: NOW - 10e5,
          summary: "Reword the shell tool's description: takes effect after the next pause",
          evidence: "owner artifact_versions · accepted by the dream's reviewer",
          revert: { type: "artifact_revert", target: "tool:shell.description@1" },
        },
        {
          id: "refinement:refine-a1:1", kind: "refinement", at: NOW - 10e5,
          summary: "The release-notes skill: takes effect after the next pause",
          evidence: "owner instruction_approvals · staged where no prompt reads it",
          revert: { type: "skill_revert", target: "refine-a1#1" },
        },
        {
          id: "refinement:refine-a1:2", kind: "refinement", at: NOW - 10e5,
          summary: "Remember user.answer_length: in effect now",
          evidence: "owner agent_facts · the user's own words: \"keep answers to one line unless I ask\"",
          revert: { type: "fact_forget", target: "user.answer_length" },
        },
      ],
    },
    {
      id: "fact:computer.staging_db", kind: "fact", at: NOW - 50e5,
      summary: "Remembered: staging still binds the sessions database as DB",
      evidence: "",
      revert: { type: "fact_forget", target: "computer.staging_db" },
    },
    {
      id: "refinement:refine-a0:refused", kind: "refinement", at: NOW - 60e5,
      summary: "I dreamt and changed nothing",
      evidence: "refused · workspace scope · the agent was idle · reviewed 3 rated turns",
      noChange: true,
    },
  ],
} satisfies { seenAt: number; unseenCount: number; entries: ChangelogEntry[] };

/** Without it a waiting decision lights nothing while a running job carries a digit. */
export const PENDING_ACTIONS: PendingAction[] = [
  // Parked commands, the one kind decided in the queue itself.
  {
    id: "defer-9y2n8ixor8", kind: "deferred_action", at: NOW - 40 * 60e3,
    title: "Approve: a command the agent wants to run on device",
    detail: "cd ~/Kinu && rm -rf node_modules && bun install",
  },
  {
    id: "defer-4k1m2pqw7z", kind: "deferred_action", at: NOW - 36 * 60e3,
    title: "Approve: a command the agent wants to run on device",
    detail: "sudo launchctl kickstart -k system/com.docker.dockerd",
  },
  {
    id: "defer-w7r1te0notes", kind: "deferred_action", at: NOW - 30 * 60e3,
    title: "Replace /pc/ashish@studio/home/ashish/notes.md",
    detail: "file write /pc/ashish@studio/home/ashish/notes.md",
    write: { path: "/pc/ashish@studio/home/ashish/notes.md" },
  },
  {
    id: "plan:main:plan-gateway:3", kind: "plan_review", at: NOW - 9e5,
    title: "Approve the plan · Gateway timeout repair",
    detail: null,
    planRef: { owner: "main", id: "plan-gateway", revision: 3 },
  },
];

export const LIVE_SHARE: OwnedLiveShare = {
  id: "live-board-1", slate: "issue-triage", visibility: "public", handle: "3f9a1c7e02",
  grant: { slates: ["issue-triage", "digest"], members: [
    { slate: "issue-triage", namespace: "mcp.github", member: "read_issue", impact: "observe" },
    { slate: "issue-triage", namespace: "workspace", member: "fs.text", impact: "observe" },
    { slate: "issue-triage", namespace: "memory", member: "recall", impact: "observe" },
    { slate: "issue-triage", namespace: "slates.digest", member: "summary", impact: "observe" },
    { slate: "digest", namespace: "workspace", member: "fs.text", impact: "observe" },
  ] },
  // Approved at r1; the slate is at r2 now, so it is stopped until the owner approves the new reach.
  createdAt: NOW - 864e5, revokedAt: null, users: [], editors: [], mode: "owner", grantRevision: "r1", editedBy: null, stale: true, paused: false, gallery: null,
  views: { viewers: 12, opens: 40, signedOutOpens: 9 },
};

export const BUILD_LINES = [
  "$ bun run build",
  "resolving 412 packages",
  "warn: chunk vendor.js is 1.4 MB after minify",
  "compiled 120 modules",
  "compiled 248 modules",
  "compiled 377 modules",
] as const;

export const BUILD_JOB_ID = "bgjob-4e1a77c0";

/** Both halves of a shell approval: the queue that grants, the list that revokes. Fed directly: `?frame=settings` needs a live agent socket. */
export const SHELL_GRANTS = [
  { rule: "rm-recursive", executor: "device" },
  { rule: "sudo", executor: "device" },
  { rule: "docker-destructive", executor: "computer" },
];

/** `getExecutorFiles`' arguments, its request's defaults filled as the read model fills them. */
export const FILES_REQUEST_ARGS = v.tuple([
  v.string(), v.string(), v.optional(v.object({ from: v.optional(v.number(), 0), hidden: v.optional(v.boolean(), false) }), {}),
]);

/** As `deviceMountSegment` keys a fleet of one. */
export const PC_SEGMENT = "Ashish's MacBook";

export const PC_MOUNT = `/pc/${PC_SEGMENT}`;

/** Production learns it from the machine (`deviceFiles`' homeDir); a bare `/pc/<name>` lands here. */
export const PC_CONSENTED_ROOT = `${PC_MOUNT}/home/dev`;

export const ACTIVITY_ACCOUNTS: readonly AccountSpend[] = [
  {
    provider: "anthropic", account: "work", calls: 402, callsWithoutUsage: 0, unpricedCalls: 0,
    usd: 9.4312, usage: { input: 14_220_118, output: 402_551, cacheRead: 12_880_004 },
    quota: {
      at: NOW - 40e3,
      windows: [
        { measure: "requests", limit: 50, remaining: 3, resetsAt: NOW + 22e3 },
        { measure: "input-tokens", limit: 40_000, remaining: 31_200, resetsAt: NOW + 22e3 },
      ],
    },
  },
  {
    provider: "codex", account: "main", calls: 214, callsWithoutUsage: 0, unpricedCalls: 0,
    usd: 5.1204, usage: { input: 8_104_220, output: 228_101, cacheRead: 6_874_002 },
    quota: {
      at: NOW - 95e3,
      windows: [
        { measure: "300m", usedPercent: 41, resetsAt: NOW + 7_380e3 },
        { measure: "10080m", usedPercent: 12, resetsAt: NOW + 388_800e3 },
      ],
    },
  },
  {
    provider: "anthropic", account: "main", calls: 38, callsWithoutUsage: 0, unpricedCalls: 0,
    usd: 1.7126, usage: { input: 1_226_706, output: 40_698 },
  },
  {
    provider: null, account: null, calls: 93, callsWithoutUsage: 93, unpricedCalls: 0, usage: {},
  },
];

const DRAINED_EVENT = {
  trace_id: "trace-1", caused_by: null, trust: "external", priority: "background", payload_visibility: "full",
  received_at: 0, reply_channel: null, dedupe_key: null,
} as const;

/** Core's own drain text, so the card reads what the agent was given. Plan and Build never share a batch, so delegated work and the rest are two. */
export const DRAIN_BATCHES = {
  delegated: [
    {
      ...DRAINED_EVENT, id: "ev-report", ingress: "subagent", variant: "subagent_report",
      payload: { from_subagent: "cli-auditor", status: "completed", content: "Report line one.\nReport line two.", sequence_id: "seq-1", kinu_mode: "build" },
    },
    {
      ...DRAINED_EVENT, id: "ev-ask", ingress: "peer_async", variant: "peer_agent",
      payload: {
        from_agent_name: "atlas", from_user_id: "u1", topic: "schema", body: "which shape?", sender_event_id: "out-1",
        reply_expected: true, kinu_mode: "build",
      },
    },
  ],
  idle: [
    { ...DRAINED_EVENT, id: "ev-timer", ingress: "timer_alarm", variant: "timer", payload: { label: "background-job-wake:job-7", trigger_id: "x", scheduled_fire_at: 0 } },
  ],
  // Mail drains in a turn of its own, in Plan (docs/MAIL.md §3); a stranger's carries no words, only how to read it.
  mail: [
    {
      ...DRAINED_EVENT, id: "ev-mail", ingress: "email_inbound", variant: "email",
      payload: {
        from: "ops@example.com", to: "api-worker.ashish@kinu.run", subject: "Deploy failed", body_text: "",
        message_id: null, in_reply_to: null, references: null, attachments: [], mail: { box: "api-worker", thread: "t-deploy", message: "m-deploy" },
      },
    },
  ],
} satisfies Record<string, KinuEvent[]>;
