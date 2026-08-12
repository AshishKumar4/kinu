import { describe, expect, test } from 'bun:test';
import { createSandboxedExecutor } from '../src/executor.js';

describe('createSandboxedExecutor', () => {
  test('runs without provider arguments', async () => {
    const result = await createSandboxedExecutor().execute('7 * 6', []);
    expect(result).toEqual({ result: 42 });
  });
});
