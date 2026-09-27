/**
 * A reset: every Durable Object class a deployment carries deleted with its storage, the Worker keeping its secrets
 * and routes. The procedure and why each step is there: docs/DEPLOYMENT.md, § Wrangler bindings.
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
import { containerApplications, deployment, why, wrangler } from './infra-cloudflare';
import { type DeployedConfig, INFRA_ENVIRONMENTS, type InfraEnvironment, deployedConfig } from './infra-manifest';

/** What one reset deleted. */
export const ResetSchema = v.object({
  environment: v.picklist(INFRA_ENVIRONMENTS),
  worker: v.string(),
  tag: v.string(),
  at: v.string(),
  placeholderVersion: v.string(),
  classes: v.array(v.object({ className: v.string(), namespace: v.string() })),
  applications: v.array(v.object({ name: v.string(), id: v.string() })),
});

export type Reset = v.InferOutput<typeof ResetSchema>;

/** The newest reset, beside `resets/<tag>.json`: what a rollback must not cross. */
export const LATEST_RESET_KEY = 'resets/latest.json';

/** The words a production reset is confirmed with. */
export const PRODUCTION_CONFIRMATION = 'reset production';

/** Every class the migrations leave standing. */
function carriedClasses(migrations: DeployedConfig['migrations']): readonly string[] {
  const carried = new Set<string>();

  for (const migration of migrations ?? []) {
    for (const name of [...migration.new_sqlite_classes ?? [], ...migration.new_classes ?? []]) carried.add(name);

    for (const name of migration.deleted_classes ?? []) carried.delete(name);
  }

  return [...carried];
}

const PLACEHOLDER = `const notice = { ok: false, resetting: true, build: null, message: 'Kinu is being reset to a fresh deployment. Back in a few minutes.' };
export default {
  async fetch(request) {
    const health = new URL(request.url).pathname === '/api/health';
    return new Response(JSON.stringify(notice), { status: health ? 200 : 503, headers: { 'content-type': 'application/json', 'retry-after': '300' } });
  },
};
`;

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

  return { config, classes: carriedClasses(config.migrations) };
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

  // A class the Worker does not carry fails the delete as non-existent; one it carries and the list misses survives.
  if ([...bound.keys()].sort().join() !== [...classes].sort().join()) {
    throw new Error(`wrangler.jsonc carries ${classes.join(', ')}; version ${live.versionId} of ${worker} binds `
      + `${[...bound.keys()].join(', ') || 'no class, as a reset placeholder does: deploy without --reset'}`);
  }

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
    migrations: [{ tag, deleted_classes: classes }],
  }));
  const deployed = run(['deploy', '-c', placeholder, '--message', `kinu ${environment} ${tag}`]);
  const placeholderVersion = /Version ID:\s*([0-9a-f-]{36})/u.exec(deployed)?.[1] ?? '';
  const after = deployment(environment);

  if (after.state !== 'deployed' || after.versionId !== placeholderVersion || after.bindings.some((binding) => binding.type === 'durable_object_namespace')) {
    throw new Error(`the placeholder uploaded as '${placeholderVersion}', and ${worker} does not serve it without Durable Objects`);
  }

  console.log(`reset: ${worker} serves placeholder ${placeholderVersion} under ${tag}; deleted ${[...bound].map(([name, namespace]) => `${name} (${namespace})`).join(', ')}`);

  // After the placeholder, so a refused upload leaves every application in place; each one is named as it goes.
  for (const application of doomed) {
    run(['containers', 'delete', application.id]);
    console.log(`reset: deleted container application ${application.name} (${application.id})`);
  }

  const reset: Reset = {
    environment,
    worker,
    tag,
    at: new Date().toISOString(),
    placeholderVersion,
    classes: [...bound].map(([className, namespace]) => ({ className, namespace })),
    applications: doomed.map(({ name, id }) => ({ name, id })),
  };

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

    console.log(`${config.name ?? ''}: ${classes.join(', ')}; container applications ${(config.containers ?? []).map((container) => container.name).join(', ')}`);

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
