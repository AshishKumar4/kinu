import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { kinuHome } from '../src/home';
import { createHostCheckpoints } from '../src/checkpoints';

const original = process.env.KINU_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.KINU_HOME;
  else process.env.KINU_HOME = original;
});

describe('kinuHome', () => {
  test('defaults to ~/.kinu', () => {
    delete process.env.KINU_HOME;
    expect(kinuHome()).toBe(resolve(join(homedir(), '.kinu')));
  });

  test('KINU_HOME overrides, and is resolved to an absolute path', () => {
    process.env.KINU_HOME = '/tmp/bench-home';
    expect(kinuHome()).toBe('/tmp/bench-home');
  });

  test('blank/whitespace KINU_HOME falls back rather than resolving to cwd', () => {
    process.env.KINU_HOME = '   ';
    expect(kinuHome()).toBe(resolve(join(homedir(), '.kinu')));
  });
});

describe('checkpoint store isolation', () => {
  // Regression: the shadow-git store used to hardcode ~/.kinu/checkpoints,
  // so an isolated KINU_HOME still wrote into the real home. Any harness
  // that promises a throwaway home depends on this staying fixed.
  test('checkpoints land under KINU_HOME, not the real home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kinu-home-iso-'));
    try {
      process.env.KINU_HOME = join(root, 'home');
      const work = join(root, 'project');
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, 'a.txt'), 'one');

      const engine = createHostCheckpoints({ agent: 'iso-test' });
      engine.beginTurn({ turnId: 't1', sessionId: 's1' });
      expect(await engine.ensureCheckpoint(work)).toBeTruthy();

      expect(existsSync(join(root, 'home', 'checkpoints', 'iso-test'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
