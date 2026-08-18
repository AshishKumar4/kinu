import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "bun:test";

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PROTEUS_HOME: home,
      ...extraEnv,
    },
  });
}



function createLocalAgent(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE workspace_identity (id TEXT NOT NULL, name TEXT NOT NULL, mission TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE search_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      root_id TEXT,
      task TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '',
      observation TEXT NOT NULL DEFAULT '',
      code_used TEXT,
      visits INTEGER NOT NULL DEFAULT 0,
      value REAL NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      msg_id TEXT,
      branch_agent_key TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_log (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      turn_id TEXT,
      step_idx INTEGER,
      parent_id TEXT,
      trace_id TEXT NOT NULL,
      ingress TEXT,
      variant TEXT,
      trust TEXT,
      priority TEXT,
      payload_visibility TEXT,
      payload TEXT NOT NULL DEFAULT 'null',
      received_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      dedupe_key TEXT
    );
  `);
  db.run("INSERT INTO workspace_identity (id, name, mission, created_at) VALUES (?, ?, ?, ?)",
    ["agent-1", name, "Test purpose", 1]);
  // `proteus memory` reassembles the document from MemoryStore's index of it,
  // which is a table this read-only path can open (see local-inspection.ts).
  db.exec(`CREATE TABLE memory_chunks (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
    hash TEXT, text TEXT NOT NULL, updated_at INTEGER
  )`);
  db.run("INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["c1", "memory/MEMORY.md", 0, 2, "h", "# Memory\n\nhello local memory\n", 2]);
  db.run("INSERT INTO search_nodes (id, parent_id, task, action, observation, visits, value, depth, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)", [
    "root",
    "solve",
    "inspect local mcts",
    "observed",
    1,
    0.7,
    0,
    "terminal",
    3,
  ]);
  db.run("INSERT INTO agent_log (id, kind, trace_id, ingress, variant, trust, priority, payload_visibility, payload, received_at, schema_version) VALUES (?, 'event', ?, ?, ?, ?, ?, ?, ?, ?, 1)", [
    "event-1",
    "trace-1",
    "chat_ws",
    "chat",
    "owner",
    "normal",
    "full",
    JSON.stringify({ text: "hello" }),
    4,
  ]);
  db.close();
}

/** A workspace from before the workspace_identity rename: identity in
 *  `agent_identity`, and none of the tables added since (scaffold_versions,
 *  crafted_tools, ...). */
function createLegacyLocalAgent(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE agent_identity (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      mission TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  db.run("INSERT INTO agent_identity (id, name, mission, created_at) VALUES (?, ?, ?, ?)",
    ["legacy-1", name, "Run the household and the lab.", 1781042330894]);
  db.close();
}
/** A workspace from before `mission` was added to the identity table — the
 *  column exists in the CREATE and is backfilled by `reconcileColumns`
 *  (identity/schema.ts:163), but only on the OPEN path. A read-only `list` must
 *  therefore not assume it. Three of the owner's real local workspaces reported
 *  `(error reading)` for exactly this, and the fixture above hid it by including
 *  `mission`. */
function createPreMissionLocalAgent(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE workspace_identity (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  db.run("INSERT INTO workspace_identity (id, name, created_at) VALUES (?, ?, ?)",
    ["pre-mission-1", name, 1781042330894]);
  db.close();
}

describe("legacy workspaces stay readable", () => {
  test("proteus list reports a pre-rename workspace's real purpose", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-legacy-"));
    tempDirs.push(home);
    createLegacyLocalAgent(home, "jarvis-d03e0a");

    const list = runCli(home, ["list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("Run the household and the lab.");
    expect(list.stdout.toString()).not.toContain("(error reading)");
  });

  test("proteus status degrades per field instead of failing", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-legacy-status-"));
    tempDirs.push(home);
    createLegacyLocalAgent(home, "jarvis-d03e0a");

    const status = runCli(home, ["status", "jarvis-d03e0a"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain("Run the household and the lab.");
    // Absent tables read as zero rather than taking the whole workspace down.
    expect(status.stdout.toString()).toContain("Scaffold:");
    expect(status.stderr.toString()).not.toContain("readonly database");
  });

  test("a workspace predating the mission column lists without an error", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-pre-mission-"));
    tempDirs.push(home);
    createPreMissionLocalAgent(home, "jarvis-d03e0a");

    const list = runCli(home, ["list"]);
    expect(list.exitCode).toBe(0);
    const out = list.stdout.toString();
    expect(out).toContain("jarvis-d03e0a");
    // An absent column is a value, not a failure: no purpose to show, and
    // nothing about the row is reported as broken.
    expect(out).not.toContain("(error reading)");
    expect(out).not.toContain("unreadable");
    expect(list.stderr.toString()).not.toContain("no such column");
  });

  test("a genuinely unreadable workspace names its cause instead of hiding it", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-unreadable-"));
    tempDirs.push(home);
    const dir = join(home, "broken-ws");
    mkdirSync(dir, { recursive: true });
    // Not a database at all — the one condition that legitimately reaches the
    // handler. The control for the test above: absent column degrades silently,
    // an unopenable file must still say why.
    writeFileSync(join(dir, "agent.db"), "this is not sqlite\n");

    const list = runCli(home, ["list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("unreadable:");
    // Parsed, not substring-matched: the logging migration made this diagnostic
    // structured, and the contract is the FIELDS — a stable dotted event name, a
    // classification, the cause chain, and which workspace it was. Asserting the
    // rendered line instead is what made this test fail on a change that strictly
    // improved the output.
    const line = list.stderr.toString().trim().split('\n')
      .find((row) => row.includes('workspace.read_failed'));
    if (line === undefined) throw new Error(`no workspace.read_failed diagnostic in stderr: ${list.stderr.toString()}`);
    const diagnostic = v.parse(v.object({
      event: v.literal('workspace.read_failed'),
      code: v.string(),
      cause: v.string(),
      fields: v.object({ workspace: v.literal('broken-ws') }),
    }), JSON.parse(line));
    // The cause must name what the environment said, not just that something failed.
    expect(diagnostic.cause).toContain('not a database');
  });
});

/** Every test here spawns real `proteus` processes (several of them, some
 *  reaching the live model catalog), so the 5s default is not a meaningful
 *  budget — matching the import-hygiene probe's explicit allowance. */
const CLI_SPAWN_TIMEOUT_MS = 30_000;

describe("CLI inspection commands", () => {
  test("inspect local durable state without model credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-inspect-"));
    tempDirs.push(home);
    createLocalAgent(home, "localtest");

    const memory = runCli(home, ["memory", "localtest"]);
    expect(memory.exitCode).toBe(0);
    expect(memory.stdout.toString()).toContain("hello local memory");

    const mcts = runCli(home, ["mcts", "localtest", "--json"]);
    expect(mcts.exitCode).toBe(0);
    expect(JSON.parse(mcts.stdout.toString())).toEqual([
      expect.objectContaining({ id: "root", value: 0.7, status: "terminal" }),
    ]);

    const events = runCli(home, ["events", "localtest", "--json"]);
    expect(events.exitCode).toBe(0);
    expect(JSON.parse(events.stdout.toString())).toEqual([
      expect.objectContaining({ id: "event-1", variant: "chat" }),
    ]);

    const executors = runCli(home, ["executors", "localtest"]);
    expect(executors.exitCode).toBe(0);
    expect(executors.stdout.toString()).toContain("laptop");
  }, CLI_SPAWN_TIMEOUT_MS);

  test("proteus model normalizes specs through the provider resolver", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-model-"));
    tempDirs.push(home);
    createLocalAgent(home, "localtest");
    const llmEnv = { PROTEUS_BASE_URL: "http://localhost:1/v1", PROTEUS_AUTH: "Bearer x" };

    // Bare model ids get the configured fallback provider, exactly like
    // /model inside a live chat session (one normalizer, no drift).
    const bare = runCli(home, ["model", "localtest", "gpt-4o-mini"], llmEnv);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout.toString()).toContain("workers-ai/gpt-4o-mini");

    const cf = runCli(home, ["model", "localtest", "@cf/meta/llama-3.1-8b-instruct"], llmEnv);
    expect(cf.exitCode).toBe(0);
    expect(cf.stdout.toString()).toContain("workers-ai/@cf/meta/llama-3.1-8b-instruct");

    const stored = runCli(home, ["model", "localtest"], llmEnv);
    expect(stored.stdout.toString()).toContain("workers-ai/@cf/meta/llama-3.1-8b-instruct");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).model)
      .toBe("workers-ai/@cf/meta/llama-3.1-8b-instruct");
  }, CLI_SPAWN_TIMEOUT_MS);

  test("proteus effort sets workspace and global defaults and appears in status", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-effort-"));
    tempDirs.push(home);
    createLocalAgent(home, "localtest");

    const initial = runCli(home, ["effort", "localtest"]);
    expect(initial.exitCode).toBe(0);
    expect(initial.stdout.toString()).toContain("medium (chat default)");

    const set = runCli(home, ["effort", "localtest", "high"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout.toString()).toContain("set high");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).reasoningEffort).toBe("high");

    const stored = runCli(home, ["effort", "localtest"]);
    expect(stored.stdout.toString()).toContain("high");
    const status = runCli(home, ["status", "localtest"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain("Effort:");
    expect(status.stdout.toString()).toContain("high");

    const invalid = runCli(home, ["effort", "localtest", "extreme"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain("low, medium, or high");
  }, CLI_SPAWN_TIMEOUT_MS);

  test("proteus model validates known, uncatalogued, and unknown-provider specs", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-model-validation-"));
    tempDirs.push(home);
    createLocalAgent(home, "localtest");
    const knownSpec = "workers-ai/@cf/moonshotai/kimi-k2.6";
    const llmEnv = {
      PROTEUS_BASE_URL: "http://localhost:1/v1",
      PROTEUS_AUTH: "Bearer x",
      PROTEUS_MODEL: "@cf/moonshotai/kimi-k2.6",
    };

    const known = runCli(home, ["model", "localtest", knownSpec], llmEnv);
    expect(known.exitCode).toBe(0);
    expect(known.stdout.toString()).toContain(`set ${knownSpec}`);
    expect(known.stdout.toString()).not.toContain("not in the model catalog");

    const uncatalogued = runCli(home, ["model", "localtest", "workers-ai/@cf/meta/not-real"], llmEnv);
    expect(uncatalogued.exitCode).toBe(0);
    expect(uncatalogued.stdout.toString()).toContain("not in the model catalog");
    expect(uncatalogued.stdout.toString()).toContain("Close matches: workers-ai/");
    expect(uncatalogued.stdout.toString()).toContain("proteus chat localtest");
    expect(uncatalogued.stdout.toString()).toContain("/model");
    expect(uncatalogued.stdout.toString()).toContain("set workers-ai/@cf/meta/not-real");

    const unknownProvider = runCli(home, ["model", "localtest", "unknown/model"], llmEnv);
    expect(unknownProvider.exitCode).toBe(1);
    expect(unknownProvider.stderr.toString()).toContain('Unknown model provider "unknown"');
    expect(unknownProvider.stderr.toString()).toContain("workers-ai");
    expect(unknownProvider.stdout.toString()).not.toContain("set unknown/model");
  }, CLI_SPAWN_TIMEOUT_MS);

  // `jobs` and `triggers` branch on opts.json in their command bodies but were
  // never given the flag, so commander rejected the documented invocation.
  test("jobs and triggers accept --json like every sibling inspector", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-json-"));
    tempDirs.push(home);
    createLocalAgent(home, "localtest");

    for (const args of [["jobs", "localtest"], ["triggers", "localtest", "list"]]) {
      const run = runCli(home, [...args, "--json"]);
      expect([args, run.exitCode, run.stderr.toString()]).toEqual([args, 0, ""]);
      expect(JSON.parse(run.stdout.toString())).toEqual([]);
    }
  }, CLI_SPAWN_TIMEOUT_MS);
});
