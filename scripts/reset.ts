/**
 * A reset: every Durable Object class a deployment carries deleted with its storage, the Worker keeping its secrets
 * and routes, then what those objects left outside their storage: their container applications, and the devbox
 * chains in the store bucket, which only a box's own state could name. The procedure and why each step is there:
 * docs/DEPLOYMENT.md, § Wrangler bindings.
 *
 *   bun scripts/reset.ts plan <environment>           what a reset deletes, read from wrangler.jsonc
 *   bun scripts/reset.ts wipe <environment> <record>  delete it, recorded in <record> and the releases bucket;
 *                                                     production asks for `reset production` typed at a terminal
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { evalSessionPath } from '@kinu.run/test-utils';
import { deleteApplicationByRest, deleteR2Prefix, deletedByRest } from './cloudflare-rest';
import { containerApplications, deployment, why, wrangler } from './infra-cloudflare';
import { type DeployedConfig, INFRA_ENVIRONMENTS, type InfraEnvironment, deployedConfig, liveClasses } from './infra-manifest';

/** What one reset deleted. */
export const ResetSchema = v.object({
  environment: v.picklist(INFRA_ENVIRONMENTS),
  worker: v.string(),
  tag: v.string(),
  at: v.string(),
  placeholderVersion: v.string(),
  classes: v.array(v.object({ className: v.string(), namespace: v.string() })),
  applications: v.array(v.object({ name: v.string(), id: v.string() })),
  /** Absent where the environment binds no devbox store, and in the records of resets before 2026-09-30. */
  chains: v.optional(v.object({ bucket: v.string(), prefix: v.string(), objects: v.number() })),
});

export type Reset = v.InferOutput<typeof ResetSchema>;

/** The newest reset, beside `resets/<tag>.json`: what a rollback must not cross. */
export const LATEST_RESET_KEY = 'resets/latest.json';

/** The words a production reset is confirmed with. */
export const PRODUCTION_CONFIRMATION = 'reset production';

