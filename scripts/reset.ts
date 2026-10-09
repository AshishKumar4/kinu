/**
 * A reset: every Durable Object class a deployment carries deleted with its storage, the Worker keeping its secrets
 * and routes, then what those objects left outside their storage: their container applications, and the devbox
 * chains in the store bucket, which only a box's own state could name. The procedure and why each step is there:
 * docs/DEPLOYMENT.md, § Wrangler bindings.
 *
 * SAFE TO STOP ANYWHERE. Everything a reset needs is checked before it deletes anything: the version the Worker
 * serves and what it binds, the applications, and the REST token the REST-only deletions take. Its record goes to
 * the releases bucket `started`, as `resets/<tag>.json` and the rollback barrier {@link LATEST_RESET_KEY}, before
 * the first deletion, and `done` after the last. A reset that stops between them leaves its placeholder serving and
 * its record `started`; run again, it finishes what that record names instead of refusing the placeholder. On
 * 2026-09-30 one stopped with its placeholder up and two applications deleted, for want of a REST token checked
 * only when it was first needed, and its rerun could only refuse.
 *
 *   bun scripts/reset.ts plan <environment>           what a reset deletes, read from wrangler.jsonc
 *   bun scripts/reset.ts wipe <environment> <record>  delete it, recorded in <record> and the releases bucket;
 *                                                     production asks for `reset production` typed at a terminal
 *   bun scripts/reset.ts pending <environment> <record>  the tag of a reset whose build never uploaded, or `none`;
 *                                                     the newest reset of the Worker, if any, written to <record> for
 *                                                     the pre-upload gate, which defers exactly the rows it deleted
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { evalSessionPath } from '@kinu.run/test-utils';
import { deleteApplicationByRest, deleteR2Prefix, deletedByRest, restApiToken } from './cloudflare-rest';
import { snapshotRegistry } from '../packages/devbox/src/snapshot-registry';
import { type ContainerApplication, type DeployedBinding, containerApplications, deployment, why, wrangler } from './infra-cloudflare';
import {
  type DeployedConfig, INFRA_ENVIRONMENTS, type InfraEnvironment, type Resource, deployedConfig, liveClasses,
} from './infra-manifest';

/** What one reset deleted, or is deleting. */
export const ResetSchema = v.object({
  environment: v.picklist(INFRA_ENVIRONMENTS),
  worker: v.string(),
  tag: v.string(),
  at: v.string(),
  /** Empty in a `started` record written before the placeholder answered with its version. */
  placeholderVersion: v.string(),
  classes: v.array(v.object({ className: v.string(), namespace: v.string() })),
  applications: v.array(v.object({ name: v.string(), id: v.string() })),
  /** Absent where the environment binds no devbox store, and in the records of resets before 2026-09-30. */
  chains: v.optional(v.object({ bucket: v.string(), prefix: v.string(), objects: v.number() })),
  /** `started` from before the first deletion until after the last. Absent in the records of resets before
   *  2026-10-01, written only once complete. Either way the record is a barrier no rollback crosses: from the
   *  placeholder on, the storage it names is gone. */
  state: v.optional(v.picklist(['started', 'done'])),
});

export type Reset = v.InferOutput<typeof ResetSchema>;

/** The newest reset, beside `resets/<tag>.json`: what a rollback must not cross. */
export const LATEST_RESET_KEY = 'resets/latest.json';

/** The words a production reset is confirmed with. */
export const PRODUCTION_CONFIRMATION = 'reset production';

/** The one binding the placeholder carries, the version metadata it names itself with. Every other binding of the
 *  Worker is gone while it serves, which is what lets the pre-upload gate tell which rows a reset owes. */
const PLACEHOLDER_BINDING = 'CF_VERSION_METADATA';

/** It names its own version on every answer, as the product does (`x-kinu-version`), so a deploy's smoke test can tell
 *  the placeholder still answering at an edge from the build it deployed. */
const PLACEHOLDER = `const notice = { ok: false, resetting: true, build: null, message: 'Kinu is being reset to a fresh deployment. Back in a few minutes.' };
export default {
  async fetch(request, env) {
    const health = new URL(request.url).pathname === '/api/health';
    const headers = { 'content-type': 'application/json', 'retry-after': '300', 'x-kinu-version': env.${PLACEHOLDER_BINDING}.id };
    return new Response(JSON.stringify(notice), { status: health ? 200 : 503, headers });
  },
};
`;

/** The store binding `KinuDevbox` keeps its chains in (`packages/cf-backend/src/kinu-devbox.ts`, `store`). */
const DEVBOX_STORE_BINDING = 'BACKUP_BUCKET';

