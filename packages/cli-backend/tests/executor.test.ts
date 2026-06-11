import { describe, expect, test } from 'bun:test';
import { resolveSandboxPolicy } from '@proteus/core';
import { createSandboxedExecutor } from '../src/executor.js';
import { detectSandboxBackend } from '../src/sandbox.js';

const hostSandbox = {
  backend: detectSandboxBackend(),
  getPolicy: () => resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: process.cwd(), tmpDir: '/tmp' }),
};

describe('createSandboxedExecutor', () => {
  test('runs without provider arguments', async () => {
    const result = await createSandboxedExecutor(hostSandbox).execute('7 * 6');
    expect(result).toEqual({ result: 42 });
  });
});
