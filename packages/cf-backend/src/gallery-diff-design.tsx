import { Effect } from "effect";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { UIMessage } from "ai";
import {
  diffLines, fileDiff, inNoteOrder, mainPanelAgent, parseGitDiff, type ChangeNotesCard, type ChangeSet, type DiffAnchor, type FileDiff, type FileStatus,
  type ChangeNote, type TurnLiveness,
} from "@kinu.run/core";
import Layout from "@/components/layout";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { MessageView } from "@/components/MessageView";
import { Composer } from "@/components/Composer";
import type { WorkMode } from "@kinu.run/core";
import { ModelPicker } from "@/components/ModelPicker";
import { InspectorBar } from "@/components/surfaces/InspectorBar";
import { ChangesPanel, LAYOUT_KEY } from "@/components/surfaces/changes/ChangesPanel";
import { ReviewBar } from "@/diff-design/ReviewBar";
import { FeedbackCard } from "@/components/surfaces/changes/FeedbackCard";
import { NotesProvider, noteOf, type NotesStore, type OpenDraft } from "@/components/surfaces/changes/notes-provider";
import { AnnotationType } from "@plannotator/ui/types";

const WORKSPACE = "api-worker";

const NOW = new Date(2026, 8, 23, 16, 5).getTime();

function snapshot(path: string, status: FileStatus, before: string, after: string): FileDiff {
  return fileDiff(path, status, diffLines(before, after));
}

const lines = (...rows: string[]): string => rows.join("\n");

const DB_BEFORE = lines(
  "import type { Env, Session } from \"./env\";",
  "import { log } from \"./log\";",
  "",
  "/** A session id is 32 hex characters; anything else never reaches the database. */",
  "export function validSessionId(id: string): boolean {",
  "  return /^[0-9a-f]{32}$/.test(id);",
  "}",
  "",
  "export function openDb(env: Env): D1Database {",
  "  return env.DB;",
  "}",
  "",
  "export async function readSession(env: Env, id: string): Promise<Session | null> {",
  "  if (!validSessionId(id)) return null;",
  "",
  "  return await openDb(env).prepare(\"SELECT * FROM sessions WHERE id = ?\").bind(id).first<Session>();",
  "}",
  "",
  "export async function writeSession(env: Env, session: Session): Promise<void> {",
  "  await openDb(env)",
  "    .prepare(\"INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)\")",
  "    .bind(session.id, session.userId, session.expiresAt)",
  "    .run();",
  "}",
  "",
  "/** The health route reports what this answers, so its monitors watch the database too. */",
  "export async function databaseUp(env: Env): Promise<boolean> {",
  "  try {",
  "    await openDb(env).prepare(\"SELECT 1\").first();",
  "",
  "    return true;",
  "  } catch (error) {",
  "    log.error(\"db.unreachable\", { error: String(error) });",
  "",
  "    return false;",
  "  }",
  "}",
);

const DB_AFTER = lines(
  "import type { Env, Session } from \"./env\";",
  "import { log } from \"./log\";",
  "",
  "export class MissingBinding extends Error {",
  "  constructor(readonly binding: string) {",
  "    super(`The ${binding} binding is not configured for this Worker`);",
  "  }",
  "}",
  "",
  "/** A session id is 32 hex characters; anything else never reaches the database. */",
  "export function validSessionId(id: string): boolean {",
  "  return /^[0-9a-f]{32}$/.test(id);",
  "}",
  "",
  "/** The sessions database, by the binding wrangler.jsonc gives it. */",
  "export function openDb(env: Env): D1Database {",
  "  const db = sessionsBinding(env);",
  "",
  "  if (db === undefined) throw new MissingBinding(\"SESSIONS_DB\");",
  "",
  "  return db;",
  "}",
  "",
  "/** Until every environment has redeployed, the old name still answers. */",
  "function sessionsBinding(env: Env): D1Database | undefined {",
  "  // DB is the name before 2026-09-22; SESSIONS_DB is the one wrangler.jsonc gives it now.",
  "  return env.SESSIONS_DB ?? env.DB;",
  "}",
  "",
  "export async function readSession(env: Env, id: string): Promise<Session | null> {",
  "  if (!validSessionId(id)) return null;",
  "",
  "  return await openDb(env).prepare(\"SELECT * FROM sessions WHERE id = ?\").bind(id).first<Session>();",
  "}",
  "",
  "export async function writeSession(env: Env, session: Session): Promise<void> {",
  "  await openDb(env)",
  "    .prepare(\"INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)\")",
  "    .bind(session.id, session.userId, session.expiresAt)",
  "    .run();",
  "}",
  "",
  "/** The health route reports what this answers, so its monitors watch the database too. */",
  "export async function databaseUp(env: Env): Promise<boolean> {",
  "  try {",
  "    await openDb(env).prepare(\"SELECT 1\").first();",
  "",
  "    return true;",
  "  } catch (error) {",
  "    log.error(\"db.unreachable\", { error: String(error) });",
  "",
  "    return false;",
  "  }",
  "}",
);

