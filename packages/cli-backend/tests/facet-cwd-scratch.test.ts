/**
 * A facet bound to a physical directory still gets its own scratch.
 *
 * A bound directory has no principal registry — every command runs as the
 * same Unix user — so uid/gid/mode cannot separate two facets there. What
 * the runtime CAN hand each facet is its own mapped scratch: a home
 * directory and a tmp directory under the workspace's own state, created
 * for the facet and removed with it. The shared tree stays honestly
 * shared — siblings can read it, and nothing claims otherwise — while
 * `HOME` and `TMPDIR` point at ground no sibling is told to write.
 *
 * This is a mapping, not a boundary: the same user can open either
 * directory, and the disclosure for a directory-bound facet says so.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupFacetCwdScratch, facetCwdScratch } from '../src/runtime';

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'kinu-facet-scratch-'));
}

describe('facetCwdScratch', () => {
  test('maps each facet to its own home and tmp, creating both', () => {
    const cwd = workdir();
    try {
      const a = facetCwdScratch(cwd, 'sub-researcher-abc123');
      const b = facetCwdScratch(cwd, 'head-aX9');

      expect(a.home).not.toBe(b.home);
      expect(a.tmp).not.toBe(b.tmp);
      expect(existsSync(a.home)).toBe(true);
      expect(existsSync(a.tmp)).toBe(true);
      expect(existsSync(b.home)).toBe(true);
      expect(existsSync(b.tmp)).toBe(true);
      // The tmp a facet is told to use lives under its own home: one root
      // to reclaim, and nothing shared to collide on.
      expect(a.tmp.startsWith(`${a.home}/`)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('the mapping is stable and copies no workspace bytes into it', () => {
    const cwd = workdir();
    try {
      const first = facetCwdScratch(cwd, 'sub-worker-1');
      const second = facetCwdScratch(cwd, 'sub-worker-1');

      expect(second).toEqual(first);
      expect(readdirSync(first.home)).toEqual(['tmp']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a hostile facet name never escapes the state directory', () => {
    const cwd = workdir();
    try {
      expect(() => facetCwdScratch(cwd, '../escape')).toThrow('not a usable agent name');
      expect(() => facetCwdScratch(cwd, 'a/b')).toThrow('not a usable agent name');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('cleanup removes the facet root and only that root', () => {
    const cwd = workdir();
    try {
      const a = facetCwdScratch(cwd, 'sub-worker-1');
      facetCwdScratch(cwd, 'sub-worker-2');

      cleanupFacetCwdScratch(cwd, 'sub-worker-1');

      expect(existsSync(a.home)).toBe(false);
      expect(existsSync(join(cwd, '.kinu', 'facets', 'sub-worker-2'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
