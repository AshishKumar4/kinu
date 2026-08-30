import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  JsonValueSchema,
  parseJsonObject,
  UsageSchema,
  type JsonObject,
  type JsonValue,
} from "@kinu.run/core";
import { tolerate } from "@kinu.run/core/obs";
import * as v from "valibot";

/** Bytes to assertable text. Decoration and line endings are the invoking
 *  terminal talking, not the CLI's answer: both production deploys failed on
 *  tests that inherited a PTY no local run had, with colour codes landing
 *  between the tokens the assertions bind. `Bun.stripANSI` is structural — no
 *  regex, no control characters, maintained beside the renderer that emits
 *  the codes. */
function toText(bytes: Buffer): string {
  return Bun.stripANSI(bytes.toString()).replaceAll('\r\n', '\n');
}


const tempDirs: string[] = [];

/** Fresh throwaway project directory per spawn: the CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo. */
function newProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kinu-test-project-"));
  tempDirs.push(dir);
  return dir;
}

const repoRoot = resolve(__dirname, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");
const RequestBodySchema = v.object({ stream: v.optional(v.boolean()) });
const SessionEventSchema = v.object({ id: v.string() });
const RunEventEnvelopeSchema = v.object({
  type: v.literal("run_event"),
  event: v.object({ type: v.string(), runId: v.string() }),
});
// The turn-start delegation nudge carries no `tool` — nothing repeated or
// failed, so `SteeringEnvelopeSchema` below (which requires one) matches only
// the reactive steers. Kept separate rather than loosening that one: a schema
// that accepts both stops proving which arm fired.
const StartNudgeEnvelopeSchema = v.object({
  type: v.literal("run_event"),
  event: v.object({
    type: v.literal("turn_steering"),
    trigger: v.literal("turn_start_no_delegation"),
    step: v.number(),
    converted: v.boolean(),
  }),
});
const SteeringEnvelopeSchema = v.object({
  type: v.literal("run_event"),
  event: v.object({
    type: v.literal("turn_steering"),
    runId: v.string(),
    step: v.number(),
    trigger: v.string(),
    tool: v.string(),
    converted: v.boolean(),
  }),
});
/** The turn-start hint carries no `tool` — it names no failing call, because it
 *  fires before there is one. Its own envelope, so the reactive-steer schema
 *  above stays exact rather than loosening `tool` to optional. */
const StartHintEnvelopeSchema = v.object({
  type: v.literal("run_event"),
  event: v.object({
    type: v.literal("turn_steering"),
    runId: v.string(),
    step: v.number(),
    trigger: v.literal("turn_start_no_delegation"),
    converted: v.boolean(),
  }),
});
const ErrorEventSchema = v.object({
  type: v.literal("error"),
  message: v.string(),
  hint: v.string(),
});
/** The `--json` turn-end usage payload, parsed by the SAME schema the durable
 *  ledger uses. Every field is optional there because an absent field means the
 *  provider did not report it, so the tests below assert on the parsed KEYS. */
const UsageEnvelopeSchema = v.object({ usage: UsageSchema });
/** A ledger row on the `--json` stream, kept whole. `RunEventEnvelopeSchema`
 *  above narrows to two fields, which cannot answer "is this key absent?". */
const LedgerRowSchema = v.object({
  type: v.literal("run_event"),
  event: v.objectWithRest({ type: v.string() }, JsonValueSchema),
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    stopLocalDaemon(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Local one-shot commands auto-start the scheduler daemon inside
 *  KINU_HOME; kill it before the temp home disappears under it. */
function stopLocalDaemon(home: string): void {
  const pidfile = tolerate(() => readFileSync(join(home, "daemon.pid"), "utf-8"), "enoent");
  if (pidfile === undefined) return;
  const pid = parseInt(pidfile.trim(), 10);
  if (Number.isInteger(pid) && pid > 1) tolerate(() => process.kill(pid, "SIGTERM"), "esrch");
}

function runCli(args: string[], opts: { home?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const env = { ...process.env, ...opts.env };
  if (opts.home) env.KINU_HOME = opts.home;
  return Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: newProjectDir(),
    stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
}

async function runCliAsync(
  args: string[],
  opts: { home?: string; stdin?: string; env?: Record<string, string> } = {},
) {
  const env = { ...process.env, ...opts.env };
  if (opts.home) env.KINU_HOME = opts.home;
  const proc = Bun.spawn({
    cmd: [process.execPath, cliBin, ...args],
    cwd: newProjectDir(),
    stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
    proc.exited,
  ]);
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode };
}

function runCliInPty(args: string[], opts: { home: string; stdin?: string }) {
  const command = [
    `KINU_HOME=${shellQuote(opts.home)}`,
    shellQuote(process.execPath),
    shellQuote(cliBin),
    ...args.map(shellQuote),
  ].join(" ");

  return Bun.spawnSync({
    cmd: ["script", "-qefc", command, "/dev/null"],
    cwd: newProjectDir(),
    stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

function writeConfig(home: string, body: JsonObject) {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("CLI behavior", () => {
  test("setup --account-only with an existing account does not enter the local model wizard", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-setup-account-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCli(["setup", "--account-only"], { home });
    const stdout = toText(proc.stdout);
    const stderr = toText(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Kinu account ready");
    expect(stdout).not.toContain("Local model provider");
    expect(stdout).not.toContain("OpenAI API key");
  });

  test("interactive setup can be rerun and reaches provider choices", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-setup-rerun-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCliInPty(["setup"], { home, stdin: "8\n" });
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Local model provider");
    // Native Workers AI is the recommendation and the default answer; Skip is 8.
    expect(stdout).toContain("1 Cloudflare Workers AI through your Kinu account");
    expect(stdout).toContain("(recommended)");
    expect(stdout).toContain("Choice [1]");
    expect(stdout).toContain("Skipped local model setup");
  });

  test("setup --local-model keeps local provider setup explicit", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-setup-local-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCli(["setup", "--local-model", "--provider", "skip"], { home });
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Skipped local model setup");
    expect(stdout).toContain("Cloud workspaces remain ready");
  });

  test("provider list summarizes connected providers without leaking credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-providers-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
      model: "codex/gpt-5.5",
      providers: {
        codex: { accessToken: "codex-access-token", refreshToken: "codex-refresh-token" },
        openai: { apiKey: "sk-secret" },
      },
    });

    const proc = runCli(["provider", "list"], { home });
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Kinu providers");
    expect(stdout).toContain("Kinu account");
    expect(stdout).toContain("Codex");
    expect(stdout).toContain("OpenAI");
    expect(stdout).not.toContain("sk-secret");
    expect(stdout).not.toContain("codex-refresh-token");
  });

  test("no-arg CLI keeps a non-interactive help fallback", () => {
    const proc = runCli([]);
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("kinu <command>");
  });

  test("subcommand help reaches the selected command instead of root help", () => {
    const proc = runCli(["run", "--help"]);
    const out = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Usage: kinu run");
    expect(out).toContain("--mode <mode>");
    expect(out).not.toContain("Self-evolving AI agent with MCTS exploration");
  });

  test("chat help offers transcript controls, never resume or fork selection", () => {
    const proc = runCli(["chat", "--help"]);
    const out = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Usage: kinu chat");
    expect(out).toContain("--transcript-dir <dir>");
    expect(out).toContain("--no-transcript");
    expect(out).not.toContain("--resume");
    expect(out).not.toContain("--session");
    expect(out).not.toContain("--fork");
    expect(out).not.toContain("-c, --continue");
    expect(out).not.toContain("-r, --resume");
  });

  test("no-name chat can select a configured cloud agent", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-chat-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      agents: {
        jarvis: {
          name: "jarvis",
          mode: "cloud",
          cloudName: "jarvis",
          alias: "jarvis",
          purpose: "Cloud agent",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
      aliases: { jarvis: "jarvis" },
    });

    const proc = runCli(["chat"], { home, stdin: "/exit\n" });
    const stderr = toText(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(stderr).not.toContain("No agents found");
  });
});

describe("kinu exec (headless)", () => {
  test("requires a task prompt and exits nonzero", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-usage-"));
    tempDirs.push(home);

    const proc = runCli(["exec"], { home });
    expect(proc.exitCode).toBe(1);
    expect(toText(proc.stderr)).toContain("A task prompt is required");
  });

  test("demands --workspace when several workspaces are configured", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-agents-"));
    tempDirs.push(home);
    const stamp = new Date(0).toISOString();
    writeConfig(home, {
      agents: {
        alpha: { name: "alpha", mode: "local", localName: "alpha", createdAt: stamp, updatedAt: stamp },
        beta: { name: "beta", mode: "local", localName: "beta", createdAt: stamp, updatedAt: stamp },
      },
    });

    const proc = runCli(["exec", "do something"], { home });
    expect(proc.exitCode).toBe(1);
    const stderr = toText(proc.stderr);
    expect(stderr).toContain("Multiple workspaces configured");
    expect(stderr).toContain("alpha");
    expect(stderr).toContain("beta");
  });

  // The real hermetic smoke: a local agent created and exec'd through the
  // spawned CLI binary against a mock OpenAI-compatible endpoint — proving
  // exit codes and the line-delimited JSON event shape end to end.
  test("runs a local workspace end-to-end with --json and honest exit codes", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-smoke-"));
    tempDirs.push(home);
    const server = startMockLlm("Hello from mock.");
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      const created = await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke test agent"], { home, env });
      expect(created.exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "smokey", "--json", "Say hello"], { home, env });
      expect(toText(proc.stderr)).toBe("");
      expect(proc.exitCode).toBe(0);

      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);
      expect(events[0]).toMatchObject({ type: "session", workspace: "smokey", backend: "local" });
      expect(events).toContainEqual(expect.objectContaining({ type: "turn_start", kind: "user", text: "Say hello" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", role: "assistant", text: "Hello from mock." }));
      const turnEnd = events.find((e) => e.type === "turn_end");
      expect(turnEnd).toMatchObject({ hadError: false });
      // The turn's cost, field for field, as the external contract emits it.
      // The mock reports prompt and completion tokens and nothing else, so
      // exactly those two travel: `cacheRead` is ABSENT rather than 0, even
      // though the SDK dialect in between fabricates cacheReadTokens: 0
      // (@ai-sdk/openai-compatible dist/index.js:88). That is what lets a
      // reader tell "no cache reads happened" from "nobody measured them".
      const turnUsage = v.parse(UsageEnvelopeSchema, turnEnd).usage;
      expect(turnUsage).toEqual({ input: 5, output: 7 });
      expect(Object.keys(turnUsage).sort()).toEqual(["input", "output"]);

      // The durable run-event ledger rides the same stream. Without it the log
      // is readable only from inside the agent's own database, which a
      // container-scoped run destroys on exit.
      const ledger = events.flatMap((event) => {
        const parsed = v.safeParse(RunEventEnvelopeSchema, event);
        return parsed.success ? [parsed.output.event] : [];
      });
      // Profile resolution lands before the step. `closeTurnRun` then writes
      // both conditional rows between `step_finish` and `turn_end`. The mock
      // answers in one step and never delegates, so the start nudge fires and
      // its opportunity row records the non-conversion. Pin all three names so
      // the evidence cannot disappear while the turn still looks complete.
      expect(ledger.map((e) => e.type)).toEqual([
        "run_start", "turn_start", "profile_resolution", "step_finish", "turn_steering",
        "delegation_opportunity", "turn_end", "run_end",
      ]);
      const nudges = events.flatMap((e) => {
        const parsed = v.safeParse(StartNudgeEnvelopeSchema, e);
        return parsed.success ? [parsed.output.event] : [];
      });
      expect(nudges).toEqual([{
        type: "turn_steering", trigger: "turn_start_no_delegation", step: 0, converted: false,
      }]);
      expect(ledger.every((e) => e.runId.length > 0)).toBe(true);
      expect(new Set(ledger.map((e) => e.runId)).size).toBe(1);

      // A second exec opens a fresh transcript; the durable conversation
      // carries the history, never a selectable JSONL artifact.
      const second = await runCliAsync(["exec", "--workspace", "smokey", "--json", "Say hello again"], { home, env });
      expect(second.exitCode).toBe(0);
      const secondHeader = v.parse(
        SessionEventSchema,
        parseJsonObject(toText(second.stdout).trim().split("\n")[0]!),
      );
      expect(secondHeader.id).not.toBe(v.parse(SessionEventSchema, events[0]).id);
    } finally {
      await server.stop();
    }
  }, 120_000);

  test("exits nonzero when the model endpoint fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-fail-"));
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startFailingLlm();
    try {
      const goodEnv = {
        KINU_BASE_URL: `http://127.0.0.1:${good.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      expect((await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env: goodEnv })).exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "smokey", "--json", "Say hello"], {
        home,
        env: { ...goodEnv, KINU_BASE_URL: `http://127.0.0.1:${bad.port}` },
      });
      expect(proc.exitCode).toBe(1);
      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);
      expect(events.some((e) => e.type === "error" || (e.type === "turn_end" && e.hadError === true))).toBe(true);
    } finally {
      await good.stop();
      await bad.stop();
    }
  }, 120_000);

  // --no-auto-evolve is the switch a paired benchmark arm needs: the same
  // workspace and the same turn, with the evolution machinery off.
  test("--no-auto-evolve runs the turn normally on a local workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-noevolve-"));
    tempDirs.push(home);
    const server = startMockLlm("Hello from mock.");
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      expect((await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "smokey", "--json", "--no-auto-evolve", "Say hello"], { home, env });
      expect(toText(proc.stderr)).toBe("");
      expect(proc.exitCode).toBe(0);
      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", role: "assistant", text: "Hello from mock." }));
      expect(events.some((e) => e.type === "evolution")).toBe(false);
    } finally {
      await server.stop();
    }
  }, 120_000);

  // Reaching this rejection proves the flag is threaded all the way into the
  // AgentClient factory rather than parsed and dropped.
  test("--no-auto-evolve is rejected for cloud workspaces", () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-noevolve-cloud-"));
    tempDirs.push(home);
    const stamp = new Date(0).toISOString();
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      agents: {
        jarvis: { name: "jarvis", mode: "cloud", cloudName: "jarvis", createdAt: stamp, updatedAt: stamp },
      },
    });

    const proc = runCli(["exec", "--workspace", "jarvis", "--json", "--no-auto-evolve", "Say hello"], { home });
    expect(proc.exitCode).toBe(1);
    expect(toText(proc.stderr)).toContain("--no-auto-evolve applies to local workspaces");
  });
});

