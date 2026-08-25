// Devbox is independent of the product that first needed it.
//
// The whole point of extracting this package is that it is a general SDK: a
// Cloudflare container presented as a persistent machine, usable by anything.
// The moment it imports the product's own core it stops being that, and the
// coupling would arrive one convenient import at a time rather than as a
// decision anyone reviewed.
//
// So the rule is mechanical and it reads the files on disk. A test that asserted
// this by importing something would prove only that one import path works; this
// asserts the absence of every path, which is what the rule actually says.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

/** Only the manifest fields this test reads. Parsed rather than asserted: a
 *  manifest is a file on disk, so it is input. */
const ManifestSchema = v.object({
  name: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
});

function manifest(path: string): v.InferOutput<typeof ManifestSchema> {
  const parsed = v.safeParse(ManifestSchema, JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path} is not a manifest this test can read`);
  return parsed.output;
}

const PACKAGE_DIR = join(import.meta.dir, '..');

/** The scope this package must not reach into. Read from the sibling manifests
 *  rather than written down, so a rename cannot leave this test checking a name
 *  nothing uses — a guard that checks the wrong name passes, which is the exact
 *  failure it exists to make loud. */
function forbiddenScope(): string {
  const name = manifest(join(PACKAGE_DIR, '..', 'core', 'package.json')).name;
  if (name === undefined || !name.startsWith('@') || !name.includes('/')) {
    throw new Error(
      `the sibling core package declares no scoped name (${JSON.stringify(name)}), so this `
      + 'test cannot know what to forbid',
    );
  }
  return name;
}

function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path);
  }
  return found;
}

describe('package independence', () => {
  const scope = forbiddenScope();

  test('the shipped source imports nothing from the product core', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'bench']) {
      for (const file of sourceFiles(join(PACKAGE_DIR, dir))) {
        const text = readFileSync(file, 'utf8');
        // Import, re-export and dynamic import all reach the same module, so
        // the check is for the specifier rather than for one syntax.
        if (text.includes(`'${scope}`) || text.includes(`"${scope}`)) {
          offenders.push(file.slice(PACKAGE_DIR.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the manifest declares no dependency on any workspace package', () => {
    const own = manifest(join(PACKAGE_DIR, 'package.json'));
    const declared = [
      ...Object.keys(own.dependencies ?? {}),
      ...Object.keys(own.devDependencies ?? {}),
    ];
    expect(declared.filter(name => name.startsWith(`${scope.split('/')[0]}/`))).toEqual([]);
    // And nothing reached in by workspace protocol under another name either.
    const ranges = Object.values({ ...own.dependencies, ...own.devDependencies });
    expect(ranges.filter(range => range.startsWith('workspace:'))).toEqual([]);
  });

  test('the guard itself can fail, proved against a known-bad specifier', () => {
    // A test that only ever sees green cannot distinguish "no violations" from
    // "the check does not work". This exercises the same predicate the test
    // above uses, against text that must be caught.
    const bad = `import { thing } from '${scope}/obs';`;
    expect(bad.includes(`'${scope}`)).toBe(true);
    const good = "import { Sandbox } from '@cloudflare/sandbox';";
    expect(good.includes(`'${scope}`)).toBe(false);
  });
});
