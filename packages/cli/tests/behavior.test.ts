import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    stopLocalDaemon(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Local one-shot commands auto-start the scheduler daemon inside
 *  PROTEUS_HOME; kill it before the temp home disappears under it. */
function stopLocalDaemon(home: string): void {
  try {
    const pid = parseInt(readFileSync(join(home, "daemon.pid"), "utf-8").trim(), 10);
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
  } catch {
    // no daemon ran for this home
  }
}

function runCli(args: string[], opts: { home?: string; stdin?: string; env?: Record<string, string> } = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: repoRoot,
    stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(opts.home ? { PROTEUS_HOME: opts.home } : {}),
      ...(opts.env ?? {}),
    },
  });
}

function runCliInPty(args: string[], opts: { home: string; stdin?: string }) {
  const command = [
    `PROTEUS_HOME=${shellQuote(opts.home)}`,
    shellQuote(process.execPath),
    shellQuote(cliBin),
    ...args.map(shellQuote),
  ].join(" ");

  return Bun.spawnSync({
    cmd: ["script", "-qefc", command, "/dev/null"],
    cwd: repoRoot,
    stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

function writeConfig(home: string, body: unknown) {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("CLI behavior", () => {
  test("setup --account-only with an existing account does not enter the local model wizard", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-setup-account-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCli(["setup", "--account-only"], { home });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Proteus account ready");
    expect(stdout).not.toContain("Local model provider");
    expect(stdout).not.toContain("OpenAI API key");
  });

  test("interactive setup can be rerun and reaches provider choices", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-setup-rerun-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCliInPty(["setup"], { home, stdin: "7\n" });
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Local model provider");
    expect(stdout).toContain("Skipped local model setup");
  });

  test("setup --local-model keeps local provider setup explicit", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-setup-local-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCli(["setup", "--local-model", "--provider", "skip"], { home });
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Skipped local model setup");
    expect(stdout).toContain("Cloud workspaces remain ready");
  });

  test("provider list summarizes connected providers without leaking credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-providers-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      user: { id: "user_123", email: "ashish@example.com" },
      model: "codex/gpt-5.5",
      providers: {
        codex: { accessToken: "codex-access-token", refreshToken: "codex-refresh-token" },
        openai: { apiKey: "sk-secret" },
      },
    });

    const proc = runCli(["provider", "list"], { home });
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Proteus providers");
    expect(stdout).toContain("Proteus account");
    expect(stdout).toContain("Codex");
    expect(stdout).toContain("OpenAI");
    expect(stdout).not.toContain("sk-secret");
    expect(stdout).not.toContain("codex-refresh-token");
  });

  test("no-arg CLI keeps a non-interactive help fallback", () => {
    const proc = runCli([]);
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("proteus <command>");
  });

  test("subcommand help reaches the selected command instead of root help", () => {
    const proc = runCli(["run", "--help"]);
    const out = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Usage: proteus run");
    expect(out).toContain("--mode <mode>");
    expect(out).not.toContain("Self-evolving AI agent with MCTS exploration");
  });

  test("chat exposes first-class session controls", () => {
    const proc = runCli(["chat", "--help"]);
    const out = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Usage: proteus chat");
    expect(out).toContain("--resume");
    expect(out).toContain("--session <idOrPath>");
    expect(out).toContain("--fork <idOrPath>");
  });

  test("no-name chat can select a configured cloud agent", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-chat-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
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
    const stderr = proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(stderr).not.toContain("No agents found");
  });
});