// A tool refusal is the `{reason,error}` payload executor tools answer failures
// on — written for the MODEL to branch on. The person watching the run must
// read prose, not that JSON, and the diagnostic the refusal logs must not land
// between them and their agent either.
describe("kinu run — a tool refusal is rendered for the person, not the model", () => {
  test("a refused escalation prints prose under ✗ and its diagnostic lands in cli.log", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-run-refusal-"));
    tempDirs.push(home);
    // An unregistered runtime fails deterministically without touching a shell.
    const server = startToolLoopMockLlm(
      { name: "run", arguments: JSON.stringify({ command: "true", runtime: "nonexistent" }) },
      1,
      "done",
    );
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      const created = await runCliAsync(["create", "refusy", "--mode", "local", "--purpose", "refusal render"], { home, env });
      expect(created.exitCode).toBe(0);

      const proc = await runCliAsync(["run", "refusy", "try the nonexistent runtime"], { home, env });
      expect(proc.exitCode).toBe(0);
      const stdout = toText(proc.stdout);
      expect(stdout).toContain("✗");
      expect(stdout).toContain("runtime_not_provisioned");
      expect(stdout).toContain("(unavailable)");
      expect(stdout).not.toContain('"reason"');
      // No diagnostic JSON on the reader's streams — the turn log owns it now.
      const stderr = toText(proc.stderr);
      expect(stderr).not.toContain('"event"');
      expect(stderr).not.toContain("AI SDK Warning");
      expect(readFileSync(join(home, "cli.log"), "utf-8")).toContain("run.escalation_refused");
    } finally {
      stopLocalDaemon(home);
      await server.stop();
    }
  }, 120_000);
});

