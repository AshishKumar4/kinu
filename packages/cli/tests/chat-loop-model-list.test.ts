import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const entry = resolve(import.meta.dir, 'fixtures/chat-loop-model-list.ts');

describe('classic chat /model', () => {
  test('a model list that cannot be read says why, instead of an empty list', async () => {
    const child = Bun.spawn([process.execPath, entry], {
      stdin: new TextEncoder().encode('/model\n'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });

    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Model: openai/gpt-5.5');
    expect(stdout).toContain('the provider catalog is unreachable');
  });
});
