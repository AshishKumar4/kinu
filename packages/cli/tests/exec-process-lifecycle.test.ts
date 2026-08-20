/**
 * `kinu exec` must EXIT.
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

import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { JsonObjectSchema, decodeJsonValue, parseJsonObject, type JsonObject, type JsonValue } from '@kinu/core';
import { tolerate } from '@kinu/core/obs';
import { scratchDir } from '@kinu/test-utils';
import * as v from 'valibot';

const repoRoot = resolve(import.meta.dir, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");
const homes: string[] = [];

/** Where {@link heartbeatCommand} records the pid of the writer it backgrounds,
 *  so cleanup can stop it instead of racing it. */
const HEARTBEAT_PID = 'heartbeat.pid';

afterEach(() => {
  for (const home of homes.splice(0)) {
    // Every process this suite left running, stopped before the directory it
    // writes into is removed. The daemon was already handled; the backgrounded
    // heartbeat was not, and it is what made `rmSync` a no-op that reported
    // success (see heartbeatCommand).
    for (const pidfile of ['daemon.pid', HEARTBEAT_PID]) {
      const recorded = tolerate(() => readFileSync(join(home, pidfile), "utf-8"), 'enoent');
      if (recorded === undefined) continue;
      const pid = parseInt(recorded.trim(), 10);
      if (Number.isInteger(pid) && pid > 1) tolerate(() => process.kill(pid, "SIGTERM"), 'esrch');
    }
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * An OpenAI-compatible endpoint that calls `run` once with `command`, then
 * answers with text. Non-streaming and streaming both, because the CLI picks.
 */
function modelThatRuns(command: string) {
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
      const body = v.parse(JsonObjectSchema, await request.json());
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
      const chunk = (data: JsonValue) => `data: ${JSON.stringify(data)}\n\n`;
      return new Response([
        chunk(decodeJsonValue({ value: {
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: null }],
        } })),
        chunk({
          id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: finish }], usage,
        }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

function newHome(): string {
  const home = scratchDir("exec-lifecycle");
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
 * on disk rather than a pid to chase across process groups.
 *
 * It records its own pid because "it stops on its own once the temp home goes
 * away" — what this comment used to claim — is a RACE, and the race was
 * measured: the loop reopens the log with `>>` every second, so a removal that
 * unlinks the log and then rmdirs the home loses to the next append, and
 * `rmSync(force: true)` swallows the resulting ENOTEMPTY and returns as if it
 * had succeeded. Two homes survived every run of this file that way, with the
 * same inode as before the removal — the directory was never gone, and nothing
 * said so. `afterEach` now stops the writer first.
 *
 * `seconds` is deliberately much longer than the exit deadline asserted below:
 * that gap IS the test. A shell that waits for this process to finish cannot
 * come in under the deadline.
 */
function heartbeatCommand(home: string, path: string, seconds: number): string {
  return `(for i in $(seq 1 ${seconds}); do [ -d ${home} ] || exit 0; echo alive >> ${path}; sleep 1; done) &`
    + ` echo $! > ${join(home, HEARTBEAT_PID)}; echo server-started`;
}

describe("kinu exec — a one-shot run terminates", () => {
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

      const events: JsonObject[] = run.stdout.trim().split("\n").map(parseJsonObject);

      expect(events.some((e) => e.type === "tool_call" || e.type === "tool_result")).toBe(true);
      expect(JSON.stringify(events)).toContain("server-started");
      expect(events.find((e) => e.type === "turn_end")).toMatchObject({ hadError: false });
    } finally {
      server.stop();
    }
  }, 240_000);
});
