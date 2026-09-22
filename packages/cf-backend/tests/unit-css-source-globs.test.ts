/**
 * Every Tailwind `@source` glob must match something: an empty glob builds green and renders Kumo unstyled
 * (bun hoists deps to the workspace root). Asserts the glob's effect, not its text.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { basename, dirname, join, resolve } from 'node:path';

const CSS_FILES = ['../src/index.css'] as const;

interface GlobParts {
  root: string;
  rest: string;
}

interface GlobScan {
  scanRoot: string;
  files: string[];
}

function sourceGlobs(cssPath: string): string[] {
  const text = readFileSync(cssPath, 'utf8');

  return [...text.matchAll(/@source\s+"([^"]+)"/g)].map((m) => m[1]);
}

/** Longest literal prefix directory plus the pattern under it. */
function splitGlob(pattern: string): GlobParts {
  const parts = pattern.split('/');
  const firstMagic = parts.findIndex((p) => /[*?[{]/.test(p));

  if (firstMagic === -1) return { root: dirname(pattern), rest: basename(pattern) };

  return { root: parts.slice(0, firstMagic).join('/') || '.', rest: parts.slice(firstMagic).join('/') };
}

/** A missing root is "matched nothing", not a crash, as Tailwind treats it. */
function scan(cssPath: string, pattern: string): GlobScan {
  const { root, rest } = splitGlob(pattern);
  const scanRoot = resolve(dirname(cssPath), root);

  if (!existsSync(scanRoot)) return { scanRoot, files: [] };

  return { scanRoot, files: [...new Glob(rest).scanSync({ cwd: scanRoot, onlyFiles: true })] };
}

describe('Tailwind @source globs', () => {
  for (const relCss of CSS_FILES) {
    const cssPath = resolve(import.meta.dir, relCss);
    const globs = sourceGlobs(cssPath);

    test(`${relCss} declares at least one @source`, () => {
      // Guards the guard: removed directives would make the loop assert nothing.
      expect(globs.length).toBeGreaterThan(0);
    });

    for (const pattern of globs) {
      test(`${relCss} — "${pattern}" matches files that exist`, () => {
        const { scanRoot, files } = scan(cssPath, pattern);

        expect({ pattern, scanRoot, matchedAnything: files.length > 0 })
          .toEqual({ pattern, scanRoot, matchedAnything: true });
      });
    }
  }

  test('the kumo scan reaches the classes the vendor components actually need', () => {
    // A package-root glob would match its README and emit nothing; require Kumo's utility classes.
    const cssPath = resolve(import.meta.dir, '../src/index.css');
    const kumo = sourceGlobs(cssPath).find((g) => g.includes('kumo'));

    if (!kumo) throw new Error('index.css must declare a Kumo @source');

    const { scanRoot, files } = scan(cssPath, kumo);
    const found = files.some((file) => readFileSync(join(scanRoot, file), 'utf8').includes('bg-kumo-'));

    expect(found).toBe(true);
  });
});
