/**
 * The Analytics Engine dataset names, held equal on the two sides that declare
 * them.
 *
 * A dataset name is written down twice and always will be: `wrangler.jsonc`
 * binds one for the WRITE path, and the SQL API takes a name as text on the
 * READ path. Nothing compared the two once, and the consequence was not an
 * error: a deployment wrote rows no reader named while its admin panels read
 * another deployment's datasets. A wrong number under the right heading.
 *
 * So this holds every schema's `dataset` equal to what wrangler binds, in both
 * directions.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import { parseJsonc } from './jsonc';
import { ANALYTICS_SCHEMAS } from '@kinu.run/core/analytics';

const REPO_ROOT = join(import.meta.dir, '..');

const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

/** Only the block this file is about. A narrow schema rather than the
 *  manifest's full one: this asks a single question of the config, and a shape
 *  that admitted more would start answering others. */
const WranglerSchema = v.object({
  analytics_engine_datasets: v.optional(v.array(v.object({
    binding: v.string(), dataset: v.string(),
  }))),
});

/** Binding name → dataset name. */
type DatasetBindings = Readonly<Record<string, string>>;

const BOUND: DatasetBindings = Object.fromEntries(
  (parseJsonc(readFileSync(join(REPO_ROOT, WRANGLER), 'utf8'), WranglerSchema, WRANGLER)
    .analytics_engine_datasets ?? []).map((dataset) => [dataset.binding, dataset.dataset]),
);

/** What the read path names. */
const READ: DatasetBindings = Object.fromEntries(
  ANALYTICS_SCHEMAS.map((schema) => [schema.binding, schema.dataset]),
);

describe('the Worker reads the datasets it writes', () => {
  test('wrangler binds exactly the datasets the schemas name', () => {
    // Both directions: a missing binding leaves a writer silently unbound, and
    // an extra one is a dataset nothing in the code base can read.
    expect(Object.keys(BOUND).length).toBeGreaterThan(0);
    expect(BOUND).toEqual(READ);
  });

  test('the equality has a red direction', () => {
    // A reader naming another dataset is exactly the shipped defect this file
    // was written for. If this passed, the test above would be measuring nothing.
    const [agent] = ANALYTICS_SCHEMAS;
    expect(BOUND).not.toEqual({ ...READ, [agent.binding]: `${agent.dataset}_other` });
  });
});
