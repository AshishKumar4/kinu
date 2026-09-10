/**
 * `NODE_BUILTIN_TOOLS` survives every entry order — the behavioural half of the
 * import-cycle gate.
 *
 * A value cycle through
 *
 *   heads/head-tools -> tools/builtins -> delegation/agents-tool
 *                    -> strategy/swarm-run -> strategy/node-agent -> heads/head-tools
 *
 * would expose the module-scope spread in `strategy/node-agent.ts`
 * (`[...HEAD_BUILTIN_TOOLS, 'report']`) to a temporal-dead-zone read. Keep
 * `HEAD_BUILTIN_TOOLS` in `heads/types`, and exercise each entry order in its
 * own process so a module-load failure is reported rather than hidden by
 * another entry order.
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
 * Every listed module and barrel is a possible first import, so each must
 * initialise the shared constants correctly in a fresh process.
 */
const ENTRY_POINTS: ReadonlyArray<readonly [label: string, specifier: string]> = [
  ['the heads barrel', 'heads/index.ts'],
  ['heads/head-tools', 'heads/head-tools.ts'],
  ['heads/types', 'heads/types.ts'],
  ['the core barrel', 'index.ts'],
  ['tools/builtins — the confined-surface factory', 'tools/builtins.ts'],
  ['tools/actor-tools — the actor surface that adds `agents`', 'tools/actor-tools.ts'],
  ['delegation/agents-tool — the delegation tool', 'delegation/agents-tool.ts'],
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
  const dir = mkdtempSync(join(tmpdir(), 'kinu-init-order-'));

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
  // The reference every case is measured against. It loads through the core
  // barrel in its own process and must itself initialise successfully, so a
  // broken reference fails explicitly instead of making the comparisons below
  // vacuously true.
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