/** Where every box's chain lives in that bucket: `boxes/<box>/…` (devbox `chainStoreRoot`). */
const CHAIN_PREFIX = 'boxes/';

/** Edge rollout takes about two minutes, as in the deploy's smoke test. */
const HEALTH_ATTEMPTS = 8;

const StamplessSchema = v.pipe(v.string(), v.parseJson(), v.object({ build: v.null() }));

/** The version a Worker serves, and the class → namespace of every Durable Object it binds. */
export interface Serving {
  readonly versionId: string;
  readonly bound: ReadonlyMap<string, string>;
}

/** What a deployed version serves, read off its bindings. */
export function servingOf(versionId: string, bindings: readonly DeployedBinding[]): Serving {
  return {
    versionId,
    bound: new Map(bindings.flatMap((binding) => (binding.type === 'durable_object_namespace' && binding.target !== undefined
      && binding.namespace !== undefined ? [[binding.target, binding.namespace] as const] : []))),
  };
}

/**
 * What a reset reads and changes outside this file: the account (wrangler and the REST API, in
 * {@link cloudflareTarget}), the deployment's origin, and the eval sessions this machine keeps for it. A test passes
 * its own, which can fail at any step. Every call that fails throws.
 */
export interface ResetTarget {
  serving: () => Serving;
  applications: () => readonly ContainerApplication[];
  /** The newest reset record of the releases bucket, or none. */
  latest: () => Reset | undefined;
  /** Uploads the placeholder that deletes `classes`, and answers its version. */
  deployPlaceholder: (classes: readonly string[], tag: string) => string;
  deleteApplication: (application: Reset['applications'][number]) => void;
  /** Deletes every container snapshot the application made, which deleting it leaves, and answers how many. */
  deleteSnapshots: (application: Reset['applications'][number]) => Promise<number>;
  /** Deletes every object under the prefix, and answers how many. */
  deleteChains: (chains: { readonly bucket: string; readonly prefix: string }) => Promise<number>;
  /** Puts the record in `file` at `key` in the releases bucket. */
  putRecord: (key: string, file: string) => void;
  /** Whether the origin's `/api/health` answers 200 `{ build: null }`. */
  stampless: (attempt: number) => Promise<boolean>;
  /** Drops every eval bearer this machine keeps for the origin: each named a session the reset deleted. */
  forgetSessions: () => void;
  /** Takes eval-service's credentials before a reset deletes them, or checks the ones a resumed reset owes its restore
   *  (scripts/credential-checkpoint.ts); throws, refusing the reset, when it cannot. */
  checkpoint: (step: 'capture' | 'owed') => void;
}

export interface WipeInput {
  readonly environment: InfraEnvironment;
  readonly config: DeployedConfig;
  /** Where the deploy reads the reset's record from, once it is done. */
  readonly recordFile: string;
  /** What the REST-only deletions authenticate with (`restApiToken`). */
  readonly restToken: string;
  readonly target: ResetTarget;
}

function origin(config: DeployedConfig): string {
  const value = config.vars?.CLI_PUBLIC_ORIGIN;

  if (value === undefined || value === '') throw new Error(`${config.name ?? 'the Worker'} sets no CLI_PUBLIC_ORIGIN, so it has no origin`);

  return value;
}

function bucketOf(config: DeployedConfig, binding: string): string | undefined {
  return config.r2_buckets?.find((entry) => entry.binding === binding)?.bucket_name;
}

function run(argv: readonly string[]): string {
  const result = wrangler(argv, 600_000);

  if (!result.ok) throw new Error(`wrangler ${argv.slice(0, 2).join(' ')} failed: ${why(result)}`);

  return result.stdout;
}

function plan(environment: InfraEnvironment) {
  const config = deployedConfig(environment);

  return { config, classes: liveClasses(config.exports) };
}

/** The newest reset recorded in `bucket`, or none. */
export function latestReset(bucket: string): Reset | undefined {
  const read = wrangler(['r2', 'object', 'get', `${bucket}/${LATEST_RESET_KEY}`, '--pipe', '--remote'], 600_000);

  if (read.ok) return v.parse(ResetSchema, JSON.parse(read.stdout));

  if (`${read.stderr}\n${read.stdout}`.includes('The specified key does not exist.')) return undefined;

  throw new Error(`wrangler r2 object get ${bucket}/${LATEST_RESET_KEY} failed: ${why(read)}`);
}

