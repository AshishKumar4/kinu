import { expect, test } from 'bun:test';
import { spawnTest } from '@kinu.run/test-utils';
import { join } from 'node:path';

// d05ff368d, 2026-10-09: measuring all flows in beforeAll reached Armada's 1800s wall without reporting a test.
test('a finished product flow reports its assertions before the next flow can hang', async () => {
  const child = spawnTest([
    process.execPath, 'test', '--timeout=0', '--preload', './scripts/fixtures/product-flow-interruption.ts',
    'tests/browser/product-flows.test.ts', '-t', 'the product reaches its home page|a workspace made from the home page answers its mission',
  ], { cwd: join(import.meta.dir, '..'), stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });

  const decoder = new TextDecoder();
  let said = '';
  let blocked = false;

  try {
    for await (const bytes of child.stderr) {
      said += decoder.decode(bytes, { stream: true });

      if (!said.includes('fixture: second flow blocked')) continue;
      blocked = true;
      child.kill('SIGTERM');
      break;
    }
  } finally {
    child.kill('SIGTERM');
    await child.exited;
  }

  expect(blocked, said).toBe(true);
  expect(said.match(/^\(pass\)/gmu)?.length ?? 0, said).toBe(1);
  expect(said.match(/^\(fail\)/gmu)?.length ?? 0, said).toBe(0);
});
