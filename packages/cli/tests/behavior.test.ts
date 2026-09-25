import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, writeFileSync } from "node:fs";

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
import { present, runToExit } from '@kinu.run/test-utils';

/** Output to assertable text, stripped of terminal decoration. */
function toText(output: string): string {
  return Bun.stripANSI(output).replaceAll('\r\n', '\n');
}

const tempDirs: string[] = [];

function newProjectDir(): string {
  const dir = scratchDir("test-project");
  tempDirs.push(dir);

  return dir;
}

const repoRoot = resolve(__dirname, "../../..");

const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

const RequestBodySchema = v.object({ stream: v.optional(v.boolean()) });

const SessionEventSchema = v.object({ id: v.string() });

const ChatRequestSchema = v.object({
  messages: v.array(v.object({ role: v.string(), content: JsonValueSchema })),
});

const RunEventEnvelopeSchema = v.object({
  type: v.literal("run_event"),
  event: v.object({ type: v.string(), runId: v.string() }),
});

// Requiring `tool` proves a naming arm (`repeated_call`/`repeated_failure`) fired, not `no_progress`.
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

const ErrorEventSchema = v.object({
  type: v.literal("error"),
  message: v.string(),
  hint: v.string(),
});

/** `--json` turn-end usage; an absent field means the provider did not report it. */
const UsageEnvelopeSchema = v.object({ usage: UsageSchema });

const LedgerRowSchema = v.object({
  type: v.literal("run_event"),
  event: v.objectWithRest({ type: v.string() }, JsonValueSchema),
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    stopLocalDaemon(dir);
  }
});

/** Local one-shot commands auto-start the scheduler daemon; kill it before the home is removed. */
function stopLocalDaemon(home: string): void {
  const pidfile = tolerate(() => readFileSync(join(home, "daemon.pid"), "utf-8"), "enoent");

  if (pidfile === undefined) return;
  const pid = parseInt(pidfile.trim(), 10);

  if (Number.isInteger(pid) && pid > 1) tolerate(() => process.kill(pid, "SIGTERM"), "esrch");
}

