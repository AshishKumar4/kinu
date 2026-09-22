/**
 * `kinu exec` must exit even after `shell` backgrounds a server, and the server must survive.
 * In-process tests await a promise and cannot see a process that never terminates.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { JsonObjectSchema, decodeJsonValue, parseJsonObject, type JsonObject, type JsonValue } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { present, scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';

const repoRoot = resolve(import.meta.dir, "../../..");

const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

const homes: string[] = [];

function newProjectDir(): string {
  const dir = scratchDir("cli-project");
  homes.push(dir);

  return dir;
}

/** Pid file of the writer {@link heartbeatCommand} backgrounds, so cleanup can stop it. */
const HEARTBEAT_PID = 'heartbeat.pid';

afterEach(() => {
  for (const home of homes.splice(0)) {
    // Stop leftover processes before removing the directory they write into.
    for (const pidfile of ['daemon.pid', HEARTBEAT_PID]) {
      const recorded = tolerate(() => readFileSync(join(home, pidfile), "utf-8"), 'enoent');

      if (recorded === undefined) continue;
      const pid = parseInt(recorded.trim(), 10);

      if (Number.isInteger(pid) && pid > 1) tolerate(() => process.kill(pid, "SIGTERM"), 'esrch');
    }

  }
});

function modelThatRuns(command: string) {
  let calls = 0;
  const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };

  const toolCall = {
    id: "call_1",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command }) },
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

  return { port: present(server.port, 'the mock server port'), stop: () => server.stop(true) };
}

function newHome(): string {
  const home = scratchDir("exec-lifecycle");
  homes.push(home);

  return home;
}

async function runCli(
  args: string[], env: Record<string, string>, home: string, timeoutMs: number,
): Promise<{ exitCode: number | null; elapsed: number; timedOut: boolean; stdout: string }> {
  const started = Date.now();

  const proc = Bun.spawn([process.execPath, cliBin, ...args], {
    cwd: newProjectDir(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, KINU_HOME: home },
  });

  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  clearTimeout(timer);
  const elapsed = Date.now() - started;

  return { exitCode, stdout, elapsed, timedOut: elapsed >= timeoutMs };
}

/**
 * A backgrounded server stand-in that appends to a log each second. It records its pid because
 * `rmSync(force: true)` swallows the ENOTEMPTY its next append causes. `seconds` far exceeds the
 * exit deadline: that gap is the test.
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
      KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
      KINU_AUTH: "Bearer mock",
      KINU_MODEL: "mock-model",
    };

    try {
      const created = await runCli(
        ["create", "lifecycle", "--mode", "local", "--purpose", "process lifecycle"], env, home, 120_000,
      );

      expect(created.exitCode).toBe(0);

      const run = await runCli(
        ["exec", "--workspace", "lifecycle", "--json", "Start the server"], env, home, 90_000,
      );

      // A correct run exits in seconds; one waiting on the background process cannot beat its 90s lifetime.
      expect(run.timedOut).toBe(false);
      expect(run.elapsed).toBeLessThan(30_000);
      expect(run.exitCode).toBe(0);

      // The server outlives the CLI; exiting by killing it would be worse than hanging.
      const before = readFileSync(beat, "utf-8").length;
      await Bun.sleep(2_500);
      expect(readFileSync(beat, "utf-8").length).toBeGreaterThan(before);
    } finally {
      await server.stop();
    }
  });

  test("the tool result reaches the model instead of waiting on the server", async () => {
    const home = newHome();
    const server = modelThatRuns(heartbeatCommand(home, join(home, "hb2.log"), 90));

    const env = {
      KINU_BASE_URL: `http://127.0.0.1:${server.port}`,
      KINU_AUTH: "Bearer mock",
      KINU_MODEL: "mock-model",
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

      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult?.toolCallId).toBe(events.find((event) => event.type === 'tool_call')?.toolCallId);
      expect(toolResult).toMatchObject({ success: true, toolCallId: expect.any(String) });
      expect(JSON.stringify(events)).toContain("server-started");
      expect(events.find((e) => e.type === "turn_end")).toMatchObject({ hadError: false });
    } finally {
      await server.stop();
    }
  });
  test('a native command failure carries class and observed exit in exec JSON', async () => {
    const home = newHome();
    const server = modelThatRuns('printf diagnostic; exit 7');
    const env = { KINU_BASE_URL: 'http://127.0.0.1:' + server.port, KINU_AUTH: 'Bearer mock', KINU_MODEL: 'mock-model' };

    try {
      expect((await runCli(['create', 'failureflow', '--mode', 'local', '--purpose', 'error outcome flow'], env, home, 120_000)).exitCode).toBe(0);
      const run = await runCli(['exec', '--workspace', 'failureflow', '--json', 'Run the command'], env, home, 90_000);
      expect(run.timedOut).toBe(false);
      const events = run.stdout.trim().split('\n').map(parseJsonObject);
      const result = events.find((event) => event.type === 'tool_result');
      expect(result).toMatchObject({ success: false, reason: 'io', execution: { exitCode: 7 }, result: expect.stringContaining('diagnostic') });
    } finally {
      await server.stop();
    }
  });
});
