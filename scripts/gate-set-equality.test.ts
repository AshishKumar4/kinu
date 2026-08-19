// The set-equality gate's own gate.
//
// Three things have to be true of it, and only the first is about finding
// violations: it must go RED on the shapes that were shipped fifteen times
// tonight, it must go GREEN on their corrected form, and it must stay SILENT on
// the legitimate shapes that its first draft mistook for violations — a URL
// route, a model id, a specifier rewrite, and a gate that governs exactly one
// file. A gate that fires on all four teaches people to ignore it, which is worse
// than not having it.
//
// Every fixture is passed as TEXT rather than written into the tree, so the red
// demonstration seeds a private enumeration without one ever existing on disk.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ENUMERATOR, NON_REPOSITORY_SCANS, auditGateProgram, gateCommands, gatePrograms,
} from './gate-set-equality';
import { LADDER, deployGates } from './ladder';
import { isTestFile, isRunnableSuite, trackedFiles } from './sources';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const at = (file: string): string => readFileSync(REPO_ROOT + file, 'utf8');

describe('red: the shapes that were shipped fifteen times', () => {
  test('a private pattern NARROWER than the shared set is a finding', () => {
    // Verbatim the shape `ladder.ts` carried: a third spelling of "test file",
    // counting 474 where the lint rule governs 661.
    const found = auditGateProgram('scripts/probe.ts', `
      const TEST_FILE = /\\.test\\.(ts|tsx|js)$/;
      export function trackedTestFiles(files: string[]): string[] {
        return files.filter((path) => TEST_FILE.test(path));
      }
    `);
    expect(found.map((v) => v.kind)).toEqual(['private-pattern']);
    expect(found[0]?.detail).toContain('463 files while the rule governed 646');
  });

  test('an inline pattern is caught as well as a named constant', () => {
    const found = auditGateProgram('scripts/probe.ts', `
      export const suites = (files: string[]) => files.filter((f) => /\\.test\\.tsx?$/.test(f));
    `);
    expect(found.map((v) => v.kind)).toEqual(['private-pattern']);
  });

  test('a private `git ls-files` is a finding', () => {
    const found = auditGateProgram('scripts/probe.ts', `
      import { spawnSync } from 'node:child_process';
      const listed = spawnSync('git', ['ls-files', 'packages'], { encoding: 'utf8' });
    `);
    expect(found.map((v) => v.kind)).toEqual(['private-enumeration']);
    expect(found[0]?.detail).toContain('tracked-only in secret-scan');
  });

  test('a private directory walk is a finding', () => {
    const found = auditGateProgram('scripts/probe.ts', `
      import { readdirSync } from 'node:fs';
      export const walk = (dir: string) => readdirSync(dir, { withFileTypes: true });
    `);
    expect(found.map((v) => v.kind)).toEqual(['private-enumeration']);
  });

  test('a glob SCAN is a finding, and constructing a glob is not', () => {
    expect(auditGateProgram('scripts/probe.ts', `
      export const files = () => [...new Bun.Glob('packages/**/*.ts').scanSync('.')];
    `).map((v) => v.kind)).toEqual(['private-enumeration']);

    // `ladder.ts` applies bunfig's own `pathIgnorePatterns` this way. It answers a
    // question about ONE path and discovers nothing.
    expect(auditGateProgram('scripts/probe.ts', `
      const globs = patterns.map((p: string) => new Bun.Glob(p));
      export const skip = (path: string) => globs.some((g) => g.match(path));
    `)).toEqual([]);
  });

  test('a lock written before the corpus was measured is a finding', () => {
    const found = auditGateProgram('scripts/probe.ts', `
      import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet';
      if (import.meta.main) {
        writeLock(keys, LOCK);
        const measured = assertMeasured('probe', [['files', files.length]]);
        process.exit(report('probe', reconcile(keys, LOCK), detail, 'cmd', measured));
      }
    `);
    expect(found.map((v) => v.kind)).toEqual(['unmeasured-publication']);
    expect(found[0]?.detail).toContain('healthiest possible number');
  });

  test('a gate that publishes with NO measurement at all is a finding twice over', () => {
    const found = auditGateProgram('scripts/probe.ts', `
      import { reconcile, report, writeLock } from './gate-ratchet';
      if (import.meta.main) {
        if (process.argv.includes('--lock')) writeLock(keys, LOCK);
        else process.exit(report('probe', reconcile(keys, LOCK), detail, 'cmd', '7 things'));
      }
    `);
    expect(found.map((v) => v.kind)).toEqual(['unmeasured-publication', 'unmeasured-publication']);
  });

  test('a stale non-repository declaration is a finding', () => {
    // The exemption outliving the scan it excused. A stale one reads as a
    // considered decision and silently covers the next gate spelled the same way.
    const declared = [...NON_REPOSITORY_SCANS.keys()][0];
    expect(declared).toBeDefined();
    const found = auditGateProgram(declared ?? '', 'export const nothing = 1;\n');
    expect(found.map((v) => v.kind)).toEqual(['stale-declaration']);
  });
});

