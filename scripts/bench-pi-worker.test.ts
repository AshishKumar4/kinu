import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { parseWorkerOutput } from './bench-worker-protocol';

const REPO_ROOT = join(import.meta.dir, '..');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const RequestSchema = v.object({
  messages: v.array(v.object({ role: v.string(), content: v.unknown() })),
  tools: v.array(v.object({ function: v.object({ name: v.string() }) })),
});

function completion(model: string): Response {
  const events = [
    {
      id: 'fake', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
    },
    {
      id: 'fake', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
    {
      id: 'fake', object: 'chat.completion.chunk', created: 1, model,
      choices: [], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function runWorker(verifierRetry: boolean): Promise<{
  output: ReturnType<typeof parseWorkerOutput>;
  requests: Array<v.InferOutput<typeof RequestSchema>>;
  authorizations: Array<string | null>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-worker-test-'));
  scratch.push(dir);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const requests: Array<v.InferOutput<typeof RequestSchema>> = [];
  const authorizations: Array<string | null> = [];
  const model = '@cf/zai-org/glm-5.2';
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      authorizations.push(request.headers.get('authorization'));
      const decoded = v.parse(RequestSchema, await request.json());
      requests.push(decoded);
      return completion(model);
    },
  });
  try {
    const input = {
      agentDir: join(home, 'pi-agent'),
      asks: ['Say done without using a tool.'],
      removeAfterAsk: [null],
      maxTokens: 100,
      llm: {
        name: 'workers-ai',
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        headers: { Authorization: 'Bearer exact-bench-auth' },
        model,
      },
      task: {
        id: 'smoke', title: 'smoke', prompt: 'smoke', editable: ['x'], guarded: [],
        checks: [{ id: 'always-fails', command: ['false'] }],
      },
      repoRoot: REPO_ROOT,
      verifierRetry,
    };
    const proc = Bun.spawn(['bun', join(REPO_ROOT, 'scripts', 'bench-pi-worker.ts')], {
      cwd: dir,
      env: { ...process.env, HOME: home, KINU_HOME: home },
      stdin: Buffer.from(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`Pi worker exited ${proc.exitCode}: ${stderr}`);
    return { output: parseWorkerOutput(stdout.trim()), requests, authorizations };
  } finally {
    upstream.stop(true);
  }
}

describe('official Pi baseline worker', () => {
  test('V0 uses the in-memory SDK session and exactly the native coding tools', async () => {
    const result = await runWorker(false);
    expect(result.output).toMatchObject({ tokens: 9, steps: 1, modelCalls: 1, hadError: false });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.tools.map((tool) => tool.function.name).sort())
      .toEqual(['bash', 'edit', 'read', 'write']);
    expect(result.authorizations).toEqual(['Bearer exact-bench-auth']);
  });

  test('V1 spends one retry inside the same meter only when the machine verifier fails', async () => {
    const result = await runWorker(true);
    expect(result.output).toMatchObject({ tokens: 18, steps: 2, modelCalls: 2, hadError: false });
    expect(result.requests).toHaveLength(2);
    const retryMessages = result.requests[1]!.messages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.stringify(message.content));
    expect(retryMessages.some((message) => message.includes('machine verifier still fails'))).toBe(true);
  });
});
