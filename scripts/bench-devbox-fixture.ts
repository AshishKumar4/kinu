#!/usr/bin/env bun
/** What the live devbox drivers share: the fixture's names, R2 residue accounting, the source revision, and the
 *  orphan teardown that removes what a killed run left. */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  WRANGLER_FAILED, containerAppIds, deleteContainerApps, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';
import { snapshotRegistry, type ApplicationSweep } from '../packages/devbox/src/snapshot-registry';
import { restApiToken } from './cloudflare-rest';
import { AwsClient } from 'aws4fetch';
import {
  writeManifest,
  type CleanupProbes, type DeleteOutcome, type TeardownEntry,
  type TeardownManifest, type TeardownStep,
} from './fixtures/storage-matrix/cleanup';
import { trackedFiles } from './sources';

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));

/** The account every devbox fixture is raised on; exported so the deployed lifecycle suite
 *  names this one rather than a second copy. */
export const BENCH_ACCOUNT_ID = 'f44999d1ddda7012e9a87729eba250f1';

const FIXTURE_BASE = 'kinu-devbox-bench';

const FIXTURE_CLASS_BY_STRATEGY = {
  'snapshot-chain': 'SnapshotChainBox',
} as const satisfies Record<Strategy, string>;

interface FixtureNames {
  readonly worker: string;
  readonly bucket: string;
  readonly containerApps: readonly string[];
}

/** Per arm, not per run: concurrent arms sharing a bucket would lose data to one arm's
 *  `/teardown` whole-bucket purge, and sharing a Worker lets `/ops/reset` zero a sibling's tally. */
export function resourceNames(runId: string, arm: Strategy): FixtureNames {
  const worker = `${FIXTURE_BASE}-${runId}-${arm}`;

  return {
    worker,
    bucket: worker,
    containerApps: [`${worker}-${FIXTURE_CLASS_BY_STRATEGY[arm].toLowerCase()}`],
  };
}

/** Single source for the box name: the teardown manifest names it as durable state, so
 *  a separate copy could drift and leave the real box undeleted. */
export function boxName(runId: string, arm: Strategy): string {
  return `ab-${arm}-${runId}`;
}

export type Strategy = 'snapshot-chain';

export const STRATEGIES: readonly Strategy[] = ['snapshot-chain'];

const log = (message: string): void => {
  process.stderr.write(`[devbox-bench] ${message}\n`);
};

const wrangler = (args: readonly string[], options: { allowFailure?: boolean } = {}): string =>
  runWrangler(REPO_ROOT, args, options);

/** Open multipart uploads are invisible to `bucket info` and the REST object list; only S3
 *  ListMultipartUploads sees them, and they or leftover objects block `bucket delete` (10008). */
interface R2ResiduePlane {
  listObjects(bucket: string): Promise<readonly string[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  listUploads(bucket: string): Promise<readonly { key: string; uploadId: string }[]>;
  abortUpload(bucket: string, key: string, uploadId: string): Promise<void>;
  bucketExists(bucket: string): Promise<boolean>;
}

export function r2ResiduePlane(deps: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}): R2ResiduePlane {
  const client = new AwsClient({
    accessKeyId: deps.accessKeyId, secretAccessKey: deps.secretAccessKey, service: 's3', region: 'auto',
  });

  const origin = `https://${deps.accountId}.r2.cloudflarestorage.com`;

  const ask = async (path: string, method = 'GET'): Promise<{ status: number; body: string }> => {
    const answer = await client.fetch(`${origin}${path}`, { method });

    return { status: answer.status, body: await answer.text() };
  };

  const missing = (status: number, body: string): boolean =>
    status === 404 && body.includes('NoSuchBucket');

  return {
    bucketExists: async (bucket) => {
      const { status, body } = await ask(`/${bucket}?list-type=2&max-keys=1`);

      if (missing(status, body)) return false;

      if (status !== 200) throw new Error(`ListObjectsV2 on ${bucket} answered ${String(status)}`);

      return true;
    },
    listObjects: async (bucket) => {
      const keys: string[] = [];
      let token: string | null = null;

      do {
        const cursor: string = token === null ? '' : `&continuation-token=${encodeURIComponent(token)}`;
        const { status, body } = await ask(`/${bucket}?list-type=2&max-keys=1000${cursor}`);

        if (status !== 200) throw new Error(`ListObjectsV2 on ${bucket} answered ${String(status)}`);

        for (const block of body.split('<Contents>').slice(1)) {
          const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];

          if (key !== undefined) keys.push(key);
        }

        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] ?? null;
      } while (token !== null);

      return keys;
    },
    deleteObject: async (bucket, key) => {
      const { status } = await ask(`/${bucket}/${encodeURIComponent(key)}`, 'DELETE');

      if (status !== 204 && status !== 404) {
        throw new Error(`DeleteObject ${bucket}/${key} answered ${String(status)}`);
      }
    },
    listUploads: async (bucket) => {
      const { status, body } = await ask(`/${bucket}?uploads=`);

      if (status !== 200) throw new Error(`ListMultipartUploads on ${bucket} answered ${String(status)}`);
      const uploads: { key: string; uploadId: string }[] = [];

      for (const block of body.split('<Upload>').slice(1)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
        const uploadId = /<UploadId>([^<]*)<\/UploadId>/.exec(block)?.[1];

        if (key !== undefined && uploadId !== undefined) uploads.push({ key, uploadId });
      }

      return uploads;
    },
    abortUpload: async (bucket, key, uploadId) => {
      const { status } = await ask(
        `/${bucket}/${encodeURIComponent(key)}?uploadId=${encodeURIComponent(uploadId)}`, 'DELETE',
      );

      if (status !== 204 && status !== 404) {
        throw new Error(`AbortMultipartUpload ${bucket}/${key} answered ${String(status)}`);
      }
    },
  };
}

