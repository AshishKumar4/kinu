/**
 * The `workdirForPath` ancestor walk is bounded at the temp boundary.
 *
 * The defect, named by scripts/preflight.ts after it refused a push on
 * 2026-09-02: a stray `pyproject.toml` in `/tmp` made every host write under
 * `/tmp` resolve its checkpoint working directory to `/tmp` and shadow-git-add
 * all of it — measured at 24,483 ms for one laptop.writeFile, surfacing
 * elsewhere as 5,000 ms test timeouts. The walk must stop at the temp boundary
 * and at the filesystem root, and a marker AT the temp directory is no project.
 *
 * The temp root here is a directory this file owns, not `/tmp` itself:
 * planting a marker in the real one would recreate the outage this tests
 * against. `TMPDIR` is set before the engine is created, because that is
 * exactly how the engine learns the boundary (os.tmpdir() reads it at call
 * time), and restored after.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostCheckpoints } from '../src/checkpoints';

describe('workdirForPath temp boundary', () => {
  /** A throwaway temp root with `label`-namespaced scratch, an engine reading
   *  it as the boundary, and both restored on cleanup. */
  function withTempBoundary(label: string) {
    const outer = mkdtempSync(join(tmpdir(), `kinu-ckpt-bound-${label}-`));
    const temp = join(outer, 'tmp');
    mkdirSync(temp, { recursive: true });
    const prior = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    const base = mkdtempSync(join(temp, 'store-'));
    const engine = createHostCheckpoints({ agent: 'bound', base });
    return {
      temp,
      engine,
      cleanup: () => {
        if (prior === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prior;
        rmSync(outer, { recursive: true, force: true });
      },
    };
  }

  test('a marker at the temp directory is not a project for paths beneath it', () => {
    const { temp, engine, cleanup } = withTempBoundary('marker-at-root');
    try {
      mkdirSync(join(temp, 'scratch'), { recursive: true });
      writeFileSync(join(temp, 'pyproject.toml'), '[tool]\n');
      // The marker sits AT the boundary. The walk must not return `temp` —
      // a scratch directory is never a project root — and the fallback for a
      // file is its own directory.
      expect(engine.workdirForPath(join(temp, 'scratch', 'edit.js')))
        .toBe(join(temp, 'scratch'));
    } finally { cleanup(); }
  });

  test('a marker above the temp directory never captures a path beneath it', () => {
    // `unboundedWorkdirsAbove` in scripts/preflight.ts refuses exactly this:
    // a marker in a directory BETWEEN the temp dir and `/`. The walk stops at
    // the boundary, so the marker is never probed.
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
    // macOS resolves /tmp → /private/tmp. A write whose path names the link
    // and a walk that probes the real path must agree where the boundary is,
    // or the walk walks straight past it through the alias.
    const { temp, engine, cleanup } = withTempBoundary('symlink');
    try {
      const link = join(temp, '..', 'alias');
      rmSync(link, { force: true });
      symlinkSync(temp, link);
      mkdirSync(join(link, 'scratch'), { recursive: true });
      writeFileSync(join(temp, '..', 'go.mod'), '');
      // The write names the alias; the walk resolves the real path to learn
      // where the boundary is, and answers in the caller's own spelling.
      expect(engine.workdirForPath(join(link, 'scratch', 'edit.js')))
        .toBe(join(link, 'scratch'));
    } finally { cleanup(); }
  });
});