// The mechanical delegation nudge is the strongest causally-measured result in
// the program, and it was measurable only from the run_events table inside the
// agent's database — which a benchmark container deletes with the container.
// Zero nudges were observable across a whole ten-task run as a result.
describe("kinu exec --json — the delegation nudge is observable from outside", () => {
  test("a turn reports both steering rows it wrote — the step-0 hint and the reactive nudge — with trigger and conversion", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-nudge-"));
    tempDirs.push(home);
    // Three failures from the same tool is the `repeated_failure` trigger; an
    // unregistered runtime fails deterministically without touching a shell.
    const server = startToolLoopMockLlm(
      { name: "run", arguments: JSON.stringify({ command: "true", runtime: "nonexistent" }) },
      3,
      "gave up",
    );
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      expect((await runCliAsync(["create", "nudgey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "nudgey", "--json", "--no-auto-evolve", "Fix it"], { home, env });
      const lines = toText(proc.stdout).trim().split("\n");
      const events = lines.map(parseJsonObject);

      const steers = events.flatMap((event) => {
        const parsed = v.safeParse(SteeringEnvelopeSchema, event);
        return parsed.success ? [parsed.output.event] : [];
      });
      expect(steers).toHaveLength(1);
      expect(steers[0]).toMatchObject({
        // repeated_call, not repeated_failure: the mock grinds the SAME call
        // with the same args and the same output, and the repeat detector
        // outranks the failure counter because it can name the exact call.
        trigger: "repeated_call",
        tool: "run",
        // The model was told and pushed on alone — the conversion denominator.
        converted: false,
      });
      expect(steers[0]?.step).toBeNumber();

      // Both arms of the delegation A/B leave the process, on the same turn:
      // the step-0 hint (fired before any tool ran — "Fix it" is a fresh ask
      // with no work behind it) and the reactive steer above. The bench reader
      // is the only copy of either, so a row that never reaches stdout is a row
      // the measurement cannot see.
      const hints = events.flatMap((event) => {
        const parsed = v.safeParse(StartHintEnvelopeSchema, event);
        return parsed.success ? [parsed.output.event] : [];
      });
      expect(hints).toHaveLength(1);
      expect(hints[0]).toMatchObject({ trigger: "turn_start_no_delegation", step: 0, converted: false });
    } finally {
      await server.stop();
    }
  }, 120_000);
});

// What a turn cost is priced OUTSIDE this repo: bench/clbench/kinu/events.py
// reads this stream and CL-Bench prices what it says. So "the provider measured
// nothing" and "the provider measured zero" must not arrive as the same bytes.
describe("kinu exec --json — the turn-end usage payload", () => {
  test("carries no usage at all when the provider reported none", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-exec-unmetered-"));
    tempDirs.push(home);
    // The one difference from the metered smoke above: no `usage` block on the
    // completion — which @ai-sdk/openai-compatible turns into an all-undefined
    // report (dist/index.js:68-84) and `normalizeUsage` into {}.
    const server = startMockLlm("Hello from mock.", null);
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      expect((await runCliAsync(["create", "quiet", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "quiet", "--json", "--no-auto-evolve", "Say hello"], { home, env });
      expect(proc.exitCode).toBe(0);
      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);

      const turnEnd = events.find((e) => e.type === "turn_end");
      expect(turnEnd).toMatchObject({ hadError: false });
      // The key is ABSENT — not present-and-zero, not present-and-null. A
      // reader pricing `usage.input ?? 0` gets nothing to price.
      expect(turnEnd && "usage" in turnEnd).toBe(false);

      // The enveloped ledger row on the same stream says the same thing, so the
      // two copies of one fact cannot disagree about a silent turn.
      const ledger = events.flatMap((event) => {
        const parsed = v.safeParse(LedgerRowSchema, event);
        return parsed.success ? [parsed.output.event] : [];
      });
      const ledgerTurnEnd = ledger.find((row) => row.type === "turn_end");
      expect(ledgerTurnEnd).toBeDefined();
      expect(ledgerTurnEnd && "usage" in ledgerTurnEnd).toBe(false);
    } finally {
      await server.stop();
    }
  }, 120_000);
});

/** Minimal OpenAI-compatible /chat/completions endpoint: streams SSE chunks
 *  for stream requests and returns a completion object otherwise. `usage: null`
 *  omits the usage block entirely — the provider that measures nothing. */
function startMockLlm(answer: string, usage: JsonObject | null = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = v.parse(RequestBodySchema, await request.json());
      if (!body.stream) {
        const completion: JsonObject = {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        };
        if (usage) completion.usage = usage;
        return Response.json(completion);
      }
      const chunk = (data: JsonValue) => `data: ${JSON.stringify(data)}\n\n`;
      const finalChunk: JsonObject = {
        id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      if (usage) finalChunk.usage = usage;
      const sse = [
        chunk({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
        }),
        chunk(finalChunk),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

/** Like startMockLlm, but the first `calls` streamed responses are the SAME
 *  tool call and the next one is the final answer — a turn that grinds. */
function startToolLoopMockLlm(
  call: { name: string; arguments: string },
  calls: number,
  answer: string,
) {
  let streamed = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = v.parse(RequestBodySchema, await request.json());
      const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-mock", object: "chat.completion", created: 1, model: "mock-model",
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage,
        });
      }
      const step = streamed++;
      const chunk = (choice: JsonObject, extra: JsonObject = {}) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [choice], ...extra,
        })}\n\n`;
      const body_ = step < calls
        ? [
            chunk({
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0, id: `call-${step}`, type: "function",
                  function: { name: call.name, arguments: call.arguments },
                }],
              },
              finish_reason: null,
            }),
            chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }, { usage }),
          ]
        : [
            chunk({ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }),
            chunk({ index: 0, delta: {}, finish_reason: "stop" }, { usage }),
          ];
      return new Response([...body_, "data: [DONE]\n\n"].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

function startFailingLlm() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return Response.json({ error: { message: "mock outage" } }, { status: 500 });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

/** 200 OK, then an OpenAI-shaped error object in the SSE body — the shape a
 *  provider uses to reject a request mid-stream, and the one that reached
 *  users as `[object Object]`. */
function startInBandErrorLlm(payload: JsonValue) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      // A provider registry lists the endpoint's models before it completes
      // anything, and that probe is a GET with no body. Parsing one as JSON
      // threw INSIDE Bun.serve, which surfaces as an unhandled error "between
      // tests" and fails whichever neighbour happens to be running.
      if (request.method === 'GET') return Response.json({ data: [] });
      const body = v.parse(RequestBodySchema, await request.json());
      if (!body.stream) return Response.json(payload, { status: 400 });
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

/** The Kinu worker as far as the CLI's provider registry cares: a model
 *  menu. An empty one is a signed-in account whose Cloudflare AI was never
 *  granted — the case that produced a workspace nothing could run. */
function startEmptyModelMenuOrigin() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/api/cli/models") return Response.json({ models: [], failures: [] });
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

describe("kinu create — an unusable model is named at creation", () => {
  test("warns when the workspace's model has no connected provider", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-create-unusable-"));
    tempDirs.push(home);
    const origin = startEmptyModelMenuOrigin();
    try {
      writeConfig(home, {
        origin: `http://127.0.0.1:${origin.port}`,
        accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
        user: { id: "user_123", email: "ashish@example.com" },
      });

      // Any ambient credential path — a BYO key, or the KINU_BASE_URL /
      // KINU_MODEL direct-endpoint override another test file sets on this
      // process — would supply a working provider and correctly suppress the
      // warning. The subprocess starts without them.
      const proc = await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke"], {
        home,
        env: {
          OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "",
          KINU_BASE_URL: "", KINU_AUTH: "", KINU_MODEL: "",
        },
      });

      expect(proc.exitCode).toBe(0);
      const stdout = toText(proc.stdout);
      expect(stdout).toContain("has no connected provider");
      expect(stdout).toContain("kinu provider connect");
    } finally {
      await origin.stop();
    }
  }, 120_000);

  test("stays quiet when the model resolves through a working provider", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-create-usable-"));
    tempDirs.push(home);
    const server = startMockLlm("ok");
    try {
      const proc = await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke"], {
        home,
        env: {
          KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
          KINU_AUTH: "Bearer mock",
          KINU_MODEL: "mock-model",
        },
      });

      expect(proc.exitCode).toBe(0);
      expect(toText(proc.stdout)).not.toContain("has no connected provider");
    } finally {
      await server.stop();
    }
  }, 120_000);
});

