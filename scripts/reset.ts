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
 *   bun scripts/reset.ts served <environment>         the build the deployment serves, which a tables reset diffs from
 *   bun scripts/reset.ts stamps <environment>         the classes whose stamp the candidate moves; exit 3 if any
 *   bun scripts/reset.ts census <environment> <out>   every table's rows on every object, for a rehearsal's diff
 *   bun scripts/reset.ts tables <environment> <record> [--from <sha>]
 *                                                     only the tables the release changed dropped, on every object
 *                                                     that holds them (scripts/tables-reset.ts)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { evalSessionPath } from '@kinu.run/test-utils';
import { deleteR2Prefix, deletedByRest } from './cloudflare-rest';
import { registryToken, restApiToken } from './cloudflare-token';
import { snapshotRegistry } from '../packages/devbox/src/snapshot-registry';
import {
  type ContainerApplication, type DeployedBinding, containerApplications, deleteContainerApplication, deployedVersion, deployment,
  r2Text, requireCloudflareAccountId, why, wrangler,
} from './infra-cloudflare';
import {
  type DeployedConfig, INFRA_ENVIRONMENTS, type InfraEnvironment, type Resource, bucketOf, deployedConfig, liveClasses,
} from './infra-manifest';
import { servedHealth } from './served-health';
import { readGenesisLockText } from './schema-drift';
import {
  cascadingDrops, censusDiff, censusLines, changedTables, confirmation, listedObjects, storesOf, unstampedTables, planLines, reachAll, RESET_CLASSES, writeLines,
  type Reached, type TablesTarget,
} from './tables-reset';
import { OPS_PASS_PREFIX } from '@kinu.run/core';

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
  /** `tables`: a tables reset (scripts/tables-reset.ts), which deletes no class: only `tables`, on every object holding
   *  them. Absent in a full reset's record. Either is a barrier: no build older than the candidate runs the new shape. */
  kind: v.optional(v.picklist(['objects', 'tables'])),
  tables: v.optional(v.array(v.object({ table: v.string(), change: v.picklist(['removed', 'reshaped']), classes: v.array(v.string()) }))),
  /** A tables reset's builds: the one the deployment served before, and the candidate. */
  from: v.optional(v.string()),
  candidate: v.optional(v.string()),
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

/** Edge rollout takes about two minutes, as in the deploy's smoke test, which asks every two seconds too: each ask
 *  that missed slept 15 s until 2026-10-14, after a placeholder that answered seconds after its upload. */
const HEALTH_MS = 120_000;

const HEALTH_POLL_MS = 2_000;

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
  /** The version the deployment serves, read from the deployment alone ({@link deployedVersion}). */
  servedVersion: () => string;
  applications: () => readonly ContainerApplication[];
  /** The newest reset record of the releases bucket, or none. */
  latest: () => Reset | undefined;
  /** Uploads the placeholder that deletes `classes`, and answers its version. */
  deployPlaceholder: (classes: readonly string[], tag: string) => string;
  deleteApplication: (application: Reset['applications'][number]) => Promise<void>;
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

function run(argv: readonly string[]): string {
  const result = wrangler(argv, { timeoutMs: 600_000 });

  if (!result.ok) throw new Error(`wrangler ${argv.slice(0, 2).join(' ')} failed: ${why(result)}`);

  return result.stdout;
}

function plan(environment: InfraEnvironment) {
  const config = deployedConfig(environment);

  return { config, classes: liveClasses(config.exports) };
}

/** The newest reset recorded in `bucket`, or none. */
export function latestReset(bucket: string): Reset | undefined {
  const text = r2Text(bucket, LATEST_RESET_KEY);

  return text === undefined ? undefined : v.parse(ResetSchema, JSON.parse(text));
}

