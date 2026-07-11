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

    const proc = runCliInPty(["setup"], { home, stdin: "6\n" });
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