/** Drain BOTH residue classes so `bucket delete` can succeed on a bucket an
 *  interrupted run left dirty. Answers what it removed, for the teardown log. */
export async function drainBucketResidue(
  plane: R2ResiduePlane, bucket: string,
): Promise<{ objects: number; uploads: number }> {
  let objects = 0;

  for (const key of await plane.listObjects(bucket)) {
    await plane.deleteObject(bucket, key);
    objects += 1;
  }

  const uploads = await plane.listUploads(bucket);

  for (const upload of uploads) await plane.abortUpload(bucket, upload.key, upload.uploadId);

  return { objects, uploads: uploads.length };
}

/** C1/C3 verifiers only observe; teardown replay is the sole deleter, since a checker that
 *  deletes cannot tell "teardown worked" from "the checker mopped up". */
export function cleanupObservationProbes(deps: {
  wrangler: (args: readonly string[], options?: { allowFailure?: boolean }) => string;
  residue: R2ResiduePlane | null;
}): Pick<CleanupProbes, 'workerAbsent' | 'bucketState'> {
  return {
    workerAbsent: async (name) => {
      const listed = deps.wrangler(['deployments', 'list', '--name', name], { allowFailure: true });

      if (!listed.startsWith(WRANGLER_FAILED)) return false;

      if (/not found|does not exist|10007/i.test(listed)) return true;
      throw new Error(`deployments list on ${name} failed: ${listed.slice(0, 240)}`);
    },
    bucketState: async (name) => {
      if (deps.residue !== null) {
        if (!(await deps.residue.bucketExists(name))) return { absent: true, objects: 0, multipartResidue: 0 };

        return {
          absent: false,
          objects: (await deps.residue.listObjects(name)).length,
          multipartResidue: (await deps.residue.listUploads(name)).length,
        };
      }

      // Without S3 keys only absence is provable: R2 refuses to delete a bucket holding objects
      // or open uploads. A present bucket's multipart count is unmeasured, and unmeasured is not zero.
      const info = deps.wrangler(['r2', 'bucket', 'info', name], { allowFailure: true });

      if (info.startsWith(WRANGLER_FAILED) && /not found|does not exist|10006/i.test(info)) {
        return { absent: true, objects: 0, multipartResidue: 0 };
      }

      throw new Error(
        `${name} still exists and R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are absent — `
        + 'multipart residue cannot be measured, and an unmeasured count is not zero',
      );
    },
  };
}

/** Named here, never read here: the values go from the environment straight into
 *  `r2ResiduePlane`, and nothing in this driver prints either one. */
const R2_CLEANUP_KEY_VARS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

const R2_CLEANUP_KEY_FILE = '.dev.vars';

/** Refuses before anything is created: without S3 keys `bucketState` throws at teardown and
 *  C1–C7 would be written false. Takes presence booleans only, so it cannot leak a credential. */
