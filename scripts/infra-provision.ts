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
 * ON AN EMPTY ACCOUNT the secrets come first. `wrangler secret put` on a Worker
 * that does not exist creates a placeholder Worker to hold them, so the deploy's
 * upload gate finds them and no Kinu version is ever live without them:
 *
 *     bun run infra:provision          storage, secrets, and the manual worklist
 *     bun run deploy --bootstrap       the Worker, its DO namespaces, container,
 *                                      routes and cron, over the placeholder
 *     bun run gate:infra               the whole inventory, verified
 *
 * `--bootstrap` because the first deploy declares everything only a deploy can
 * create; its post-deploy check tolerates nothing.
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
import * as v from 'valibot';
import { KinuError } from '@kinu.run/core/obs';
import { restCall } from './cloudflare-rest';
import { restApiToken } from './cloudflare-token';
import {
  type Deployment, type Observation, type Run, authenticated, deployment, environmentArgs, kvNamespace, r2, secretNames,
  requireCloudflareAccountId, vectorize, why,
  wrangler,
} from './infra-cloudflare';
import {
  INFRA_ENVIRONMENTS, type Infrastructure, type Resource, SUPPLY, UNCAPTURED, deriveInfrastructure,
  environmentFrom, requiredIn, vectorizeGeometry,
} from './infra-manifest';

const BOLD = '\u001B[1m';

const NC = '\u001B[0m';

/**
 * `noted` and `refused` are deliberately different words. `noted` is a value
 * that is correctly unset here — optional for this Worker, or one that only
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

/** Where installing a secret talks to: the operator at a terminal, and the Worker. */
export interface SecretIo {
  ask(question: string): Promise<string>;
  readonly interactive: boolean;
  /** Installs the value on the Worker, `wrangler secret put` through stdin. */
  install(name: string, value: string): Run;
  /** Shows the operator a value minted here, once. */
  show(text: string): void;
  /** The account's tokens, for the `account-token` supplies; absent where nothing may mint one. */
  readonly tokens?: AccountTokens;
}

/** Account-owned tokens, as the operator's own token reaches them (`/accounts/<id>/tokens`). */
export interface AccountTokens {
  /** The active tokens named `name`, by id; or why the account would not say. */
  list(name: string): Promise<{ readonly held: readonly string[] } | { readonly refused: string }>;
  /** A token named `name` holding the permission group `permission` on this account alone. */
  mint(name: string, permission: string): Promise<{ readonly id: string; readonly value: string }>;
}