/** The account as wrangler and the REST API reach it. */
function cloudflareTarget(environment: InfraEnvironment, config: DeployedConfig, scratch: string): ResetTarget {
  const worker = config.name ?? '';
  const releases = bucketOf(config, 'RELEASES_BUCKET') ?? '';
  const site = origin(config);

  return {
    serving: () => {
      const live = deployment(environment);

      if (live.state !== 'deployed') throw new Error(`${worker} serves no version to reset: ${live.state === 'unknown' ? live.reason : 'it has no deployment'}`);

      return servingOf(live.versionId, live.bindings);
    },
    applications: () => {
      const listed = containerApplications();

      if ('failure' in listed) throw new Error(listed.failure);

      return listed;
    },
    latest: () => latestReset(releases),
    deployPlaceholder: (classes, tag) => {
      const placeholder = join(scratch, 'wrangler.json');

      writeFileSync(join(scratch, 'worker.js'), PLACEHOLDER);
      writeFileSync(placeholder, JSON.stringify({
        name: worker,
        account_id: config.account_id,
        main: 'worker.js',
        compatibility_date: config.compatibility_date,
        workers_dev: false,
        routes: config.routes,
        version_metadata: { binding: PLACEHOLDER_BINDING },
        exports: Object.fromEntries(classes.map((name) => [name, { type: 'durable-object', state: 'deleted' }])),
      }));

      return /Version ID:\s*([0-9a-f-]{36})/u.exec(run(['deploy', '-c', placeholder, '--message', `kinu ${environment} ${tag}`]))?.[1] ?? '';
    },
    deleteApplication: (application) => {
      if (!deletedByRest(application.id)) {
        run(['containers', 'delete', application.id]);

        return;
      }

      const deleted = deleteApplicationByRest(config.account_id ?? '', application.id);

      if (!deleted.ok) throw new Error(deleted.reason);
    },
    deleteSnapshots: async (application) => {
      const token = (process.env['DEVBOX_REGISTRY_TOKEN'] ?? '').trim() || restApiToken();
      const swept = await snapshotRegistry({ account: config.account_id ?? '', token, fetch: (input, init) => fetch(input, init) }).deleteApplication(application.id);

      if (swept.kind === 'refused') throw new Error(`${application.name}'s snapshots were not deleted: ${swept.reason}`);

      if (swept.left.length > 0) throw new Error(`${application.name} left ${String(swept.left.length)} snapshot(s) in the registry: ${swept.left.join(', ')}`);

      return swept.deleted;
    },
    deleteChains: (chains) => deleteR2Prefix({ accountId: config.account_id ?? '', bucket: chains.bucket, prefix: chains.prefix }),
    putRecord: (key, file) => {
      run(['r2', 'object', 'put', `${releases}/${key}`, '--file', file, '--content-type', 'application/json', '--remote']);
    },
    stampless: async (attempt) => {
      const answer = await fetch(`${site}/api/health?reset=${String(attempt)}`);

      return answer.status === 200 && v.safeParse(StamplessSchema, await answer.text()).success;
    },
    forgetSessions: () => {
      rmSync(dirname(evalSessionPath(site, undefined)), { recursive: true, force: true });
    },
    checkpoint: (step) => {
      const taken = Bun.spawnSync([process.execPath, join(import.meta.dir, 'credential-checkpoint.ts'), step, site], { stdout: 'inherit', stderr: 'inherit' });

      if (taken.exitCode !== 0) {
        throw new Error(step === 'capture' ? 'eval-service\'s credentials were not captured, as the line above says; nothing was deleted'
          : 'the checkpoint this reset owes its restore is not intact, as the line above says; remove it to finish without it');
      }
    },
  };
}

/** Why a reset cannot delete `applications` and `chains` with `restToken`, or undefined: asked before it deletes. */
function credentialRefusal(applications: Reset['applications'], chains: Reset['chains'], restToken: string): string | undefined {
  const rest = applications.filter((application) => deletedByRest(application.id)).map((application) => application.name);
  const needs = [...rest.length === 0 ? [] : [`container application(s) ${rest.join(', ')}`], ...chains === undefined ? [] : [`the chains under ${chains.bucket}/${chains.prefix}`]];

  return restToken !== '' || needs.length === 0 ? undefined
    : `${needs.join(' and ')} are deleted only through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN); nothing was deleted`;
}

/** The record at `file`, at `resets/<tag>.json` and at the barrier, in that order. */
function record(target: ResetTarget, file: string, reset: Reset): void {
  writeFileSync(file, JSON.stringify(reset));

  for (const key of [`resets/${reset.tag}.json`, LATEST_RESET_KEY]) target.putRecord(key, file);
}

