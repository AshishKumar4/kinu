/**
 * Every Tailwind `@source` glob must match something.
 *
 * This is the config-correctness class of defect, and it is the quietest one we
 * have: a glob that matches no files is not an error anywhere. Tailwind scans
 * zero files, emits zero classes, exits 0. The build is green, the bundle is
 * valid, the deploy succeeds — and every vendor component renders unstyled,
 * which nobody notices until they look at the page.
 *
 * The defect this locks: `@source "../node_modules/@cloudflare/kumo/dist/..."`
 * resolved to `packages/cf-backend/node_modules/`, but bun hoists shared
 * dependencies to the workspace root, so the directory never existed. Verified
 * against the shipped bundle: `dist/client/assets/*.css` contained no
 * `bg-kumo-base` at all. Kumo's Button, Badge, Loader and Combobox are used on
 * the workspace page, the settings page and the MCTS explorer.
 *
 * The assertion is deliberately about the glob's EFFECT, not its text: any path
 * that finds the files passes, so hoisting can change without this failing for
 * the wrong reason.
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

/** `@source "<glob>";` — Tailwind v4's scan directive. */
function sourceGlobs(cssPath: string): string[] {
  const text = readFileSync(cssPath, 'utf8');
  return [...text.matchAll(/@source\s+"([^"]+)"/g)].map((m) => m[1]!);
}

/** Split a glob into the longest literal prefix directory and the pattern
 *  under it, so the scan is rooted where the glob actually points. */
function splitGlob(pattern: string): GlobParts {
  const parts = pattern.split('/');
  const firstMagic = parts.findIndex((p) => /[*?[{]/.test(p));
  if (firstMagic === -1) return { root: dirname(pattern), rest: basename(pattern) };
  return { root: parts.slice(0, firstMagic).join('/') || '.', rest: parts.slice(firstMagic).join('/') };
}

/** Files a `@source` glob actually reaches. A root that does not exist is the
 *  headline case — it is "matched nothing", not a crash, because the whole
 *  point is that Tailwind treats it that way too. */
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
      // Guards the guard: if the directives are removed or renamed, the loop
      // below would silently assert nothing and this file would stop working.
      expect(globs.length).toBeGreaterThan(0);
    });

    for (const pattern of globs) {
      test(`${relCss} — "${pattern}" matches files that exist`, () => {
        const { scanRoot, files } = scan(cssPath, pattern);

        // Asserted as an object so a failure names the glob and the directory
        // it resolved to — the two things you need to fix it.
        expect({ pattern, scanRoot, matchedAnything: files.length > 0 })
          .toEqual({ pattern, scanRoot, matchedAnything: true });
      });
    }
  }

  test('the kumo scan reaches the classes the vendor components actually need', () => {
    // Matching *some* file is necessary but not sufficient — pointing at the
    // package root would match its README and still emit nothing. This asserts
    // the scanned set contains the utility classes Kumo's compiled components
    // reference, which is what has to reach the stylesheet.
    const cssPath = resolve(import.meta.dir, '../src/index.css');
    const kumo = sourceGlobs(cssPath).find((g) => g.includes('kumo'));
    if (!kumo) throw new Error('index.css must declare a Kumo @source');

    const { scanRoot, files } = scan(cssPath, kumo);
    const found = files.some((file) => readFileSync(join(scanRoot, file), 'utf8').includes('bg-kumo-'));

    expect(found).toBe(true);
  });
});