export function r2CleanupKeyRefusal(input: {
  readonly verifiesCleanup: boolean;
  readonly accessKeyIdPresent: boolean;
  readonly secretAccessKeyPresent: boolean;
}): string | null {
  if (!input.verifiesCleanup) return null;

  const absent = [
    ...(input.accessKeyIdPresent ? [] : [R2_CLEANUP_KEY_VARS[0]]),
    ...(input.secretAccessKeyPresent ? [] : [R2_CLEANUP_KEY_VARS[1]]),
  ];

  if (absent.length === 0) return null;

  return `${absent.join(' and ')} ${absent.length === 1 ? 'is' : 'are'} absent, and this run `
    + 'verifies its own cleanup: the check reads every bucket through S3, so a bucket that still exists '
    + 'has an unmeasurable multipart count and C1-C7 would be written false over a check that '
    + `never ran. Export ${R2_CLEANUP_KEY_VARS.join(' and ')} — they live in ${R2_CLEANUP_KEY_FILE} `
    + 'in the repository root — or pass --keep to retain every resource and verify nothing. '
    + 'Nothing has been created.';
}

export interface SourceRevision {
  readonly commit: string;
  readonly dirtyDigest: string;
}

export function sourceRevision(): SourceRevision {
  const commit = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();

  // `git diff --binary HEAD` omits untracked paths; hash those via `trackedFiles`, not a private
  // `git ls-files`, so the digest covers the same source set as the project's own gates.
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });

  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');

  const untracked = new Set(
    status.split('\0')
      .filter((row) => row.startsWith('?? '))
      .map((row) => row.slice(3)),
  );

  if (diff.length === 0 && untracked.size === 0) return { commit, dirtyDigest: 'clean' };

  const hash = createHash('sha256').update(diff);

  for (const path of trackedFiles()) {
    if (!untracked.has(path)) continue;
    hash.update('\0untracked\0').update(path).update('\0');
    hash.update(readFileSync(join(REPO_ROOT, path))).update('\0');
  }

  return { commit, dirtyDigest: `sha256:${hash.digest('hex')}` };
}

/** Each container application's ids into its manifest entry, written before anything is deleted: deleting the
 *  application, or the Worker that owns it, leaves its snapshots, and only its ids find them after. Called once its
 *  application exists and again before a teardown, so a run interrupted anywhere has them. */
export function recordApplicationIds(manifest: TeardownManifest): void {
  const learnt = manifest.entries.filter((entry) => entry.kind === 'container-app' && !entry.done).map((entry) => {
    const ids = containerAppIds(REPO_ROOT, [entry.name], log).map((found) => found.id).filter((id) => !entry.ids.includes(id));

    entry.ids.push(...ids);

    return ids.length;
  });

  if (learnt.some((count) => count > 0)) writeManifest(REPO_ROOT, manifest);
}

/** What a container application's teardown reaches: the platform's listing and deletion, and the registry. */
export interface ContainerAppPorts {
  /** The ids the platform lists under `name` now. */
  readonly listed: (name: string) => readonly string[];
  /** Deletes the application `name`; a failure's words, or undefined. */
  readonly remove: (name: string) => string | undefined;
  readonly sweep: (applicationId: string) => Promise<ApplicationSweep>;
}

/**
 * One step for a container application and every snapshot it made, the same for a finished run and an interrupted
 * one: its ids recorded in the entry (`persist`) before anything is deleted, then the application if it is still
 * listed, then each id's snapshots. A step after the application went, or a retry after a refused sweep, still has
 * the ids; deleting the application leaves its snapshots, which on 2026-10-09 were 801 of the 923 orphans removed.
 */
export async function containerAppTeardown(entry: TeardownEntry, persist: () => void, ports: ContainerAppPorts): Promise<DeleteOutcome> {
  const listed = ports.listed(entry.name);
  const ids = [...new Set([...entry.ids, ...listed])];

  if (ids.length > entry.ids.length) {
    entry.ids = ids;
    persist();
  }

  const failed = listed.length === 0 ? undefined : ports.remove(entry.name);

  if (failed !== undefined) return { ok: false, error: failed };

  if (ids.length === 0) return { ok: true, absent: true };

  for (const applicationId of ids) {
    const swept = await ports.sweep(applicationId);

    if (swept.kind === 'refused') return { ok: false, error: `${entry.name}'s snapshots were not deleted: ${swept.reason}` };

    if (swept.left.length > 0) return { ok: false, error: `${entry.name} left ${String(swept.left.length)} snapshot(s) in the registry` };
  }

  return { ok: true };
}