/** The reset `worker` is still in: it serves a placeholder, binding no class, that the newest record names. Its build
 *  never uploaded, so its classes are gone and the next deploy creates them. */
export function pendingReset(worker: string, live: Serving, latest: Reset | undefined): Reset | undefined {
  if (live.bound.size !== 0 || latest === undefined || latest.worker !== worker) return undefined;

  return latest.placeholderVersion === '' || latest.placeholderVersion === live.versionId ? latest : undefined;
}

/**
 * The infrastructure rows `reset` deleted and a deploy recreates, by the ids every infra report keys resources on:
 * the namespace of each class it deleted and each container application it deleted, and — while `live` is still its
 * placeholder — every binding the placeholder does not carry, out of `resources`. Only the pre-upload gate of a
 * `--reset` deploy asks; a version that is not the placeholder carries its own bindings, so the record then answers
 * for its classes and applications alone.
 */
export function resetResourceIds(reset: Reset, live: Serving | undefined, resources: readonly Resource[]): readonly string[] {
  const placeholder = live !== undefined && live.versionId === reset.placeholderVersion;

  return [
    ...reset.classes.map((entry) => `durable-object.${reset.worker}:${entry.className}`),
    ...reset.applications.map((application) => `container.${application.name}`),
    ...placeholder
      ? resources.filter((resource) => resource.kind === 'binding' && resource.binding !== PLACEHOLDER_BINDING).map((resource) => resource.id)
      : [],
  ];
}

function resumed(worker: string, live: Serving, target: ResetTarget): Reset {
  const pending = pendingReset(worker, live, target.latest());

  if (pending === undefined) {
    throw new Error(`version ${live.versionId} of ${worker} binds no class, as a reset placeholder does, and no reset record names it: `
      + 'deploy without --reset (with --bootstrap, the classes being gone)');
  }

  console.log(`reset: ${worker} serves the placeholder of ${pending.tag}, whose record is ${pending.state ?? 'done'}; finishing it`);
  target.checkpoint('owed');

  return { ...pending, placeholderVersion: live.versionId };
}

/** Everything checked, the record and the barrier written `started`, then the placeholder that deletes the classes. */
function begin(input: WipeInput, live: Serving): Reset {
  const { config, target } = input;
  const worker = config.name ?? '';
  const classes = liveClasses(config.exports);
  const names = new Set((config.containers ?? []).map((container) => container.name));
  const namespaces = new Set(live.bound.values());

  const applications = target.applications()
    .filter((application) => names.has(application.name) || (application.namespace !== undefined && namespaces.has(application.namespace)))
    .map(({ name, id }) => ({ name, id }));

  const store = bucketOf(config, DEVBOX_STORE_BINDING);
  const chains = store === undefined ? undefined : { bucket: store, prefix: CHAIN_PREFIX, objects: 0 };
  const refused = credentialRefusal(applications, chains, input.restToken);

  if (refused !== undefined) throw new Error(refused);
  target.checkpoint('capture');
  const tag = `reset-${new Date().toISOString().replace(/[-:]|\.\d+/gu, '')}`;

  const started: Reset = {
    environment: input.environment, worker, tag, at: new Date().toISOString(), placeholderVersion: '',
    classes: [...live.bound].map(([className, namespace]) => ({ className, namespace })), applications, state: 'started',
  };

  if (chains !== undefined) started.chains = chains;

  // Before the first deletion: from the placeholder on, the storage is gone, and no rollback may cross that.
  record(target, input.recordFile, started);
  const placeholderVersion = target.deployPlaceholder([...live.bound.keys()], tag);
  const after = target.serving();

  if (after.versionId !== placeholderVersion || after.bound.size > 0) {
    throw new Error(`the placeholder uploaded as '${placeholderVersion}', and ${worker} does not serve it without Durable Objects`);
  }

  const retired = [...live.bound.keys()].filter((name) => !classes.includes(name));
  const added = classes.filter((name) => !live.bound.has(name));

  console.log(`reset: ${worker} serves placeholder ${placeholderVersion} under ${tag}; deleted ${started.classes.map((each) => `${each.className} (${each.namespace})`).join(', ')}`
    + `${retired.length === 0 ? '' : `; retired ${retired.join(', ')}`}${added.length === 0 ? '' : `; the deploy creates ${added.join(', ')}`}`);

  const placed = { ...started, placeholderVersion };

  record(target, input.recordFile, placed);

  return placed;
}

