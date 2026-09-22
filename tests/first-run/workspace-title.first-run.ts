import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import * as v from 'valibot';
import { JsonValueSchema } from '@kinu.run/core';
import { callAgentRpc, listCloudAgents } from '../../packages/cli/src/cloud-api';
import { sessionExpired } from '../../packages/cli/src/config';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { expectReached, FIRST_RUN_DEFECTS } from './first-run';

const CASE = 'workspace-title';

const StoredSession = v.pipe(v.string(), v.parseJson(), v.object({
  origin: v.string(), accessToken: v.pipe(v.string(), v.minLength(1)), tokenExpiresAt: v.optional(v.string()),
}));

const Health = v.object({ build: v.object({ sha: v.string(), version: v.string(), builtAt: v.string() }) });

const Snapshot = v.object({ status: v.object({ name: v.string(), displayName: v.string() }) });

/**
 * Read-only exception to the fresh-workspace runner: it must never create,
 * rename, send a turn to, or delete this explicitly selected OWNED workspace.
 * Whole-workspace spend belongs to its history, not this check, so the receipt
 * contains only actual listing/snapshot observations, never model/spend fields.
 *
 * WHAT IT MEASURES, and what it deliberately no longer accepts as its entry
 * condition. The earlier prerequisite was "a nonempty registry title that is
 * not the slug", which the DEFECT satisfies: a workspace stuck on the truncated
 * first line of its own prompt (#18) passed the gate and the gate then only
 * compared registry title to snapshot title. So the title the deployment shows
 * had to be wrong in exactly the reported way for the check to be green about
 * hydration. The prerequisite is now the ORIGIN the registry recorded — a
 * workspace still showing a `provisional` stand-in has not finished being
 * named, so it cannot answer the hydration question either way — and the
 * observation is both that the origin settled and that the snapshot serves the
 * registry's title.
 *
 * Targeted invocation: KINU_FIRST_RUN_OPERATOR=1 KINU_EVAL_BACKEND=cloud
 * KINU_FIRST_RUN_CLI_CONFIG=<existing-config> KINU_EVAL_ORIGIN=<origin>
 * KINU_FIRST_RUN_WORKSPACE=<owned-id> KINU_FIRST_RUN_DEPLOYED_SHA=<served-sha>
 * BENCH_ARTIFACTS=<private-durable-directory> bun --bun vitest run
 * --config vitest.first-run.config.ts tests/first-run/workspace-title.first-run.ts
 */
describe('First-run · workspace-title (owned workspace, read-only)', () => {
  test.skipIf(process.env.KINU_FIRST_RUN_OPERATOR !== '1')('MEASURED: workspace-title', async () => {
    const configPath = process.env.KINU_FIRST_RUN_CLI_CONFIG;
    const origin = process.env.KINU_EVAL_ORIGIN;
    const workspace = process.env.KINU_FIRST_RUN_WORKSPACE;
    const expectedSha = process.env.KINU_FIRST_RUN_DEPLOYED_SHA;

    if (process.env.KINU_EVAL_BACKEND !== 'cloud' || !configPath || !origin || !workspace?.trim() || !expectedSha) {
      throw new Error('Read-only title first-run requires cloud backend, explicit CLI config, origin, owned workspace and deployed SHA');
    }

    const stored = v.safeParse(StoredSession, readFileSync(configPath, 'utf8'));

    if (!stored.success) throw new Error('The selected interactive CLI config is invalid');
    const auth = stored.output;

    if (auth.origin !== origin) throw new Error('Requested deployment differs from the interactive CLI config origin');

    if (sessionExpired(auth)) throw new Error('Interactive CLI session expired; run kinu auth');

    const root = resolveArtifactRoot({ flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
      repoRoot: join(import.meta.dirname, '../..'), runRoot: tmpdir() });

    mkdirSync(root, { recursive: true });
    const receiptPath = join(root, `workspace-title-${Date.now()}.json`);
    const requested = { origin, workspace, expectedSha, authority: 'interactive CLI operator', readOnly: true };
    writeFileSync(receiptPath, JSON.stringify({ requested, phase: 'started' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

    function prerequisite(message: string): never {
      writeFileSync(receiptPath, JSON.stringify({ requested, phase: 'prerequisite-failed', error: message }, null, 2) + '\n');
      throw new Error('workspace-title prerequisite: ' + message);
    }

    console.warn('[first-run receipt] ' + receiptPath);

    const healthResponse = await fetch(origin + '/api/health');

    if (!healthResponse.ok) prerequisite('Health returned HTTP ' + healthResponse.status);
    const { build } = v.parse(Health, await healthResponse.json());

    if (build.sha !== expectedSha) prerequisite(`Requested build ${expectedSha}, observed ${build.sha}`);
    const registry = await listCloudAgents(origin, auth.accessToken);
    const owned = registry.find(entry => entry.name === workspace);

    if (owned === undefined) prerequisite('Explicit workspace is not in the authenticated caller registry; no snapshot was requested');

    if (!owned.displayName.trim() || owned.displayName === workspace) {
      prerequisite('Selected workspace needs a nonempty registry title distinct from its ID; this would not exercise title hydration');
    }

    // THE ENTRY CONDITION IS THE ORIGIN, not the shape of the string. A title
    // still marked `provisional` is the deterministic stand-in the create
    // stored, which means naming has not finished — the state #18 reported as
    // permanent, and the one this check used to accept as its starting point.
    if (owned.nameOrigin === 'provisional') {
      prerequisite(`Selected workspace still shows its provisional stand-in title "${owned.displayName}"; naming has not settled, so hydration cannot be measured`);
    }

    // First actor RPC: do not warm its title through another read beforehand.
    // Select title fields only; private memory and other snapshot data are never logged.
    const snapshot = v.safeParse(Snapshot, await callAgentRpc({
      origin, token: auth.accessToken, name: workspace, method: 'getWorkspaceSnapshot', schema: JsonValueSchema,
    }));

    if (!snapshot.success) prerequisite('Loaded snapshot is missing its required status/title fields; comparison unavailable');
    const statusTitle = snapshot.output.status.displayName;
    const statusWorkspace = snapshot.output.status.name;

    const settled = owned.nameOrigin !== 'provisional';

    const receipt = { requested, build, phase: 'observed', receipts: [{ workspace, registryTitle: owned.displayName,
      nameOrigin: owned.nameOrigin ?? null, statusTitle, statusWorkspace,
      matches: settled && statusTitle === owned.displayName && statusWorkspace === workspace }] };

    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    expectReached(CASE, { what: 'settled-title-hydrates-from-the-owned-registry-row', reached: receipt.receipts[0]?.matches === true,
      detail: JSON.stringify({ workspace, registryTitle: owned.displayName, nameOrigin: owned.nameOrigin ?? null, statusTitle, statusWorkspace, deployedSha: build.sha }) });
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
