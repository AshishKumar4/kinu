import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { fixtureConfigForArms, resourceNames } from './bench-devbox-fixture';

const ROOT = dirname(import.meta.dir);

const ARM = 'snapshot-chain';

const CLASSES = ['SnapshotChainBox', 'BenchOpCounter'];

const GeneratedConfig = v.looseObject({
  containers: v.array(v.looseObject({ class_name: v.string() })),
  durable_objects: v.object({
    bindings: v.array(v.looseObject({ class_name: v.string() })),
  }),
  migrations: v.array(v.looseObject({
    tag: v.string(),
    new_sqlite_classes: v.array(v.string()),
  })),
  vars: v.record(v.string(), v.string()),
});

describe('bench fixture Durable Object bindings', () => {
  test('captures one arm\'s generated config before disposal', () => {
    const captured = fixtureConfigForArms(
      readFileSync(join(ROOT, 'packages/devbox/bench/wrangler.jsonc'), 'utf8'),
      resourceNames('workerd-binding-probe', ARM),
      [ARM],
    );

    const config = v.parse(GeneratedConfig, JSON.parse(captured));
    expect(config.durable_objects.bindings.map((binding) => binding.class_name)).toEqual(CLASSES);
    expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: CLASSES }]);
    expect(config.containers.map((container) => container.class_name)).toEqual(CLASSES.slice(0, -1));
    expect(config.vars.BENCH_SELECTED_ARMS).toBe(ARM);
  });
});
