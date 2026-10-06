/** Resolve every deployed Worker import with the bundler that emits the artifact.
 *  Container contents are outside this graph; the devbox deploy tier exercises the real golden. */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { readDeployedGraph } from './deployed-graph';
import { assertMeasured, finding } from './gate-ratchet';
import { parseJsonc } from './jsonc';
import { trackedFiles } from './sources';

const root = join(import.meta.dir, '..');

const Config = v.object({ main: v.string() });

const configs = trackedFiles().filter(file => /^packages\/[^/]+\/wrangler\.jsonc$/.test(file));

const entries = configs.map(file => {
  const config = parseJsonc(readFileSync(join(root, file), 'utf8'), Config, file);

  return relative(root, join(root, dirname(file), config.main));
});

const graph = await readDeployedGraph(entries);

console.log(`deployed-resolution: ${assertMeasured('deployed-resolution', [
  ['deployed Worker entry points', graph.entries.length],
  ['modules in the deployed graph', graph.modules.length],
])}`);

console.log('deployed-resolution: blind spots: this measures import resolution, not export shape, runtime behavior, or modules inside container images.');

test('the deployed graph has no unreadable modules', () => {
  expect(graph.unreadable.map(hole => `${hole.file}: ${hole.reason}`)).toEqual([]);
});

test('every import in the deployed graph resolves', () => {
  if (graph.unresolved.length === 0) return;
  throw new Error(`${graph.unresolved.length} specifier(s) do not resolve\n${graph.unresolved.map(miss => finding({
    at: `${miss.file} imports '${miss.specifier}'`,
    invariant: 'every deployed Worker import resolves under the bundler that emits the artifact',
    found: miss.reason,
    silently: 'the build or a lazy module fails when loaded',
    fix: 'give the specifier a path the resolver can reach, or install its package',
  })).join('\n')}`);
});