/** What the record names and is still there, deleted, the record written `done`, and the placeholder seen serving. */
async function finish(input: WipeInput, reset: Reset): Promise<Reset> {
  const { target } = input;

  // The sessions died with the classes; the tiers mint new ones.
  target.forgetSessions();
  let done = reset;

  if (reset.state === 'started') {
    const there = new Set(target.applications().map((application) => application.id));
    const left = reset.applications.filter((application) => there.has(application.id));
    const refused = credentialRefusal(left, reset.chains, input.restToken);

    if (refused !== undefined) throw new Error(refused);

    for (const application of left) {
      target.deleteApplication(application);
      console.log(`reset: deleted container application ${application.name} (${application.id})`);
    }

    // Every application the record names, those a stopped run already deleted included: the snapshots outlive it.
    for (const application of reset.applications) {
      console.log(`reset: deleted ${String(await target.deleteSnapshots(application))} snapshot(s) of ${application.name}`);
    }

    // Last, once no box is left to write one.
    const objects = reset.chains === undefined ? undefined : await target.deleteChains(reset.chains);

    done = { ...reset, state: 'done' };

    if (reset.chains !== undefined) {
      done.chains = { ...reset.chains, objects: objects ?? 0 };
      console.log(`reset: deleted ${String(objects)} chain objects under ${reset.chains.bucket}/${reset.chains.prefix}`);
    }

    record(target, input.recordFile, done);
  } else {
    writeFileSync(input.recordFile, JSON.stringify(done));
  }

  let answered = false;

  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS && !answered; attempt += 1) {
    answered = await target.stampless(attempt);

    if (!answered && attempt < HEALTH_ATTEMPTS) await Bun.sleep(15_000);
  }

  if (!answered) throw new Error(`${origin(input.config)}/api/health never answered 200 { build: null }`);

  return done;
}

export async function wipe(input: WipeInput): Promise<Reset> {
  const worker = input.config.name ?? '';

  if (bucketOf(input.config, 'RELEASES_BUCKET') === undefined) throw new Error(`${worker} binds no RELEASES_BUCKET to keep the reset's record in`);
  origin(input.config);
  const live = input.target.serving();

  return finish(input, live.bound.size === 0 ? resumed(worker, live, input.target) : begin(input, live));
}

/** Asks on the terminal, and only there: piped input is no person's answer. */
async function confirmedAtTerminal(): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stderr.write(`Type '${PRODUCTION_CONFIRMATION}' to delete every Durable Object of production: `);

  for await (const line of console) return line.trim() === PRODUCTION_CONFIRMATION;

  return false;
}

async function main(argv: readonly string[], scratch: string): Promise<number> {
  const [command, environment, recordFile] = argv;
  const known = v.is(v.picklist(INFRA_ENVIRONMENTS), environment);

  if (known && command === 'plan' && recordFile === undefined) {
    const { config, classes } = plan(environment);

    const store = bucketOf(config, DEVBOX_STORE_BINDING);

    console.log(`${config.name ?? ''}: the classes the live version binds, of which wrangler.jsonc carries ${classes.join(', ')}; `
      + `container applications ${(config.containers ?? []).map((container) => container.name).join(', ')}, and those bound to the deleted namespaces`
      + `${store === undefined ? '' : `; every object under ${store}/${CHAIN_PREFIX}`}`);

    return 0;
  }

  if (known && command === 'wipe' && recordFile !== undefined) {
    if (environment === 'production' && !await confirmedAtTerminal()) {
      console.error(`reset: not confirmed at a terminal with '${PRODUCTION_CONFIRMATION}'; nothing was deleted.`);

      return 1;
    }

    const { config } = plan(environment);

    const reset = await wipe({
      environment, config, recordFile, restToken: restApiToken(), target: cloudflareTarget(environment, config, scratch),
    });

    console.log(`reset: placeholder ${reset.placeholderVersion} answers /api/health with no build; recorded at resets/${reset.tag}.json`);

    return 0;
  }

  if (known && command === 'pending' && recordFile !== undefined) {
    const { config } = plan(environment);
    const worker = config.name ?? '';
    const target = cloudflareTarget(environment, config, scratch);
    const latest = target.latest();

    if (latest?.worker === worker) writeFileSync(recordFile, JSON.stringify(latest));
    console.log(pendingReset(worker, target.serving(), latest)?.tag ?? 'none');

    return 0;
  }

  console.error('usage: bun scripts/reset.ts plan <environment> | wipe <environment> <record> | pending <environment> <record>');

  return 2;
}

if (import.meta.main) {
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-reset-'));
  let code: number;

  try {
    code = await main(process.argv.slice(2), scratch);
  } catch (error) {
    console.error(`reset: REFUSED — ${renderThrownChain({ cause: error })}`);
    code = 1;
  }

  rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}