/** The account's own ports: wrangler's listing, the application deletion, and the registry client the boxes use. */
function accountContainerAppPorts(): ContainerAppPorts {
  const token = (process.env['DEVBOX_REGISTRY_TOKEN'] ?? '').trim() || restApiToken();
  const registry = snapshotRegistry({ account: BENCH_ACCOUNT_ID, token, fetch: (input, init) => fetch(input, init) });

  return {
    listed: (name) => containerAppIds(REPO_ROOT, [name], log).map((found) => found.id),
    remove: (name) => deleteContainerApps(REPO_ROOT, [name], log).find((status) => /failed/i.test(status)),
    sweep: async (applicationId) => (token === ''
      ? { kind: 'refused', reason: 'deleting snapshots needs DEVBOX_REGISTRY_TOKEN or KINU_CLOUDFLARE_API_TOKEN' }
      : await registry.deleteApplication(applicationId)),
  };
}

/** Deletes by resource name only: a recovered manifest's process is gone, so no lane state.
 *  "Already absent" is success so an interrupted recovery can be rerun. */
export function orphanTeardownExecutor(
  residue: R2ResiduePlane | null,
  ports: ContainerAppPorts = accountContainerAppPorts(),
): TeardownStep {
  // Durable state is reachable only through its Worker, so a box-empty entry is worthless
  // until the Worker serving it is deleted.
  const workersDeleted = new Set<string>();

  return async (entry, persist, manifest): Promise<DeleteOutcome> => {
    if (entry.kind === 'worker') {
      // Deleting a Worker can take its container applications with it: their ids are written first.
      recordApplicationIds(manifest);
      const deleted = wrangler(['delete', '--name', entry.name, '--force'], { allowFailure: true });

      if (!deleted.startsWith(WRANGLER_FAILED)) {
        workersDeleted.add(entry.name);

        return { ok: true };
      }

      if (/not found|does not exist/i.test(deleted)) {
        workersDeleted.add(entry.name);

        return { ok: true, absent: true };
      }

      return { ok: false, error: deleted.slice(0, 240) };
    }

    if (entry.kind === 'container-app') return await containerAppTeardown(entry, persist, ports);

    if (entry.kind === 'r2-bucket') {
      let deleted = wrangler(['r2', 'bucket', 'delete', entry.name], { allowFailure: true });

      if (deleted.startsWith(WRANGLER_FAILED) && /not empty|10008/i.test(deleted) && residue !== null) {
        const drained = await drainBucketResidue(residue, entry.name);
        log(`${entry.name}: drained ${String(drained.objects)} object(s), aborted ${String(drained.uploads)} upload(s)`);
        deleted = wrangler(['r2', 'bucket', 'delete', entry.name], { allowFailure: true });
      }

      if (!deleted.startsWith(WRANGLER_FAILED)) return { ok: true };

      if (/not found|does not exist/i.test(deleted)) return { ok: true, absent: true };

      return { ok: false, error: deleted.slice(0, 240) };
    }

    if (entry.kind === 'do-state' || entry.kind === 'alarm' || entry.kind === 'mount') {
      // Checks only the Worker derived from this box, not the whole recovery: one arm's failed
      // delete must not report another arm's durable state as surviving.
      const owner = workerServingBox(entry.name);

      if (owner === null) return { ok: false, error: `no Worker name derives from box ${entry.name}` };

      return workersDeleted.has(owner)
        ? { ok: true }
        : { ok: false, error: `Worker ${owner} must be deleted before its durable state` };
    }

    if (entry.kind === 'local-path') {
      rmSync(entry.name, { recursive: true, force: true });

      return { ok: true };
    }

    return { ok: false, error: `unsupported teardown resource ${entry.kind}` };
  };
}

/** A recovered manifest carries no lane state; the box name alone says which Worker goes first.
 *  Null for a name no strategy produces: a wrong guess reports live-served state as deleted. */
function workerServingBox(box: string): string | null {
  for (const strategy of STRATEGIES) {
    const prefix = `ab-${strategy}-`;

    if (!box.startsWith(prefix)) continue;
    const runId = box.slice(prefix.length);

    if (runId === '' || boxName(runId, strategy) !== box) continue;

    return resourceNames(runId, strategy).worker;
  }

  return null;
}