const CONFIG_BEFORE = lines(
  "{",
  "  \"name\": \"api\",",
  "  \"main\": \"src/index.ts\",",
  "  \"compatibility_date\": \"2026-09-01\",",
  "  \"d1_databases\": [",
  "    { \"binding\": \"SESSIONS_DB\", \"database_name\": \"sessions\", \"database_id\": \"4c1e9a20-7b5d-4f3e-9c2a-1d8e6f0b3a71\" }",
  "  ]",
  "}",
);

const CONFIG_AFTER = lines(
  "{",
  "  \"name\": \"api\",",
  "  \"main\": \"src/index.ts\",",
  "  \"compatibility_date\": \"2026-09-01\",",
  "  \"d1_databases\": [",
  "    { \"binding\": \"SESSIONS_DB\", \"database_name\": \"sessions\", \"database_id\": \"4c1e9a20-7b5d-4f3e-9c2a-1d8e6f0b3a71\" }",
  "  ],",
  "  // Staging bound its database by the old name; it reads the new one too.",
  "  \"env\": {",
  "    \"staging\": {",
  "      \"d1_databases\": [",
  "        { \"binding\": \"SESSIONS_DB\", \"database_name\": \"sessions-staging\", \"database_id\": \"b72f0c51-3e8a-4d19-a6c4-5e2b9d7f1c08\" }",
  "      ]",
  "    }",
  "  }",
  "}",
);

const MIGRATION_BEFORE = lines(
  "-- 0007: a session expires.",
  "ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;",
);

const MIGRATION_AFTER = lines(
  "-- 0007: a session expires.",
  "ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;",
  "",
  "-- The session reads and the expiry sweep both look sessions up by expiry.",
  "CREATE INDEX sessions_expires_at ON sessions (expires_at);",
);

const TEST_AFTER = lines(
  "import { describe, expect, test } from \"bun:test\";",
  "import { databaseUp, openDb, readSession } from \"../../src/db\";",
  "import { envWith } from \"../helpers\";",
  "",
  "describe(\"the sessions database binding\", () => {",
  "  test(\"openDb reads SESSIONS_DB\", () => {",
  "    const db = { prepare: () => null };",
  "    const env = envWith({ SESSIONS_DB: db });",
  "",
  "    expect(openDb(env)).toBe(db);",
  "  });",
  "",
  "  test(\"an environment deployed before the rename still reads DB\", () => {",
  "    const db = { prepare: () => null };",
  "",
  "    expect(openDb(envWith({ DB: db }))).toBe(db);",
  "  });",
  "",
  "  test(\"no binding at all fails by its name\", () => {",
  "    expect(() => openDb(envWith({}))).toThrow(\"SESSIONS_DB\");",
  "  });",
  "",
  "  test(\"the health check reports a missing database as down\", async () => {",
  "    expect(await databaseUp(envWith({}))).toBe(false);",
  "  });",
  "",
  "  test(\"a malformed session id never reaches the database\", async () => {",
  "    expect(await readSession(envWith({}), \"not-an-id\")).toBeNull();",
  "  });",
  "});",
);

const LEGACY_BEFORE = lines(
  "/**",
  " * Sessions as they were kept before the D1 database. Nothing imports it since",
  " * the Worker moved to readSession; it stays only for sessions that have not expired.",
  " */",
  "import type { Env } from \"./env\";",
  "",
  "export async function legacySession(env: Env, id: string): Promise<string | null> {",
  "  return await env.SESSIONS_KV.get(`session:${id}`);",
  "}",
  "",
  "export async function legacyUser(env: Env, id: string): Promise<string | null> {",
  "  const session = await legacySession(env, id);",
  "",
  "  return session === null ? null : JSON.parse(session).userId;",
  "}",
);

