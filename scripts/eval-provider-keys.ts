#!/usr/bin/env bun
/**
 * EVAL-SERVICE'S PROVIDER KEYS, ON EVERY DEPLOYMENT IT DRIVES. A reset deletes every Durable Object of a deployment,
 * eval-service's provider credentials with them, and a deploy can reach a deployment whose reset ran in another
 * run; so before the tiers and the evals, every staging and promotion deploy asks the deployment which credentials
 * eval-service holds, stores through the product's own route each key it does not hold, and asks which models it
 * can run: every model the eval pass runs must then be listed.
 *
 *   bun scripts/eval-provider-keys.ts <origin> [--accounts=<first>-<last>]
 *
 * The keys are {@link EVAL_PROVIDER_KEYS}, `{"<provider>.bearer": "<key>"}`, each named as the product stores it
 * (`catalogCredKey`, packages/core/src/providers/catalog.ts) and posted under that very name:
 * `POST <origin>/api/user/credentials/<provider>.bearer` with the body `{"kind":"bearer","token":"<key>"}`, carrying the
 * deployment's eval identity (`evalWebIdentityEnv`) in the dev identity header, which acts as eval-service. No key is
 * printed. Whatever is missing (the file, a key, the identity, an eval model) is a finding: printed, written into the
 * deploy's report when there is one, and the exit is 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  accountOf, baseCredentialKey, CLOUDFLARE_OAUTH_CRED_KEY, profileCatalogDigest, ReasoningEffortSchema, type ReasoningEffort, DEFAULT_WORKERS_AI_MODEL_SPEC, DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, EVAL_WORKSPACE_LEASE_MS,
  MAIN_ACCOUNT, MY_GATEWAY_PROVIDER_ID, validateCredential, type OAuthCredential,
  parseEvalAccount, parseGatewayTarget, type EvalAccount,
} from '@kinu.run/core';
import { evalWebIdentityEnv } from '@kinu.run/test-utils';
import { evalMatrix } from '../evals/src/config';
import { listWorkspaces, settleCatalog, webHeaders, type CatalogNeed, type PublicWebIdentity } from '../evals/src/workspace-roster';
import { trialInheritedRows } from '../evals/src/slot';
import { ARMS } from '../evals/src/target';
import { recordStep } from './deploy-report';
import { deployedConfig, deploymentAt } from './infra-manifest';

/** Where the operator keeps eval-service's provider keys: outside every checkout, mode 600. */
export const EVAL_PROVIDER_KEYS = join(homedir(), '.config', 'kinu', 'eval-provider-keys.json');

const KeysSchema = v.record(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]*\.bearer$/u)), v.pipe(v.string(), v.minLength(1)));

const ModelsSchema = v.looseObject({ models: v.array(v.looseObject({ spec: v.string() })) });

/** How long one call to the deployment may take, as the deploy's smoke test bounds its own with `curl --max-time`. */
const CALL_MS = 30_000;

export interface Provisioning {
  readonly origin: string;
  readonly keysPath: string;
  /** The deployment's DEV_IDENTITY_SECRET, and the variable it came from, for a finding that names it. */
  readonly identity: string | undefined;
  readonly identityEnv: string;
  /** The models the eval pass measures; the reviewer runs on a ChatGPT login, never a stored key. */
  readonly models: readonly string[];
  /** The trial accounts the eval runs act as here (`evals/src/slot.ts`), each given the keys eval-service is. */
  readonly trialAccounts?: readonly EvalAccount[];
  /** The deployment's own AI Gateway and a Cloudflare API token that may run it, which every account is given when the
   *  run measures a gateway model ({@link gatewayFor}); a run on none leaves the accounts without a Cloudflare login. */
  readonly gateway?: EvalGateway;
  /** Plan logins (`claude.oauth`, `chatgpt.oauth@<account>`) a run signed in for itself (scripts/eval-plan-run.ts). Each
   *  has one owner, whose renewals single-flight in its own object: the trial account its model's sequence runs in, given
   *  those its models name ({@link plansNamed}) once. eval-service never holds one; the run deletes them at its end. */
  readonly planGrants?: Readonly<Record<string, OAuthCredential>>;
  /** The reasoning effort the run's turns ask (`KINU_EVAL_EFFORT`), set on each trial account's default tier; absent,
   *  none is set, and one a run before left is taken away. */
  readonly effort?: ReasoningEffort;
}