describe("proteus exec (headless)", () => {
  test("requires a task prompt and exits nonzero", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-usage-"));
    tempDirs.push(home);

    const proc = runCli(["exec"], { home });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("A task prompt is required");
  });

  test("demands --workspace when several workspaces are configured", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-agents-"));
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
    const stderr = proc.stderr.toString();
    expect(stderr).toContain("Multiple workspaces configured");
    expect(stderr).toContain("alpha");
    expect(stderr).toContain("beta");
  });

  // The real hermetic smoke: a local agent created and exec'd through the
  // spawned CLI binary against a mock OpenAI-compatible endpoint — proving
  // exit codes and the line-delimited JSON event shape end to end.
  test("runs a local workspace end-to-end with --json, resumable sessions, and honest exit codes", async () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-smoke-"));
    tempDirs.push(home);
    const server = startMockLlm("Hello from mock.");
    try {
      const env = {
        PROTEUS_BASE_URL: `http://127.0.0.1:${server.port}`,
        PROTEUS_AUTH: "Bearer mock",
        PROTEUS_MODEL: "mock-model",
      };

      const created = runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke test agent"], { home, env });
      expect(created.exitCode).toBe(0);

      const proc = runCli(["exec", "--workspace", "smokey", "--json", "Say hello"], { home, env });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);

      const events = proc.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events[0]).toMatchObject({ type: "session", workspace: "smokey", backend: "local" });
      expect(events).toContainEqual(expect.objectContaining({ type: "turn_start", kind: "user", text: "Say hello" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", role: "assistant", text: "Hello from mock." }));
      const turnEnd = events.find((e) => e.type === "turn_end");
      expect(turnEnd).toMatchObject({ hadError: false });

      // The durable run-event ledger rides the same stream. Without it the log
      // is readable only from inside the agent's own database, which a
      // container-scoped run destroys on exit.
      const ledger = events
        .filter((e) => e.type === "run_event")
        .map((e) => (e as { event: { type: string } }).event);
      expect(ledger.map((e) => e.type)).toEqual(["run_start", "turn_start", "step_finish", "turn_end", "run_end"]);
      expect(ledger.every((e) => typeof (e as { runId?: unknown }).runId === "string")).toBe(true);
      expect(new Set(ledger.map((e) => (e as { runId: string }).runId)).size).toBe(1);

      // --resume continues the same recorded session instead of opening a new one.
      const sessionId = String((events[0] as { id: string }).id);
      const resumed = runCli(["exec", "--workspace", "smokey", "--json", "--resume", sessionId, "Say hello again"], { home, env });
      expect(resumed.exitCode).toBe(0);
      const resumedHeader = JSON.parse(resumed.stdout.toString().trim().split("\n")[0]!) as { id: string };
      expect(resumedHeader.id).toBe(sessionId);
    } finally {
      server.stop();
    }
  }, 120_000);

  test("exits nonzero when the model endpoint fails", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-fail-"));
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startFailingLlm();
    try {
      const goodEnv = {
        PROTEUS_BASE_URL: `http://127.0.0.1:${good.port}`,
        PROTEUS_AUTH: "Bearer mock",
        PROTEUS_MODEL: "mock-model",
      };
      expect(runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env: goodEnv }).exitCode).toBe(0);

      const proc = runCli(["exec", "--workspace", "smokey", "--json", "Say hello"], {
        home,
        env: { ...goodEnv, PROTEUS_BASE_URL: `http://127.0.0.1:${bad.port}` },
      });
      expect(proc.exitCode).toBe(1);
      const events = proc.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.some((e) => e.type === "error" || (e.type === "turn_end" && e.hadError === true))).toBe(true);
    } finally {
      good.stop();
      bad.stop();
    }
  }, 120_000);

  // --no-auto-evolve is the switch a paired benchmark arm needs: the same
  // workspace and the same turn, with the evolution machinery off.
  test("--no-auto-evolve runs the turn normally on a local workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-noevolve-"));
    tempDirs.push(home);
    const server = startMockLlm("Hello from mock.");
    try {
      const env = {
        PROTEUS_BASE_URL: `http://127.0.0.1:${server.port}`,
        PROTEUS_AUTH: "Bearer mock",
        PROTEUS_MODEL: "mock-model",
      };
      expect(runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env }).exitCode).toBe(0);

      const proc = runCli(["exec", "--workspace", "smokey", "--json", "--no-auto-evolve", "Say hello"], { home, env });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      const events = proc.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", role: "assistant", text: "Hello from mock." }));
      expect(events.some((e) => e.type === "evolution")).toBe(false);
    } finally {
      server.stop();
    }
  }, 120_000);

  // Reaching this rejection proves the flag is threaded all the way into the
  // AgentClient factory rather than parsed and dropped.
  test("--no-auto-evolve is rejected for cloud workspaces", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-noevolve-cloud-"));
    tempDirs.push(home);
    const stamp = new Date(0).toISOString();
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      agents: {
        jarvis: { name: "jarvis", mode: "cloud", cloudName: "jarvis", createdAt: stamp, updatedAt: stamp },
      },
    });

    const proc = runCli(["exec", "--workspace", "jarvis", "--json", "--no-auto-evolve", "Say hello"], { home });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("--no-auto-evolve applies to local workspaces");
  });
});

