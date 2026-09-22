/**
 * `NODE_BUILTIN_TOOLS` survives every entry order: each case is a fresh `bun` process (the registry is
 * per process), and this file imports nothing from `../src` so a TDZ read fails a case instead of the file.
 */

import { scratchDir } from '../../test-utils/src/scratch';
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';

const here = dirname(fileURLToPath(import.meta.url));

const srcUrl = (relative: string): string =>
  pathToFileURL(join(here, '..', 'src', relative)).href;

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

/** Parsed rather than cast: unreadable probe output is a broken experiment, not an empty surface. */
const ObservedSchema = v.object({
  head: v.array(v.string()),
  node: v.array(v.string()),
});

type Observed = v.InferOutput<typeof ObservedSchema>;

function observeAfterLoading(specifier: string): Observed {
  const dir = scratchDir('init-order');

  const probe = join(dir, 'probe.mjs');
  // Only the first import sets the order; the two below read an already-populated registry.
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
}

describe('module initialisation order', () => {
  // The reference must itself initialise, or every comparison below is vacuous.
  const [, referenceSpecifier] = ENTRY_POINTS[3];
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
