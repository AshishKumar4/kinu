import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { proteusHome } from '../src/home';
import { createHostCheckpoints } from '../src/checkpoints';

const original = process.env.PROTEUS_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.PROTEUS_HOME;
  else process.env.PROTEUS_HOME = original;
});

describe('proteusHome', () => {
  test('defaults to ~/.proteus', () => {
    delete process.env.PROTEUS_HOME;
    expect(proteusHome()).toBe(resolve(join(homedir(), '.proteus')));
  });

  test('PROTEUS_HOME overrides, and is resolved to an absolute path', () => {
    process.env.PROTEUS_HOME = '/tmp/bench-home';
    expect(proteusHome()).toBe('/tmp/bench-home');
  });

  test('blank/whitespace PROTEUS_HOME falls back rather than resolving to cwd', () => {
    process.env.PROTEUS_HOME = '   ';
    expect(proteusHome()).toBe(resolve(join(homedir(), '.proteus')));
  });
});

describe('checkpoint store isolation', () => {
  // Regression: the shadow-git store used to hardcode ~/.proteus/checkpoints,
  // so an isolated PROTEUS_HOME still wrote into the real home. Any harness
  // that promises a throwaway home depends on this staying fixed.
  test('checkpoints land under PROTEUS_HOME, not the real home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proteus-home-iso-'));
    try {
      process.env.PROTEUS_HOME = join(root, 'home');
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
