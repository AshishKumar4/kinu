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
 *   bun scripts/reset.ts served <environment>         the build the deployment serves, which a tables plan diffs from
 *   bun scripts/reset.ts stamps <environment>         the classes whose stamp the candidate moves; exit 3 if any
 *   bun scripts/reset.ts schema-change <environment>  what the candidate does to the served build's tables: none
 *                                                     (exit 0), additive (4: only tables made, which ships with
 *                                                     --reset-tables on its own), or changes (5: holds for Main)
 *   bun scripts/reset.ts census <environment> <out>   every table's rows and their digest on every object, for a diff
 *   bun scripts/reset.ts census-diff <environment> <before> <after> <record>
 *                                                     a census before a tables release against the walk's after it:
 *                                                     fails on the reset's structure, and on a frozen target (all
 *                                                     but production) on any change outside the record's plan
 *   bun scripts/reset.ts tables-plan <environment> <record> [--from <sha>]
 *                                                     before the upload: every table each class drops (those the
 *                                                     release changed, and what refers to them), and what refuses
 *   bun scripts/reset.ts tables-record <environment> <record>
 *                                                     just before the upload: the plan's record published as the
 *                                                     rollback barrier
 *   bun scripts/reset.ts tables <environment> <record>
 *                                                     after it: every object opened, so each resets itself, and
 *                                                     its census (scripts/tables-reset.ts)
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
  type DeployedConfig, ExportEntrySchema, INFRA_ENVIRONMENTS, type InfraEnvironment, type Resource, WRANGLER_CONFIG, bucketOf, deployedConfig, liveClasses,
} from './infra-manifest';
import { servedHealth } from './served-health';
import { readGenesisLockText } from './schema-drift';
import {
  censusDiff, censusLines, changedTables, classLossRefusals, confirmation, derivedIn, listedObjects, lossRefusals, planLines, referrersOf, schemaChange, verdictOf, walk, walkLines, writeLines,
  type TablesTarget,
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
  /** `tables`: a release whose objects repair their tables at first contact (scripts/tables-reset.ts), which deletes
   *  no class. Absent in a full reset's record. Either is a barrier: no build older than the candidate runs the new
   *  shape. */
  kind: v.optional(v.picklist(['objects', 'tables'])),
  tables: v.optional(v.array(v.object({ table: v.string(), change: v.picklist(['removed', 'reshaped']), classes: v.array(v.string()) }))),
  /** A tables release's builds: the one the deployment served before, and the candidate. */
  from: v.optional(v.string()),
  candidate: v.optional(v.string()),
});

export type Reset = v.InferOutput<typeof ResetSchema>;

/** The newest reset, beside `resets/<tag>.json`: what a rollback must not cross. */
export const LATEST_RESET_KEY = 'resets/latest.json';

/** What staging's upgrade fixtures expect to find (scripts/upgrade-fixtures.ts). A full reset deletes it with the
 *  accounts that held them, so the deploy after it seeds them anew, on purpose. */
export const UPGRADE_ANCHOR_KEY = 'upgrade-fixtures/manifest.json';

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

/** A built config (dist/kinu/wrangler.json) as far as it names Durable Object classes; every other field is kept. */
export const BuiltClassesSchema = v.looseObject({
  durable_objects: v.optional(v.looseObject({ bindings: v.array(v.looseObject({ class_name: v.string(), script_name: v.optional(v.string()) })) })),
  exports: v.optional(v.record(v.string(), ExportEntrySchema)),
  containers: v.optional(v.array(v.looseObject({ class_name: v.string() }))),
});

/**
 * The build as a version can be uploaded before the reset (deploy.sh step 2a), and the classes left out of it: each
 * Durable Object class the target does not bind yet, with every binding, export and container that names it. Wrangler
 * provisions a declared class when a version is deployed, and refuses an upload that binds one before ("the namespace
 * must exist before a binding can reference it", rc28's MailNameDO and MailboxDO, 2026-10-20). What the upload reads is
 * the script's startup, the same bytes either way; the deploy after the reset binds them all.
 */