// The mechanical delegation nudge is the strongest causally-measured result in
// the program, and it was measurable only from the run_events table inside the
// agent's database — which a benchmark container deletes with the container.
// Zero nudges were observable across a whole ten-task run as a result.
describe("proteus exec --json — the delegation nudge is observable from outside", () => {
  test("a turn that grinds on one failing tool reports its nudge, trigger and conversion", async () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-exec-nudge-"));
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
        PROTEUS_BASE_URL: `http://127.0.0.1:${server.port}`,
        PROTEUS_AUTH: "Bearer mock",
        PROTEUS_MODEL: "mock-model",
      };
      expect(runCli(["create", "nudgey", "--mode", "local", "--purpose", "smoke"], { home, env }).exitCode).toBe(0);

      const proc = runCli(["exec", "--workspace", "nudgey", "--json", "--no-auto-evolve", "Fix it"], { home, env });
      const lines = proc.stdout.toString().trim().split("\n");
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

      const steers = events
        .filter((e) => e.type === "run_event")
        .map((e) => (e as { event: Record<string, unknown> }).event)
        .filter((e) => e.type === "turn_steering");
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
      expect(typeof steers[0]!.step).toBe("number");
    } finally {
      server.stop();
    }
  }, 120_000);
});

/** Minimal OpenAI-compatible /chat/completions endpoint: streams SSE chunks
 *  for stream requests and returns a completion object otherwise. */
function startMockLlm(answer: string): { port: number; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = await request.json().catch(() => ({})) as { stream?: boolean };
      const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage,
        });
      }
      const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      const sse = [
        chunk({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
        }),
        chunk({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        }),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

/** Like startMockLlm, but the first `calls` streamed responses are the SAME
 *  tool call and the next one is the final answer — a turn that grinds. */
function startToolLoopMockLlm(
  call: { name: string; arguments: string },
  calls: number,
  answer: string,
): { port: number; stop(): void } {
  let streamed = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = await request.json().catch(() => ({})) as { stream?: boolean };
      const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-mock", object: "chat.completion", created: 1, model: "mock-model",
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage,
        });
      }
      const step = streamed++;
      const chunk = (choice: unknown, extra: Record<string, unknown> = {}) =>
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
  return { port: server.port, stop: () => server.stop(true) };
}

function startFailingLlm(): { port: number; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return Response.json({ error: { message: "mock outage" } }, { status: 500 });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

/** 200 OK, then an OpenAI-shaped error object in the SSE body — the shape a
 *  provider uses to reject a request mid-stream, and the one that reached
 *  users as `[object Object]`. */
function startInBandErrorLlm(payload: unknown): { port: number; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.json().catch(() => ({})) as { stream?: boolean };
      if (!body.stream) return Response.json(payload, { status: 400 });
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

/** The Proteus worker as far as the CLI's provider registry cares: a model
 *  menu. An empty one is a signed-in account whose Cloudflare AI was never
 *  granted — the case that produced a workspace nothing could run. */
function startEmptyModelMenuOrigin(): { port: number; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/api/cli/models") return Response.json([]);
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

describe("proteus create — an unusable model is named at creation", () => {
  test("warns when the workspace's model has no connected provider", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-create-unusable-"));
    tempDirs.push(home);
    const origin = startEmptyModelMenuOrigin();
    try {
      writeConfig(home, {
        origin: `http://127.0.0.1:${origin.port}`,
        accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
        user: { id: "user_123", email: "ashish@example.com" },
      });

      // OPENAI_API_KEY in the ambient environment would supply a working
      // credential path and correctly suppress the warning.
      const proc = runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], {
        home,
        env: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
      });

      expect(proc.exitCode).toBe(0);
      const stdout = proc.stdout.toString();
      expect(stdout).toContain("has no connected provider");
      expect(stdout).toContain("proteus provider connect");
    } finally {
      origin.stop();
    }
  }, 120_000);

  test("stays quiet when the model resolves through a working provider", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-create-usable-"));
    tempDirs.push(home);
    const server = startMockLlm("ok");
    try {
      const proc = runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], {
        home,
        env: {
          PROTEUS_BASE_URL: `http://127.0.0.1:${server.port}`,
          PROTEUS_AUTH: "Bearer mock",
          PROTEUS_MODEL: "mock-model",
        },
      });

      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).not.toContain("has no connected provider");
    } finally {
      server.stop();
    }
  }, 120_000);
});

