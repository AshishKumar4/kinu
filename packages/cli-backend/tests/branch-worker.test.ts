// Local MCTS branch seam: workers explore and reflect but never score themselves (scoring is mcts/evaluation.ts in the parent).
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, test, expect, afterAll, mock } from 'bun:test';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';


import { Database } from 'bun:sqlite';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import { createBranchSpawner } from '../src/branch-process';

const dir = scratchDir('branch-test');

// Wraps `fork` to keep the child handle (the spawner's `activeBranches` is private), so tests can read raw replies
// and inject the two envelopes the real worker never emits.
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

// `branch-worker.ts` refuses a `KINU_ROOT_DB` its root-issued bootstrap does not name, so pass the runtime's own `dbPath`.
// `createCLIRuntime` stops at identity and actor tables, so the search ledger is initialised here.
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { initActorStateSchema } from '@kinu.run/core';

const parentDbPath = join(dir, 'parent.db');

const parentDb = new Database(parentDbPath, { create: true });

const parentRuntime = createCLIRuntime(parentDb, { dbPath: parentDbPath, llm: null, agentName: 'branch-parent' });

initActorStateSchema(makeWorkspaceSchemaSql(parentDb));

afterAll(() => {
  parentDb.close();
});

const replySchema = v.object({
  method: v.string(),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});

const wireBodySchema = v.record(v.string(), JsonValueSchema);

const wireMessagesSchema = v.array(v.object({ role: v.string(), content: v.string() }));

interface ModelReply {
  status: number;
  body: JsonValue;
}

const BRANCH_ANSWER = 'one read-only approach: parse with a PEG, verify against the fixture corpus';

const HISTORY = [{ role: 'user', content: 'ship a parser' }];

const LANGUAGES: [string, ...string[]] = ['typescript'];

/** OpenAI-compatible stand-in for the branch provider (`KINU_BASE_URL` + `workers-ai`); records request bodies. */
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

// A method outside BranchCallSchema is logged and dropped, never answered: the silence keeps a branch from rating itself.

describe('branch-worker protocol — no self-rating', () => {
  test('neither exploration nor reflection caps the branch model output', async () => {
    const endpoint = startModelEndpoint();
    const { spawn, abort } = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawn('uncapped-branch');

    try {
      const exploration = await handle.explore({ priorHistory: HISTORY, craftedTools: [], languages: LANGUAGES, mode: 'plan', siblings: [] });
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
      // An output cap truncates the proposal and the engine then scores the fragment.
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
    }

    const reflectMessages = v.parse(wireMessagesSchema, endpoint.bodies[1]?.messages);
    expect(reflectMessages.at(-1)?.content).toContain(BRANCH_ANSWER);
  });

  test("an 'evaluate' message is not in the protocol, so the worker answers nothing", async () => {
    const { proc, release } = await spawnWorker();
    const seen: Array<JsonValue> = [];

    const listener = (message: JsonValue): void => {
      seen.push(message);
    };

    proc.on('message', listener);

    try {
      proc.send({ method: 'evaluate', id: 99, args: { task: 'rate yourself' } });
      // A real delay: the worker is a separate process, so the wait is the assertion.
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
    // A leaked worker keeps a model-capable process and a SQLite handle alive per abandoned branch.
    const child = forkedChild();
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();

    try {
      await handle.release();
      expect(child.exitCode === null && child.signalCode === null).toBe(false);
      // `kill(pid, 0)` answers ESRCH only once the child is reaped.
      expect(() => { process.kill(pid ?? -1, 0); }).toThrow(/ESRCH/);
      await expect(handle.generateReflection('after release')).rejects.toThrow(
        /exit|closed|channel|not running|release/i,
      );
    } finally {
      await handle.release();
    }
  });
});

// An empty provider error message passes a truthiness check and later surfaces as a TypeError in the MCTS engine.
describe('branch worker failure replies', () => {
  test("an error reply always carries a message, and it is the provider's", async () => {
    const endpoint = startModelEndpoint();
    const { spawn, abort } = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawn('failing-branch');
    const replies: Array<v.InferOutput<typeof replySchema>> = [];
    forkedChild().on('message', (message: JsonValue) => {
      const parsed = v.safeParse(replySchema, message);

      if (parsed.success) replies.push(parsed.output);
    });

    try {
      endpoint.reply.status = 400;
      endpoint.reply.body = { error: { message: '' } };
      await expect(handle.explore({ priorHistory: HISTORY, craftedTools: [], languages: LANGUAGES, mode: 'plan', siblings: [] })).rejects.toThrow();
      expect(replies).toHaveLength(1);
      expect(replies[0]?.result).toBeUndefined();
      expect(replies[0]?.error).toBeDefined();
      expect(replies[0]?.error).not.toBe('');
      endpoint.reply.body = { error: { message: 'upstream exploded' } };
      await expect(handle.explore({ priorHistory: HISTORY, craftedTools: [], languages: LANGUAGES, mode: 'plan', siblings: [] }))
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

    // Call ids ascend from 1 on a fresh handle: reflection is 1, explore is 2.
    try {
      // Falsy but present: a truthiness check reads this as "no error".
      const falsyError = handle.generateReflection('ship a parser');
      proc.emit('message', { method: 'reflect', id: 1, error: '' });
      await expect(falsyError).rejects.toThrow('Branch worker failed reflect without a message');

      const noResult = handle.explore({ priorHistory: HISTORY, craftedTools: [], languages: LANGUAGES, mode: 'plan', siblings: [] });
      proc.emit('message', { method: 'explore', id: 2 });
      await expect(noResult).rejects.toThrow('Branch worker sent a malformed reply');
    } finally {
      await abort('policy-branch');
      await endpoint.stop();
    }
  });
});