describe('green: the corrected form', () => {
  test('the same gate, narrowed by a named predicate, is silent', () => {
    expect(auditGateProgram('scripts/probe.ts', `
      import { isRunnableSuite, trackedFiles } from './sources';
      export function trackedTestFiles(): string[] {
        return trackedFiles().filter(isRunnableSuite);
      }
    `)).toEqual([]);
  });

  test('the same publication, with the measurement upstream of both writers', () => {
    expect(auditGateProgram('scripts/probe.ts', `
      import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet';
      if (import.meta.main) {
        const measured = assertMeasured('probe', [['files', files.length]]);
        if (process.argv.includes('--lock')) writeLock(keys, LOCK);
        else process.exit(report('probe', reconcile(keys, LOCK), detail, 'cmd', measured));
      }
    `)).toEqual([]);
  });

  test('the enumerator itself may hold the one pattern, and nothing else may', () => {
    expect(auditGateProgram(ENUMERATOR, at(ENUMERATOR))).toEqual([]);
    // Same bytes, a different path: the exemption is the file, not the content.
    expect(auditGateProgram('scripts/copy-of-sources.ts', at(ENUMERATOR)).length)
      .toBeGreaterThan(0);
  });
});

describe('silent: the legitimate shapes its first draft mistook for violations', () => {
  test('a gate governing exactly ONE named file reports nothing', () => {
    // `tracing-gate.ts`'s real shape. Its governed set is one wrangler config and
    // the tracer call sites in it; there is no set to narrow and nothing to share.
    expect(auditGateProgram('scripts/probe.ts', `
      import { readFileSync } from 'node:fs';
      import { assertMeasured } from './gate-ratchet';
      const config = readFileSync(root + 'packages/cf-backend/wrangler.jsonc', 'utf8');
      export const environments = () => JSON.parse(config).env;
    `)).toEqual([]);
  });

  test('a URL route pattern is not a corpus criterion', () => {
    // `bench-inference-proxy.ts:84`. The first draft called every one of these a
    // private path pattern, because it looked for a separator in the regex source.
    expect(auditGateProgram('scripts/probe.ts', `
      export const route = (url: string) => /^\\/api\\/user\\/ai\\/v1\\/models$/.test(url);
    `)).toEqual([]);
  });

  test('a model id prefix is not a path prefix', () => {
    // `bench.ts:155`. `@cf/deepseek-ai/deepseek-v4-pro-0813` has slashes in it.
    expect(auditGateProgram('scripts/probe.ts', `
      export const native = (model: string) => model.startsWith('@cf/');
    `)).toEqual([]);
  });

  test('a specifier rewrite is not a selection', () => {
    // `capability-parity.ts`'s `./x.js` -> `./x.ts` resolution. `.replace()`
    // transforms one name; it picks no corpus.
    expect(auditGateProgram('scripts/probe.ts', `
      export const stem = (base: string) => base.replace(/\\.jsx?$/, '');
    `)).toEqual([]);
  });

  test('scanning prose for file mentions is not enumerating files', () => {
    // `platform-catalog.ts:140` finds paths INSIDE documentation text. The pattern
    // matches filenames by construction and selects no corpus, so the distinction
    // is the method: `matchAll` over content, never `test` over a path.
    expect(auditGateProgram('scripts/probe.ts', `
      const MENTION = /(?:packages|scripts|docs)\\/[\\w./@-]*\\.\\w+/g;
      export const mentions = (prose: string) => [...prose.matchAll(MENTION)];
    `)).toEqual([]);
  });

  test('an oxlint rule reporting a diagnostic is not publishing a gate number', () => {
    // 38 of the first run's 40 findings were this. `context.report` is a member
    // call on a name no gate imported from the ratchet.
    expect(auditGateProgram('scripts/probe.ts', `
      export const rule = { create: (context) => ({
        CallExpression(node) { context.report({ node, messageId: 'x' }); },
      }) };
    `)).toEqual([]);
  });
});

