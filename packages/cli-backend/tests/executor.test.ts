import { describe, expect, test } from 'bun:test';
import { createSandboxedExecutor } from '../src/executor.js';

describe('createSandboxedExecutor', () => {
  test('runs without provider arguments', async () => {
    const result = await createSandboxedExecutor().execute('7 * 6', []);
    expect(result).toEqual({ result: 42 });
  });

  test('declares installed interpreters and runs code in the requested language', async () => {
    const executor = createSandboxedExecutor();
    const installed = Bun.which('python3') !== null;
    expect(executor.languages.includes('python')).toBe(installed);
    if (!installed) return;
    const result = await executor.execute('print(40 + 2)', [], { language: 'python' });
    expect(result).toEqual({ result: '42' });
  });

  test('rejects a language it did not declare', async () => {
    const executor = createSandboxedExecutor();
    const result = await executor.execute('puts 42', [], { language: 'ruby' });
    expect(result.error).toContain('does not support language "ruby"');
  });
});
