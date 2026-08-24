/**
 * The Analytics Engine dataset names, held equal on the two sides that declare
 * them.
 *
 * A dataset name is written down twice and always will be: `wrangler.jsonc`
 * binds one per environment for the WRITE path, and the SQL API takes a name as
 * text on the READ path. Nothing compared the two, and the consequence was not
 * an error — `env.staging` binds `kinu_agent_metrics_staging` while sharing
 * production's `CLOUDFLARE_ACCOUNT_ID`, so staging wrote rows no reader named
 * and its admin panels, had they been reachable, would have presented
 * production's numbers as staging's. A wrong number under the right heading.
 *
 * So the read path now derives its name from ONE source — the schema's base plus
 * that deployment's `ANALYTICS_DATASET_SUFFIX` — and this holds that derivation
 * equal to what wrangler binds, per environment and in both directions.
 *
 * WRANGLER DOES NOT INHERIT `vars` INTO A NAMED ENVIRONMENT. Every environment
 * that binds a dataset must therefore declare its own suffix, and an absent one
 * is the defect rather than a default, which is why it is required below.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import { parseJsonc } from './jsonc';
import { ANALYTICS_SCHEMAS, analyticsDataset } from '../packages/cf-backend/src/analytics/schemas';

const REPO_ROOT = join(import.meta.dir, '..');
const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

/** Only the two blocks this file is about. A narrow schema rather than the
 *  manifest's full one: this asks a single question of the config, and a shape
 *  that admitted more would start answering others. */
const DeploymentSchema = v.object({
  analytics_engine_datasets: v.optional(v.array(v.object({
    binding: v.string(), dataset: v.string(),
  }))),
  vars: v.optional(v.record(v.string(), v.string())),
});

const WranglerSchema = v.object({
  ...DeploymentSchema.entries,
  env: v.optional(v.record(v.string(), DeploymentSchema)),
});

/** Binding name → dataset name. */
type DatasetBindings = Readonly<Record<string, string>>;

interface Deployment {
  readonly name: string;
  readonly suffix: string;
  readonly bound: DatasetBindings;
}

/** What the read path must name for a deployment carrying `suffix`. */
function derivedBindings(suffix: string): DatasetBindings {
  return Object.fromEntries(ANALYTICS_SCHEMAS.map((schema) =>
    [schema.binding, analyticsDataset(schema, suffix)]));
}

/**
 * Every environment that binds analytics datasets, production first.
 *
 * Derived rather than listed, so an environment added tomorrow is covered the
 * day it is added — the failure this whole file exists for is a second
 * deployment nobody re-checked.
 */
function deployments(): readonly Deployment[] {
  const config = parseJsonc(
    readFileSync(join(REPO_ROOT, WRANGLER), 'utf8'), WranglerSchema, WRANGLER,
  );
  const blocks: [string, v.InferOutput<typeof DeploymentSchema>][] = [
    ['production', config],
    ...Object.entries(config.env ?? {}),
  ];
  return blocks
    .filter(([, block]) => (block.analytics_engine_datasets ?? []).length > 0)
    .map(([name, block]) => {
      const suffix = block.vars?.ANALYTICS_DATASET_SUFFIX;
      if (suffix === undefined) {
        throw new Error(
          `${WRANGLER}: environment "${name}" binds analytics datasets but declares no `
          + "ANALYTICS_DATASET_SUFFIX, so its reader would name production's datasets",
        );
      }
      return {
        name,
        suffix,
        bound: Object.fromEntries(
          (block.analytics_engine_datasets ?? []).map((dataset) => [dataset.binding, dataset.dataset]),
        ),
      };
    });
}

const DEPLOYMENTS = deployments();

describe('every deployment reads the datasets it writes', () => {
  test('production and staging both bind analytics, and are both measured', () => {
    // Named rather than counted: the assertions below iterate, so an environment
    // silently dropped from the config would make them all vacuously pass.
    expect(DEPLOYMENTS.map((deployment) => deployment.name)).toEqual(['production', 'staging']);
  });

  test.each(DEPLOYMENTS.map((deployment) => [deployment.name, deployment] as const))(
    '%s binds exactly the datasets its suffix derives',
    (_name, deployment) => {
      // Both directions: a missing binding leaves a writer silently unbound, and
      // an extra one is a dataset nothing in the code base can read.
      expect(deployment.bound).toEqual(derivedBindings(deployment.suffix));
    },
  );

  test("staging names its own datasets, not production's", () => {
    // The suffix could be set to '' and every equality above would still hold,
    // while staging went back to reading production. This is the assertion that
    // says the separation exists at all.
    const [production, staging] = DEPLOYMENTS;
    for (const [binding, dataset] of Object.entries(staging.bound)) {
      expect(dataset).not.toBe(production.bound[binding]);
    }
  });
});

describe('the derivation itself', () => {
  test('production is the unsuffixed name, and a suffix appends', () => {
    const [agent] = ANALYTICS_SCHEMAS;
    expect(analyticsDataset(agent, '')).toBe(agent.dataset);
    expect(analyticsDataset(agent, '_staging')).toBe(`${agent.dataset}_staging`);
  });

  test('a value that is not a dataset suffix is refused, not appended', () => {
    // The suffix reaches SQL as text. It is our own deployment var rather than a
    // request field, which is why a throw is the right answer: the shipped
    // config cannot be malformed without this file failing first.
    const [agent] = ANALYTICS_SCHEMAS;
    for (const bad of ['staging', '_Staging', '_stag ing', "_x'", `_${'x'.repeat(64)}`]) {
      expect(() => analyticsDataset(agent, bad)).toThrow(RangeError);
    }
  });

  test('the equality has a red direction', () => {
    // Staging's bindings against production's suffix is exactly the shipped
    // defect this file was written for. If this passed, the test above would be
    // measuring nothing.
    expect(DEPLOYMENTS[1].bound).not.toEqual(derivedBindings(''));
  });
});