const PLACEHOLDER = `const notice = { ok: false, resetting: true, build: null, message: 'Kinu is being reset to a fresh deployment. Back in a few minutes.' };
export default {
  async fetch(request) {
    const health = new URL(request.url).pathname === '/api/health';
    return new Response(JSON.stringify(notice), { status: health ? 200 : 503, headers: { 'content-type': 'application/json', 'retry-after': '300' } });
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

function origin(config: DeployedConfig): string {
  const value = config.vars?.CLI_PUBLIC_ORIGIN;

  if (value === undefined || value === '') throw new Error(`${config.name ?? 'the Worker'} sets no CLI_PUBLIC_ORIGIN, so it has no origin`);

  return value;
}

async function stampless(url: string): Promise<boolean> {
  const answer = await fetch(url);

  return answer.status === 200 && v.safeParse(StamplessSchema, await answer.text()).success;
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

/** Each one is named as it goes. */
function deleteApplications(accountId: string, applications: readonly { readonly name: string; readonly id: string }[]): void {
  for (const application of applications) {
    if (deletedByRest(application.id)) {
      const deleted = deleteApplicationByRest(accountId, application.id);

      if (!deleted.ok) throw new Error(deleted.reason);
    } else {
      run(['containers', 'delete', application.id]);
    }

    console.log(`reset: deleted container application ${application.name} (${application.id})`);
  }
}

/** Every chain object in the devbox store, or undefined where the environment binds none. */
async function deleteChains(config: DeployedConfig): Promise<Reset['chains']> {
  const store = config.r2_buckets?.find((entry) => entry.binding === DEVBOX_STORE_BINDING)?.bucket_name;

  if (store === undefined) return undefined;
  const objects = await deleteR2Prefix({ accountId: config.account_id ?? '', bucket: store, prefix: CHAIN_PREFIX });

  console.log(`reset: deleted ${String(objects)} chain objects under ${store}/${CHAIN_PREFIX}`);

  return { bucket: store, prefix: CHAIN_PREFIX, objects };
}

async function wipe(environment: InfraEnvironment, recordFile: string, scratch: string): Promise<Reset> {
  const { config, classes } = plan(environment);
  const worker = config.name ?? '';
  const health = `${origin(config)}/api/health`;
  const bucket = config.r2_buckets?.find((entry) => entry.binding === 'RELEASES_BUCKET')?.bucket_name;

  if (bucket === undefined) throw new Error(`${worker} binds no RELEASES_BUCKET to keep the reset's record in`);
  const live = deployment(environment);

  if (live.state !== 'deployed') throw new Error(`${worker} serves no version to reset: ${live.state === 'unknown' ? live.reason : 'it has no deployment'}`);

  const bound = new Map(live.bindings.flatMap((binding) => (binding.type === 'durable_object_namespace' && binding.target !== undefined
    && binding.namespace !== undefined ? [[binding.target, binding.namespace] as const] : [])));

  // The placeholder deletes what the live version binds: a class it does not carry fails the delete as non-existent,
  // and one it carries and the list misses survives. wrangler.jsonc may name others, which the next deploy creates,
  // or retire one, which is deleted here.
  if (bound.size === 0) {
    throw new Error(`version ${live.versionId} of ${worker} binds no class, as a reset placeholder does: deploy without --reset`);
  }

  const retired = [...bound.keys()].filter((name) => !classes.includes(name));
  const added = classes.filter((name) => !bound.has(name));

  const applications = containerApplications();

  if ('failure' in applications) throw new Error(applications.failure);
  const names = new Set((config.containers ?? []).map((container) => container.name));
  const namespaces = new Set(bound.values());

  const doomed = applications.filter((application) => names.has(application.name)
    || (application.namespace !== undefined && namespaces.has(application.namespace)));

  const tag = `reset-${new Date().toISOString().replace(/[-:]|\.\d+/gu, '')}`;
  const placeholder = join(scratch, 'wrangler.json');

  writeFileSync(join(scratch, 'worker.js'), PLACEHOLDER);
  writeFileSync(placeholder, JSON.stringify({
    name: worker,
    account_id: config.account_id,
    main: 'worker.js',
    compatibility_date: config.compatibility_date,
    workers_dev: false,
    routes: config.routes,
    exports: Object.fromEntries([...bound.keys()].map((name) => [name, { type: 'durable-object', state: 'deleted' }])),
  }));
  const deployed = run(['deploy', '-c', placeholder, '--message', `kinu ${environment} ${tag}`]);
  const placeholderVersion = /Version ID:\s*([0-9a-f-]{36})/u.exec(deployed)?.[1] ?? '';
  const after = deployment(environment);

  if (after.state !== 'deployed' || after.versionId !== placeholderVersion || after.bindings.some((binding) => binding.type === 'durable_object_namespace')) {
    throw new Error(`the placeholder uploaded as '${placeholderVersion}', and ${worker} does not serve it without Durable Objects`);
  }

  console.log(`reset: ${worker} serves placeholder ${placeholderVersion} under ${tag}; deleted ${[...bound].map(([name, namespace]) => `${name} (${namespace})`).join(', ')}`
    + `${retired.length === 0 ? '' : `; retired ${retired.join(', ')}`}${added.length === 0 ? '' : `; the deploy creates ${added.join(', ')}`}`);

  // After the placeholder, so a refused upload leaves every application in place.
  deleteApplications(config.account_id ?? '', doomed);

  const reset: Reset = {
    environment,
    worker,
    tag,
    at: new Date().toISOString(),
    placeholderVersion,
    classes: [...bound].map(([className, namespace]) => ({ className, namespace })),
    applications: doomed.map(({ name, id }) => ({ name, id })),
  };

  // Last, once no box is left to write one.
  const chains = await deleteChains(config);

  if (chains !== undefined) reset.chains = chains;

  writeFileSync(recordFile, JSON.stringify(reset));

  for (const key of [`resets/${tag}.json`, LATEST_RESET_KEY]) {
    run(['r2', 'object', 'put', `${bucket}/${key}`, '--file', recordFile, '--content-type', 'application/json', '--remote']);
  }

  // Every eval bearer this machine keeps for the origin named a session the reset deleted; the tiers mint new ones.
  rmSync(dirname(evalSessionPath(origin(config), undefined)), { recursive: true, force: true });
  let answered = false;

  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS && !answered; attempt += 1) {
    answered = await stampless(`${health}?reset=${String(attempt)}`);

    if (!answered && attempt < HEALTH_ATTEMPTS) await Bun.sleep(15_000);
  }

  if (!answered) throw new Error(`${health} never answered 200 { build: null }`);

  return reset;
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

    const store = config.r2_buckets?.find((entry) => entry.binding === DEVBOX_STORE_BINDING)?.bucket_name;

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

    const reset = await wipe(environment, recordFile, scratch);

    console.log(`reset: placeholder ${reset.placeholderVersion} answers /api/health with no build; recorded at resets/${reset.tag}.json`);

    return 0;
  }

  console.error('usage: bun scripts/reset.ts plan <environment> | wipe <environment> <record>');

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
