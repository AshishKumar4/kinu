/**
 * `proteus exec` must EXIT.
 *
 * This is the assertion the whole suite structurally could not make. Every
 * other test of the one-shot path runs in-process and awaits a promise, so it
 * can prove the turn produced the right events and still be blind to whether
 * the process that produced them ever terminates. Two defects shipped straight
 * through that blind spot in one session:
 *
 *   - `settleBackgroundWork` waited on a detached job that never settles, so a
 *     one-shot run hung until the harness SIGKILLed it (6.4 of 16.2 agent-hours
 *     of dead idle across a benchmark run, found by an external benchmark and
 *     not by us).
 *   - the host shell settled on the child's `close`, which does not fire until
 *     every inherited pipe shuts, so backgrounding a server held the process
 *     open for the server's whole lifetime.
 *
 * Both are invisible to a return value and obvious to a stopwatch on a real
 * process. So this spawns the actual CLI binary against a mock model that
 * drives the actual `run` tool at a real host shell, and asserts on the exit.
 *
 * The paired assertion matters as much: the backgrounded process must SURVIVE.
 * Exiting promptly by killing the user's server would pass a naive timing test
 * and destroy the thing they asked for.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      const pid = parseInt(readFileSync(join(home, "daemon.pid"), "utf-8").trim(), 10);
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch { /* no daemon ran for this home */ }
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * An OpenAI-compatible endpoint that calls `run` once with `command`, then
 * answers with text. Non-streaming and streaming both, because the CLI picks.
 */
function modelThatRuns(command: string): { port: number; stop(): void } {
  let calls = 0;
  const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
  const toolCall = {
    id: "call_1",
    type: "function",
    function: { name: "run", arguments: JSON.stringify({ command, runtime: "laptop" }) },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json().catch(() => ({}))) as { stream?: boolean };
      const first = calls++ === 0;
      const delta = first
        ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
        : { role: "assistant", content: "started it" };
      const finish = first ? "tool_calls" : "stop";

      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-mock", object: "chat.completion", created: 1, model: "mock-model",
          choices: [{
            index: 0,
            message: first
              ? { role: "assistant", content: null, tool_calls: [toolCall] }
              : { role: "assistant", content: "started it" },
            finish_reason: finish,
          }],
          usage,
        });
      }
      const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      return new Response([
        chunk({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: null }],
        }),
        chunk({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: finish }], usage,
        }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "proteus-exec-life-"));
  homes.push(home);
  return home;
}

/** Run the CLI to completion, or report that it did not finish in time. */
async function runCli(
  args: string[], env: Record<string, string>, home: string, timeoutMs: number,
): Promise<{ exitCode: number | null; elapsed: number; timedOut: boolean; stdout: string }> {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, cliBin, ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, PROTEUS_HOME: home },
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  return { exitCode, stdout, elapsed, timedOut: elapsed >= timeoutMs };
}

/**
 * A stand-in for the server the agent was asked to start: it backgrounds, it
 * outlives the command, and it keeps touching a file so its liveness is a fact
 * on disk rather than a pid to chase across process groups. It stops on its own
 * once the temp home goes away, so cleanup never leaves it behind.
 *
 * `seconds` is deliberately much longer than the exit deadline asserted below:
 * that gap IS the test. A shell that waits for this process to finish cannot
 * come in under the deadline.
 */
function heartbeatCommand(home: string, path: string, seconds: number): string {
  return `(for i in $(seq 1 ${seconds}); do [ -d ${home} ] || exit 0; echo alive >> ${path}; sleep 1; done) &`
    + ` echo server-started`;
}

describe("proteus exec — a one-shot run terminates", () => {
  test("a turn that backgrounds a long-lived process still exits, and leaves it running", async () => {
    const home = newHome();
    const beat = join(home, "heartbeat.log");
    const server = modelThatRuns(heartbeatCommand(home, beat, 90));
    const env = {
      PROTEUS_BASE_URL: `http://127.0.0.1:${server.port}`,
      PROTEUS_AUTH: "Bearer mock",
      PROTEUS_MODEL: "mock-model",
    };
    try {
      const created = await runCli(
        ["create", "lifecycle", "--mode", "local", "--purpose", "process lifecycle"], env, home, 120_000,
      );
      expect(created.exitCode).toBe(0);

      const run = await runCli(
        ["exec", "--workspace", "lifecycle", "--json", "Start the server"], env, home, 90_000,
      );

      // The whole point. A correct run exits in a few seconds; one that waits
      // on the backgrounded process cannot beat its 90s lifetime.
      expect(run.timedOut).toBe(false);
      expect(run.elapsed).toBeLessThan(30_000);
      expect(run.exitCode).toBe(0);

      // And the process the user asked for outlived the CLI that started it —
      // exiting fast by killing it would be a worse bug than hanging.
      const before = readFileSync(beat, "utf-8").length;
      await Bun.sleep(2_500);
      expect(readFileSync(beat, "utf-8").length).toBeGreaterThan(before);
    } finally {
      server.stop();
    }
  }, 240_000);

  test("the tool result reaches the model instead of waiting on the server", async () => {
    // The same defect seen from the model's side: if the call only returns when
    // the server dies, the turn cannot continue, so `run`'s output never enters
    // the transcript. Asserting on the exit alone would not catch a variant
    // that exits promptly having dropped the result.
    const home = newHome();
    const server = modelThatRuns(heartbeatCommand(home, join(home, "hb2.log"), 90));
    const env = {
      PROTEUS_BASE_URL: `http://127.0.0.1:${server.port}`,
      PROTEUS_AUTH: "Bearer mock",
      PROTEUS_MODEL: "mock-model",
    };
    try {
      expect((await runCli(
        ["create", "resultflow", "--mode", "local", "--purpose", "tool result flow"], env, home, 120_000,
      )).exitCode).toBe(0);

      const run = await runCli(
        ["exec", "--workspace", "resultflow", "--json", "Start the server"], env, home, 90_000,
      );
      expect(run.timedOut).toBe(false);

      const events = run.stdout.trim().split("\n")
        .flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });

      expect(events.some((e) => e.type === "tool_call" || e.type === "tool_result")).toBe(true);
      expect(JSON.stringify(events)).toContain("server-started");
      expect(events.find((e) => e.type === "turn_end")).toMatchObject({ hadError: false });
    } finally {
      server.stop();
    }
  }, 240_000);
});
