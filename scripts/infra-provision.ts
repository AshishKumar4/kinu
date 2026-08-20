/**
 * `bun run infra:provision` — bring a Cloudflare account up to what the binding
 * manifest declares, idempotently, and say what it could not do.
 *
 * WHAT IT DOES AND DELIBERATELY DOES NOT. It creates the account-level resources
 * `wrangler deploy` binds and cannot create for itself: R2 buckets and the
 * Vectorize indexes. It does NOT deploy the Worker.
 * `bun run deploy` is the only production deploy path — a bare `wrangler deploy`
 * skips the asset check and the post-deploy smoke gate, and production has
 * already shipped that way once — so provisioning composes with that command
 * rather than reimplementing half of it.
 *
 * THE TWO PASSES ARE STATED, NOT HIDDEN. `wrangler secret put` needs the Worker
 * to exist, so on an empty account the order is necessarily:
 *
 *     bun run infra:provision     storage, and the manual worklist
 *     bun run deploy              the Worker, its DO namespaces, container,
 *                                 routes and cron
 *     bun run infra:provision     the secrets, now that there is a Worker
 *     bun run gate:infra          the whole inventory, verified
 *
 * The second provision run creates nothing it created the first time. Detecting
 * whether the Worker exists and saying "secrets deferred until it does" is the
 * whole difference between a two-pass procedure and a program that appears to
 * have succeeded while the root secret was never set.
 *
 * IDEMPOTENCE IS BUILT ON THE THREE-STATE LOOKUP, not on tolerating errors.
 * `present` is a no-op that says so; `absent` is created; `unknown` REFUSES —
 * creating a bucket because the network was down is how an account ends up with
 * two answers to "which bucket holds the snapshots".
 *
 * A SILENTLY SKIPPED RESOURCE IS THE DEFECT THIS EXISTS TO PREVENT, so every
 * resource wrangler cannot create is printed with the manual step, every run,
 * green or not — including the ones no CLI can even observe.
 */

import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import {
  type Observation, authenticated, deployment, kvNamespace, r2, secretNames, vectorize, why,
  wrangler,
} from './infra-cloudflare';
import {
  type InfraEnvironment, type Resource, SUPPLY, UNCAPTURED, deriveInfrastructure, requiredIn,
  vectorizeGeometry,
} from './infra-manifest';

const BOLD = '\u001B[1m';
const NC = '\u001B[0m';

/**
 * `noted` and `refused` are deliberately different words. `noted` is a value
 * that is correctly unset here — optional in this environment, or one that only
 * ever arrives from outside. `refused` is this program declining to act because
 * it could not know, or because there is no terminal to ask at. Printing both as
 * one would recreate, in the report, the exact conflation the three-state lookup
 * exists to prevent.
 */
type Outcome = 'created' | 'existed' | 'noted' | 'refused' | 'failed';

