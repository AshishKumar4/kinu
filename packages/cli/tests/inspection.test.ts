import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function runCli(home: string, args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PROTEUS_HOME: home,
    },
  });
}

function createLocalAgent(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE agent_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE vfs_files (
      path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      parent_path TEXT NOT NULL DEFAULT '',
      data BLOB,
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, chunk_index)
    );
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
  db.run("INSERT INTO agent_identity (id, name, created_at) VALUES (?, ?, ?)", ["agent-1", name, 1]);
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
});