const README_BEFORE = lines(
  "# api",
  "",
  "Serves `/api` for the app. Every route that reads a session goes through",
  "`readSession` in `src/db.ts`.",
  "",
  "## Sessions",
  "",
  "Sessions live in the D1 database `sessions`.",
  "",
  "## Tests",
  "",
  "Run `bun test workers/api`.",
);

const README_AFTER = lines(
  "# api",
  "",
  "Serves `/api` for the app. Every route that reads a session goes through",
  "`readSession` in `src/db.ts`.",
  "",
  "## Sessions",
  "",
  "Sessions live in the D1 database `sessions`, bound as `SESSIONS_DB`. An",
  "environment deployed before the rename still binds it as `DB`; `openDb`",
  "reads either until every environment has redeployed.",
  "",
  "## Tests",
  "",
  "Run `bun test workers/api`.",
);

const WORKER_FILES: readonly FileDiff[] = [
  snapshot("workers/api/src/db.ts", "changed", DB_BEFORE, DB_AFTER),
  snapshot("workers/api/wrangler.jsonc", "changed", CONFIG_BEFORE, CONFIG_AFTER),
  snapshot("workers/api/src/kv-sessions.ts", "removed", LEGACY_BEFORE, ""),
  snapshot("workers/api/migrations/0007_sessions.sql", "changed", MIGRATION_BEFORE, MIGRATION_AFTER),
  snapshot("workers/api/test/integration/sessions-binding.test.ts", "added", "", TEST_AFTER),
  snapshot("workers/api/README.md", "changed", README_BEFORE, README_AFTER),
];

const WORKER_CHANGES: ChangeSet = {
  baseline: "snapshot 4f1c9a",
  source: "workspace", label: "Workspace", mode: "vfs-baseline", files: WORKER_FILES, trackedSince: NOW - 111 * 60e3,
};


const RUNBOOK = lines(
  "# API incident runbook",
  "",
  ...Array.from({ length: 34 }, (_, index) => [
    `## Step ${String(index + 1)}`,
    "",
    index % 2 === 0
      ? "Tail the Worker with `wrangler tail api --status error` before touching the code."
      : "Check `/api/health` from outside the network, and keep its answer in the incident.",
    "",
  ]).flat(),
);

const OLD_ROUTER = lines(
  'import type { Env } from "./env";',
  "",
  ...Array.from({ length: 40 }, (_, index) => `export const ROUTE_${String(index)} = "/api/v1/route-${String(index)}";`),
);

const SEED_COLUMNS = "id,user_id,expires_at,store";

const SEED_BEFORE = lines(SEED_COLUMNS, ...Array.from({ length: 1400 }, (_, index) => `${String(index)},user-${String(index % 50)},${String(1790000000 + index * 60)},kv`));

const SEED_AFTER = lines(SEED_COLUMNS, ...Array.from({ length: 1400 }, (_, index) => {
  const store = index % 20 === 5 && index < 970 ? "kv" : "d1";

  return `${String(index)},user-${String(index % 50)},${String(1790000000 + index * 60)},${store}`;
}));

const EDGE_CHANGES: ChangeSet = {
  source: "workspace", label: "Workspace", mode: "vfs-baseline", trackedSince: NOW - 26 * 60 * 60e3,
  files: [
    { path: "workers/api/worker-configuration.d.ts", status: "changed", added: 1214, removed: 1180, lines: [], truncated: true },
    { path: "data/exports/sessions-2026.json", status: "changed", added: 0, removed: 0, lines: [], omitted: "large" },
    { path: "public/status-badge.png", status: "changed", added: 0, removed: 0, lines: [], omitted: "binary" },
    snapshot("data/seed/sessions.csv", "changed", SEED_BEFORE, SEED_AFTER),
    snapshot("docs/incident-runbook.md", "added", "", RUNBOOK),
    snapshot("workers/api/src/old-router.ts", "removed", OLD_ROUTER, ""),
  ],
};

