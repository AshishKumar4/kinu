import { workspaceHome } from '@kinu.run/cli-backend';
import { childEnv, runToExit, workspaceDatabase } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { placeLocalWorkspace } from './helpers/local-refs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import { describe, expect, test } from "bun:test";
import {
  initWorkspaceSchema, MEMORY_PATH, openWorkspaceMainActor,
  type JsonValue, type SpendSource, type Usage,
} from "@kinu.run/core";
import { createWorkspace } from "@kinu.run/core/workspace-birth";
import { makeWorkspaceSchemaSql } from "@kinu.run/cli-backend";
import { wrapDatabase } from "@kinu.run/core/identity";
import { runCli } from './helpers/run-cli';

/** The CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo. */

function newProjectDir(): string {
  const dir = scratchDir("test-project");

  return dir;
}

const repoRoot = resolve(__dirname, "../../..");

const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

describe('CLI explicit endpoint options', () => {
  const flags = ['--model', 'fixture-model', '--base-url', 'http://127.0.0.1:1/v1', '--auth', 'Bearer fixture-only'];
  const environment = { KINU_MODEL: 'fixture-model', KINU_BASE_URL: 'http://127.0.0.1:1/v1', KINU_AUTH: 'Bearer fixture-only' };

  async function createEndpointWorkspace(extraEnv: Record<string, string> = {}) {
    const home = scratchDir('cli-endpoint-home');
    const kinuHome = join(home, '.kinu');
    const cwd = newProjectDir();

    const run = (args: string[], env: Record<string, string> = {}) => runToExit([process.execPath, cliBin, ...args], {
      cwd, env: childEnv({ HOME: home, KINU_HOME: kinuHome, KINU_SKIP_DAEMON: '1', ...env }),
    });

    const created = await run(['create', 'explicit-local', '--mode', 'local', '--purpose', 'Offline endpoint fixture', ...flags], extraEnv);
    expect(created.exitCode, created.stderr).toBe(0);

    return { created, home: kinuHome, run };
  }

  test('create diagnoses the supplied endpoint and does not persist its bearer', async () => {
    const { created, home, run } = await createEndpointWorkspace();

    expect(created.stdout).not.toContain('has no connected provider');
    const status = await run(['status', 'explicit-local', ...flags]);

    expect(status.exitCode, status.stderr).toBe(0);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain(environment.KINU_AUTH);
    expect(readFileSync(join(home, 'explicit-local', 'agent.db')).includes(environment.KINU_AUTH)).toBe(false);
  });

  test('status uses explicit flags without inference and matches the environment invocation', async () => {
    const { run } = await createEndpointWorkspace();
    const status = await run(['status', 'explicit-local', ...flags]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain('Offline endpoint fixture');
    expect(status.stdout).toContain('fixture-model');
    const fromEnvironment = await run(['status', 'explicit-local'], environment);

    expect(fromEnvironment.exitCode, fromEnvironment.stderr).toBe(0);
    expect(fromEnvironment.stdout).toBe(status.stdout);
  });

  test('command-line endpoint options take precedence over conflicting environment values', async () => {
    const conflicting = { KINU_MODEL: 'unknown-provider/env-model', KINU_BASE_URL: '', KINU_AUTH: '' };
    const { created, run } = await createEndpointWorkspace(conflicting);

    expect(created.stdout).toContain('fixture-model');
    expect(created.stdout).not.toContain('has no connected provider');
    const status = await run(['status', 'explicit-local', ...flags], conflicting);

    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain('fixture-model');
    expect(status.stdout).not.toContain('env-model');
  });
});

/** The production schema via `kinu create`, not a hand-written DDL copy. */
/** A placed workspace; returns the folder its ref records. */
async function createLocalAgent(home: string, name: string): Promise<string> {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = workspaceDatabase(join(dir, "agent.db"));

  try {
    const rt = await createWorkspace(db, { name, purpose: "Test purpose", home: workspaceHome(db) });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    // `search_nodes` and `agent_log` are actor-private: seed under the main actor `createWorkspace` issued;
    // rows under any other id are silently invisible to `kinu swarm` and `kinu events`.
    const actorId = openWorkspaceMainActor(wrapDatabase(db).sql).actorId;
    // Through the agent's own memory, so the file and its index are what a session leaves.
    await rt.memory.write(MEMORY_PATH, "# Memory\n\nhello local memory\n");
    await rt.memory.index(MEMORY_PATH);
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
    db.run("INSERT INTO agent_log (actor_id, id, kind, trace_id, ingress, variant, trust, priority, payload_visibility, payload, received_at) VALUES (?, ?, 'event', ?, ?, ?, ?, ?, ?, ?, ?)", [
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
    ]);
  } finally {
    db.close();
  }

  return placeLocalWorkspace(home, name);
}

test("a genuinely unreadable workspace names its cause instead of hiding it", async () => {
  const home = scratchDir("cli-unreadable");
  const dir = join(home, "broken-ws");
  mkdirSync(dir, { recursive: true });
  // Not a database: the one condition that legitimately reaches the handler.
  writeFileSync(join(dir, "agent.db"), "this is not sqlite\n");
  const folder = placeLocalWorkspace(home, "broken-ws", 'ws-broken');

  // `kinu list` lists the workspaces placed in the folder it runs in.
  const list = await runToExit([process.execPath, cliBin, "list"], { cwd: folder, env: { ...process.env, KINU_HOME: home } });
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain("unreadable:");

  // Assert contract fields, not rendered lines, which may change formatting.
  const log = readFileSync(join(home, "cli.log"), "utf-8");
  const line = log.trim().split('\n').find((row) => row.includes('workspace.read_failed'));

  if (line === undefined) throw new Error(`no workspace.read_failed diagnostic in cli.log: ${log}`);

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

    const memory = await runCli(["memory", "localtest"], { home });
    expect(memory.exitCode).toBe(0);
    expect(memory.stdout).toContain("hello local memory");

    const mcts = await runCli(["swarm", "localtest", "--json"], { home });
    expect(mcts.exitCode).toBe(0);
    expect(JSON.parse(mcts.stdout)).toEqual([
      expect.objectContaining({ id: "root", value: 0.7, status: "terminal" }),
    ]);

    const events = await runCli(["events", "localtest", "--json"], { home });
    expect(events.exitCode).toBe(0);
    expect(JSON.parse(events.stdout)).toEqual([
      expect.objectContaining({ id: "event-1", variant: "chat" }),
    ]);

    const executors = await runCli(["executors", "localtest"], { home });
    expect(executors.exitCode).toBe(0);
    expect(executors.stdout).not.toContain("device");
    expect(executors.stdout).toContain("native_binary");
  });

  // 2026-10-04: a local workspace works in its recorded folder; one without a folder is refused.
  test("kinu executors <name> workspace runs in the addressed workspace's folder, never the invoking directory", async () => {
    const home = scratchDir("cli-executor-exec");
    const placed = await createLocalAgent(home, "localtest");
    const invokedFrom = newProjectDir();

    const run = (command: string) => runToExit([process.execPath, cliBin, "executors", "localtest", "workspace", command], {
      cwd: invokedFrom, env: { ...process.env, KINU_HOME: home },
    });

    const wrote = await run("echo addressed > marker.txt && pwd");
    expect(wrote.exitCode).toBe(0);
    expect(wrote.stdout).toContain(placed);
    expect(existsSync(join(invokedFrom, "marker.txt"))).toBe(false);
    expect(readFileSync(join(placed, "marker.txt"), "utf8")).toBe("addressed\n");

    // A command's own flags are its own, and its failure ends this command with its exit and its words once.
    const flagged = await runToExit([process.execPath, cliBin, "executors", "localtest", "workspace", "ls", "-a", "no-such-entry"], {
      cwd: invokedFrom, env: { ...process.env, KINU_HOME: home },
    });

    expect({ exitCode: flagged.exitCode, stdout: flagged.stdout, said: flagged.stderr.split("no-such-entry").length - 1 }).toEqual({ exitCode: 2, stdout: "", said: 1 });

    // Without its ref the workspace has no folder, and the command runs nowhere.
    writeFileSync(join(home, "config.json"), JSON.stringify({ agents: {} }));
    const folderless = await run("pwd");
    expect(folderless.exitCode).not.toBe(0);
    expect(folderless.stderr).toContain('Workspace "localtest" has no folder');
  });

  test("kinu model normalizes specs through the provider resolver", async () => {
    const home = scratchDir("cli-model");
    await createLocalAgent(home, "localtest");
    const llmEnv = { KINU_BASE_URL: "http://localhost:1/v1", KINU_AUTH: "Bearer x" };

    const bare = await runCli(["model", "localtest", "gpt-4o-mini"], { home, env: llmEnv });
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain("workers-ai/gpt-4o-mini");

    const cf = await runCli(["model", "localtest", "@cf/meta/llama-3.1-8b-instruct"], { home, env: llmEnv });
    expect(cf.exitCode).toBe(0);
    expect(cf.stdout).toContain("workers-ai/@cf/meta/llama-3.1-8b-instruct");

    const stored = await runCli(["model", "localtest"], { home, env: llmEnv });
    expect(stored.stdout).toContain("workers-ai/@cf/meta/llama-3.1-8b-instruct");
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

    const initial = await runCli(["effort", "localtest"], { home });
    expect(initial.exitCode, initial.stderr).toBe(0);
    expect(initial.stdout).toContain("medium");

    const set = await runCli(["effort", "localtest", "high"], { home });
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("set high");

    const stored = await runCli(["effort", "localtest"], { home });
    expect(stored.stdout).toContain("high");
    const status = await runCli(["status", "localtest"], { home });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain("Effort:");
    expect(status.stdout).toContain("high");

    const invalid = await runCli(["effort", "localtest", "extreme"], { home });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("none, minimal, low, medium, high, xhigh, max");
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

    const known = await runCli(["model", "localtest", knownSpec], { home, env: llmEnv });
    expect(known.exitCode).toBe(0);

    const readPinnedModel = () => {
      const db = workspaceDatabase(join(home, 'localtest', 'agent.db'));

      try {
        return openWorkspaceMainActor(wrapDatabase(db).sql).config.getModel();
      } finally {
        db.close();
      }
    };

    expect(readPinnedModel()).toBe(knownSpec);

    const uncatalogued = await runCli(["model", "localtest", "workers-ai/@cf/meta/not-real"], { home, env: llmEnv });
    expect(uncatalogued.exitCode).toBe(0);
    expect(readPinnedModel()).toBe('workers-ai/@cf/meta/not-real');

    const unknownProvider = await runCli(["model", "localtest", "unknown/model"], { home, env: llmEnv });
    expect(unknownProvider.exitCode).toBe(1);
    expect(readPinnedModel()).toBe('workers-ai/@cf/meta/not-real');
  });

  // stderr is the person's screen, and under the TUI a stray line corrupts it.
  test("a slow model listing is logged to cli.log, not printed", async () => {
    const home = scratchDir("cli-model-slow");
    await createLocalAgent(home, "localtest");
    const slowFetch = join(home, "slow-fetch.ts");

    writeFileSync(slowFetch, `
      const now = Date.now;
      let held = 0;
      Date.now = () => now() + held;
      globalThis.fetch = async () => { held += 5_000; return new Response("{}", { status: 503 }); };
    `);

    const run = await runToExit([process.execPath, "--preload", slowFetch, cliBin, "model", "localtest", "workers-ai/@cf/meta/llama-3.1-8b-instruct"], {
      cwd: newProjectDir(),
      env: { ...process.env, KINU_HOME: home, KINU_BASE_URL: "http://localhost:1/v1", KINU_AUTH: "Bearer x" },
    });

    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(home, "cli.log"), "utf-8")).toContain("models.listing_slow");
  });

  test("cancelling a job id that names no running job in a cloud workspace cancels nothing and fails", async () => {
    const home = scratchDir("cli-cancel-none");
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ result: { ok: false } }) });

    try {
      const run = await runCli(["jobs", "cloudtest", "cancel", "no-such-job"], { home, env: {
        KINU_TOKEN: "ptc_test", KINU_ORIGIN: `http://localhost:${server.port}`,
      } });

      expect(run.exitCode).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  // `jobs` and `triggers` read opts.json, so commander must accept `--json`.
  test("jobs and triggers accept --json like every sibling inspector", async () => {
    const home = scratchDir("cli-json");
    await createLocalAgent(home, "localtest");

    for (const args of [["jobs", "localtest"], ["triggers", "localtest", "list"]]) {
      const run = await runCli([...args, "--json"], { home });
      expect([args, run.exitCode, run.stderr]).toEqual([args, 0, ""]);
      expect(JSON.parse(run.stdout)).toEqual([]);
    }
  });

  // The fire time lives in next_fire_at only, not the spec's `atMs`.
  test("a one-shot local trigger stores its fire time in next_fire_at, not the spec", async () => {
    const home = scratchDir("cli-timer");
    await createLocalAgent(home, "localtest");

    const at = "2030-01-02T03:04:05Z";
    const run = await runCli(["triggers", "localtest", "at", at], { home });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(run.stdout).toContain("scheduled");

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

  /** `kinu spend` marks the total as a floor while a measured call carried no rate, and says how many. */
  test("kinu spend names the unpriced calls that make its dollar total a floor", async () => {
    const home = scratchDir("cli-spend");
    await createLocalAgent(home, "localtest");

    const db = workspaceDatabase(join(home, "localtest", "agent.db"));

    try {
      const actorId = openWorkspaceMainActor(wrapDatabase(db).sql).actorId;

      const rows: Array<{
        source: SpendSource;
        usage: Usage;
        usd?: number;
      }> = [
        { source: "judge", usage: { input: 1_000, output: 100 }, usd: 0.0165 },
        { source: "judge", usage: { input: 2_048, output: 100, cacheWrite: 1_024, cacheWrite1h: 512 }, usd: 0.0175 },
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

    const json = await runCli(["spend", "localtest", "--json"], { home });
    expect([json.exitCode, json.stderr]).toEqual([0, ""]);

    const parsed = v.parse(
      v.object({ total: v.object({ unpricedCalls: v.number() }) }),
      JSON.parse(json.stdout),
    );

    expect(parsed.total).toEqual({ unpricedCalls: 1 });

    const printed = await runCli(["spend", "localtest"], { home });
    expect([printed.exitCode, printed.stderr]).toEqual([0, ""]);
    const out = printed.stdout;
    expect(out).toContain("$0.0340");
    expect(out).toContain("The dollar total is a floor: 1 measured call carried no models.dev rate");
  });
});

/** A cloud workspace on its account's default tier: what the workspace says it runs, not this machine's profile. */
describe("kinu model and kinu effort on an unpinned cloud workspace", () => {
  test("name the model and effort the workspace's default tier runs it on, with no profile on this machine", async () => {
    const home = scratchDir("cli-cloud-tier");

    const answers = new Map<string, JsonValue>([
      ["getStoredModelSpec", { spec: null }],
      ["getReasoningEffort", { effort: null }],
      ["getAgentStatus", {
        name: "cloudtest", purpose: "p", createdAt: 1, scaffoldVersion: 0, searchNodeCount: 0, messageCount: 0,
        model: "workers-ai/@cf/vendor/tier-model", reasoningEffort: "low",
      }],
    ]);

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/rpc")) return new Response("no", { status: 404 });
        const { method } = v.parse(v.object({ method: v.string() }), await request.json());

        return Response.json({ result: answers.get(method) ?? null });
      },
    });

    try {
      const env = { KINU_TOKEN: "ptc_test", KINU_ORIGIN: `http://localhost:${server.port}` };
      const model = await runCli(["model", "cloudtest"], { home, env });
      const effort = await runCli(["effort", "cloudtest"], { home, env });

      expect([model.exitCode, model.stdout.includes("workers-ai/@cf/vendor/tier-model (the default tier's)")]).toEqual([0, true]);
      expect([effort.exitCode, effort.stdout.includes("low (the default tier's)")]).toEqual([0, true]);
    } finally {
      await server.stop(true);
    }
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
      return await runCli(["events", "cloudtest"], { home, env: {
        KINU_TOKEN: "ptc_test",
        KINU_ORIGIN: `http://localhost:${server.port}`,
      } });
    } finally {
      await server.stop(true);
    }
  }

  test("a cloud workspace prints the rows a local one prints, character for character", async () => {
    const home = scratchDir("cli-events");
    await createLocalAgent(home, "localtest");

    const local = await runCli(["events", "localtest"], { home });
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