/** What one environment's Worker says about itself, for the report line. */
function deploymentNote(live: Deployment): string {
  if (live.state === 'deployed') return `deployed, version ${live.versionId}`;

  if (live.state === 'absent') {
    return 'not deployed yet — the secrets below go onto a placeholder Worker until the first '
      + '`bun run deploy --bootstrap` replaces it';
  }

  return `could not be read — ${live.reason}`;
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

    // Named one by one rather than left to a `default`: a resource kind this
    // program cannot look up is a fact about the seam, and a kind added later
    // has to arrive here and be answered rather than fall quietly into
    // "unknown".
    case 'access-application':
    case 'access-organization':
    case 'access-policy':
    case 'access-scope':
    case 'account':
    case 'ai-gateway':
    case 'binding':
    case 'container':
    case 'container-namespace':
    case 'cron':
    case 'custom-domain':
    case 'dns-record':
    case 'durable-object':
    case 'email-routing':
    case 'wildcard-dns':
    case 'worker':
    case 'zone-route':
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

export function plan(resource: Resource, observation: Observation): Plan {
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

  return { action: 'create', argv: resource.create };
}

function ensure(resource: Resource): Step {
  const decision = plan(resource, look(resource));

  if (decision.action === 'skip') return { id: resource.id, outcome: 'existed', detail: decision.detail };

  if (decision.action === 'refuse') return { id: resource.id, outcome: 'refused', detail: decision.detail };
  const run = wrangler(decision.argv, { timeoutMs: 300_000 });

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
export async function putSecret(name: string, { worker }: Pick<Infrastructure, 'worker'>, io: SecretIo): Promise<Step> {
  const id = name;
  const supply = SUPPLY.get(name);

  if (!io.interactive) {
    return {
      id,
      outcome: 'refused',
      detail: 'needs a terminal. Re-run this command from an interactive shell — a secret '
        + 'generated where nobody can read it is worse than one that is simply absent, because '
        + 'the absent one is reported by `bun run gate:infra`.',
    };
  }

  const minted = supply?.minted;

  const prompt = minted === undefined
    ? `\n${name} for ${worker.workerName}.\n  ${supply?.source ?? ''}\n  Paste the value (enter to skip): `
    : `\n${name} for ${worker.workerName}.\n  ${minted.paste ? 'Paste an existing value, or press' : 'Press'} enter to generate one: `;

  const typed = (await io.ask(prompt)).trim();

  if (typed.length === 0 && minted === undefined) {
    return { id, outcome: 'refused', detail: 'skipped at the prompt' };
  }

  if (typed.length > 0 && minted?.paste === false) {
    return { id, outcome: 'refused', detail: `a pasted value was refused: ${supply?.source ?? 'it is minted here'}` };
  }

  const value = typed.length > 0 ? typed : randomBytes(32).toString('base64');

  // Through stdin, never argv: an argument is visible in the process table and
  // in anything that echoes the command.
  const run = io.install(name, value);

  if (!run.ok) {
    return { id, outcome: 'failed', detail: `\`wrangler secret put ${name}\` failed: ${why(run)}` };
  }

  if (typed.length === 0) {
    io.show(`\n  ${BOLD}COPY THIS NOW — Cloudflare cannot show it again.${NC}\n  ${name}=${value}\n  Keep it ${minted?.keep ?? ''}.\n\n`);
  }

  return { id, outcome: 'created', detail: typed.length > 0 ? 'installed from the value you pasted' : 'generated and installed' };
}

/**
 * An `account-token` supply minted and installed, with no one asked (ledger 1019-am). Its name is the Worker's, so each
 * deployment holds its own. One the Worker names and the account still holds is left; one the account lost is minted
 * again. None is ever revoked here: deploys of one environment are serialized per machine only, a Worker's secret is
 * never read back, and a failed install may still have landed, so no token can be proved unheld. Other active tokens
 * of its name are named as kept.
 */
export async function mintAccountToken(name: string, { worker }: Pick<Infrastructure, 'worker'>, io: SecretIo, installed: boolean): Promise<Step | null> {
  const permission = SUPPLY.get(name)?.permission ?? '';
  const tokenName = `${worker.workerName} · ${name}`;

  if (io.tokens === undefined) return { id: name, outcome: 'refused', detail: 'nothing here may mint an account token' };
  const listed = await io.tokens.list(tokenName);

  if ('refused' in listed) return { id: name, outcome: 'refused', detail: `the account would not list its tokens: ${listed.refused}` };

  if (installed && listed.held.length > 0) return null;
  const minted = await io.tokens.mint(tokenName, permission);
  const run = io.install(name, minted.value);

  if (!run.ok) return { id: name, outcome: 'failed', detail: `\`wrangler secret put ${name}\` failed, and token ${minted.id} minted for it is kept, as it may have landed: ${why(run)}` };

  const others = listed.held.length === 0 ? '' : `; ${String(listed.held.length)} other active token(s) of that name are kept (${listed.held.join(', ')}), as which one a Worker holds cannot be read back`;

  return { id: name, outcome: 'created', detail: `minted as "${tokenName}" (${permission}) and installed${others}` };
}

const TokensSchema = v.object({
  result: v.array(v.object({ id: v.string(), name: v.string(), status: v.string() })),
  result_info: v.object({ total_count: v.number() }),
});

/** The largest page the token list serves (Cloudflare's List Tokens reference). */
const TOKENS_PER_PAGE = 50;

const GroupsSchema = v.object({ result: v.array(v.object({ id: v.string(), name: v.string() })) });

const MintedSchema = v.object({ result: v.object({ id: v.string(), value: v.string() }) });

/** {@link AccountTokens} on `account`, with the operator's own REST token: an account token, owned by the account and
 *  by no person, is minted with the account's `API Tokens Write` (measured on f44999, 2026-10-23). */
export function accountTokens(account: string, { token = restApiToken(), api }: { readonly token?: string; readonly api?: string } = {}): AccountTokens {
  const at = (path: string) => `/accounts/${account}/tokens${path}`;

  return {
    list: async (name) => {
      try {
        const held: string[] = [];

        for (let page = 1, pages = 1; page <= pages; page += 1) {
          const answer = await restCall({ method: 'GET', path: at(`?per_page=${String(TOKENS_PER_PAGE)}&page=${String(page)}`), token, api }, TokensSchema);

          pages = Math.ceil(answer.result_info.total_count / TOKENS_PER_PAGE);
          held.push(...answer.result.filter((one) => one.name === name && one.status === 'active').map(({ id }) => id));
        }

        return { held };
      } catch (cause) {
        if (cause instanceof KinuError && cause.code === 'denied') return { refused: cause.message };
        throw cause;
      }
    },
    mint: async (name, permission) => {
      const group = (await restCall({ method: 'GET', path: at('/permission_groups'), token, api }, GroupsSchema)).result.find((one) => one.name === permission);

      if (group === undefined) throw new KinuError('missing', `Cloudflare names no permission group "${permission}"`);
      const policies = [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${account}`]: '*' }, permission_groups: [{ id: group.id }] }];

      return (await restCall({ method: 'POST', path: at(''), token, api, body: { name, policies } }, MintedSchema)).result;
    },
  };
}

/* ── Reporting ────────────────────────────────────────────────────────── */

const MARK = {
  created: 'CREATED ',
  existed: 'existed ',
  noted: 'noted   ',
  refused: 'REFUSED ',
  failed: 'FAILED  ',
} satisfies Record<Outcome, string>;

/** The secrets step: each required secret the Worker does not hold, installed through `io`. */
export async function provisionSecrets(
  infrastructure: Pick<Infrastructure, 'worker'>,
  live: Deployment,
  held: () => Observation & { readonly names?: readonly string[] },
  io: SecretIo & { readonly only?: 'account-token' },
): Promise<Step[]> {
  const { only } = io;
  // On a Worker that does not exist `wrangler secret put` makes a placeholder to hold them, so the secrets precede
  // any code, and the first deploy replaces it.
  const observed = live.state === 'absent' ? { state: 'absent' } as const : held();

  if (observed.state === 'unknown') {
    console.log(`  [${MARK.refused}] secrets\n           ${observed.reason}`);

    return [{ id: 'secrets', outcome: 'refused', detail: observed.reason }];
  }

  const names = new Set(observed.state === 'present' ? observed.names ?? [] : []);
  const steps: Step[] = [];

  for (const [name, supply] of SUPPLY) {
    if (supply.handling === 'config-var' || (only !== undefined && supply.handling !== only)) continue;

    if (supply.handling === 'account-token') {
      const step = await mintAccountToken(name, infrastructure, io, names.has(name));

      if (step !== null) steps.push(step);
      console.log(`  [${MARK[step?.outcome ?? 'existed']}] ${name}\n           ${step?.detail ?? 'held by the account and set'}`);
      continue;
    }

    if (names.has(name)) {
      console.log(`  [${MARK.existed}] ${name}\n           already set`);
      continue;
    }

    if (supply.handling === 'out-of-band') {
      console.log(`  [${MARK.noted}] ${name}\n           `
        + `must be supplied out of band: ${supply.source ?? ''}\n           absent ⇒ ${supply.absent}`);
      continue;
    }

    if (!requiredIn(name, infrastructure.worker)) {
      console.log(`  [${MARK.noted}] ${name}\n           `
        + `optional here (no ${supply.pairedWith ?? 'paired var'} in the Worker's vars). `
        + `absent ⇒ ${supply.absent}`);
      continue;
    }

    const step = await putSecret(name, infrastructure, io);

    steps.push(step);
    console.log(`  [${MARK[step.outcome]}] ${step.id}\n           ${step.detail}`);
  }

  return steps;
}


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

/** `--account-tokens`, as every deploy runs it before its upload gates: each `account-token` supply minted or kept,
 *  nothing asked, nothing else provisioned. Exits 1 on a token it could not mint, which the infra gate then names. */
async function mintTokens(environment: (typeof INFRA_ENVIRONMENTS)[number]): Promise<number> {
  const infrastructure = deriveInfrastructure(environment);

  const steps = await provisionSecrets(infrastructure, deployment(environment), () => secretNames(environment), {
    ask: async () => '', interactive: false, show: () => undefined, only: 'account-token',
    install: (secret, value) => wrangler(['secret', 'put', secret, ...environmentArgs(infrastructure.environment)], { stdin: value }),
    tokens: accountTokens(requireCloudflareAccountId()),
  });

  return steps.some((step) => step.outcome === 'failed' || step.outcome === 'refused') ? 1 : 0;
}

async function main(): Promise<number> {
  const environment = environmentFrom(process.argv.slice(2));

  if (environment !== undefined && process.argv.includes('--account-tokens')) return await mintTokens(environment);

  if (environment === undefined) {
    console.error(`infra:provision: usage: bun run infra:provision [${INFRA_ENVIRONMENTS.join('|')}]`);

    return 2;
  }

  const session = authenticated();

  if (session.state !== 'present') {
    console.error(`infra:provision: no Cloudflare session — ${session.state === 'unknown' ? session.reason : 'wrangler is logged out'}`);
    console.error('  fix: npx wrangler login');

    return 1;
  }

  const infrastructure = deriveInfrastructure(environment);
  const { worker } = infrastructure;
  console.log(`${BOLD}Kinu infrastructure provisioning — ${environment}${NC}`);
  console.log(`Account:      ${requireCloudflareAccountId()}`);
  console.log(`Worker:       ${worker.workerName}`);

  const steps: Step[] = [];

  console.log(`\n${BOLD}Storage${NC} — what wrangler can create, in dependency order`);

  // Everything before the Worker binds it. The order is the resource order out
  // of the manifest, which is already the order the sections appear in: buckets,
  // then the indexes.
  for (const resource of infrastructure.resources) {
    if (resource.origin !== 'wrangler-cli') continue;
    const step = ensure(resource);
    steps.push(step);
    console.log(`  [${MARK[step.outcome]}] ${resource.id}\n           ${step.detail}`);
  }

  console.log(`\n${BOLD}The Worker${NC} — created by \`bun run deploy\`, never by this command`);
  const live = deployment(environment);
  console.log(`  ${worker.workerName}: ${deploymentNote(live)}`);

  console.log('  A bare `wrangler deploy` is not a substitute: it skips the CLI-asset check and '
    + 'the post-deploy smoke gate, and production has already shipped that way once.');

  console.log(`\n${BOLD}Secrets${NC} — presence is checked; no value is ever read back`);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const reader = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;

  try {
    steps.push(...await provisionSecrets(infrastructure, live, () => secretNames(environment), {
      ask: async (question) => (reader === undefined ? '' : reader.question(question)),
      interactive,
      install: (secret, value) => wrangler(['secret', 'put', secret, ...environmentArgs(infrastructure.environment)], { stdin: value }),
      show: (text) => { process.stderr.write(text); },
      tokens: accountTokens(requireCloudflareAccountId()),
    }));
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
  console.log(`  next: bun run deploy${live.state === 'absent' ? ' --bootstrap' : ''}, then bun run gate:infra`);

  return failed.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