const API_PATCH = [
  "diff --git a/wrangler.jsonc b/wrangler.jsonc",
  "index 4c1e2a7..8d0b3f5 100644",
  "--- a/wrangler.jsonc",
  "+++ b/wrangler.jsonc",
  "@@ -18,7 +18,7 @@",
  "   \"env\": {",
  "     \"staging\": {",
  "       \"d1_databases\": [",
  "-        { \"binding\": \"DB\", \"database_name\": \"sessions-staging\" }",
  "+        { \"binding\": \"SESSIONS_DB\", \"database_name\": \"sessions-staging\" }",
  "       ]",
  "     }",
  "   }",
  "diff --git a/src/db.ts b/src/db.ts",
  "index 9a7c2e1..b41f0d6 100644",
  "--- a/src/db.ts",
  "+++ b/src/db.ts",
  "@@ -8,6 +8,9 @@ import { log } from \"./log\";",
  " export function openDb(env: Env): D1Database {",
  "-  return env.DB;",
  "+  const db = env.SESSIONS_DB ?? env.DB;",
  "+",
  "+  if (db === undefined) throw new MissingBinding(\"SESSIONS_DB\");",
  "+",
  "+  return db;",
  " }",
  "diff --git a/migrations/0007_sessions_expiry.sql b/migrations/0007_sessions_expiry.sql",
  "new file mode 100644",
  "index 0000000..c3d9e4a",
  "--- /dev/null",
  "+++ b/migrations/0007_sessions_expiry.sql",
  "@@ -0,0 +1,2 @@",
  "+-- The session reads and the expiry sweep both look sessions up by expiry.",
  "+CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);",
  "diff --git a/test/sessions-binding.test.ts b/test/sessions-binding.test.ts",
  "new file mode 100644",
  "index 0000000..e7f2a19",
  "--- /dev/null",
  "+++ b/test/sessions-binding.test.ts",
  "@@ -0,0 +1,6 @@",
  "+import { expect, test } from \"bun:test\";",
  "+import { openDb } from \"../src/db\";",
  "+",
  "+test(\"the database opens by its new binding\", () => {",
  "+  expect(openDb({ SESSIONS_DB: {} } as Env)).toBeDefined();",
  "+});",
].join("\n");

const OPS_PATCH = [
  "diff --git a/runbooks/d1-binding-rename.md b/runbooks/d1-binding-rename.md",
  "index 2b6e9c4..71d3a0e 100644",
  "--- a/runbooks/d1-binding-rename.md",
  "+++ b/runbooks/d1-binding-rename.md",
  "@@ -1,3 +1,4 @@",
  " # Renaming a D1 binding",
  "-Rename it in wrangler.jsonc and deploy.",
  "+Read the database under both names until every environment has redeployed,",
  "+then drop the old name.",
  " ",
  "diff --git a/dashboards/api-health.png b/dashboards/api-health.png",
  "index 1a2b3c4..5d6e7f8 100644",
  "Binary files a/dashboards/api-health.png and b/dashboards/api-health.png differ",
].join("\n");

/** Two repositories in the laptop's working folder, each a folder of the list: the Worker's fix, and its runbook. */
const DEVICE_CHANGES: ChangeSet = {
  source: "laptop", label: "laptop", mode: "git", baseline: "api@3f2a91c ops@9b8e7d2", repositories: ["api", "ops"],
  files: [
    ...parseGitDiff(API_PATCH).map((file) => ({ ...file, path: `api/${file.path}` })),
    ...parseGitDiff(OPS_PATCH).map((file) => ({ ...file, path: `ops/${file.path}` })),
  ],
};

const DEVICE_OFFLINE: ChangeSet = {
  source: "laptop", label: "laptop", mode: "git", files: [], error: "laptop is offline. Its changes come back when it reconnects.",
};


const IDLE: TurnLiveness = { kind: "idle" };