// A provider rejection used to reach the terminal twice — once as the AI SDK's
// default `console.error(rawPayload)` dump, once as our own `error
// [object Object]` — and never said which command fixed it.
describe("proteus exec — provider failures are legible and actionable", () => {
  const BILLING_ERROR = {
    error: { message: "Your account is not active.", type: "invalid_request_error", code: "billing_not_active" },
  };

  test("renders the provider's own words once, with the command that resolves it", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-provider-err-"));
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startInBandErrorLlm(BILLING_ERROR);
    try {
      const env = {
        PROTEUS_BASE_URL: `http://127.0.0.1:${good.port}`,
        PROTEUS_AUTH: "Bearer mock",
        PROTEUS_MODEL: "mock-model",
      };
      expect(runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env }).exitCode).toBe(0);

      const proc = runCli(["exec", "--workspace", "smokey", "Say hello"], {
        home,
        env: { ...env, PROTEUS_BASE_URL: `http://127.0.0.1:${bad.port}` },
      });

      const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
      expect(proc.exitCode).toBe(1);
      expect(output).not.toContain("[object Object]");
      expect(output.split("Your account is not active.").length - 1).toBe(1);
      expect(output).toContain("proteus provider");
    } finally {
      good.stop();
      bad.stop();
    }
  }, 120_000);

  test("--json carries the guidance as a field, not just as terminal decoration", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-provider-err-json-"));
    tempDirs.push(home);
    const good = startMockLlm("ok");
    const bad = startInBandErrorLlm(BILLING_ERROR);
    try {
      const env = {
        PROTEUS_BASE_URL: `http://127.0.0.1:${good.port}`,
        PROTEUS_AUTH: "Bearer mock",
        PROTEUS_MODEL: "mock-model",
      };
      expect(runCli(["create", "smokey", "--mode", "local", "--purpose", "smoke"], { home, env }).exitCode).toBe(0);

      const proc = runCli(["exec", "--workspace", "smokey", "--json", "Say hello"], {
        home,
        env: { ...env, PROTEUS_BASE_URL: `http://127.0.0.1:${bad.port}` },
      });

      expect(proc.exitCode).toBe(1);
      const events = proc.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const error = events.find((event) => event.type === "error");
      expect(error).toBeDefined();
      expect(String(error!.message)).toContain("Your account is not active.");
      expect(String(error!.hint)).toContain("proteus provider");
    } finally {
      good.stop();
      bad.stop();
    }
  }, 120_000);
});

// `proteus exec "prompt"` blocked on stdin until EOF whenever stdin was not a
// TTY. A harness or CI runner that spawns the CLI with an inherited, idle pipe
// never sends EOF, so every scripted use hung forever and needed a `</dev/null`
// incantation to work. Measured before the fix: the full 15s timeout; after: ~0.6s.
describe("proteus exec — stdin must not hang a scripted run", () => {
  test("returns promptly when argv carries the prompt and stdin stays open", async () => {
    const cli = join(import.meta.dir, "..", "bin", "cli.ts");
    const home = mkdtempSync(join(tmpdir(), "proteus-stdin-"));
    const started = Date.now();
    // stdin: 'pipe', never written to and never closed — exactly what a harness
    // that inherits an idle stdin hands the process.
    const proc = Bun.spawn(["bun", cli, "exec", "--workspace", "nonexistent", "hello"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, PROTEUS_HOME: home },
    });
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
    // The assertion is that it terminates at all, rather than waiting on an
    // EOF that never arrives.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test("a pipe that starts delivering within the grace is read to EOF — bytes are never dropped", async () => {
    const cli = join(import.meta.dir, "..", "bin", "cli.ts");
    const home = mkdtempSync(join(tmpdir(), "proteus-stdin-"));
    const proc = Bun.spawn(["bun", cli, "exec", "--workspace", "nonexistent", "hello"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PROTEUS_HOME: home },
    });
    // First chunk inside the grace window, second well past it: the old
    // whole-read race resolved '' at 250ms and dropped BOTH chunks silently.
    proc.stdin.write("chunk-one ");
    await new Promise((r) => setTimeout(r, 600));
    proc.stdin.write("chunk-two");
    await proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    rmSync(home, { recursive: true, force: true });
    // A delivering pipe is a real pipe: it must never be reported as ignored.
    expect(stderr).not.toContain("stdin was open but idle");
  }, 20_000);
});