interface Step {
  readonly id: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

/** Whether an existing resource is really there, per kind. Provision and verify
 *  ask the same questions of the same seam — a provisioner with its own idea of
 *  "exists" is a second answer nothing compares. */
function look(resource: Resource): Observation {
  switch (resource.kind) {
    case 'kv': return kvNamespace(resource.name);
    case 'r2': return r2(resource.name);
    case 'vectorize': {
      const geometry = vectorizeGeometry();
      return vectorize(resource.name, geometry.dimensions, geometry.metric);
    }
    default:
      return { state: 'unknown', reason: `no lookup is implemented for a ${resource.kind} resource` };
  }
}

/**
 * WHETHER to create something. Pure, and separated from the doing so the
 * idempotence rule is a thing a test can drive rather than a thing an account
 * demonstrates.
 *
 * The `unknown` arm is the important one and it is deliberately the most
 * conservative: a lookup that failed means this program does not know whether
 * the resource exists, and the only safe move on not knowing is to do nothing
 * and say so. Creating a bucket because the network was down is how an account
 * ends up with two answers to "which bucket holds the snapshots".
 */
export type Plan =
  | { readonly action: 'create'; readonly argv: readonly string[] }
  | { readonly action: 'skip'; readonly detail: string }
  | { readonly action: 'refuse'; readonly detail: string };

export function plan(
  resource: Resource,
  observation: Observation,
  wranglerEnv: string | undefined,
): Plan {
  if (observation.state === 'present') {
    return { action: 'skip', detail: `already exists — ${observation.detail}` };
  }
  if (observation.state === 'unknown') {
    return {
      action: 'refuse',
      detail: `could not determine whether it exists, so nothing was created — ${observation.reason}`,
    };
  }
  if (resource.create === undefined) {
    return {
      action: 'refuse',
      detail: 'absent, and no wrangler command creates it — see the manual worklist below',
    };
  }
  return {
    action: 'create',
    argv: [...resource.create, ...(wranglerEnv === undefined ? [] : ['--env', wranglerEnv])],
  };
}

function ensure(resource: Resource, environment: InfraEnvironment): Step {
  const decision = plan(resource, look(resource), environment.wranglerEnv);
  if (decision.action === 'skip') return { id: resource.id, outcome: 'existed', detail: decision.detail };
  if (decision.action === 'refuse') return { id: resource.id, outcome: 'refused', detail: decision.detail };
  const run = wrangler(decision.argv, 300_000);
  return run.ok
    ? { id: resource.id, outcome: 'created', detail: `wrangler ${decision.argv.join(' ')}` }
    : { id: resource.id, outcome: 'failed', detail: `\`wrangler ${decision.argv.join(' ')}\` failed: ${why(run)}` };
}

/* ── Secrets ──────────────────────────────────────────────────────────── */

/**
 * Install one secret, asking the operator for it.
 *
 * THE VALUE IS DISPLAYED EXACTLY ONCE, and only when this program generated it.
 * That is not a lapse in the never-log-a-secret rule, it is the reason there is
 * no `generate` handling: Cloudflare cannot show a secret again, so a root key
 * this program invents and never shows anyone is a key nobody can restore from —
 * and losing CREDENTIAL_ENCRYPTION_KEY means every user reconnects every
 * provider. It goes to stderr, at an interactive terminal, once, and is never
 * written to a file, an event, or a log line.
 *
 * Without a terminal it refuses rather than inventing one, because a secret
 * generated into a CI log is worse than a secret that is absent: the absent one
 * is reported by the gate.
 */
async function putSecret(
  name: string,
  environment: InfraEnvironment,
  ask: (question: string) => Promise<string>,
  interactive: boolean,
): Promise<Step> {
  const id = `${environment.key}/${name}`;
  const supply = SUPPLY.get(name);
  if (!interactive) {
    return {
      id,
      outcome: 'refused',
      detail: 'needs a terminal. Re-run this command from an interactive shell — a secret '
        + 'generated where nobody can read it is worse than one that is simply absent, because '
        + 'the absent one is reported by `bun run gate:infra`.',
    };
  }
  const generated = name.startsWith('CREDENTIAL_ENCRYPTION_KEY');
  const prompt = generated
    ? `\n${name} for ${environment.workerName}.\n  Paste an existing value, or press enter to generate one: `
    : `\n${name} for ${environment.workerName}.\n  ${supply?.source ?? ''}\n  Paste the value (enter to skip): `;
  const typed = (await ask(prompt)).trim();
  if (typed.length === 0 && !generated) {
    return { id, outcome: 'refused', detail: 'skipped at the prompt' };
  }
  const value = typed.length > 0 ? typed : randomBytes(32).toString('base64');
  // Through stdin, never argv: an argument is visible in the process table and
  // in anything that echoes the command.
  const run = wrangler([
    'secret', 'put', name,
    ...(environment.wranglerEnv === undefined ? [] : ['--env', environment.wranglerEnv]),
  ], 120_000, value);
  if (!run.ok) {
    return { id, outcome: 'failed', detail: `\`wrangler secret put ${name}\` failed: ${why(run)}` };
  }
  if (typed.length === 0) {
    process.stderr.write(
      `\n  ${BOLD}COPY THIS NOW — Cloudflare cannot show it again.${NC}\n`
      + `  ${name}=${value}\n`
      + '  Losing it means every user reconnects every provider.\n\n',
    );
  }
  return { id, outcome: 'created', detail: typed.length > 0 ? 'installed from the value you pasted' : 'generated and installed' };
}

/* ── Reporting ────────────────────────────────────────────────────────── */

const MARK = {
  created: 'CREATED ',
  existed: 'existed ',
  noted: 'noted   ',
  refused: 'REFUSED ',
  failed: 'FAILED  ',
} satisfies Record<Outcome, string>;

function manualWorklist(resources: readonly Resource[]): void {
  console.log(`\n${BOLD}Cannot be created by anything in this repository${NC}`);
  console.log('Each one is a step a human takes. None of them is skipped quietly:\n');
  for (const resource of resources) {
    console.log(`  · ${resource.id}\n      ${resource.purpose}\n      ${resource.manual ?? ''}`);
  }
  console.log('\n  And the dependencies the binding manifest cannot express at all:\n');
  for (const item of UNCAPTURED) {
    console.log(`  · ${item.what}\n      check: ${item.check}`);
  }
}

async function main(): Promise<number> {
  const session = authenticated();
  if (session.state !== 'present') {
    console.error(`infra:provision: no Cloudflare session — ${session.state === 'unknown' ? session.reason : 'wrangler is logged out'}`);
    console.error('  fix: npx wrangler login');
    return 1;
  }

  const infrastructure = deriveInfrastructure();
  console.log(`${BOLD}Kinu infrastructure provisioning${NC}`);
  console.log(`Account:      ${infrastructure.accountId}`);
  console.log(`Environments: ${infrastructure.environments.map((environment) => environment.key).join(', ')}`);

  const steps: Step[] = [];
  const done = new Set<string>();

  console.log(`\n${BOLD}Storage${NC} — what wrangler can create, in dependency order`);
  // Everything before the Worker binds it. The order is the resource order out
  // of the manifest, which is already the order the sections appear in: buckets,
  // then the indexes.
  for (const environment of infrastructure.environments) {
    for (const resource of infrastructure.resources) {
      if (resource.origin !== 'wrangler-cli') continue;
      if (!resource.environments.includes(environment.key) || done.has(resource.id)) continue;
      done.add(resource.id);
      const step = ensure(resource, environment);
      steps.push(step);
      console.log(`  [${MARK[step.outcome]}] ${resource.id}\n           ${step.detail}`);
    }
  }

  console.log(`\n${BOLD}The Worker${NC} — created by \`bun run deploy\`, never by this command`);
  const deployed = new Map<string, boolean>();
  for (const environment of infrastructure.environments) {
    const live = deployment(environment.wranglerEnv);
    deployed.set(environment.key, live.state === 'deployed');
    const note = live.state === 'deployed'
      ? `deployed, version ${live.versionId}`
      : live.state === 'absent'
        ? 'not deployed yet — its Durable Object namespaces, container, routes and cron do not '
          + 'exist until it is'
        : `could not be read — ${live.reason}`;
    console.log(`  ${environment.key} (${environment.workerName}): ${note}`);
  }
  console.log('  A bare `wrangler deploy` is not a substitute: it skips the CLI-asset check and '
    + 'the post-deploy smoke gate, and production has already shipped that way once.');

  console.log(`\n${BOLD}Secrets${NC} — presence is checked; no value is ever read back`);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const reader = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  try {
    for (const environment of infrastructure.environments) {
      if (deployed.get(environment.key) !== true) {
        console.log(`  ${environment.key}: deferred — \`wrangler secret put\` needs the Worker to `
          + 'exist. Run `bun run deploy`, then this command again.');
        continue;
      }
      const held = secretNames(environment.wranglerEnv);
      if (held.state === 'unknown') {
        steps.push({ id: `${environment.key} secrets`, outcome: 'refused', detail: held.reason });
        console.log(`  [${MARK.refused}] ${environment.key} secrets\n           ${held.reason}`);
        continue;
      }
      const names = new Set(held.state === 'present' ? held.names ?? [] : []);
      for (const [name, supply] of SUPPLY) {
        if (supply.handling === 'config-var') continue;
        if (names.has(name)) {
          console.log(`  [${MARK.existed}] ${environment.key}/${name}\n           already set`);
          continue;
        }
        if (supply.handling === 'out-of-band') {
          console.log(`  [${MARK.noted}] ${environment.key}/${name}\n           `
            + `must be supplied out of band: ${supply.source ?? ''}\n           absent ⇒ ${supply.absent}`);
          continue;
        }
        if (!requiredIn(name, environment)) {
          console.log(`  [${MARK.noted}] ${environment.key}/${name}\n           `
            + `optional here (no ${supply.pairedWith ?? 'paired var'} in this environment's vars). `
            + `absent ⇒ ${supply.absent}`);
          continue;
        }
        const step = await putSecret(
          name,
          environment,
          async (question) => (reader === undefined ? '' : reader.question(question)),
          interactive,
        );
        steps.push(step);
        console.log(`  [${MARK[step.outcome]}] ${step.id}\n           ${step.detail}`);
      }
    }
  } finally {
    reader?.close();
  }

  manualWorklist(infrastructure.resources.filter((resource) => resource.origin === 'manual'));

  const created = steps.filter((step) => step.outcome === 'created').length;
  const existed = steps.filter((step) => step.outcome === 'existed').length;
  const refused = steps.filter((step) => step.outcome === 'refused');
  const failed = steps.filter((step) => step.outcome === 'failed');
  console.log(
    `\n${BOLD}infra:provision${NC}: ${String(created)} created, ${String(existed)} already existed, `
    + `${String(refused.length)} refused, ${String(failed.length)} failed.`,
  );
  for (const step of failed) console.error(`  FAILED  ${step.id}: ${step.detail}`);
  console.log('  next: bun run deploy, then this command again, then bun run gate:infra');
  return failed.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
