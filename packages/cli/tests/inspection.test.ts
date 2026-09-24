import { scratchDir } from '../../test-utils/src/scratch';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import { describe, expect, test } from "bun:test";
import {
  initWorkspaceSchema, openWorkspaceMainActor,
  type LLMProviderConfig, type SpendSource, type Usage,
} from "@kinu.run/core";
import { createWorkspace } from "@kinu.run/core/identity";
import { makeSql, makeWorkspaceSchemaSql } from "@kinu.run/cli-backend";

/** The CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo. */
const DUMMY_LLM: LLMProviderConfig = {
  name: "fake", baseURL: "http://localhost:0", headers: {}, model: "fake-model",
};

function newProjectDir(): string {
  const dir = scratchDir("test-project");

  return dir;
}

const repoRoot = resolve(__dirname, "../../..");

const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: newProjectDir(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      KINU_HOME: home,
      ...extraEnv,
    },
  });
}

/** Async: the HTTP server the CLI calls lives on the loop `spawnSync` would hold. */
async function runCliServed(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliBin, ...args],
    cwd: newProjectDir(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, KINU_HOME: home, ...extraEnv },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

/** The production schema via `kinu create`, not a hand-written DDL copy. */
async function createLocalAgent(home: string, name: string): Promise<void> {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "agent.db"));

  try {
    await createWorkspace(db, { name, purpose: "Test purpose", llm: DUMMY_LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    // `search_nodes` and `agent_log` are actor-private: seed under the main actor `createWorkspace` issued;
    // rows under any other id are silently invisible to `kinu mcts` and `kinu events`.
    const actorId = openWorkspaceMainActor(makeSql(db)).actorId;
    db.run("INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["c1", "memory/MEMORY.md", 0, 2, "h", "# Memory\n\nhello local memory\n", 2]);
    db.run("INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation, visits, value, depth, status, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      actorId,
      "root",
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
    db.run("INSERT INTO agent_log (actor_id, id, kind, trace_id, ingress, variant, trust, priority, payload_visibility, payload, received_at, schema_version) VALUES (?, ?, 'event', ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      actorId,
      "event-1",
      "trace-1",
      "chat_ws",
      "chat",
      "owner",
      "normal",
      "full",
      JSON.stringify({ text: "hello" }),
      4,
      1,
    ]);
  } finally {
    db.close();
  }
}

test("a genuinely unreadable workspace names its cause instead of hiding it", () => {
  const home = scratchDir("cli-unreadable");
  const dir = join(home, "broken-ws");
  mkdirSync(dir, { recursive: true });
  // Not a database: the one condition that legitimately reaches the handler.
  writeFileSync(join(dir, "agent.db"), "this is not sqlite\n");

  const list = runCli(home, ["list"]);
  expect(list.exitCode).toBe(0);
  expect(list.stdout.toString()).toContain("unreadable:");

  // Assert contract fields, not rendered lines, which may change formatting.
  const line = list.stderr.toString().trim().split('\n')
    .find((row) => row.includes('workspace.read_failed'));

  if (line === undefined) throw new Error(`no workspace.read_failed diagnostic in stderr: ${list.stderr.toString()}`);

  const diagnostic = v.parse(v.object({
    event: v.literal('workspace.read_failed'),
    code: v.string(),
    cause: v.string(),
    fields: v.object({ workspace: v.literal('broken-ws') }),
  }), JSON.parse(line));

  expect(diagnostic.cause).toContain('not a database');
});

describe("CLI inspection commands", () => {
  test("inspect local durable state without model credentials", async () => {
    const home = scratchDir("cli-inspect");
    await createLocalAgent(home, "localtest");

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
    expect(executors.stdout.toString()).not.toContain("device");
    expect(executors.stdout.toString()).toContain("native_binary");
  });

  test("kinu model normalizes specs through the provider resolver", async () => {
    const home = scratchDir("cli-model");
    await createLocalAgent(home, "localtest");
    const llmEnv = { KINU_BASE_URL: "http://localhost:1/v1", KINU_AUTH: "Bearer x" };

    const bare = runCli(home, ["model", "localtest", "gpt-4o-mini"], llmEnv);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout.toString()).toContain("workers-ai/gpt-4o-mini");

    const cf = runCli(home, ["model", "localtest", "@cf/meta/llama-3.1-8b-instruct"], llmEnv);
    expect(cf.exitCode).toBe(0);
    expect(cf.stdout.toString()).toContain("workers-ai/@cf/meta/llama-3.1-8b-instruct");

    const stored = runCli(home, ["model", "localtest"], llmEnv);
    expect(stored.stdout.toString()).toContain("workers-ai/@cf/meta/llama-3.1-8b-instruct");
    // Workspace-scoped: the global config must not gain a model here.
    const configPath = join(home, "config.json");

    const globalModel = existsSync(configPath)
      ? v.parse(v.object({ model: v.optional(v.string()) }), JSON.parse(readFileSync(configPath, "utf8"))).model
      : undefined;

    expect(globalModel).toBeUndefined();
  });

  test("kinu effort sets the workspace's own effort, and status shows it", async () => {
    const home = scratchDir("cli-effort");
    await createLocalAgent(home, "localtest");

    const initial = runCli(home, ["effort", "localtest"]);
    expect(initial.exitCode, initial.stderr.toString()).toBe(0);
    expect(initial.stdout.toString()).toContain("medium");

    const set = runCli(home, ["effort", "localtest", "high"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout.toString()).toContain("set high");

    const stored = runCli(home, ["effort", "localtest"]);
    expect(stored.stdout.toString()).toContain("high");
    const status = runCli(home, ["status", "localtest"]);
    expect(status.exitCode, status.stderr.toString()).toBe(0);
    expect(status.stdout.toString()).toContain("Effort:");
    expect(status.stdout.toString()).toContain("high");

    const invalid = runCli(home, ["effort", "localtest", "extreme"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain("none, minimal, low, medium, high, xhigh, max");
  });

  test("kinu model validates known, uncatalogued, and unknown-provider specs", async () => {
    const home = scratchDir("cli-model-validation");
    await createLocalAgent(home, "localtest");
    const knownSpec = "workers-ai/@cf/moonshotai/kimi-k2.6";

    const llmEnv = {
      KINU_BASE_URL: "http://localhost:1/v1",
      KINU_AUTH: "Bearer x",
      KINU_MODEL: "@cf/moonshotai/kimi-k2.6",
    };

    const known = runCli(home, ["model", "localtest", knownSpec], llmEnv);
    expect(known.exitCode).toBe(0);
    expect(known.stdout.toString()).toContain(`set ${knownSpec}`);
    expect(known.stdout.toString()).not.toContain("not in the model catalog");

    const uncatalogued = runCli(home, ["model", "localtest", "workers-ai/@cf/meta/not-real"], llmEnv);
    expect(uncatalogued.exitCode).toBe(0);
    expect(uncatalogued.stdout.toString()).toContain("not in the model catalog");
    expect(uncatalogued.stdout.toString()).toContain("Close matches: workers-ai/");
    expect(uncatalogued.stdout.toString()).toContain("kinu chat localtest");
    expect(uncatalogued.stdout.toString()).toContain("/model");
    expect(uncatalogued.stdout.toString()).toContain("set workers-ai/@cf/meta/not-real");

    const unknownProvider = runCli(home, ["model", "localtest", "unknown/model"], llmEnv);
    expect(unknownProvider.exitCode).toBe(1);
    expect(unknownProvider.stderr.toString()).toContain('Unknown model provider "unknown"');
    expect(unknownProvider.stderr.toString()).toContain("workers-ai");
    expect(unknownProvider.stdout.toString()).not.toContain("set unknown/model");
  });

  // `jobs` and `triggers` read opts.json, so commander must accept `--json`.
  test("jobs and triggers accept --json like every sibling inspector", async () => {
    const home = scratchDir("cli-json");
    await createLocalAgent(home, "localtest");

    for (const args of [["jobs", "localtest"], ["triggers", "localtest", "list"]]) {
      const run = runCli(home, [...args, "--json"]);
      expect([args, run.exitCode, run.stderr.toString()]).toEqual([args, 0, ""]);
      expect(JSON.parse(run.stdout.toString())).toEqual([]);
    }
  });

  // The fire time lives in next_fire_at only, not the spec's `atMs`.
  test("a one-shot local trigger stores its fire time in next_fire_at, not the spec", async () => {
    const home = scratchDir("cli-timer");
    await createLocalAgent(home, "localtest");

    const at = "2030-01-02T03:04:05Z";
    const run = runCli(home, ["triggers", "localtest", "at", at]);
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    expect(run.stdout.toString()).toContain("scheduled");

    const db = new Database(join(home, "localtest", "agent.db"), { readonly: true });

    try {
      const row = v.parse(
        v.object({ spec: v.string(), nextFireAt: v.number() }),
        db.query("SELECT spec, next_fire_at AS nextFireAt FROM triggers").get(),
      );

      expect(row.nextFireAt).toBe(Date.parse(at));
      expect(JSON.parse(row.spec)).not.toHaveProperty("atMs");
    } finally {
      db.close();
    }
  });

  /** `kinu spend` marks the total as a floor, naming unpriced calls and `cacheWrite1h` calls priced at the 5m rate. */
  test("kinu spend names BOTH reasons its dollar total is a floor", async () => {
    const home = scratchDir("cli-spend");
    await createLocalAgent(home, "localtest");

    const db = new Database(join(home, "localtest", "agent.db"));

    try {
      const actorId = openWorkspaceMainActor(makeSql(db)).actorId;

      const rows: Array<{
        source: SpendSource;
        usage: Usage;
        usd?: number;
        usdFloorTokens?: number;
      }> = [
        { source: "judge", usage: { input: 1_000, output: 100 }, usd: 0.0165 },
        {
          source: "judge",
          usage: { input: 2_048, output: 100, cacheWrite: 1_024, cacheWrite1h: 512 },
          usd: 0.0175,
          usdFloorTokens: 512,
        },
        { source: "fast", usage: { input: 500, output: 50 } },
      ];

      for (const [i, payload] of rows.entries()) {
        db.run("INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts) VALUES (?, ?, ?, 'model_call', ?, ?)", [
          actorId, "workspace", i, JSON.stringify({ ...payload, eventIndex: i, runId: "workspace", timestamp: new Date(i * 1_000).toISOString() }), new Date(i * 1_000).toISOString(),
        ]);
      }
    } finally {
      db.close();
    }

    const json = runCli(home, ["spend", "localtest", "--json"]);
    expect([json.exitCode, json.stderr.toString()]).toEqual([0, ""]);

    const parsed = v.parse(
      v.object({ total: v.object({ unpricedCalls: v.number(), floorPricedCalls: v.number() }) }),
      JSON.parse(json.stdout.toString()),
    );

    expect(parsed.total).toEqual({ unpricedCalls: 1, floorPricedCalls: 1 });

    const printed = runCli(home, ["spend", "localtest"]);
    expect([printed.exitCode, printed.stderr.toString()]).toEqual([0, ""]);
    const out = printed.stdout.toString();
    expect(out).toContain("$0.0340");
    expect(out).toContain("The dollar total is a floor");
    expect(out).toContain("1 measured call carried no models.dev rate");
    expect(out).toContain("1 priced call wrote cache at a retention tier the catalog does not rate");
  });
});

/**
 * `kinu events` renders the same rows for either backend. The cloud shape here is a fixture; cf-backend's
 * unit-inspect-row-shapes.test.ts asserts the real orchestrator produces it.
 */
describe("kinu events rendering", () => {
  const CLOUD_ROW = {
    id: "event-1", trace_id: "trace-1", caused_by: null, ingress: "chat_ws",
    variant: "chat", trust: "owner", priority: "normal",
    payload_visibility: "full", payload: { text: "hello" }, received_at: 4,
  };

  type EventsAnswer = readonly (typeof CLOUD_ROW)[] | { readonly events: readonly (typeof CLOUD_ROW)[] };

  async function eventsAgainstCloud(home: string, result: EventsAnswer) {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ result }) });

    try {
      return await runCliServed(home, ["events", "cloudtest"], {
        KINU_TOKEN: "ptc_test",
        KINU_ORIGIN: `http://localhost:${server.port}`,
      });
    } finally {
      await server.stop(true);
    }
  }

  test("a cloud workspace prints the rows a local one prints, character for character", async () => {
    const home = scratchDir("cli-events");
    await createLocalAgent(home, "localtest");

    const local = await runCliServed(home, ["events", "localtest"]);
    const cloud = await eventsAgainstCloud(home, [CLOUD_ROW]);

    expect([local.exitCode, local.stderr]).toEqual([0, ""]);
    expect(local.stdout).toContain("event-1 chat chat_ws");
    expect([cloud.exitCode, cloud.stderr]).toEqual([0, ""]);
    expect(cloud.stdout).toBe(local.stdout);
  });

  test("an enveloped answer is refused by name rather than dumped as raw JSON", async () => {
    const home = scratchDir("cli-events-envelope");

    const enveloped = await eventsAgainstCloud(home, { events: [CLOUD_ROW] });

    expect(enveloped.exitCode).toBe(1);
    expect(enveloped.stderr).toContain("list of rows");
    expect(enveloped.stdout).toBe("");
  });
});
