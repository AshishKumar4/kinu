/**
 * `NODE_BUILTIN_TOOLS` survives every entry order — the behavioural half of the
 * import-cycle gate.
 *
 * The defect this is built from: `strategy/node-agent.ts` reads
 * `HEAD_BUILTIN_TOOLS` at MODULE SCOPE (`[...HEAD_BUILTIN_TOOLS, 'report']`), and
 * that constant used to live in `heads/head-tools.ts`, which sat on a five-module
 * value cycle:
 *
 *   heads/head-tools -> tools/builtins -> tools/agents-tool
 *                    -> strategy/swarm-run -> strategy/node-agent -> heads/head-tools
 *
 * Enter that ring at `heads/*` and `head-tools` is still initialising when the
 * spread runs, so the spread hits the temporal dead zone. What made it expensive
 * is HOW it failed: the throw happened at module evaluation, so
 * `unit-fork-run-identity.test.ts` — which imports the heads barrel first — did
 * not fail six tests, it failed to LOAD, and its six tests disappeared from the
 * run's count. `bun test packages/core/tests/` passed at the same time, because
 * entering through the core barrel ordered the cycle the other way. A suite that
 * SHRINKS reads as green.
 *
 * `import/no-cycle` (.oxlintrc.json) catches the cycle statically. This catches
 * the initialisation behaviourally, and the two fail for different reasons: the
 * lint rule cannot see a TDZ read, and this cannot see a cycle that nothing reads
 * at module scope yet.
 *
 * Two design rules, both learned from the incident:
 *
 *   Subprocesses, because entry order is a property of a module registry and a
 *   registry is per PROCESS. Static imports here would measure whichever order
 *   some earlier test file in the same `bun test` run already established — a
 *   check that cannot fail. Each case gets its own `bun` process whose FIRST
 *   import is the module under test.
 *
 *   This file imports NOTHING from `../src`, on purpose. A test that statically
 *   imports the constant it is guarding fails the same way the incident did — the
 *   file stops loading and its cases vanish from the count instead of failing.
 *   Every value here arrives as subprocess output, so a temporal-dead-zone read
 *   is reported as a failing test that names the ReferenceError.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';

const here = dirname(fileURLToPath(import.meta.url));
const srcUrl = (relative: string): string =>
  pathToFileURL(join(here, '..', 'src', relative)).href;

/**
 * Every module that was on the ring, plus the two barrels a test or a backend
 * actually enters through. Each one is a first import somebody really performs,
 * so each is an order the constant has to survive. The heads barrel is first
 * because it is the order that broke.
 */
const ENTRY_POINTS: ReadonlyArray<readonly [label: string, specifier: string]> = [
  ['the heads barrel — the order that broke', 'heads/index.ts'],
  ['heads/head-tools — where the constant used to live', 'heads/head-tools.ts'],
  ['heads/types — where it lives now', 'heads/types.ts'],
  ['the core barrel — the order that masked it', 'index.ts'],
  ['tools/builtins — the confined-surface factory', 'tools/builtins.ts'],
  ['tools/actor-tools — the actor surface that adds `agents`', 'tools/actor-tools.ts'],
  ['tools/agents-tool — the delegation tool', 'tools/agents-tool.ts'],
  ['strategy/swarm-run — the search that runs the nodes', 'strategy/swarm-run.ts'],
  ['strategy/node-agent — the reader itself, first', 'strategy/node-agent.ts'],
];

/** What the probe prints. Parsed rather than asserted: unreadable probe output is
 *  a broken experiment, and a cast would have reported it as an empty surface. */
const ObservedSchema = v.object({
  head: v.array(v.string()),
  node: v.array(v.string()),
});
type Observed = v.InferOutput<typeof ObservedSchema>;

function observeAfterLoading(specifier: string): Observed {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-init-order-'));
  try {
    const probe = join(dir, 'probe.mjs');
    // The first import is the whole experiment; the two below it read constants
    // out of an already-populated registry and cannot change the order.
    writeFileSync(
      probe,
      [
        `import ${JSON.stringify(srcUrl(specifier))};`,
        `import { HEAD_BUILTIN_TOOLS } from ${JSON.stringify(srcUrl('heads/types.ts'))};`,
        `import { NODE_BUILTIN_TOOLS } from ${JSON.stringify(srcUrl('strategy/node-agent.ts'))};`,
        'process.stdout.write(JSON.stringify({',
        '  head: [...HEAD_BUILTIN_TOOLS],',
        '  node: [...NODE_BUILTIN_TOOLS],',
        '}));',
        '',
      ].join('\n'),
    );
    const run = spawnSync('bun', [probe], { encoding: 'utf8', cwd: here });
    expect(
      run.status,
      `importing ${specifier} first did not initialise cleanly (exit ${run.status}):\n${run.stderr}`,
    ).toBe(0);
    return v.parse(ObservedSchema, JSON.parse(run.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('module initialisation order', () => {
  // The reference every case is measured against, taken through the entry order
  // that used to MASK the defect — so a reference that is itself broken shows up
  // here rather than making the cases below vacuously true.
  const [, referenceSpecifier] = ENTRY_POINTS[3]!;
  const reference = observeAfterLoading(referenceSpecifier);

  test('the constants under test are non-empty and related as documented', () => {
    expect(reference.head.length).toBeGreaterThan(0);
    expect(reference.node).toEqual([...reference.head, 'report']);
  });

  for (const [label, specifier] of ENTRY_POINTS) {
    test(`NODE_BUILTIN_TOOLS is whole when loading starts at ${label}`, () => {
      const observed = observeAfterLoading(specifier);
      expect(observed.head).toEqual([...reference.head]);
      expect(observed.node).toEqual([...reference.node]);
    });
  }
});