export function validationBuild(built: BuiltClasses, serving: Serving): ValidationBuild {
  const bindings = built.durable_objects?.bindings ?? [];
  const declared = [...bindings.filter((binding) => binding.script_name === undefined).map((binding) => binding.class_name), ...liveClasses(built.exports)];
  const withheld = [...new Set(declared)].filter((name) => !serving.bound.has(name));
  const kept = (name: string) => !withheld.includes(name);

  // A field the build has no value for stays absent: an undefined one is not written.
  const config = {
    ...built,
    durable_objects: built.durable_objects === undefined ? undefined : { ...built.durable_objects, bindings: bindings.filter((binding) => kept(binding.class_name)) },
    exports: built.exports === undefined ? undefined : Object.fromEntries(Object.entries(built.exports).filter(([name]) => kept(name))),
    containers: built.containers?.filter((container) => kept(container.class_name)),
  } satisfies BuiltClasses;

  return { config, withheld };
}

export type BuiltClasses = v.InferOutput<typeof BuiltClassesSchema>;

/** The build the validation uploads, and the classes it leaves out. */
export interface ValidationBuild {
  readonly config: BuiltClasses;
  readonly withheld: readonly string[];
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
  /** Deletes the upgrade fixtures' anchor from the releases bucket ({@link UPGRADE_ANCHOR_KEY}). */
  forgetUpgradeAnchor: () => void;
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
    forgetUpgradeAnchor: () => {
      run(['r2', 'object', 'delete', `${releases}/${UPGRADE_ANCHOR_KEY}`, '--remote']);
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

    // The fixtures' accounts went with the classes: the deploy after this seeds them as a first seed, not as a loss.
    target.forgetUpgradeAnchor();
    console.log(`reset: forgot the upgrade fixtures' anchor (${UPGRADE_ANCHOR_KEY})`);

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

/** A tables release's commands (scripts/tables-reset.ts). */
const TABLES_COMMANDS = ['served', 'stamps', 'schema-change', 'retirements', 'census', 'tables-plan', 'tables-record', 'tables'] as const;

/** `census-diff <environment> <before> <after> <record>`: the proof a tables release keeps, its plan's tables read from
 *  its record. Staging holds still while a release's eval runs on it; production's people write all along. */
function censusDiffCommand(environment: InfraEnvironment, args: readonly string[]): number {
  const [before, after, recordFile] = args;

  if (before === undefined || after === undefined || recordFile === undefined) {
    console.error('usage: bun scripts/reset.ts census-diff <environment> <before> <after> <record>');

    return 2;
  }

  const planned = v.parse(v.object({ tables: v.array(v.object({ table: v.string() })) }), JSON.parse(readFileSync(recordFile, 'utf8')));
  const diff = censusDiff(readFileSync(before, 'utf8'), readFileSync(after, 'utf8'), new Set(planned.tables.map(({ table }) => table)), environment !== 'production');

  for (const line of diff.lines) console.log(line);

  return diff.failed.length === 0 ? 0 : 1;
}

/** `served`, `stamps`, `census`, `tables-plan`, `tables-record` and `tables`: a tables release's commands. */
async function tablesCommand(command: (typeof TABLES_COMMANDS)[number], environment: InfraEnvironment, args: readonly string[]): Promise<number> {
  const [recordFile, flag, from] = args;

  if (command === 'served' && recordFile === undefined) {
    const sha = (await servedHealth(origin(plan(environment).config))).build?.sha;

    if (sha === undefined) throw new Error(`${environment} serves no build stamp, so a tables release cannot tell what it changed from`);
    console.log(sha);

    return 0;
  }

  if (command === 'stamps' && recordFile === undefined) return await stampsMoved(environment);

  if (command === 'schema-change' && recordFile === undefined) return await schemaChangeOf(environment);

  if (command === 'retirements' && recordFile === undefined) return await retirementsOf(environment);

  if (command === 'census' && recordFile !== undefined) {
    const { reached } = await walk(tablesTarget(environment, plan(environment).config));

    writeLines(recordFile, censusLines(reached));
    console.log(`census: ${String(reached.length)} object(s); every table's rows in ${recordFile}`);

    return 0;
  }

  if (command === 'tables-plan' && recordFile !== undefined && (flag === undefined || (flag === '--from' && from !== undefined))) {
    return await planTables({ environment, recordFile, from });
  }

  if (command === 'tables-record' && recordFile !== undefined && flag === undefined) return publishTables(environment, recordFile);

  if (command === 'tables' && recordFile !== undefined && flag === undefined) return await walkTables(environment, recordFile);

  console.error('usage: bun scripts/reset.ts served <environment> | stamps <environment> | census <environment> <out> '
    + '| tables-plan <environment> <record> [--from <sha>] | tables-record <environment> <record> | tables <environment> <record> '
    + '| schema-change <environment>');

  return 2;
}

/** The tables whose loss is acceptable, each with why (`scripts/schema-loss.json`), as the candidate holds them. */
function lossAcceptable(): Record<string, string> {
  return v.parse(v.record(v.string(), v.string()), JSON.parse(fileAt(process.cwd(), 'HEAD', 'scripts/schema-loss.json')));
}

/** Exit 3 when the candidate moves a class's stamp: every database of that class repairs itself at first contact. */
async function stampsMoved(environment: InfraEnvironment): Promise<number> {
  const sha = (await servedHealth(origin(plan(environment).config))).build?.sha;
  const served = sha === undefined ? undefined : stampsAt(sha);
  const candidate = stampsAt('HEAD') ?? {};
  const moved = Object.keys(candidate).filter((schema) => served?.[schema] !== candidate[schema]);

  console.log(moved.length === 0 ? 'none' : moved.join(','));

  return moved.length === 0 ? 0 : 3;
}

/** Exit 1 when the candidate retires a class the deployment's served build exports and, in production, the owner's words
 *  (`KINU_LOSS_OVERRIDE`) do not name it: its namespace and every row in it go with the deploy. Elsewhere it is said. */
async function retirementsOf(environment: InfraEnvironment): Promise<number> {
  const sha = (await servedHealth(origin(plan(environment).config))).build?.sha;

  if (sha === undefined) throw new Error(`${environment} serves no build stamp, so which classes this release retires is unknown`);

  const exported = (commit: string) => {
    const config = join(mkdtempSync(join(tmpdir(), 'kinu-exports-')), 'wrangler.jsonc');

    writeFileSync(config, fileAt(process.cwd(), commit, WRANGLER_CONFIG));

    return liveClasses(deployedConfig(environment, config).exports);
  };

  const refusals = classLossRefusals(exported(sha), exported('HEAD'), environment === 'production' ? process.env['KINU_LOSS_OVERRIDE'] : undefined);

  for (const line of refusals) console.error(`retirements: ${line}`);

  if (refusals.length === 0) return 0;

  if (environment !== 'production') return 0;
  console.error('retirements: REFUSED before the upload: production loses no user\'s rows (the owner, 2026-10-21). Keep the class, or '
    + 'deploy with --loss-override "<the owner\'s words naming each class>". Nothing was uploaded.');

  return 1;
}

/** What this release does to the tables of the build the deployment serves (`schemaChange`): exit 0 for none, 4 for
 *  additive, 5 for a change; a deployment whose build it cannot read is an error, never taken as unchanged. */
async function schemaChangeOf(environment: InfraEnvironment): Promise<number> {
  const sha = (await servedHealth(origin(plan(environment).config))).build?.sha;

  if (sha === undefined) throw new Error(`${environment} serves no build stamp, so what this release changes is unknown`);
  const change = schemaChange(releaseVerdicts(sha));

  console.log(`${change.kind}${change.tables.length === 0 ? '' : `: ${change.tables.join(', ')}`}`);

  return { none: 0, additive: 4, changes: 5 }[change.kind];
}

/** How long a pass lives if this process dies before it deletes it: past the longest sweep, short of a day. */
const PASS_TTL_SECONDS = 6 * 60 * 60;

/** The deployment as the walk reaches it: Cloudflare's object lists, its AUTH_KV, and its `/ops` routes. The version
 *  the deploy uploaded, and how long an older one may still answer, come from deploy.sh (`KINU_VERSION`,
 *  `KINU_PROPAGATION_SECONDS`), so the walk waits on the version as its smoke test does; run by hand, any answers. */
function tablesTarget(environment: InfraEnvironment, config: DeployedConfig): TablesTarget {
  const site = origin(config);
  const account = requireCloudflareAccountId();
  const kv = config.kv_namespaces?.find((namespace) => namespace.binding === 'AUTH_KV')?.id;
  const token = restApiToken();
  const version = process.env.KINU_VERSION ?? '';

  if (kv === undefined) throw new Error(`${config.name ?? 'the Worker'} binds no AUTH_KV, where the walk's pass is written`);

  if (token === '') throw new Error('the walk lists objects through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)');
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
    ops: async (pass, path, body) => {
      const answer = await fetch(`${site}/ops/${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json' }, body: body === null ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });

      return { status: answer.status, text: await answer.text(), version: answer.headers.get('x-kinu-version') };
    },
    candidate: version === '' ? null : { version, propagationMs: Number(process.env.KINU_PROPAGATION_SECONDS ?? '120') * 1000 },
    pause: (ms) => Bun.sleep(ms),
  };
}

/** The short sha a build is named by, as `/api/health` serves it. */
function shortSha(ref: string): string {
  return Bun.spawnSync(['git', 'rev-parse', '--short=9', ref]).stdout.toString().trim();
}

/** A file as a commit of `repo` holds it: the worktree's may say what no uploaded build does. */
function fileAt(repo: string, commit: string, path: string): string {
  const shown = Bun.spawnSync(['git', 'show', `${commit}:${path}`], { cwd: repo });

  if (shown.exitCode !== 0) throw new Error(`${commit} carries no ${path}: ${shown.stderr.toString().trim()}`);

  return shown.stdout.toString();
}

/** What each repair does to each table that changed from `from` to the candidate `repo` holds at HEAD: the plan's verdicts. */
export function releaseVerdicts(from: string, repo = process.cwd()) {
  const candidate = (path: string) => fileAt(repo, 'HEAD', path);
  const before = readGenesisLockText(fileAt(repo, from, 'scripts/schema-genesis.lock.json'));
  const after = readGenesisLockText(candidate('scripts/schema-genesis.lock.json'));
  const classes = v.parse(v.record(v.string(), v.array(v.string())), JSON.parse(candidate('scripts/schema-classes.json')));
  const lockDiff = changedTables(before, after);
  // The lock keeps every genesis it held, so a table retired since `from` may still be in both: its retired list says so.
  const retiredAt = (text: string) => v.parse(v.array(v.string()), JSON.parse(text));
  const servedRetired = Bun.spawnSync(['git', 'show', `${from}:scripts/schema-retired.json`], { cwd: repo });
  const wasRetired = servedRetired.exitCode === 0 ? retiredAt(servedRetired.stdout.toString()) : [];

  const retired = retiredAt(candidate('scripts/schema-retired.json'))
    .filter((table) => !wasRetired.includes(table) && !lockDiff.changed.some((entry) => entry.table === table))
    .map((table) => ({ table, change: 'removed' as const }));

  const changed = [...lockDiff.changed, ...retired].sort((a, b) => a.table.localeCompare(b.table));
  const { added } = lockDiff;

  const direct = changed.map((table) => verdictOf(table, { to: after, classes }));
  // Each object drops what refers to a dropped table, or is derived from one, with it, so the plan names those too.
  // A lock entry may name a file the candidate retired with its table; the candidate's own files are what it declares.
  const held = new Set(Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repo }).stdout.toString().split('\n'));
  const files = [...new Set(Object.keys(after).map((key) => key.slice(key.indexOf('@') + 1)))].filter((file) => held.has(file));
  const derived = new Map(files.flatMap((file) => [...derivedIn(fileAt(repo, 'HEAD', file))]));
  const verdicts = [...direct, ...referrersOf(direct, { to: after, classes, derived })];

  return { changed: [...changed, ...verdicts.slice(direct.length).map(({ table }) => ({ table, change: 'reshaped' as const }))], added, verdicts };
}

/** The class stamps a commit's build carries, or none for a build before stamps were per class. */
export function stampsAt(commit: string): Record<string, string> | undefined {
  const shown = Bun.spawnSync(['git', 'show', `${commit}:packages/core/src/identity/schema-genesis.ts`]);
  const stamps = [...shown.stdout.toString().matchAll(/^\s+(\w+): 0x([0-9a-f]+),$/gmu)].map((match) => [match[1] ?? '', match[2] ?? ''] as const);

  return shown.exitCode !== 0 || stamps.length === 0 ? undefined : Object.fromEntries(stamps);
}

/** Before the upload: the plan, its refusals, production's confirmation, and the record `started`, which from the
 *  upload on is a barrier no rollback crosses. `tables-plan <environment> <record>`. */
async function planTables(input: { environment: InfraEnvironment; recordFile: string; from: string | undefined }): Promise<number> {
  const { environment, recordFile } = input;
  const { config } = plan(environment);
  const candidate = shortSha('HEAD');
  const from = input.from ?? (await servedHealth(origin(config))).build?.sha;

  if (from === undefined) throw new Error(`${origin(config)} serves no build stamp, so the build it serves is unknown: name it with --from <sha>`);

  if (candidate.startsWith(from.slice(0, 7))) throw new Error(`${origin(config)} already serves ${candidate}: name the build it served before with --from <sha>`);
  const { changed, added, verdicts } = releaseVerdicts(from);

  console.log(`tables: ${from} → ${candidate} on ${config.name ?? ''}; each database drops these tables the first time the candidate opens it`);

  for (const line of planLines(verdicts, added)) console.log(`tables: ${line}`);

  if (verdicts.some((verdict) => verdict.does === 'refuse')) {
    console.error('tables: REFUSED before the upload: the resets above would leave databases refused. Nothing was uploaded.');

    return 1;
  }

  const losses = environment === 'production' ? lossRefusals(verdicts, { acceptable: lossAcceptable(), words: process.env['KINU_LOSS_OVERRIDE'] }) : [];

  if (losses.length > 0) {
    for (const line of losses) console.error(`tables: ${line}`);
    console.error('tables: REFUSED before the upload: production loses no user\'s rows (the owner, 2026-10-21). Keep these tables\' '
      + 'shape, or deploy with --loss-override "<the owner\'s words naming each table>". Nothing was uploaded.');

    return 1;
  }

  const words = confirmation(verdicts);

  if (environment === 'production' && words !== null && !await confirmedAtTerminal(words, 'drop exactly these tables in production\'s databases, and every row they hold')) {
    console.error(`tables: not confirmed at a terminal with '${words}'; nothing was uploaded.`);

    return 1;
  }

  const tag = `tables-${new Date().toISOString().replace(/[-:]|\.\d+/gu, '')}`;

  const planned: Reset = {
    environment, worker: config.name ?? '', tag, at: new Date().toISOString(), placeholderVersion: '', classes: [], applications: [], state: 'started',
    kind: 'tables', from, candidate, tables: changed.map((table) => ({ ...table, classes: [...verdicts.find((verdict) => verdict.table === table.table)?.classes ?? []] })),
  };

  // Kept here until `tables-record` publishes it just before the upload: a deploy that stops before then changed nothing,
  // and must leave no barrier a rollback would refuse to cross.
  writeFileSync(recordFile, JSON.stringify(planned));

  return 0;
}

/** Just before the upload, the first moment any object repairs: the plan's record published as the barrier no rollback
 *  crosses. `tables-record <environment> <record>`. */
function publishTables(environment: InfraEnvironment, recordFile: string): number {
  const { config } = plan(environment);

  record({ putRecord: tablesRecordPut(config) }, recordFile, v.parse(ResetSchema, JSON.parse(readFileSync(recordFile, 'utf8'))));
  console.log(`tables: the plan's record published as the rollback barrier`);

  return 0;
}

/** After the upload: every object opened once under the candidate, what each repair did, and the record `done`.
 *  `tables <environment> <record>`. */
async function walkTables(environment: InfraEnvironment, recordFile: string): Promise<number> {
  const { config } = plan(environment);
  const started = v.parse(ResetSchema, JSON.parse(readFileSync(recordFile, 'utf8')));
  const walked = await walk(tablesTarget(environment, config));
  const { reached } = walked;
  const { lines, failed } = walkLines(walked);

  for (const line of lines) console.log(`tables: ${line}`);
  writeLines(`${recordFile}.census.tsv`, censusLines(reached));
  console.log(`tables: every database's tables and rows in ${recordFile}.census.tsv`);

  if (failed.length > 0) throw new Error(`${String(failed.length)} database(s) refused, or moved rows in a rebuild (above); the record stays started`);

  record({ putRecord: tablesRecordPut(config) }, recordFile, { ...started, state: 'done' });
  console.log(`tables: done; recorded at resets/${started.tag}.json`);

  return 0;
}

/** Puts a record into the releases bucket, as a full reset's are. */
function tablesRecordPut(config: DeployedConfig): ResetTarget['putRecord'] {
  const releases = bucketOf(config, 'RELEASES_BUCKET');

  if (releases === undefined) throw new Error(`${config.name ?? 'the Worker'} binds no RELEASES_BUCKET to keep the reset's record in`);

  return (key, file) => { run(['r2', 'object', 'put', `${releases}/${key}`, '--file', file, '--content-type', 'application/json', '--remote']); };
}

/** The build's version for deploy.sh's pre-reset validation, written to `out`, and the classes it leaves out, said. */
function validationCommand(environment: InfraEnvironment, [built, out, ...extra]: readonly string[], scratch: string): number {
  if (built === undefined || out === undefined || extra.length > 0) {
    console.error('usage: bun scripts/reset.ts validation <environment> <built-config> <out>');

    return 2;
  }

  const { config } = plan(environment);
  const validated = validationBuild(v.parse(BuiltClassesSchema, JSON.parse(readFileSync(built, 'utf8'))), cloudflareTarget(environment, config, scratch).serving());

  writeFileSync(out, JSON.stringify(validated.config));
  console.log(validated.withheld.join(' '));

  return 0;
}

/** `pending <environment> <record>`: the tag of a reset this worker began and did not finish, or `none`; its record
 *  written to `recordFile` when the newest is this worker's. */
function pendingCommand(environment: InfraEnvironment, recordFile: string, scratch: string): number {
  const { config } = plan(environment);
  const worker = config.name ?? '';
  const target = cloudflareTarget(environment, config, scratch);
  const latest = target.latest();

  if (latest?.worker === worker) writeFileSync(recordFile, JSON.stringify(latest));
  console.log(pendingReset(worker, target.serving(), latest)?.tag ?? 'none');

  return 0;
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
    // A full reset loses every user's rows: production takes one only on the owner's words saying so (2026-10-21).
    if (environment === 'production' && !/\bevery table\b/u.test(process.env['KINU_LOSS_OVERRIDE'] ?? '')) {
      console.error('reset: REFUSED: a full reset of production loses every user\'s rows, and the owner\'s words for it '
        + '(--loss-override "<words naming every table>") were not given; nothing was deleted.');

      return 1;
    }

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

  if (known && command === 'pending' && recordFile !== undefined) return pendingCommand(environment, recordFile, scratch);

  if (known && command === 'validation') return validationCommand(environment, argv.slice(2), scratch);

  if (known && command === 'census-diff') return censusDiffCommand(environment, argv.slice(2));

  const tables = TABLES_COMMANDS.find((name) => name === command);

  if (known && tables !== undefined) return await tablesCommand(tables, environment, argv.slice(2));

  console.error('usage: bun scripts/reset.ts plan <environment> | wipe <environment> <record> | pending <environment> <record> '
    + '| validation <environment> <built-config> <out> '
    + '| served <environment> | stamps <environment> | census <environment> <out> | census-diff <environment> <before> <after> <record> '
    + '| tables-plan <environment> <record> [--from <sha>] | tables-record <environment> <record> | tables <environment> <record>');

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
