/**
 * What the static-analysis gates read.
 *
 * This was `readSources` inside `ast-duplication.ts`, which made three gates
 * import a fourth gate to find out which files exist — the wrong direction, and
 * it briefly looked like one broken function in the duplication gate had taken
 * `reachability` and `do-init-gate` down with it. Walking the repo is not the
 * duplication gate's job, and it is not the parser's either: `syntax.ts` stays a
 * pure parser seam so that nothing which merely wants `declaredName` transitively
 * depends on shelling out to git.
 *
 * `git ls-files` rather than a directory crawl, because a gate should see what is
 * committed: a build artefact, a scratch file or an ignored vendor tree is not
 * code anyone maintains, and every one of them would arrive as a finding.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;

/** Backend and core product code. Colocated `*.test.ts` is out: duplicated test
 *  fixtures are a different and much cheaper problem than duplicated logic. */
const SOURCE_RE = /^packages\/[^/]+\/src\/.+\.tsx?$/;
const TEST_RE = /\.test\.tsx?$/;

const tracked = (): string[] =>
  execFileSync('git', ['-C', root, 'ls-files', 'packages'], { encoding: 'utf8' }).split('\n');

/** Product source: the files a gate holds to the standard. */
export function readSources(): Map<string, string> {
  const files = tracked()
    .filter((f) => SOURCE_RE.test(f) && !TEST_RE.test(f) && !f.endsWith('.d.ts'));
  return new Map(files.map((f) => [f, readFileSync(root + f, 'utf8')]));
}

/** Colocated and `tests/` suites, which `readSources` deliberately omits. A gate
 *  that reports "reachable" needs these separately from product code, so that
 *  "only its own test calls this" is sayable rather than invisible. */
export function readTests(): Map<string, string> {
  const files = tracked().filter((f) => TEST_RE.test(f));
  return new Map(files.map((f) => [f, readFileSync(root + f, 'utf8')]));
}
