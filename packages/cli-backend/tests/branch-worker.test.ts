// Seam test for the local MCTS branch path: forked branch workers EXPLORE
// and REFLECT but cannot score themselves — scoring happens in the parent
// process at the core engine seam (mcts/evaluation.ts). A worker that still
// answered 'evaluate' would mean same-model self-rating snuck back in.
import { describe, test, expect, afterAll } from 'bun:test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonValueSchema, type JsonValue } from '@proteus/core';
import * as v from 'valibot';

const dir = mkdtempSync(join(tmpdir(), 'proteus-branch-test-'));
const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'branch-worker.ts');
let child: ChildProcess | null = null;

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

async function spawnWorker(): Promise<ChildProcess> {
  if (child) return child;
  child = fork(workerPath, [join(dir, 'branch.db')], { stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker startup timeout')), 30_000);
    child!.on('message', (msg: { method: string }) => {
      if (msg.method === 'ready') { clearTimeout(timeout); resolve(); }
    });
    child!.on('error', reject);
  });
  return child;
}

function rpc(proc: ChildProcess, method: string, args: JsonValue) {
  return new Promise<{ method: string; result?: JsonValue; error?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('rpc timeout')), 10_000);
    const handler = (message: JsonValue) => {
      const parsed = v.safeParse(v.object({
        method: v.string(),
        result: v.optional(JsonValueSchema),
        error: v.optional(v.string()),
      }), message);
      if (parsed.success && parsed.output.method === method) {
        clearTimeout(timeout);
        proc.off('message', handler);
        resolve(parsed.output);
      }
    };
    proc.on('message', handler);
    proc.send({ method, args });
  });
}

describe('branch-worker protocol — no self-rating', () => {
  test('exploration and reflection use low provider effort without output caps', () => {
    const source = readFileSync(workerPath, 'utf8');
    expect(source).not.toContain('maxOutputTokens');
    expect(source).toContain("reasoningEffortOptions('low', parseModelSpec(spec).provider)");
  });

  test("'evaluate' is not part of the protocol anymore", async () => {
    const proc = await spawnWorker();
    const reply = await rpc(proc, 'evaluate', { task: 'rate yourself' });
    expect(reply.error).toContain('Unknown method: evaluate');
    expect(reply.result).toBeUndefined();
  });

  test('the BranchHandle the spawner builds exposes only explore + generateReflection', async () => {
    const { createBranchSpawner } = await import('../src/branch-process.js');
    const { spawn, abort } = createBranchSpawner(dir, {
      llm: { name: 'workers-ai', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' },
    });
    const handle = await spawn('seam-test-branch');
    try {
      expect(Object.keys(handle).sort()).toEqual(['explore', 'generateReflection']);
    } finally {
      await abort('seam-test-branch');
    }
  });
});

// A branch failure must arrive as a legible error, never as a silently
// "successful" empty result. A provider error whose .message is empty used to
// pass the parent's truthiness check, resolve `undefined`, and surface much
// later as a TypeError inside the MCTS engine — the real provider error lost.
describe('branch worker failure replies', () => {
  test('an error reply always carries a message', () => {
    const source = readFileSync(workerPath, 'utf8');
    // The catch must normalise, not forward a possibly-empty err.message.
    expect(source).not.toContain('error: (err as Error).message');
    expect(source).toContain("'branch worker failed'");
  });

  test('the parent rejects on error PRESENCE, not truthiness, and on a missing result', () => {
    const parent = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'branch-process.ts'),
      'utf8',
    );
    expect(parent).toContain('msg.error !== undefined');
    expect(parent).not.toContain('resolve(msg.result as T)');
    expect(parent).toContain('Branch worker returned no result for');
  });
});
