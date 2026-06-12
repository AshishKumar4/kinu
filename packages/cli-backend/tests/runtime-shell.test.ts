import { describe, expect, test } from 'bun:test';
import { createHostShell } from '../src/runtime.js';

describe('createHostShell', () => {
  test('aborts long-running commands through AbortSignal', async () => {
    const shell = createHostShell(process.cwd());
    const controller = new AbortController();
    const started = Date.now();
    const command = shell.exec('sleep 5; echo done', { signal: controller.signal });

    setTimeout(() => controller.abort(new Error('stop requested')), 100);
    const result = await command;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.stdout).not.toContain('done');
    expect(result.stderr).toContain('Command aborted.');
    expect(result.exitCode).toBe(130);
  });
});