/**
 * The plan grants `models` run on: a grant serves the model specs whose provider part its key names, `claude.oauth`
 * serving `claude/…` and `chatgpt.oauth@compare` serving `chatgpt@compare/…`.
 */
function plansNamed(models: readonly string[], grants: Readonly<Record<string, OAuthCredential>>): [string, OAuthCredential][] {
  return Object.entries(grants).filter(([key]) => {
    const provider = baseCredentialKey(key).replace(/\.oauth$/u, '');
    const named = accountOf(key) === MAIN_ACCOUNT ? provider : `${provider}@${accountOf(key)}`;

    return models.some((model) => model.startsWith(`${named}/`));
  });
}

/** Give one trial account the plan grants the run's models name and it does not hold: a grant it holds is its own, maybe
 *  renewed since, and the run's first copy would undo that. A finding, or null. */
async function givePlans(input: Provisioning, headers: Record<string, string>, account: string, holds: ReadonlySet<string>): Promise<string | null> {
  for (const [key, grant] of plansNamed(input.models, input.planGrants ?? {}).filter(([named]) => !holds.has(named))) {
    const answer = await fetch(`${input.origin}/api/user/credentials/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(grant), signal: AbortSignal.timeout(CALL_MS),
    });

    if (!answer.ok) return `storing the run's ${key} for ${account} answered ${String(answer.status)}`;
  }

  return null;
}

/** An AI Gateway the eval accounts reach a gateway model through, billed to its Cloudflare account. */
export interface EvalGateway { readonly accountId: string; readonly id: string; readonly token: string }

/** Whether the run measures a model reached through the user's own AI Gateway (`my-gateway/<author>/<model>`). */
function needsGateway(models: readonly string[]): boolean {
  return models.some((model) => model.startsWith(`${MY_GATEWAY_PROVIDER_ID}/`));
}

/**
 * Give one account `gateway`: its Cloudflare login, the gateway token as a Cloudflare credential names it (my-gateway sends
 * it as the gateway's `cf-aig-authorization` and the management reads' bearer, measured on staging 2620e7c05), and the
 * gateway selected. Either already there is left as it is. A finding, or null.
 */
async function giveGateway(origin: string, headers: Record<string, string>, held: ReadonlySet<string>, gateway: EvalGateway): Promise<string | null> {
  if (!held.has(CLOUDFLARE_OAUTH_CRED_KEY)) {
    const stored = await fetch(`${origin}/api/user/credentials/${CLOUDFLARE_OAUTH_CRED_KEY}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'oauth', accessToken: gateway.token, expiresAt: NEVER, metadata: { accountId: gateway.accountId } }),
      signal: AbortSignal.timeout(CALL_MS),
    });

    if (!stored.ok) return `storing the Cloudflare login at ${origin} answered ${String(stored.status)}`;
  }

  const selection = await fetch(`${origin}/api/user/cloudflare/gateways`, { headers, signal: AbortSignal.timeout(CALL_MS) });

  if (!selection.ok) return `reading the selected AI Gateway at ${origin} answered ${String(selection.status)}`;

  if (v.parse(v.looseObject({ selectedId: v.nullable(v.string()) }), await selection.json()).selectedId === gateway.id) return null;

  const selected = await fetch(`${origin}/api/user/cloudflare/gateway`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: gateway.id }), signal: AbortSignal.timeout(CALL_MS),
  });

  return selected.ok ? null : `selecting AI Gateway ${gateway.id} at ${origin} answered ${String(selected.status)}`;
}

/** An API token does not expire as an OAuth login does: its credential names no end. */
const NEVER = Date.parse('2100-01-01T00:00:00Z');

/** What eval-service lists: every model spec it can run. */
interface Listed {
  readonly specs: ReadonlySet<string>;
}

async function listed(input: Provisioning, headers: Record<string, string>): Promise<Listed | { readonly why: string }> {
  const answer = await fetch(`${input.origin}/api/user/models`, { headers, signal: AbortSignal.timeout(CALL_MS) });

  if (!answer.ok) return { why: `listing eval-service's models answered ${String(answer.status)}` };
  const { models } = v.parse(ModelsSchema, await answer.json());

  return { specs: new Set(models.map((model) => model.spec)) };
}

const CredentialsSchema = v.array(v.object({ key: v.string() }));

/**
 * The credential keys eval-service holds, read from its credential inventory. Not inferred from the model list:
 * a provider whose catalogue probe fails is absent there while its key is stored, and storing again would
 * replace a working key with the operator's file (review, 2026-10-01).
 */
async function heldKeys(input: Provisioning, headers: Record<string, string>, who = 'eval-service'): Promise<ReadonlySet<string> | { readonly why: string }> {
  const answer = await fetch(`${input.origin}/api/user/credentials`, { headers, signal: AbortSignal.timeout(CALL_MS) });

  if (!answer.ok) return { why: `listing ${who}'s credentials answered ${String(answer.status)}` };

  return new Set(v.parse(CredentialsSchema, await answer.json()).map((credential) => credential.key));
}

/** The keys in the operator's file, or why there are none to store. */
/** The eval provider keys at `path`, or why there are none. */
export function keysIn(path: string): { readonly keys: Readonly<Record<string, string>> } | { readonly why: string } {
  if (!existsSync(path)) return { why: `${path} does not exist` };
  const keys = v.safeParse(KeysSchema, JSON.parse(readFileSync(path, 'utf8')));

  if (!keys.success) return { why: `${path} is not {"<provider>.bearer": "<key>"}: ${v.summarize(keys.issues).split('\n')[0] ?? ''}` };

  return Object.keys(keys.output).length === 0 ? { why: `${path} holds no key` } : { keys: keys.output };
}

export interface Provisioned {
  /** The credential keys stored by this run, each one eval-service listed no provider for. */
  readonly stored: readonly string[];
  /** One line each; empty when every eval model is listed. */
  readonly findings: readonly string[];
  /** With trial accounts: how many were given a key, and the ones reset first for rows a trial would inherit. */
  readonly trials?: { readonly given: number; readonly reset: readonly string[] };
  /** With trial accounts: one that holds such rows while a run is on it, left as it is. */
  readonly notes?: readonly string[];
}

const EmailSchema = v.looseObject({ email: v.string() });

/** What one trial account came to: given a key, reset first, or why not. */
type TrialOutcome = { readonly given: boolean; readonly reset: boolean; readonly finding?: string; readonly note?: string };

/**
 * A trial account made ready for the runs that act as it: reset first when it holds a row a trial would inherit and no
 * run is on it (the product's own account delete, which empties it whole), then given each key it does not hold and a
 * deep-tier route with an independent provider fallback, through the same catalog settings API a user saves.
 */
async function readyTrialAccount(input: Provisioning & { identity: string }, account: EvalAccount, keys: Readonly<Record<string, string>>): Promise<TrialOutcome> {
  const identity: PublicWebIdentity = { kind: 'secret', secret: input.identity, account };
  const headers = webHeaders(identity);
  const read = async (path: string) => fetch(`${input.origin}${path}`, { headers, signal: AbortSignal.timeout(CALL_MS) });
  const held = await trialInheritedRows({ origin: input.origin, identity });

  if ('why' in held) return { given: false, reset: false, finding: `${account}: ${held.why}` };
  const inherited = Object.entries(held.inherited);
  let reset = false;

  if (inherited.length > 0) {
    const rows = inherited.map(([table, count]) => `${table} ${String(count)}`).join(', ');
    // Every page: a run on a workspace past the first would otherwise be reset under it.
    const live = (await listWorkspaces(input.origin, identity)).find((workspace) => Date.now() - workspace.lastVisited < EVAL_WORKSPACE_LEASE_MS);

    if (live !== undefined) {
      return { given: false, reset: false, note: `${account} at ${input.origin} holds rows a trial would inherit (${rows}), and a run is on it (${live.name}): not reset` };
    }

    const { email } = v.parse(EmailSchema, await (await read('/api/user/profile')).json());

    const deleted = await fetch(`${input.origin}/api/user/account`, {
      method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: email }),
      signal: AbortSignal.timeout(CALL_MS),
    });

    if (!deleted.ok) return { given: false, reset: false, finding: `resetting ${account}, which holds ${rows}, answered ${String(deleted.status)}` };
    reset = true;
  }

  const holds = await heldKeys(input, headers, account);

  if ('why' in holds) return { given: false, reset, finding: holds.why };
  let given = false;

  for (const [key, token] of Object.entries(keys)) {
    if (holds.has(key)) continue;

    const answer = await fetch(`${input.origin}/api/user/credentials/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bearer', token }),
      signal: AbortSignal.timeout(CALL_MS),
    });

    if (!answer.ok) return { given, reset, finding: `storing ${key} for ${account} answered ${String(answer.status)}` };
    given = true;
  }

  const gated = input.gateway !== undefined && needsGateway(input.models) ? await giveGateway(input.origin, headers, holds, input.gateway) : null;

  if (gated !== null) return { given, reset, finding: `${account}: ${gated}` };
  const planned = await givePlans(input, headers, account, holds);

  if (planned !== null) return { given, reset, finding: planned };

  // A bare account inherits a single Workers AI model for its swarm judge. Its refusal ended every research swarm
  // in run 37880718948. Keys alone do not configure that route: keep the user's retry count, and cross providers, to
  // the one model a single-model run measures. Nothing else falls back: a model the run measures takes the chain of
  // the tier it runs under or its own (`profiles/resolve.ts`), and a call another model answered would be counted as its
  // own (2026-10-23, a GLM 5.3 run's 98 calls answered by Muse), so no tier keeps a chain and no measured model has one.
  const model = DEFAULT_WORKERS_AI_MODEL_SPEC;
  const [only, ...more] = input.models;
  const judgeChain = only !== undefined && more.length === 0 && only !== model ? [only] : [];

  const deepRoute: CatalogNeed = (catalog) => {
    const tiers = Object.fromEntries(Object.entries(catalog.tiers).map(([id, tier]) => {
      const { fallbacks: _chain, ...unchained } = tier ?? { model };

      const { reasoningEffort: _effort, ...uneffortful } = unchained;
      const sized = id === 'default' ? { ...uneffortful, ...input.effort !== undefined && { reasoningEffort: input.effort } } : unchained;

      return [id, id === 'deep' ? { ...sized, model } : sized];
    }));

    const { modelFallbacks: chained, ...base } = catalog;
    const kept = Object.entries(chained ?? {}).filter(([spec]) => spec !== model && !input.models.includes(spec));
    const chains = judgeChain.length > 0 ? [...kept, [model, judgeChain] as const] : kept;
    const next = { ...base, tiers: { ...catalog.tiers, ...tiers, deep: tiers['deep'] ?? { model } }, ...chains.length > 0 && { modelFallbacks: Object.fromEntries(chains) } };

    return profileCatalogDigest(next) === profileCatalogDigest(catalog) ? null : next;
  };

  try {
    await settleCatalog(input.origin, headers, [deepRoute]);
  } catch (error) {
    return { given, reset, finding: `configuring ${account}'s deep tier and provider fallback failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  return { given, reset };
}

/** Trial accounts readied eight at a time: a deploy reaches hundreds, each a first request to an object of its own. */
async function readyTrialAccounts(input: Provisioning & { identity: string }, keys: Readonly<Record<string, string>>): Promise<TrialOutcome[]> {
  const accounts = input.trialAccounts ?? [];
  const outcomes: TrialOutcome[] = [];

  for (let at = 0; at < accounts.length; at += 8) {
    outcomes.push(...await Promise.all(accounts.slice(at, at + 8).map((account) => readyTrialAccount(input, account, keys))));
  }

  return outcomes;
}

/** Stores each key eval-service does not hold, then checks every eval model is listed. */
export async function provisionEvalProviderKeys(input: Provisioning): Promise<Provisioned> {
  if (input.identity === undefined || input.identity === '') {
    return { stored: [], findings: [`${input.identityEnv} is not set, so nothing can act as eval-service at ${input.origin}`] };
  }

  const headers = { [DEV_IDENTITY_HEADER]: input.identity };
  const held = await heldKeys(input, headers);

  if ('why' in held) return { stored: [], findings: [held.why] };
  const file = keysIn(input.keysPath);
  const findings: string[] = 'why' in file ? [file.why] : [];
  const stored: string[] = [];

  for (const [key, token] of Object.entries('why' in file ? {} : file.keys)) {
    if (held.has(key)) continue;

    const answer = await fetch(`${input.origin}/api/user/credentials/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bearer', token }),
      signal: AbortSignal.timeout(CALL_MS),
    });

    if (answer.ok) stored.push(key);
    else findings.push(`storing ${key} for eval-service answered ${String(answer.status)}`);
  }

  const gated = input.gateway !== undefined && needsGateway(input.models) ? await giveGateway(input.origin, headers, held, input.gateway) : null;

  if (gated !== null) findings.push(`eval-service: ${gated}`);
  const after = await listed(input, headers);

  if ('why' in after) return { stored, findings: [...findings, after.why] };
  // A plan model runs only where its grant is owned: its trial account, checked below.
  const planModels = new Set(input.models.filter((model) => plansNamed([model], input.planGrants ?? {}).length > 0));

  for (const model of input.models.filter((each) => !planModels.has(each))) {
    if (!after.specs.has(model)) findings.push(`eval-service at ${input.origin} lists no ${model}, so the eval pass cannot run it`);
  }

  const first = input.trialAccounts?.[0];

  if (first === undefined) return { stored, findings };
  const outcomes = await readyTrialAccounts({ ...input, identity: input.identity }, 'why' in file ? {} : file.keys);
  const theirs = await listed(input, { ...headers, [DEV_IDENTITY_ACCOUNT_HEADER]: first });

  if ('why' in theirs) findings.push(theirs.why);
  else findings.push(...input.models.filter((model) => !theirs.specs.has(model)).map((model) => `${first} at ${input.origin} lists no ${model}, so its trials cannot run it`));

  return {
    stored,
    findings: [...findings, ...outcomes.flatMap((outcome) => outcome.finding ?? [])],
    trials: {
      given: outcomes.filter((outcome) => outcome.given).length,
      reset: outcomes.flatMap((outcome, at) => outcome.reset ? [input.trialAccounts?.[at] ?? ''] : []),
    },
    notes: outcomes.flatMap((outcome) => outcome.note ?? []),
  };
}

/**
 * The plan grants a run holds (scripts/eval-plan-run.ts), handed to this step in its environment alone: a JSON record of
 * credential key to OAuth login, each checked as the product checks a stored credential, whose refusal never quotes it.
 */
function plansIn(held: string | undefined): Readonly<Record<string, OAuthCredential>> | undefined {
  if (held === undefined || held === '') return undefined;

  return Object.fromEntries(Object.entries(v.parse(v.record(v.string(), v.unknown()), JSON.parse(held))).map(([key, value]) => {
    const credential = validateCredential({ key, value });

    if (credential.kind !== 'oauth') throw new Error(`the run's ${key} is not a plan login`);

    return [key, credential];
  }));
}

/**
 * The AI Gateway the deployment at `origin` runs on (its `AI_GATEWAY_URL`, wrangler.jsonc), and the gateway token
 * (`WEBSEARCH_CF_TOKEN`, ~/.config/kinu/secrets.env and armada): AI Gateway Run, Edit and Read and Workers AI, and
 * nothing that writes the account's Workers, containers or tokens, since it is stored in deployed accounts. A gateway
 * model's trials are billed to the deployment's own account.
 */
function gatewayFor(origin: string): EvalGateway {
  const deployment = deploymentAt(origin);

  const target = deployment === undefined ? { reason: `no environment in wrangler.jsonc serves ${origin}` }
    : parseGatewayTarget(deployedConfig(deployment.environment).vars?.['AI_GATEWAY_URL']);

  const token = process.env['WEBSEARCH_CF_TOKEN'] ?? '';

  if ('reason' in target) throw new Error(`a gateway model needs ${origin}'s AI Gateway: ${target.reason}`);

  if (token === '') throw new Error('a gateway model needs WEBSEARCH_CF_TOKEN, the gateway token (AI Gateway Run)');

  return { accountId: target.account, id: target.id, token };
}

if (import.meta.main) {
  const asked = process.argv[2] ?? '';

  if (!URL.canParse(asked)) {
    console.error('usage: bun scripts/eval-provider-keys.ts <origin> [--accounts=<first>-<last>]');
    process.exit(2);
  }

  const origin = new URL(asked).origin;
  const identityEnv = evalWebIdentityEnv(origin);
  const matrix = evalMatrix(process.env, ARMS.map((arm) => arm.id));
  const identity = process.env[identityEnv]?.trim();

  // `--accounts=<first>-<last>`: the block of trial accounts one eval run leased (scripts/evals-map.ts,
  // scripts/evals-lease.ts), and no other: the run that holds a block is the one that keys it, so no deploy's keys reset
  // the rows another run's trial is making. Without it, eval-service alone.
  const leased = /^--accounts=(\d+)-(\d+)$/u.exec(process.argv[3] ?? '');

  const accounts = leased === null ? [] : Array.from({ length: Number(leased[2]) - Number(leased[1]) + 1 },
    (_, at) => parseEvalAccount(`trial-${String(Number(leased[1]) + at)}`)).filter((account) => account !== null);

  const gateway = needsGateway(matrix.models) ? gatewayFor(origin) : undefined;
  const planGrants = plansIn(process.env['KINU_EVAL_PLAN_GRANTS']);
  const namedEffort = process.env['KINU_EVAL_EFFORT']?.trim() ?? '';
  const effort = namedEffort === '' ? undefined : v.parse(ReasoningEffortSchema, namedEffort);

  const { stored, findings, trials, notes } = await provisionEvalProviderKeys({
    origin, keysPath: EVAL_PROVIDER_KEYS, identity, identityEnv, models: matrix.models, trialAccounts: accounts,
    ...gateway !== undefined && { gateway }, ...planGrants !== undefined && { planGrants }, ...effort !== undefined && { effort },
  });

  for (const note of notes ?? []) console.log(`eval-provider-keys: ${note}`);

  if (trials !== undefined) {
    console.log(`eval-provider-keys: gave ${String(trials.given)} trial account(s) a key at ${origin}`
      + `${trials.reset.length === 0 ? '' : `, resetting ${trials.reset.join(', ')} first for rows a trial would inherit`}`);
  }

  const report = process.env['KINU_DEPLOY_REPORT'] ?? '';

  for (const found of findings) {
    console.error(`eval-provider-keys: ${found}`);

    if (report !== '') recordStep(report, { phase: 'provision', what: 'eval-service\'s provider keys', finding: found });
  }

  console.log(`eval-provider-keys: stored ${stored.length === 0 ? 'no key, eval-service holding every one' : stored.join(', ')} at ${origin}`
    + `${findings.length === 0 ? `; it lists every eval model: ${matrix.models.join(', ')}` : ''}`);
  process.exit(findings.length === 0 ? 0 : 1);
}
