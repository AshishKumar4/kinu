// Seam test for the local MCTS branch path: forked branch workers EXPLORE
// and REFLECT but cannot score themselves — scoring happens in the parent
// process at the core engine seam (mcts/evaluation.ts). A worker that still
// answered 'evaluate' would mean same-model self-rating snuck back in.
//
// Every test here drives the real fork: `createBranchSpawner` forks the real
// `branch-worker.ts`, which resolves a real provider and talks HTTP to the
// capturing endpoint below, so the request a branch actually put on the wire and
// the reply envelope it actually sent are both observable.
import { describe, test, expect, afterAll, mock } from 'bun:test';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import { createBranchSpawner } from '../src/branch-process';

const dir = mkdtempSync(join(tmpdir(), 'kinu-branch-test-'));

// The spawner keeps its ChildProcess private (`activeBranches`), so the
// parent-side reply policy cannot be reached without the handle. This wraps
// `fork`: the real one still runs and its real child is what the spawner gets —
// the test only keeps the handle too, so it can read the worker's raw reply
// envelopes and deliver the two the shipped worker deliberately never emits (a
// falsy-but-present error, a missing result).
const realFork = childProcess.fork;
let lastForked: ChildProcess | null = null;
await mock.module('node:child_process', () => ({
  ...childProcess,
  fork: (...args: Parameters<typeof childProcess.fork>): ChildProcess => {
    lastForked = realFork(...args);
    return lastForked;
  },
}));

function forkedChild(): ChildProcess {
  if (!lastForked) throw new Error('the spawner forked no child process');
  return lastForked;
}

// The spawner is handed the workspace's ONE database — the same file the parent
// runtime holds, which is what a branch's own process opens to bind its actor
// row. It is no longer a base path the spawner decorates: `branch-worker.ts`
// refuses a `KINU_ROOT_DB` its root-issued bootstrap does not name, so a
// fixture that passes anything but the runtime's own `dbPath` gets a child that
// exits before `ready`.
//
// `createCLIRuntime` on a root path stops at the identity and actor tables, so
// the search ledger the branch's own rollouts land in is initialised here.
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { initActorStateSchema } from '@kinu.run/core';
const parentDbPath = `${dir}.db`;
const parentDb = new Database(parentDbPath, { create: true });
const parentRuntime = createCLIRuntime(parentDb, { dbPath: parentDbPath, llm: null, hostRoot: null, agentName: 'branch-parent' });
initActorStateSchema(makeWorkspaceSchemaSql(parentDb));

afterAll(() => {
  parentDb.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(parentDbPath, { force: true });
});

const replySchema = v.object({
  method: v.string(),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});
const wireBodySchema = v.record(v.string(), JsonValueSchema);
const wireMessagesSchema = v.array(v.object({ role: v.string(), content: v.string() }));

/** What the endpoint answers with: a completion, or an upstream failure. */
interface ModelReply {
  status: number;
  body: JsonValue;
}

const BRANCH_ANSWER = 'one read-only approach: parse with a PEG, verify against the fixture corpus';
const HISTORY = [{ role: 'user', content: 'ship a parser' }];
const LANGUAGES: [string, ...string[]] = ['typescript'];

/**
 * An OpenAI-compatible endpoint standing in for the provider a branch resolves
 * (`KINU_BASE_URL` + `workers-ai` is the CLI's local-gateway path). It records
 * every request body the worker's provider stack actually sent, and `reply` lets a
 * test answer the way a failing upstream does.
 */
function startModelEndpoint() {
  const bodies: Array<Record<string, JsonValue>> = [];
  const reply: ModelReply = {
    status: 200,
    body: {
      id: 'cmpl-branch-test',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: BRANCH_ANSWER }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(v.parse(wireBodySchema, await request.json()));
      return Response.json(reply.body, { status: reply.status });
    },
  });
  return {
    bodies,
    reply,
    stop: () => server.stop(true),
    llm: {
      name: 'workers-ai',
      baseURL: `http://127.0.0.1:${String(server.port)}/v1`,
      headers: { Authorization: 'Bearer branch-test' },
      model: 'test-model',
    },
  };
}

async function spawnWorker() {
  const spawner = createBranchSpawner(parentDbPath, { llm: null, parent: parentRuntime.actor });
  const handle = await spawner.spawn('protocol-only');
  return { proc: forkedChild(), release: () => handle.release() };
}

// The worker answers only what BranchCallSchema parses. A method outside the
// protocol is unattributable, so it is logged and dropped, never executed and
// never answered — that silence is what keeps a branch from rating itself.