// A provider rejection used to reach the terminal twice — once as the AI SDK's
// default `console.error(rawPayload)` dump, once as our own `error
// [object Object]` — and never said which command fixed it.
describe("kinu exec — provider failures are legible and actionable", () => {
  const BILLING_ERROR: JsonObject = {
    error: { message: "Your account is not active.", type: "invalid_request_error", code: "billing_not_active" },
  };

  test("renders the provider's own words once, with the command that resolves it", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-provider-err-"));
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startInBandErrorLlm(BILLING_ERROR);
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${good.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      expect((await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "smokey", "Say hello"], {
        home,
        env: { ...env, KINU_BASE_URL: `http://127.0.0.1:${bad.port}` },
      });

      const output = `${toText(proc.stdout)}${toText(proc.stderr)}`;
      expect(proc.exitCode).toBe(1);
      expect(output).not.toContain("[object Object]");
      expect(output.split("Your account is not active.").length - 1).toBe(1);
      expect(output).toContain("kinu provider");
    } finally {
      await good.stop();
      await bad.stop();
    }
  }, 120_000);

  test("--json carries the guidance as a field, not just as terminal decoration", async () => {
    const home = mkdtempSync(join(tmpdir(), "kinu-cli-provider-err-json-"));
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startInBandErrorLlm(BILLING_ERROR);
    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${good.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };
      expect((await runCliAsync(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCliAsync(["exec", "--workspace", "smokey", "--json", "Say hello"], {
        home,
        env: { ...env, KINU_BASE_URL: `http://127.0.0.1:${bad.port}` },
      });

      expect(proc.exitCode).toBe(1);
      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);
      const error = events.flatMap((event) => {
        const parsed = v.safeParse(ErrorEventSchema, event);
        return parsed.success ? [parsed.output] : [];
      })[0];
      expect(error).toBeDefined();
      expect(error?.message).toContain("Your account is not active.");
      expect(error?.hint).toContain("kinu provider");
    } finally {
      await good.stop();
      await bad.stop();
    }
  }, 120_000);
});