const MESSAGES: UIMessage[] = [
  {
    id: "u1", role: "user",
    parts: [{ type: "text", text: "/api/health on the api Worker has answered 500 since the last deploy. Find out why and fix it." }],
  },
  {
    id: "a1", role: "assistant",
    parts: [
      { type: "text", text: "Found it. The config renamed the sessions database's binding to `SESSIONS_DB`, but `openDb` still returns `env.DB`, which is undefined now, so every request that opens the database fails." },
      { type: "tool-file", toolCallId: "t1", state: "output-available", input: { op: "edit", path: "workers/api/src/db.ts" }, output: "ok" },
      { type: "tool-file", toolCallId: "t2", state: "output-available", input: { op: "edit", path: "workers/api/wrangler.jsonc" }, output: "ok" },
      { type: "tool-file", toolCallId: "t3", state: "output-available", input: { op: "edit", path: "workers/api/migrations/0007_sessions.sql" }, output: "ok" },
      { type: "tool-file", toolCallId: "t4", state: "output-available", input: { op: "write", path: "workers/api/test/integration/sessions-binding.test.ts" }, output: "ok" },
      { type: "tool-run", toolCallId: "t5", state: "output-available", input: { runtime: "computer", command: "bun test workers/api" }, output: "18 pass\n0 fail" },
    ],
  },
  {
    id: "a2", role: "assistant",
    parts: [{
      type: "text",
      text: "Fixed. `openDb` reads the database as `SESSIONS_DB`, falls back to the old name until every environment has redeployed, and fails by name when neither is bound. Staging binds the new name too, and migration 0007 indexes sessions by expiry. I removed the unused KV session store and added five tests; all 18 of the Worker's tests pass.",
    }],
  },
];

const DB = "workers/api/src/db.ts";

const FALLBACK = "env.SESSIONS_DB ?? env.DB";

const FALLBACK_AT = (DB_AFTER.split("\n")[26] ?? "").indexOf(FALLBACK);

const BASELINE = "snapshot 4f1c9a";

const FALLBACK_ANCHOR: DiffAnchor = {
  scope: "text", path: DB, side: "new", lineStart: 27, lineEnd: 27, charStart: FALLBACK_AT, charEnd: FALLBACK_AT + FALLBACK.length, baseline: BASELINE,
};

const NOTES: readonly ChangeNote[] = [
  noteOf({
    id: "fallback", type: AnnotationType.COMMENT, createdA: NOW - 9 * 60e3, anchor: FALLBACK_ANCHOR, quote: FALLBACK,
    text: "Keep the fallback for this deploy, but log it: a read through the old name is something to hear about.",
  }),
  noteOf({
    id: "id-test", type: AnnotationType.DELETION, createdA: NOW - 7 * 60e3,
    anchor: { scope: "lines", path: "workers/api/test/integration/sessions-binding.test.ts", side: "new", lineStart: 27, lineEnd: 29, baseline: BASELINE },
    quote: (TEST_AFTER.split("\n").slice(26, 29)).join("\n"),
  }),
  noteOf({
    id: "legacy", type: AnnotationType.COMMENT, createdA: NOW - 5 * 60e3,
    anchor: { scope: "file", path: "workers/api/src/kv-sessions.ts", baseline: BASELINE },
    quote: "workers/api/src/kv-sessions.ts",
    text: "Keep this until the KV sessions expire; a few users still sign in through it.",
  }),
];

const SENT: readonly ChangeNote[] = [
  ...NOTES,
  noteOf({
    id: "all", type: AnnotationType.GLOBAL_COMMENT, createdA: NOW - 3 * 60e3, quote: "",
    text: "Good fix. After these, run the Worker's tests again and tell me what changed.",
  }),
];

function cardOf(notes: readonly ChangeNote[]): ChangeNotesCard {
  return {
    source: "workspace", label: "Workspace",
    notes: inNoteOrder(notes).map((note) => ({
      id: note.id, type: note.type, ...(note.text !== undefined && { text: note.text }), ...(note.type !== "GLOBAL_COMMENT" && note.anchor !== undefined && { anchor: note.anchor }),
    })),
  };
}

const WRITING: OpenDraft = {
  anchor: FALLBACK_ANCHOR, quote: FALLBACK,
  initialText: "Keep the fallback for this deploy, but log it: a read through the old name is something to hear about.",
};

const REPLY: UIMessage = {
  id: "a3", role: "assistant",
  parts: [{ type: "text", text: "On it. I'll log each read through the old binding, drop the malformed-id test, and keep `kv-sessions.ts` until the KV sessions expire. Then I'll rerun the Worker's tests." }],
};