describe('the denominator, from both sides', () => {
  test('gate commands are resolved from LADDER *and* deploy.sh, which disagree', () => {
    // The warning that makes this gate honest: deriving "all gates" from LADDER
    // alone would certify 34 while governing 35.
    const ladder = new Set(LADDER.map((gate) => gate.run));
    const deploy = deployGates();
    expect(deploy.length).toBeGreaterThan(ladder.size);

    const deployOnly = deploy.filter((run) => !ladder.has(run));
    expect(deployOnly).toContain('bun run verify:lean');

    // Resolved through `bun run`, so a deploy-only npm script contributes the
    // program it names rather than reading as one opaque gate.
    const commands = gateCommands();
    expect(commands).toContain('bash scripts/verify-lean.sh');
    expect(commands).toContain('bun scripts/secret-scan.ts');
  });

  test('a gate target resolving to no file throws instead of being skipped', () => {
    // How the ci-tier bench gate came to fail in 0.1s while the same line passed
    // at deploy: one ran through a shell that expanded the glob and one did not.
    expect(() => gatePrograms(['bun scripts/does-not-exist.ts'], trackedFiles()))
      .toThrow(/matches no enumerated file/);
    expect(() => gatePrograms(['bun test scripts/no-such-*.test.ts'], trackedFiles()))
      .toThrow(/matches no enumerated file/);
  });

  test('the governed set holds gate programs only, and reaches imported modules', () => {
    const programs = gatePrograms(gateCommands(), trackedFiles());

    // Reached only through the import closure: nothing runs `bun scripts/ladder.ts`
    // as a gate, and its private pattern sat there for exactly that reason.
    expect(programs.governed).toContain('scripts/ladder.ts');
    expect(programs.governed).toContain('scripts/sources.ts');
    // A live-tree rule gate carries a denominator, so it is governed.
    expect(programs.governed).toContain('tools/oxlint/anti-slop/no-ambient-git.gate.test.ts');
    // Product code is what gates MEASURE. `node --check packages/pc-agent/src/index.js`
    // is a gate command naming a product file; it is not a gate.
    expect(programs.governed.every((f) => f.startsWith('scripts/') || f.startsWith('tools/')))
      .toBe(true);
    // A suite's corpus is the fixtures it builds.
    expect(programs.governed).not.toContain('scripts/bench.test.ts');
    expect(programs.suites).toContain('scripts/bench.test.ts');
  });
});

describe('the live tree', () => {
  test('every governed gate program shares the one enumeration', () => {
    const programs = gatePrograms(gateCommands(), trackedFiles());
    const violations = programs.governed
      .flatMap((file) => auditGateProgram(file, at(file)));
    expect(violations.map((v) => `${v.file}:${String(v.line)} ${v.kind}`)).toEqual([]);
  });

  test('the denominator is not zero in any of its five parts', () => {
    // A gate that scanned nothing reports a clean sweep. All five counts are the
    // ones this gate divides by, so all five are asserted here as well as being
    // handed to `assertMeasured` at runtime.
    const programs = gatePrograms(gateCommands(), trackedFiles());
    expect(LADDER.length).toBeGreaterThan(30);
    expect(deployGates().length).toBeGreaterThan(30);
    expect(gateCommands().length).toBeGreaterThan(50);
    expect(programs.governed.length).toBeGreaterThan(50);
    expect(trackedFiles().length).toBeGreaterThan(1000);
  });

  test('the narrower predicate is a real subset of the wider one over the real tree', () => {
    // Not that the regexes look different — that the SETS stand in the claimed
    // relation over the actual files. `isRunnableSuite` is what a test runner
    // selects, `isTestFile` is what the lint rule governs, and the ladder's
    // denominator being the first while the lint enforces the second is the whole
    // reason both are named instead of one being re-spelled.
    const suites = trackedFiles().filter(isRunnableSuite);
    const governed = trackedFiles().filter(isTestFile);
    expect(suites.length).toBeGreaterThan(400);
    expect(governed.length).toBeGreaterThan(suites.length);
    for (const suite of suites) expect(isTestFile(suite)).toBe(true);
    // And the gap is real code, not a rounding difference: helpers carrying no
    // test suffix, which a runner never executes and the lint rule still governs.
    expect(governed.filter((f) => !isRunnableSuite(f)).length).toBeGreaterThan(20);
  });

  test('every non-repository declaration still names a gate that enumerates', () => {
    // The declaration list is this test's denominator. Emptied — by a cleanup that
    // dropped the entries rather than the gates — every assertion below is true of
    // nothing, and the escape hatch it documents becomes undocumented silently.
    expect(NON_REPOSITORY_SCANS.size).toBeGreaterThan(0);
    for (const [file, reason] of NON_REPOSITORY_SCANS) {
      expect(trackedFiles()).toContain(file);
      expect(reason.length).toBeGreaterThan(40);
      expect(auditGateProgram(file, at(file)).map((v) => v.kind)).not.toContain('stale-declaration');
    }
  });

});
