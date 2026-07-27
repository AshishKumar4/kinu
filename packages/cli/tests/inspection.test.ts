import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
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

const VFS_FILES_DDL = `
  CREATE TABLE vfs_files (
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    parent_path TEXT NOT NULL DEFAULT '',
    data BLOB,
    is_dir INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (path, chunk_index)
  );`;

function createLocalAgent(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE workspace_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    ${VFS_FILES_DDL}
    CREATE TABLE search_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
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
  db.run("INSERT INTO workspace_identity (id, name, created_at) VALUES (?, ?, ?)", ["agent-1", name, 1]);
  db.run("INSERT INTO vfs_files (path, chunk_index, data, is_dir, size, mtime) VALUES (?, 0, ?, 0, ?, ?)", [
    "SOUL.md",
    Buffer.from("# Test\n\n## Mission\n\nTest purpose\n"),
    33,
    1,
  ]);
  db.run("INSERT INTO vfs_files (path, chunk_index, data, is_dir, size, mtime) VALUES (?, 0, ?, 0, ?, ?)", [
    "memory/MEMORY.md",
    Buffer.from("# Memory\n\nhello local memory\n"),
    28,
    2,
  ]);
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

/** A workspace from before the workspace_identity rename and before the VFS
 *  BLOB-encoding fix: identity in `agent_identity`, SOUL.md bound as TEXT, and
 *  none of the tables added since (scaffold_versions, crafted_tools, ...). */
function createLegacyLocalAgent(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE agent_identity (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    ${VFS_FILES_DDL}
  `);
  db.run("INSERT INTO agent_identity (id, name, created_at) VALUES (?, ?, ?)", ["legacy-1", name, 1781042330894]);
  const soul = "# jarvis\n\n## Mission\n\nRun the household and the lab.";
  db.run("INSERT INTO vfs_files (path, chunk_index, data, is_dir, size, mtime) VALUES (?, 0, ?, 0, ?, ?)", [
    "SOUL.md",
    soul,
    soul.length,
    1,
  ]);
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
});

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
  });

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
  });

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
  });

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
  });
});
