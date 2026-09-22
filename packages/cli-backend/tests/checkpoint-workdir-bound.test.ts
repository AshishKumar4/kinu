/**
 * The `workdirForPath` walk stops at the temp boundary and filesystem root; a marker at the temp dir is no project.
 * Uses an owned temp root with `TMPDIR` set before engine creation (os.tmpdir() reads it at call time).
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { createHostCheckpoints } from '../src/checkpoints';

describe('workdirForPath temp boundary', () => {
  function withTempBoundary(label: string) {
    const outer = scratchDir(`ckpt-bound-${label}`);
    const temp = join(outer, 'tmp');
    mkdirSync(temp, { recursive: true });
    const prior = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    const base = scratchDir('store', temp);
    const engine = createHostCheckpoints({ agent: 'bound', base });

    return {
      temp,
      engine,
      cleanup: () => {
        if (prior === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prior;
      },
    };
  }

  test('a marker at the temp directory is not a project for paths beneath it', () => {
    const { temp, engine, cleanup } = withTempBoundary('marker-at-root');

    try {
      mkdirSync(join(temp, 'scratch'), { recursive: true });
      writeFileSync(join(temp, 'pyproject.toml'), '[tool]\n');
      expect(engine.workdirForPath(join(temp, 'scratch', 'edit.js')))
        .toBe(join(temp, 'scratch'));
    } finally { cleanup(); }
  });

  test('a marker above the temp directory never captures a path beneath it', () => {
    // `unboundedWorkdirsAbove` in scripts/preflight.ts refuses a marker between the temp dir and `/`.
    const { temp, engine, cleanup } = withTempBoundary('marker-above');

    try {
      mkdirSync(join(temp, 'scratch'), { recursive: true });
      writeFileSync(join(temp, '..', 'Cargo.toml'), '');
      expect(engine.workdirForPath(join(temp, 'scratch', 'edit.js')))
        .toBe(join(temp, 'scratch'));
    } finally { cleanup(); }
  });

  test('a real project beneath the temp directory still resolves to itself', () => {
    const { temp, engine, cleanup } = withTempBoundary('project-beneath');

    try {
      const project = join(temp, 'real-project');
      mkdirSync(join(project, 'src'), { recursive: true });
      writeFileSync(join(project, 'package.json'), '{}');
      writeFileSync(join(project, 'src', 'main.ts'), 'x');
      expect(engine.workdirForPath(join(project, 'src', 'main.ts'))).toBe(project);
      expect(engine.workdirForPath(join(project, 'src'))).toBe(project);
    } finally { cleanup(); }
  });

  test('a symlinked temp root is the same boundary as its real path', () => {
    // macOS resolves /tmp to /private/tmp; the walk must find the boundary through the alias.
    const { temp, engine, cleanup } = withTempBoundary('symlink');

    try {
      const link = join(temp, '..', 'alias');
      rmSync(link, { force: true });
      symlinkSync(temp, link);
      mkdirSync(join(link, 'scratch'), { recursive: true });
      writeFileSync(join(temp, '..', 'go.mod'), '');
      // The walk resolves the real path to find the boundary and answers in the caller's spelling.
      expect(engine.workdirForPath(join(link, 'scratch', 'edit.js')))
        .toBe(join(link, 'scratch'));
    } finally { cleanup(); }
  });
});