describe('branch-worker protocol — no self-rating', () => {
  test('neither exploration nor reflection caps the branch model output', async () => {
    const endpoint = startModelEndpoint();
    const { spawn, abort } = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawn('uncapped-branch');
    try {
      const exploration = await handle.explore(HISTORY, [], LANGUAGES, 'plan', []);
      expect(exploration.text).toBe(BRANCH_ANSWER);
      const reflection = await handle.generateReflection('ship a parser', 'the fixture corpus still fails');
      expect(reflection.text).toBe(BRANCH_ANSWER);
    } finally {
      await abort('uncapped-branch');
      await endpoint.stop();
    }

    expect(endpoint.bodies).toHaveLength(2);
    for (const body of endpoint.bodies) {
      expect(body.model).toBe('test-model');
      // An output cap on a whole exploration truncates the proposal mid-sentence
      // and the engine then scores the fragment.
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
    }
    // Reflection is about the attempt THIS branch made — its own trace row, not
    // the bare task string.
    const reflectMessages = v.parse(wireMessagesSchema, endpoint.bodies[1]?.messages);
    expect(reflectMessages.at(-1)?.content).toContain(BRANCH_ANSWER);
  });

  test("'evaluate' is not part of the protocol anymore", async () => {
    const { proc, release } = await spawnWorker();
    const seen: Array<JsonValue> = [];
    const listener = (message: JsonValue): void => {
      seen.push(message);
    };
    proc.on('message', listener);
    try {
      proc.send({ method: 'evaluate', id: 99, args: { task: 'rate yourself' } });
      // A real delay: the worker is a separate process, so no in-process
      // event marks "it chose silence" — the wait IS the assertion.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1000);
      await promise;
      expect(seen).toEqual([]);
    } finally {
      proc.off('message', listener);
      await release();
    }
  });

  test('a branch handle releases its exact process after the final read', async () => {
    const { spawn } = createBranchSpawner(parentDbPath, { llm: { name: 'workers-ai', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' }, parent: parentRuntime.actor });
    const handle = await spawn('seam-test-branch');
    try {
      await handle.release();
      await expect(handle.generateReflection('after release')).rejects.toThrow();
    } finally {
      await handle.release();
    }
  });
});

// A branch failure must arrive as a legible error, never as a silently
// "successful" empty result. A provider error whose .message is empty used to
// pass the parent's truthiness check, resolve `undefined`, and surface much
// later as a TypeError inside the MCTS engine — the real provider error lost.
describe('branch worker failure replies', () => {
  test("an error reply always carries a message, and it is the provider's", async () => {
    const endpoint = startModelEndpoint();
    const { spawn, abort } = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawn('failing-branch');
    // The worker's own reply envelopes, read off the real IPC channel: the
    // spawner's promise only ever shows what the PARENT made of them.
    const replies: Array<v.InferOutput<typeof replySchema>> = [];
    forkedChild().on('message', (message: JsonValue) => {
      const parsed = v.safeParse(replySchema, message);
      if (parsed.success) replies.push(parsed.output);
    });
    try {
      // A real provider failure whose own message is empty — the shape that used
      // to travel back as `error: ''`.
      endpoint.reply.status = 400;
      endpoint.reply.body = { error: { message: '' } };
      await expect(handle.explore(HISTORY, [], LANGUAGES, 'plan', [])).rejects.toThrow();
      // One reply, and it parsed as the envelope — so `error` is a string by the
      // schema above, and what is left to hold is that it is there and says
      // something.
      expect(replies).toHaveLength(1);
      expect(replies[0]?.result).toBeUndefined();
      expect(replies[0]?.error).toBeDefined();
      expect(replies[0]?.error).not.toBe('');
      // And when the provider did say something, that is what comes back —
      // never a constant standing in for it.
      endpoint.reply.body = { error: { message: 'upstream exploded' } };
      await expect(handle.explore(HISTORY, [], LANGUAGES, 'plan', []))
        .rejects.toThrow('upstream exploded');
      expect(replies).toHaveLength(2);
      expect(replies[1]?.error).toBe('upstream exploded');
    } finally {
      await abort('failing-branch');
      await endpoint.stop();
    }
  });

  test('the parent rejects on error PRESENCE, not truthiness, and on a missing result', async () => {
    const endpoint = startModelEndpoint();
    const { spawn, abort } = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawn('policy-branch');
    const proc = forkedChild();
    // The parent tags every call on a child with ascending ids from 1, and a
    // reply settles the wait with its id. This handle is fresh, so the forged
    // replies below name the reflection wait 1 and the explore wait 2.
    try {
      // Falsy but PRESENT: a truthiness check reads this as "no error".
      const falsyError = handle.generateReflection('ship a parser');
      proc.emit('message', { method: 'reflect', id: 1, error: '' });
      await expect(falsyError).rejects.toThrow('Branch worker failed reflect without a message');

      // Neither error nor result: the reply is outside the protocol, and the
      // wait rejects instead of handing the engine `undefined`.
      const noResult = handle.explore(HISTORY, [], LANGUAGES, 'plan', []);
      proc.emit('message', { method: 'explore', id: 2 });
      await expect(noResult).rejects.toThrow('Branch worker sent a malformed reply');
    } finally {
      await abort('policy-branch');
      await endpoint.stop();
    }
  });
});
