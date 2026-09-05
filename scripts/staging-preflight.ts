#!/usr/bin/env bun
/**
 * Does the staging deployment run THIS branch?
 *
 * The cloud eval arm's whole claim is that it measures the product, so the one
 * question it must answer before it spends is which build it is measuring. A
 * cloud run against a week-old deployment reports the deployment's behaviour
 * under this branch's banner, and the branch is where a reader will look for the
 * cause. Measured on 2026-08-24: the deployed sha was `17abc2980` while the local
 * checkout was 27 commits ahead — so an arm run that day would have graded code
 * nobody had written yet in either direction.
 *
 * WHAT IT COMPARES. `git rev-parse --short HEAD` against `build.sha` from
 * `GET <origin>/api/health`, which is the same pair `scripts/deploy.sh` Step 4
 * asserts after a deploy. The stamp is read out of the DEPLOYED ASSET BUNDLE, so
 * an absent stamp also means the CLI download assets never published — a partial
 * deploy, not merely an unknown version.
 *
 * WHAT IT DOES ABOUT A MISMATCH. Refuses, and names `bun run deploy:staging`.
 * `--allow-stale` downgrades the refusal to a warning, for the one legitimate
 * case: measuring a deployment on purpose (a bisect, or reproducing a production
 * report) rather than measuring this branch. The flag is required so that choice
 * is recorded in the command somebody ran, not inferred from a log afterwards.
 *
 * A DIRTY TREE IS A WARNING, never a refusal. Uncommitted work cannot be
 * deployed and so cannot be measured, but the sha still names what was — and a
 * preflight that refused every dirty tree would refuse every developer.
 */
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';

import { EVAL_STAGING_ORIGIN, evalTargetVerdict } from '../packages/test-utils/src/eval-identity';

/** `/api/health`'s build stamp, as this reads it off the wire. Only the fields
 *  the comparison uses — the feature counts and endpoint map are the health
 *  route's own contract and parsing them here would be a mirror with no reader. */
const HealthSchema = v.object({
  ok: v.boolean(),
  build: v.nullable(v.object({
    version: v.string(),
    sha: v.string(),
    builtAt: v.string(),
  })),
});
export type DeployedHealth = v.InferOutput<typeof HealthSchema>;

export type StagingVerdict =
  /** The deployment runs this checkout's HEAD. */
  | { readonly kind: 'current'; readonly sha: string; readonly builtAt: string }
  /** It runs something else, and says what. */
  | { readonly kind: 'stale'; readonly deployed: string; readonly local: string; readonly builtAt: string }
  /** It answered, but with no build stamp: its asset bundle is incomplete, so
   *  its CLI download endpoints are broken and no version can be established. */
  | { readonly kind: 'unstamped' }
  /** It did not answer, or answered something that is not a health document. */
  | { readonly kind: 'unreachable'; readonly reason: string };

/**
 * The verdict, over values rather than over the network, so the decision is
 * testable without a deployment. `health` is null when the GET itself failed.
 */
export function stagingDeploymentVerdict(input: {
  readonly localSha: string;
  readonly health: DeployedHealth | null;
  readonly failure?: string;
}): StagingVerdict {
  if (input.health === null) {
    return { kind: 'unreachable', reason: input.failure ?? 'the health endpoint did not answer' };
  }
  const build = input.health.build;
  if (build === null) return { kind: 'unstamped' };
  if (build.sha === input.localSha) {
    return { kind: 'current', sha: build.sha, builtAt: build.builtAt };
  }
  return { kind: 'stale', deployed: build.sha, local: input.localSha, builtAt: build.builtAt };
}

/**
 * One sentence a reader can act on, per verdict.
 *
 * Every branch names a command or a flag. A preflight that reports a state
 * without a remedy has moved the problem rather than surfaced it.
 */
export function describeStagingVerdict(verdict: StagingVerdict, origin: string): string {
  switch (verdict.kind) {
    case 'current':
      return `staging runs this checkout (${verdict.sha}, built ${verdict.builtAt})`;
    case 'stale':
      return `staging runs ${verdict.deployed} (built ${verdict.builtAt}) and this checkout is `
        + `${verdict.local}. A cloud eval arm would grade the deployed build under this branch's `
        + 'name. Deploy this branch with `bun run deploy:staging`, or measure the deployed build '
        + 'on purpose with --allow-stale.';
    case 'unstamped':
      return `${origin}/api/health answered with no build stamp, so its asset bundle is `
        + 'incomplete and no version can be established. Re-run `bun run deploy:staging` — a '
        + 'deploy that skipped the CLI archive step leaves the download endpoints broken too.';
    case 'unreachable':
      return `${origin}/api/health did not answer (${verdict.reason}). The cloud arm cannot run `
        + 'without a reachable deployment: check the deploy, then `bun run deploy:staging`.';
  }
}

export async function readDeployedHealth(origin: string): Promise<{
  health: DeployedHealth | null; failure?: string;
}> {
  try {
    const response = await fetch(`${origin}/api/health`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return { health: null, failure: `HTTP ${String(response.status)}` };
    }
    return { health: v.parse(HealthSchema, await response.json()) };
  } catch (error) {
    return { health: null, failure: String(error) };
  }
}

export function localHeadSha(): string {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return head.status === 0 ? head.stdout.trim() : 'dev';
}

function treeIsDirty(): boolean {
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return status.status === 0 && status.stdout.trim().length > 0;
}

/** Run as a script: `bun scripts/staging-preflight.ts [--allow-stale] [origin]`. */
if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowStale = args.includes('--allow-stale');
  const origin = (args.find((arg) => !arg.startsWith('--')) ?? EVAL_STAGING_ORIGIN)
    .trim().replace(/\/+$/, '');

  // The same allowlist every other eval entry point is held to. A preflight that
  // would happily interrogate production teaches whoever reads it that the origin
  // is negotiable, and this script's answer is what gates a spending run.
  const allowed = evalTargetVerdict(origin);
  if (allowed.kind === 'refused') {
    console.error(`staging-preflight: REFUSED — ${allowed.reason}`);
    process.exit(1);
  }

  const { health, failure } = await readDeployedHealth(allowed.origin);
  const localSha = localHeadSha();
  const verdict = stagingDeploymentVerdict({ localSha, health, failure });
  const line = describeStagingVerdict(verdict, allowed.origin);

  if (verdict.kind === 'current') {
    console.error(`staging-preflight: ${line}`);
    if (treeIsDirty()) {
      console.error('staging-preflight: WARNING — this tree has uncommitted changes, which are '
        + 'not in the deployment and so are not being measured.');
    }
    process.exit(0);
  }

  if (allowStale) {
    console.error(`staging-preflight: WARNING (--allow-stale) — ${line}`);
    process.exit(0);
  }
  console.error(`staging-preflight: REFUSED — ${line}`);
  process.exit(1);
}
