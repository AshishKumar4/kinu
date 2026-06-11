import { describe, expect, test } from 'bun:test';
import { resolveSandboxPolicy } from '@proteus/core';
import { createHostShell } from '../src/runtime.js';
import { detectSandboxBackend } from '../src/sandbox.js';

// Real sandbox backend: abort handling must keep working under bwrap too.
const hostSandbox = {
  backend: detectSandboxBackend(),
  getPolicy: () => resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: process.cwd(), tmpDir: '/tmp' }),
};

describe('createHostShell', () => {
  test('aborts long-running commands through AbortSignal', async () => {
    const shell = createHostShell(process.cwd(), hostSandbox);
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