/** The account as wrangler and the REST API reach it. */
function cloudflareTarget(environment: InfraEnvironment, config: DeployedConfig, scratch: string): ResetTarget {
  const worker = config.name ?? '';
  const releases = bucketOf(config, 'RELEASES_BUCKET') ?? '';
  const site = origin(config);
  const account = requireCloudflareAccountId();

  return {
    serving: () => {
      const live = deployment(environment);

      if (live.state !== 'deployed') throw new Error(`${worker} serves no version to reset: ${live.state === 'unknown' ? live.reason : 'it has no deployment'}`);

      return servingOf(live.versionId, live.bindings);
    },
    servedVersion: () => {
      const served = deployedVersion(environment);

      if (served.state !== 'deployed') throw new Error(`${worker} serves no version: ${served.state === 'unknown' ? served.reason : 'it has no deployment'}`);

      return served.versionId;
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
    deleteApplication: deleteContainerApplication,
    deleteSnapshots: async (application) => {
      const swept = await snapshotRegistry({ account, token: registryToken(), fetch: (input, init) => fetch(input, init) }).deleteApplication(application.id);

      if (swept.kind === 'refused') throw new Error(`${application.name}'s snapshots were not deleted: ${swept.reason}`);

      if (swept.left.length > 0) throw new Error(`${application.name} left ${String(swept.left.length)} snapshot(s) in the registry: ${swept.left.join(', ')}`);

      return swept.deleted;
    },
    deleteChains: (chains) => deleteR2Prefix({ accountId: account, bucket: chains.bucket, prefix: chains.prefix }),
    putRecord: (key, file) => {
      run(['r2', 'object', 'put', `${releases}/${key}`, '--file', file, '--content-type', 'application/json', '--remote']);
    },
    stampless: async (attempt) => {
      return (await servedHealth(site, { query: `?reset=${String(attempt)}` })).build === null;
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
function record(target: Pick<ResetTarget, 'putRecord'>, file: string, reset: Reset): void {
  writeFileSync(file, JSON.stringify(reset));

  for (const key of [`resets/${reset.tag}.json`, LATEST_RESET_KEY]) target.putRecord(key, file);
}

/** The reset `worker` is still in: it serves a placeholder, binding no class, that the newest record names. Its build
 *  never uploaded, so its classes are gone and the next deploy creates them. */
export function pendingReset(worker: string, live: Serving, latest: Reset | undefined): Reset | undefined {
  if (live.bound.size !== 0 || latest === undefined || latest.worker !== worker || latest.kind === 'tables') return undefined;

  return latest.placeholderVersion === '' || latest.placeholderVersion === live.versionId ? latest : undefined;
}

/**
 * The infrastructure rows `reset` deleted, or deletes when it is finished, and a deploy recreates, by the ids every
 * infra report keys resources on: the namespace of each class it deleted, each container application it names and
 * that application's hold on its class's namespace, and — while `live` is still its placeholder — every binding the
 * placeholder does not carry, out of `resources`. Only the pre-upload gate of a `--reset` deploy asks; a version that
 * is not the placeholder carries its own bindings, so the record then answers for its classes and applications alone.
 *
 * The hold is the reset's because a reset stopped after its placeholder leaves the application bound to a namespace
 * the placeholder deleted, and only finishing the reset deletes it: staging, 2026-10-14, the reset of 56377b387
 * stopped there, and the gate refused the `--reset` deploy that would have finished it.
 */
export function resetResourceIds(reset: Reset, live: Serving | undefined, resources: readonly Resource[]): readonly string[] {
  // A reset stopped before its record named its placeholder still serves it: the one `pendingReset` resumes.
  const placeholder = live !== undefined && pendingReset(reset.worker, live, reset) !== undefined;

  return [
    ...reset.classes.map((entry) => `durable-object.${reset.worker}:${entry.className}`),
    ...reset.applications.flatMap((application) => [`container.${application.name}`, `container-namespace.${application.name}`]),
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
  // The placeholder binds no class by construction (`deployPlaceholder` writes its config), so what is read back is
  // only that the deployment serves it: the version's own view may not exist yet (`deployedVersion`).
  const placeholderVersion = target.deployPlaceholder([...live.bound.keys()], tag);
  const served = target.servedVersion();

  if (served !== placeholderVersion) throw new Error(`the placeholder uploaded as '${placeholderVersion}', and ${worker} serves '${served}'`);

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
      await target.deleteApplication(application);
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

  const until = Date.now() + HEALTH_MS;
  let answered = await target.stampless(1);

  for (let attempt = 2; !answered && Date.now() < until; attempt += 1) {
    await Bun.sleep(HEALTH_POLL_MS);
    answered = await target.stampless(attempt);
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
async function confirmedAtTerminal(words = PRODUCTION_CONFIRMATION, what = 'delete every Durable Object of production'): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stderr.write(`Type '${words}' to ${what}: `);

  for await (const line of console) return line.trim() === words;

  return false;
}

/** A tables reset's commands (scripts/tables-reset.ts). */
const TABLES_COMMANDS = ['served', 'stamps', 'census', 'tables'] as const;

/** `served`, `census` and `tables`: a tables reset's commands. */
async function tablesCommand(command: (typeof TABLES_COMMANDS)[number], environment: InfraEnvironment, args: readonly string[]): Promise<number> {
  const [recordFile, flag, from] = args;

  if (command === 'served' && recordFile === undefined) {
    const sha = (await servedHealth(origin(plan(environment).config))).build?.sha;

    if (sha === undefined) throw new Error(`${environment} serves no build stamp, so a tables reset cannot tell what it changed from`);
    console.log(sha);

    return 0;
  }

  // Exit 3 when the candidate moves a class's stamp: every database of that class is refused until the step reaches it.
  if (command === 'stamps' && recordFile === undefined) {
    const sha = (await servedHealth(origin(plan(environment).config))).build?.sha;
    const served = sha === undefined ? undefined : stampsAt(sha);
    const candidate = stampsAt('HEAD') ?? {};
    const moved = Object.keys(candidate).filter((schema) => served?.[schema] !== candidate[schema]);

    console.log(moved.length === 0 ? 'none' : moved.join(','));

    return moved.length === 0 ? 0 : 3;
  }

  if (command === 'census' && recordFile !== undefined) {
    const { config } = plan(environment);
    const reached = await reachAll(tablesTarget(environment, config), { tables: [], drop: false });

    writeLines(recordFile, censusLines(reached));
    console.log(`census: ${String(reached.length)} object(s) of ${RESET_CLASSES.join(', ')}; every table's rows in ${recordFile}`);

    return 0;
  }

  if (command === 'tables' && recordFile !== undefined && (flag === undefined || (flag === '--from' && from !== undefined))) {
    return await resetChangedTables({ environment, recordFile, from });
  }

  console.error('usage: bun scripts/reset.ts served <environment> | stamps <environment> | census <environment> <out> | tables <environment> <record> [--from <sha>]');

  return 2;
}

/** How long a pass lives if this process dies before it deletes it: past the longest sweep, short of a day. */
const PASS_TTL_SECONDS = 6 * 60 * 60;

/** The deployment as a tables reset reaches it: Cloudflare's object lists, its AUTH_KV, and its `/ops/tables`. */
function tablesTarget(environment: InfraEnvironment, config: DeployedConfig): TablesTarget {
  const site = origin(config);
  const account = requireCloudflareAccountId();
  const kv = config.kv_namespaces?.find((namespace) => namespace.binding === 'AUTH_KV')?.id;
  const token = restApiToken();

  if (kv === undefined) throw new Error(`${config.name ?? 'the Worker'} binds no AUTH_KV, where a tables reset's pass is written`);

  if (token === '') throw new Error('a tables reset lists objects through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)');
  const live = deployment(environment);

  if (live.state !== 'deployed') throw new Error(`${config.name ?? 'the Worker'} serves no version: ${live.state === 'unknown' ? live.reason : 'it has no deployment'}`);
  const { bound } = servingOf(live.versionId, live.bindings);

  return {
    objects: async (className) => {
      const namespace = bound.get(className);

      if (namespace === undefined) throw new Error(`${config.name ?? 'the Worker'} binds no ${className}`);

      return await listedObjects(account, namespace, token);
    },
    admit: (digest) => { run(['kv', 'key', 'put', `${OPS_PASS_PREFIX}${digest}`, '1', '--namespace-id', kv, '--ttl', String(PASS_TTL_SECONDS), '--remote']); },
    forget: (digest) => { run(['kv', 'key', 'delete', `${OPS_PASS_PREFIX}${digest}`, '--namespace-id', kv, '--remote']); },
    ops: async (pass, body) => {
      const answer = await fetch(`${site}/ops/tables`, {
        method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
      });

      return { status: answer.status, text: await answer.text() };
    },
  };
}

/** The short sha a build is named by, as `/api/health` serves it. */
function shortSha(ref: string): string {
  return Bun.spawnSync(['git', 'rev-parse', '--short=9', ref]).stdout.toString().trim();
}

/** The tables `from` and the candidate's lock disagree on, or the reason this step cannot drop them. */
function releaseTables(from: string): ReturnType<typeof changedTables> {
  const fromLock = Bun.spawnSync(['git', 'show', `${from}:scripts/schema-genesis.lock.json`]);

  if (fromLock.exitCode !== 0) throw new Error(`${from} carries no scripts/schema-genesis.lock.json in this checkout: ${fromLock.stderr.toString().trim()}`);
  const before = readGenesisLockText(fromLock.stdout.toString());
  // The candidate's lock as committed: the worktree's file may say what no uploaded build does.
  const candidate = Bun.spawnSync(['git', 'show', 'HEAD:scripts/schema-genesis.lock.json']);

  return changedTables(before, readGenesisLockText(candidate.stdout.toString()));
}

/** The tables each class's init makes, as the candidate commit measured them. */
function candidateClasses(): Record<string, readonly string[]> {
  const shown = Bun.spawnSync(['git', 'show', 'HEAD:scripts/schema-classes.json']);

  return v.parse(v.record(v.string(), v.array(v.string())), JSON.parse(shown.stdout.toString()));
}

/** The class stamps a commit's build carries, or none for a build before stamps were per class. */
export function stampsAt(commit: string): Record<string, string> | undefined {
  const shown = Bun.spawnSync(['git', 'show', `${commit}:packages/core/src/identity/schema-genesis.ts`]);
  const stamps = [...shown.stdout.toString().matchAll(/^\s+(\w+): 0x([0-9a-f]+),$/gmu)].map((match) => [match[1] ?? '', match[2] ?? ''] as const);

  return shown.exitCode !== 0 || stamps.length === 0 ? undefined : Object.fromEntries(stamps);
}

/** The plan, the confirmation, the record `started`, the drops, the record `done`: `tables <environment> <record>`. */
async function resetChangedTables(input: { environment: InfraEnvironment; recordFile: string; from: string | undefined }): Promise<number> {
  const { environment, recordFile } = input;
  const { config } = plan(environment);
  const site = origin(config);
  const served = (await servedHealth(site)).build?.sha;
  const candidate = shortSha('HEAD');
  const from = input.from ?? recordedFrom(recordFile) ?? served;

  if (from === undefined) throw new Error(`${site} serves no build stamp, so the build it served before is unknown: name it with --from <sha>`);

  if (served === undefined || !candidate.startsWith(served.slice(0, 7))) {
    throw new Error(`${site} serves ${served ?? 'no build'}, not the candidate ${candidate}: a tables reset runs once the candidate is uploaded, through its own /ops/tables`);
  }

  if (candidate.startsWith(from.slice(0, 7))) throw new Error(`${site} already served ${candidate} before: name the build it served earlier with --from <sha>`);
  const { changed, added } = releaseTables(from);

  const target = tablesTarget(environment, config);
  const asked = await reachAll(target, { tables: changed, drop: false });
  const unstamped = unstampedTables(changed, candidateClasses(), asked);

  if (unstamped.length > 0) {
    throw new Error(`${unstamped.join(', ')} changed and no class's stamp covers it: its object makes it after it starts, so storage holding `
      + 'its old genesis is never refused. Make it in its class\'s init (scripts/schema-classes.json), or reset fully (deploy --reset); nothing was dropped');
  }

  const cascading = cascadingDrops(asked);

  if (cascading.length > 0) {
    throw new Error(`dropping would reach rows no changed table holds: ${cascading.join('; ')}. Change the referring table in the same `
      + 'release, or reset fully (deploy --reset); nothing was dropped');
  }

  if (changed.length === 0 && storesOf(asked).every((store) => store.answer.stamp !== 'behind')) {
    console.log(`tables: no table changed between ${from} and ${candidate}, and every database is stamped as this build's; nothing to do`);

    return 0;
  }

  console.log(`tables: ${from} → ${candidate} on ${config.name ?? ''}; ${String(asked.length)} object(s) listed in ${RESET_CLASSES.join(', ')}`);

  for (const line of planLines(changed, added, asked)) console.log(`tables: ${line}`);
  console.log(`tables: ${shareCardsNote(asked)}`);

  if (environment === 'production' && !await confirmedAtTerminal(confirmation(asked), 'rebuild and drop exactly these tables on every database of production that holds them')) {
    console.error(`tables: not confirmed at a terminal with '${confirmation(asked)}'; nothing was changed.`);

    return 1;
  }

  const holders = (table: string) => [...new Set(storesOf(asked).filter((store) => store.answer.held.some((held) => held.table === table)).map((store) => store.kind))];
  const tag = `tables-${new Date().toISOString().replace(/[-:]|\.\d+/gu, '')}`;

  const started: Reset = {
    environment, worker: config.name ?? '', tag, at: new Date().toISOString(), placeholderVersion: '', classes: [], applications: [], state: 'started',
    kind: 'tables', from, candidate, tables: changed.map((table) => ({ table: table.table, change: table.change, classes: holders(table.table) })),
  };

  // Before the first drop: from here no build older than the candidate runs on this storage.
  record({ putRecord: tablesRecordPut(config) }, recordFile, started);
  const dropped = await reachAll(target, { tables: changed, drop: true });

  for (const store of storesOf(dropped)) {
    if (store.answer.rebuilt.length > 0) console.log(`tables: rebuilt ${store.answer.rebuilt.join(', ')} on ${store.kind} ${store.label}`);

    if (store.answer.dropped.length > 0) console.log(`tables: dropped ${store.answer.dropped.join(', ')} on ${store.kind} ${store.label}`);
  }

  // Every object either pass met is asked again, though a listing may have dropped it since.
  const met = [...asked, ...dropped];
  const verified = await reachAll(target, { tables: changed, drop: false }, met);
  // The census either side of the drops, beside the record: a rehearsal diffs them, and so does this run.
  writeLines(`${recordFile}.census-before.tsv`, censusLines(asked));
  writeLines(`${recordFile}.census-after.tsv`, censusLines(verified));
  const moved = censusDiff(censusLines(asked), censusLines(verified), new Set([...changed.map((table) => table.table), ...added]));

  console.log(`tables: census before and after in ${recordFile}.census-{before,after}.tsv; ${String(moved.meant.length)} line(s) the release meant to move, `
    + `${String(moved.unmeant.length)} it did not mean to (live writes during the run, or a fault)`);

  for (const line of moved.unmeant) console.log(`tables:   unmeant ${line}`);
  const unanswered = verified.filter((object) => object.answer === undefined).map((object) => `${object.className} ${object.id} (${object.error ?? ''})`);
  const unfinished = storesOf(verified).filter((store) => store.answer.stamp !== 'current' || store.answer.held.some((held) => held.stale)).map((store) => `${store.kind} ${store.label}`);
  const left = [...unanswered, ...unfinished];

  if (left.length > 0) throw new Error(`${String(left.length)} database(s) still behind this build or not answering: ${left.join('; ')}. Run again to finish`);

  record({ putRecord: tablesRecordPut(config) }, recordFile, { ...started, state: 'done' });
  console.log(`tables: done; recorded at resets/${tag}.json`);

  return 0;
}

/** The build a stopped tables reset named as served before, read from its own record. */
function recordedFrom(recordFile: string): string | undefined {
  const text = Bun.file(recordFile).size > 0 ? readFileSync(recordFile, 'utf8') : '';
  const recorded = text === '' ? undefined : v.safeParse(ResetSchema, JSON.parse(text));

  return recorded?.success === true && recorded.output.kind === 'tables' ? recorded.output.from : undefined;
}

/** Puts a record into the releases bucket, as a full reset's are. */
function tablesRecordPut(config: DeployedConfig): ResetTarget['putRecord'] {
  const releases = bucketOf(config, 'RELEASES_BUCKET');

  if (releases === undefined) throw new Error(`${config.name ?? 'the Worker'} binds no RELEASES_BUCKET to keep the reset's record in`);

  return (key, file) => { run(['r2', 'object', 'put', `${releases}/${key}`, '--file', file, '--content-type', 'application/json', '--remote']); };
}

/** What the accounts lose of the shares they received, which only bites where `user_share_cards` changed. */
function shareCardsNote(reached: readonly Reached[]): string {
  const rows = reached.flatMap((object) => object.answer?.held.filter((held) => held.table === 'user_share_cards' && held.stale) ?? []);
  const total = rows.reduce((sum, held) => sum + held.rows, 0);

  return rows.length === 0 ? 'user_share_cards is not dropped: every received share stays'
    : `user_share_cards is dropped on ${String(rows.length)} account(s), ${String(total)} received share(s): each recipient loses those cards, `
      + 'and no sender re-delivers them, since its share_cards_sent row still says it sent each (a card comes back only when its share changes)';
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

  if (known && command === 'census' && recordFile !== undefined) {
    const { config } = plan(environment);
    const reached = await reachAll(tablesTarget(environment, config), { tables: [], drop: false });

    writeLines(recordFile, censusLines(reached));
    console.log(`census: ${String(reached.length)} object(s) of ${RESET_CLASSES.join(', ')}; every table's rows in ${recordFile}`);

    return 0;
  }

  const tables = TABLES_COMMANDS.find((name) => name === command);

  if (known && tables !== undefined) return await tablesCommand(tables, environment, argv.slice(2));

  console.error('usage: bun scripts/reset.ts plan <environment> | wipe <environment> <record> | pending <environment> <record> '
    + '| served <environment> | census <environment> <out> | tables <environment> <record> [--from <sha>]');

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