function ChatColumn({ wide, sent, onOpenNote }: { wide: boolean; sent: readonly ChangeNote[] | null; onOpenNote: (anchor: DiffAnchor | undefined) => void }) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<WorkMode>("build");
  const [model, setModel] = useState("opencode-go/muse-spark-1.3-contributor");

  return (
    <div className={`flex h-full min-w-0 flex-1 flex-col ${wide ? "border-r p-border" : ""}`}>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-6 lg:px-8 [&>*]:mx-auto [&>*]:max-w-[780px]">
        {MESSAGES.map((message) => <div key={message.id}><MessageView message={message} /></div>)}
        {sent !== null && <FeedbackCard card={cardOf(sent)} sentAt={NOW - 60e3} now={NOW} onOpen={onOpenNote} />}
        {sent !== null && <div><MessageView message={REPLY} /></div>}
      </div>
      <div className="p-composer-dock">
        <Composer value={value} onValueChange={setValue} onSend={() => setValue("")} onStop={() => {}} placeholder="Send a message..."
          disabled={false} liveness={IDLE} mode={{ value: mode, onChange: setMode }}
          attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
          modelPicker={<ModelPicker models={[{ spec: "opencode-go/muse-spark-1.3-contributor", label: "Muse Spark 1.3", provider: "OpenCode Go" }]} value={model} onChange={setModel} size="xs" />}
          notices={[]} />
      </div>
    </div>
  );
}

function useWide(): boolean {
  const query = "(min-width: 768px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = (): void => setWide(media.matches);

    media.addEventListener("change", sync);

    return () => media.removeEventListener("change", sync);
  }, []);

  return wide;
}

function fallbackRow(): HTMLElement | null {
  const card = document.querySelector(`[data-file-card="${DB}"]`);

  if (card?.querySelector('[data-diff-tinted="pending"]') !== null) return null;

  return card.querySelector<HTMLElement>('[data-note-row][data-side="new"][data-new="27"]');
}

function textRange(code: HTMLElement, start: number, end: number): Range {
  const range = document.createRange();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let at = 0;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;

    if (start >= at && start <= at + length) range.setStart(node, start - at);

    if (end >= at && end <= at + length) {
      range.setEnd(node, end - at);
      break;
    }

    at += length;
  }

  return range;
}

function useDesignSelection(kind: string | null): void {
  useEffect(() => {
    if (kind === null) return;

    const timer = setInterval(() => {
      const row = fallbackRow();
      const code = row?.querySelector<HTMLElement>("[data-code]");

      if (row === null || code === null || code === undefined) return;
      clearInterval(timer);

      if (kind === "lines") {
        const gutter = (line: number): Element | null => row.parentElement?.querySelector(`[data-note-row][data-side="new"][data-new="${String(line)}"] > span`) ?? null;

        gutter(25)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        gutter(27)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true }));

        return;
      }

      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(textRange(code, FALLBACK_AT, FALLBACK_AT + FALLBACK.length));
      code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, 60);

    return () => clearInterval(timer);
  }, [kind]);
}

function DesignSelection({ kind }: { kind: string | null }) {
  useDesignSelection(kind);

  return null;
}

const MAIN_CHAT = mainPanelAgent({ activity: "idle" });

function Workspace({ wide, chatPane, inspector, chat, panel }: { wide: boolean; chatPane: boolean; inspector: number; chat: ReactNode; panel: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        workspace={{ name: WORKSPACE, title: "API Worker", to: `/workspace/${WORKSPACE}/overview`, editValue: "API Worker", rename: async () => {}, remove: () => {} }}
        chats={[{ agent: MAIN_CHAT, to: `/workspace/${WORKSPACE}`, rename: async () => {} }]}
        active="main"
        newChat={`/workspace/${WORKSPACE}/new`}
      />
      <div className="flex shrink-0 items-center gap-1 border-b p-border p-sidebar px-3 py-2 md:hidden">
        <button type="button" aria-pressed={chatPane} className={`rounded-full px-3 py-1.5 text-xs ${chatPane ? "p-accent-subtle p-accent" : "p-text-3"}`}>Chat</button>
        <button type="button" aria-pressed={!chatPane} className={`rounded-full px-3 py-1.5 text-xs ${chatPane ? "p-text-3" : "p-accent-subtle p-accent"}`}>Workspace</button>
      </div>
      <div className="flex min-h-0 flex-1">
        {(wide || chatPane) && chat}
        {(wide || !chatPane) && <div className="flex w-full shrink-0 flex-col p-sidebar" style={wide ? { width: inspector } : undefined}>{panel}</div>}
      </div>
    </div>
  );
}