function runCli(args: string[], opts: { home?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const env = { ...process.env, ...opts.env };

  if (opts.home) env.KINU_HOME = opts.home;

  return runToExit([process.execPath, cliBin, ...args], { cwd: newProjectDir(), env, stdin: opts.stdin });
}

function runCliInPty(args: string[], opts: { home: string; stdin?: string }) {
  const command = [
    `KINU_HOME=${shellQuote(opts.home)}`,
    shellQuote(process.execPath),
    shellQuote(cliBin),
    ...args.map(shellQuote),
  ].join(" ");

  return runToExit(["script", "-qefc", command, "/dev/null"], { cwd: newProjectDir(), stdin: opts.stdin });
}

function writeConfig(home: string, body: JsonObject) {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("CLI behavior", () => {
  test("setup --account-only with an existing account does not enter the local model wizard", async () => {
    const home = scratchDir("cli-setup-account");
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = await runCli(["setup", "--account-only"], { home });
    const stdout = toText(proc.stdout);
    const stderr = toText(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Kinu account ready");
    expect(stdout).not.toContain("Local model provider");
    expect(stdout).not.toContain("OpenAI API key");
  });

  test("interactive setup can be rerun and reaches provider choices", async () => {
    const home = scratchDir("cli-setup-rerun");
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = await runCliInPty(["setup"], { home, stdin: "8\n" });
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Model provider for local workspaces");
    // Native Workers AI is the recommendation and the default answer; Skip is 8.
    expect(stdout).toContain("1 Cloudflare Workers AI through your Kinu account");
    expect(stdout).toContain("(recommended)");
    expect(stdout).toContain("Choice [1]");
    expect(stdout).toContain("Skipped choosing a model provider");
  });

  test("setup --local-model keeps local provider setup explicit", async () => {
    const home = scratchDir("cli-setup-local");
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = await runCli(["setup", "--local-model", "--provider", "skip"], { home });
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Skipped choosing a model provider");
    expect(stdout).toContain("Cloud workspaces are ready");
  });

  test("provider list summarizes connected providers without leaking credentials", async () => {
    const home = scratchDir("cli-providers");
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

    const proc = await runCli(["provider", "list"], { home });
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Model providers");
    expect(stdout).toContain("Kinu account");
    expect(stdout).toContain("Codex");
    expect(stdout).toContain("OpenAI");
    expect(stdout).not.toContain("sk-secret");
    expect(stdout).not.toContain("codex-refresh-token");
  });

  test("no-arg CLI keeps a non-interactive help fallback", async () => {
    const proc = await runCli([]);
    const stdout = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("kinu <command>");
  });

  test("subcommand help reaches the selected command instead of root help", async () => {
    const proc = await runCli(["run", "--help"]);
    const out = toText(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Usage: kinu run");
    expect(out).toContain("--mode <mode>");
    expect(out).not.toContain("Self-evolving AI agent with MCTS exploration");
  });

  test("chat help offers transcript controls, never resume or fork selection", async () => {
    const proc = await runCli(["chat", "--help"]);
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

  test("no-name chat can select a configured cloud agent", async () => {
    const home = scratchDir("cli-chat");
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

    const proc = await runCli(["chat"], { home, stdin: "/exit\n" });
    const stderr = toText(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(stderr).not.toContain("No workspaces");
  });
});

describe("kinu exec (headless)", () => {
  test("requires a task prompt and exits nonzero", async () => {
    const home = scratchDir("cli-exec-usage");
    tempDirs.push(home);

    const proc = await runCli(["exec"], { home });
    expect(proc.exitCode).toBe(1);
    expect(toText(proc.stderr)).toContain("A task prompt is required");
  });

  test("demands --workspace when several workspaces are configured", async () => {
    const home = scratchDir("cli-exec-agents");
    tempDirs.push(home);
    const stamp = new Date(0).toISOString();
    writeConfig(home, {
      agents: {
        alpha: { name: "alpha", mode: "local", localName: "alpha", createdAt: stamp, updatedAt: stamp },
        beta: { name: "beta", mode: "local", localName: "beta", createdAt: stamp, updatedAt: stamp },
      },
    });

    const proc = await runCli(["exec", "do something"], { home });
    expect(proc.exitCode).toBe(1);
    const stderr = toText(proc.stderr);
    expect(stderr).toContain("Multiple workspaces configured");
    expect(stderr).toContain("alpha");
    expect(stderr).toContain("beta");
  });

  test("runs a local workspace end-to-end with --json and honest exit codes", async () => {
    const home = scratchDir("cli-exec-smoke");
    tempDirs.push(home);
    const server = startMockLlm("Hello from mock.");

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      const created = await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke test agent"], { home, env });
      expect(created.exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "smokey", "--json", "Say hello"], { home, env });
      expect(toText(proc.stderr)).toBe("");
      expect(proc.exitCode).toBe(0);

      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);
      expect(events[0]).toMatchObject({ type: "session", workspace: "smokey", backend: "local" });
      expect(events).toContainEqual(expect.objectContaining({ type: "turn_start", kind: "user", text: "Say hello" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", role: "assistant", text: "Hello from mock." }));
      const turnEnd = events.find((e) => e.type === "turn_end");
      expect(turnEnd).toMatchObject({ hadError: false });
      // The mock reports only prompt/completion tokens, so `cacheRead` is absent rather than 0,
      // even though @ai-sdk/openai-compatible fabricates cacheReadTokens: 0.
      const turnUsage = v.parse(UsageEnvelopeSchema, turnEnd).usage;
      expect(turnUsage).toEqual({ input: 5, output: 7 });
      expect(Object.keys(turnUsage).sort()).toEqual(["input", "output"]);

      const ledger = events.flatMap((event) => {
        const parsed = v.safeParse(RunEventEnvelopeSchema, event);

        return parsed.success ? [parsed.output.event] : [];
      });

      // Pinned whole so an extra or missing row cannot pass while the turn looks complete.
      expect(ledger.map((e) => e.type)).toEqual([
        "run_start", "turn_start", "profile_resolution", "model_operation", "step_partial", "step_finish",
        "model_operation", "turn_end", "run_end",
      ]);
      expect(ledger.every((e) => e.runId.length > 0)).toBe(true);
      expect(new Set(ledger.map((e) => e.runId)).size).toBe(1);

      const second = await runCli(["exec", "--workspace", "smokey", "--json", "Say hello again"], { home, env });
      expect(second.exitCode).toBe(0);

      const secondHeader = v.parse(
        SessionEventSchema,
        parseJsonObject(toText(second.stdout).trim().split("\n")[0]),
      );

      expect(secondHeader.id).not.toBe(v.parse(SessionEventSchema, events[0]).id);

      const secondTurnCall = present(
        server.requests
          .map((request) => v.parse(ChatRequestSchema, request).messages.map((m) => [m.role, m.content]))
          .find((said) => said.some(([role, content]) => role === "user" && content === "Say hello again")),
        "the second exec's model call",
      );

      expect(secondTurnCall).toContainEqual(["user", "Say hello"]);
      expect(secondTurnCall).toContainEqual(["assistant", "Hello from mock."]);
    } finally {
      await server.stop();
    }
  });

  test("exits nonzero when the model endpoint fails", async () => {
    const home = scratchDir("cli-exec-fail");
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startFailingLlm();

    try {
      const goodEnv = {
        KINU_BASE_URL: `http://127.0.0.1:${good.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      expect((await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env: goodEnv })).exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "smokey", "--json", "Say hello"], {
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
  });

  test("--no-auto-evolve runs the turn normally on a local workspace", async () => {
    const home = scratchDir("cli-exec-noevolve");
    tempDirs.push(home);
    const server = startMockLlm("Hello from mock.");

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      expect((await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "smokey", "--json", "--no-auto-evolve", "Say hello"], { home, env });
      expect(toText(proc.stderr)).toBe("");
      expect(proc.exitCode).toBe(0);
      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", role: "assistant", text: "Hello from mock." }));
      expect(events.some((e) => e.type === "evolution")).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("--no-auto-evolve is rejected for cloud workspaces", async () => {
    const home = scratchDir("cli-exec-noevolve-cloud");
    tempDirs.push(home);
    const stamp = new Date(0).toISOString();
    writeConfig(home, {
      origin: "https://kinu.example.com",
      accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
      agents: {
        jarvis: { name: "jarvis", mode: "cloud", cloudName: "jarvis", createdAt: stamp, updatedAt: stamp },
      },
    });

    const proc = await runCli(["exec", "--workspace", "jarvis", "--json", "--no-auto-evolve", "Say hello"], { home });
    expect(proc.exitCode).toBe(1);
    expect(toText(proc.stderr)).toContain("--no-auto-evolve applies to local workspaces");
  });
});

// A tool refusal's `{reason,error}` JSON is for the model; the person reads prose, and the
// refusal's diagnostic stays off their streams.
describe("kinu run — a tool refusal is rendered for the person, not the model", () => {
  test("a refused escalation prints prose under ✗ and its diagnostic lands in cli.log", async () => {
    const home = scratchDir("cli-run-refusal");
    tempDirs.push(home);

    const server = startToolLoopMockLlm(
      { name: "shell", arguments: JSON.stringify({ command: "true", runtime: "nonexistent" }) },
      1,
      "done",
    );

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      const created = await runCli(["create", "refusy", "--mode", "local", "--purpose", "refusal render"], { home, env });
      expect(created.exitCode).toBe(0);

      const proc = await runCli(["run", "refusy", "try the nonexistent runtime"], { home, env });
      expect(proc.exitCode).toBe(1);
      const stdout = toText(proc.stdout);
      expect(stdout).toContain("✗");
      expect(stdout).toContain("runtime_not_provisioned");
      expect(stdout).toContain("(unavailable)");
      expect(stdout).not.toContain('"reason"');
      const stderr = toText(proc.stderr);
      expect(stderr).not.toContain('"event"');
      expect(stderr).not.toContain("AI SDK Warning");
      expect(readFileSync(join(home, "cli.log"), "utf-8")).toContain("shell.escalation_refused");
    } finally {
      stopLocalDaemon(home);
      await server.stop();
    }
  });
});

describe("kinu exec --json — a mechanical steer is observable from outside", () => {
  test("a turn reports the steering row it wrote, with trigger, tool and conversion", async () => {
    const home = scratchDir("cli-exec-nudge");
    tempDirs.push(home);

    const server = startToolLoopMockLlm(
      { name: "shell", arguments: JSON.stringify({ command: "true", runtime: "nonexistent" }) },
      3,
      "gave up",
    );

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      expect((await runCli(["create", "nudgey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "nudgey", "--json", "--no-auto-evolve", "Fix it"], { home, env });
      const lines = toText(proc.stdout).trim().split("\n");
      const events = lines.map(parseJsonObject);

      const steers = events.flatMap((event) => {
        const parsed = v.safeParse(SteeringEnvelopeSchema, event);

        return parsed.success ? [parsed.output.event] : [];
      });

      expect(steers).toHaveLength(1);
      expect(steers[0]).toMatchObject({
        // repeated_call, not repeated_failure: the repeat detector outranks the failure counter
        // because it can name the exact call.
        trigger: "repeated_call",
        tool: "shell",
        converted: false,
      });
      expect(steers[0]?.step).toBeNumber();
    } finally {
      await server.stop();
    }
  });
});

// Turn cost is priced outside this repo (bench/clbench/kinu/events.py), so "measured nothing"
// and "measured zero" must not arrive as the same bytes.
describe("kinu exec --json — the turn-end usage payload", () => {
  test("carries no usage at all when the provider reported none", async () => {
    const home = scratchDir("cli-exec-unmetered");
    tempDirs.push(home);
    // No `usage` block: @ai-sdk/openai-compatible reports all-undefined and `normalizeUsage` returns {}.
    const server = startMockLlm("Hello from mock.", null);

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      expect((await runCli(["create", "quiet", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "quiet", "--json", "--no-auto-evolve", "Say hello"], { home, env });
      expect(proc.exitCode).toBe(0);
      const events = toText(proc.stdout).trim().split("\n").map(parseJsonObject);

      const turnEnd = events.find((e) => e.type === "turn_end");
      expect(turnEnd).toMatchObject({ hadError: false });
      expect(turnEnd && "usage" in turnEnd).toBe(false);

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
  });
});

function startMockLlm(answer: string, usage: JsonObject | null = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }) {
  const requests: JsonValue[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const raw = v.parse(JsonValueSchema, await request.json());
      requests.push(raw);
      const body = v.parse(RequestBodySchema, raw);

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

  return { port: present(server.port, 'the mock server port'), stop: () => server.stop(true), requests };
}

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

  return { port: present(server.port, 'the mock server port'), stop: () => server.stop(true) };
}

function startFailingLlm() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return Response.json({ error: { message: "mock outage" } }, { status: 500 });
    },
  });

  return { port: present(server.port, 'the mock server port'), stop: () => server.stop(true) };
}

function startInBandErrorLlm(payload: JsonValue) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      // A provider registry probes with a body-less GET first; parsing it as JSON throws inside
      // Bun.serve and fails whichever neighbouring test is running.
      if (request.method === 'GET') return Response.json({ data: [] });
      const body = v.parse(RequestBodySchema, await request.json());

      if (!body.stream) return Response.json(payload, { status: 400 });

      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  return { port: present(server.port, 'the mock server port'), stop: () => server.stop(true) };
}

/** A model menu; empty means Cloudflare AI was never granted. */
function startEmptyModelMenuOrigin() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/api/cli/models") return Response.json({ models: [], failures: [] });

      return new Response("not found", { status: 404 });
    },
  });

  return { port: present(server.port, 'the mock server port'), stop: () => server.stop(true) };
}

describe("kinu create — an unusable model is named at creation", () => {
  test("warns when the workspace's model has no connected provider", async () => {
    const home = scratchDir("cli-create-unusable");
    tempDirs.push(home);
    const origin = startEmptyModelMenuOrigin();

    try {
      writeConfig(home, {
        origin: `http://127.0.0.1:${origin.port}`,
        accessToken: ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join(""),
        user: { id: "user_123", email: "ashish@example.com" },
      });

      // Ambient credentials (a BYO key, or KINU_BASE_URL/KINU_MODEL set by another test file) would
      // suppress the warning; the subprocess starts without them.
      const proc = await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], {
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
  });

  test("stays quiet when the model resolves through a working provider", async () => {
    const home = scratchDir("cli-create-usable");
    tempDirs.push(home);
    const server = startMockLlm("ok");

    try {
      const proc = await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], {
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
  });
});

// A provider rejection prints once, in the provider's words, with the fix command.
describe("kinu exec — provider failures are legible and actionable", () => {
  const BILLING_ERROR: JsonObject = {
    error: { message: "Your account is not active.", type: "invalid_request_error", code: "billing_not_active" },
  };

  test("renders the provider's own words once, with the command that resolves it", async () => {
    const home = scratchDir("cli-provider-err");
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startInBandErrorLlm(BILLING_ERROR);

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${good.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      expect((await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "smokey", "Say hello"], {
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
  });

  test("--json carries the guidance as a field, not just as terminal decoration", async () => {
    const home = scratchDir("cli-provider-err-json");
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startInBandErrorLlm(BILLING_ERROR);

    try {
      const env = {
        KINU_BASE_URL: `http://127.0.0.1:${good.port}`,
        KINU_AUTH: "Bearer mock",
        KINU_MODEL: "mock-model",
      };

      expect((await runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env })).exitCode).toBe(0);

      const proc = await runCli(["exec", "--workspace", "smokey", "--json", "Say hello"], {
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
  });
});

// With non-TTY stdin, `kinu exec "prompt"` must not wait for EOF: a harness's idle pipe never sends one.
describe("kinu exec — stdin must not hang a scripted run", () => {
  test("returns promptly when argv carries the prompt and stdin stays open", async () => {
    const cli = join(import.meta.dir, "..", "bin", "cli.ts");
    const home = scratchDir("stdin");
    const started = Date.now();

    const proc = Bun.spawn(["bun", cli, "exec", "--workspace", "nonexistent", "hello"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, KINU_HOME: home },
    });

    await proc.exited;
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a pipe that starts delivering within the grace is read to EOF — bytes are never dropped", async () => {
    const cli = join(import.meta.dir, "..", "bin", "cli.ts");
    const home = scratchDir("stdin");

    const proc = Bun.spawn(["bun", cli, "exec", "--workspace", "nonexistent", "hello"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, KINU_HOME: home },
    });

    await proc.stdin.write("chunk-one ");
    await new Promise((r) => setTimeout(r, 600));
    await proc.stdin.write("chunk-two");
    await proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).not.toContain("stdin was open but idle");
  });
});