// `kinu exec "prompt"` blocked on stdin until EOF whenever stdin was not a
// TTY. A harness or CI runner that spawns the CLI with an inherited, idle pipe
// never sends EOF, so every scripted use hung forever and needed a `</dev/null`
// incantation to work. Measured before the fix: the full 15s timeout; after: ~0.6s.
describe("kinu exec — stdin must not hang a scripted run", () => {
  test("returns promptly when argv carries the prompt and stdin stays open", async () => {
    const cli = join(import.meta.dir, "..", "bin", "cli.ts");
    const home = mkdtempSync(join(tmpdir(), "kinu-stdin-"));
    const started = Date.now();
    // stdin: 'pipe', never written to and never closed — exactly what a harness
    // that inherits an idle stdin hands the process.
    const proc = Bun.spawn(["bun", cli, "exec", "--workspace", "nonexistent", "hello"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, KINU_HOME: home },
    });
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
    // The assertion is that it terminates at all, rather than waiting on an
    // EOF that never arrives.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test("a pipe that starts delivering within the grace is read to EOF — bytes are never dropped", async () => {
    const cli = join(import.meta.dir, "..", "bin", "cli.ts");
    const home = mkdtempSync(join(tmpdir(), "kinu-stdin-"));
    const proc = Bun.spawn(["bun", cli, "exec", "--workspace", "nonexistent", "hello"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, KINU_HOME: home },
    });
    // First chunk inside the grace window, second well past it: the old
    // whole-read race resolved '' at 250ms and dropped BOTH chunks silently.
    await proc.stdin.write("chunk-one ");
    await new Promise((r) => setTimeout(r, 600));
    await proc.stdin.write("chunk-two");
    await proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    rmSync(home, { recursive: true, force: true });
    // A delivering pipe is a real pipe: it must never be reported as ignored.
    expect(stderr).not.toContain("stdin was open but idle");
  }, 20_000);
});