function setsFor(params: URLSearchParams): readonly ChangeSet[] {
  const laptop = params.get("offline") === "1" ? DEVICE_OFFLINE : DEVICE_CHANGES;

  if (params.get("set") === "edge") return [EDGE_CHANGES];

  return params.has("source") || params.has("menu") ? [WORKER_CHANGES, laptop] : [WORKER_CHANGES];
}

function Scene({ params }: { params: URLSearchParams }) {
  const wide = useWide();
  const sets = setsFor(params);
  const [source, setSource] = useState(params.get("source") ?? sets[0]?.source ?? "workspace");
  const [opened, setOpened] = useState<{ readonly file: string | null; readonly n: number }>({ file: params.get("file"), n: 0 });

  const [reviewedAt, setReviewedAt] = useState<number | null>(params.get("reviewed") === "1" ? NOW - 60e3 : null);
  const [sent, setSent] = useState<readonly ChangeNote[] | null>(params.get("sent") === "1" ? SENT : null);
  const [chatPane, setChatPane] = useState(params.get("pane") === "chat");
  const shown = sets.find((set) => set.source === source) ?? sets[0];

  const initial = params.get("notes") === "1" && sent === null ? NOTES : [];
  const latest = useRef<readonly ChangeNote[]>(initial);

  const store = useMemo<NotesStore>(() => ({
    load: () => Effect.sync(() => ({ ok: true, notes: [...latest.current] })),
    save: (notes) => Effect.sync(() => {
      latest.current = notes;

      return { ok: true, notes: [...notes] };
    }),
    send: () => Effect.sync(() => {
      setSent(latest.current);
      setChatPane(true);

      return { ok: true, notes: [] };
    }),
  }), []);

  const openNote = (anchor: DiffAnchor | undefined): void => {
    setSource("workspace");
    setChatPane(false);
    setOpened((prior) => ({ file: anchor?.path ?? null, n: prior.n + 1 }));
  };

  const changed = reviewedAt !== null || shown?.error !== undefined ? null : shown?.files.length ?? null;

  const panel = (
    <>
      <InspectorBar surface="Changes" pages={[]} choose={() => {}} trailing={null} tools={[
        { key: "Work" }, { key: "Changes", count: changed === null ? undefined : { value: changed, accent: false } },
        { key: "Files" }, { key: "Agent" }, { key: "Environment" }, { key: "Activity" },
      ]} />
      <div className="min-h-0 flex-1">
        <ChangesPanel key={opened.n} sets={sets} source={source} onSource={setSource} now={NOW} file={opened.file}
          menuOpen={params.get("menu") === "source"} notesOpen={params.get("annotations") === "1"}
          reviewedAt={reviewedAt} onReviewed={() => setReviewedAt(NOW)} onUndo={() => setReviewedAt(null)}
          onOpenInFiles={shown?.mode === "vfs-baseline" ? () => {} : null} />
      </div>
    </>
  );

  return (
    <NotesProvider key={sent === null ? "open" : "sent"} baseline={shown?.baseline ?? BASELINE} files={shown?.files ?? []} now={() => NOW} store={store}
      initial={initial} writing={params.get("comment") === "1" ? WRITING : undefined}>
      <Workspace wide={wide} chatPane={chatPane} inspector={Number(params.get("inspector") ?? 340)} panel={panel}
        chat={<ChatColumn wide={wide} sent={sent} onOpenNote={openNote} />} />
      <DesignSelection kind={params.get("select")} />
    </NotesProvider>
  );
}

export default function diffDesignFrame() {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");

  if (theme === "dark" || theme === "light") {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
  }

  localStorage.setItem(LAYOUT_KEY, params.get("layout") === "unified" ? "unified" : "split");

  return {
    entries: [`/workspace/${WORKSPACE}`],
    node: (
      <>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/workspace/:agentId" element={<Scene params={params} />} />
            <Route path="*" element={<Navigate to={`/workspace/${WORKSPACE}`} replace />} />
          </Route>
        </Routes>
        {params.get("review") !== "0" && <ReviewBar />}
      </>
    ),
  };
}
