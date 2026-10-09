#!/usr/bin/env bun
/**
 * EVAL-SERVICE'S PROVIDER KEYS, ON EVERY DEPLOYMENT IT DRIVES. A reset deletes every Durable Object of a deployment,
 * eval-service's provider credentials with them, and a deploy can reach a deployment whose reset ran in another
 * run; so before the tiers and the evals, every staging and promotion deploy asks the deployment which credentials
 * eval-service holds, stores through the product's own route each key it does not hold, and asks which models it
 * can run: every model the eval pass runs must then be listed.
 *
 *   bun scripts/eval-provider-keys.ts <origin>
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
import { basename, join } from 'node:path';
import * as v from 'valibot';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, inheritedRows, ProfileCatalogEnvelopeSchema, type EvalAccount } from '@kinu.run/core';
import { evalWebIdentityEnv } from '@kinu.run/test-utils';
import { DEFAULT_MODELS, DEFAULT_TRIALS, evalMatrix, PASS_FIRST_SLOT } from '../evals/src/config';
import { WORKSPACE_LEASE_MS } from '../evals/src/session';
import { trialAccounts, trialAccountsAt } from '../evals/src/slot';
import { ARMS } from '../evals/src/target';
import { recordStep } from './deploy-report';
import { isEvalTask, trackedFiles } from './sources';

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
}

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
function keysIn(path: string): { readonly keys: Readonly<Record<string, string>> } | { readonly why: string } {
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

const JsonRowsSchema = v.record(v.string(), v.number());

const WorkspacesSchema = v.looseObject({ entries: v.array(v.object({ name: v.string(), lastVisited: v.number() })) });

const EmailSchema = v.looseObject({ email: v.string() });

/** What one trial account came to: given a key, reset first, or why not. */
type TrialOutcome = { readonly given: boolean; readonly reset: boolean; readonly finding?: string; readonly note?: string };

/**
 * A trial account made ready for the runs that act as it: reset first when it holds a row a trial would inherit and no
 * run is on it (the product's own account delete, which empties it whole), then given each key it does not hold and a
 * deep-tier route with an independent provider fallback, through the same catalog settings API a user saves.
 */
async function readyTrialAccount(input: Provisioning & { identity: string }, account: EvalAccount, keys: Readonly<Record<string, string>>): Promise<TrialOutcome> {
  const headers = { [DEV_IDENTITY_HEADER]: input.identity, [DEV_IDENTITY_ACCOUNT_HEADER]: account };
  const read = async (path: string) => fetch(`${input.origin}${path}`, { headers, signal: AbortSignal.timeout(CALL_MS) });
  const held = await read('/api/user/held-rows');

  if (!held.ok) return { given: false, reset: false, finding: `reading what ${account} holds answered ${String(held.status)}` };
  const inherited = Object.entries(inheritedRows(v.parse(JsonRowsSchema, await held.json())));
  let reset = false;

  if (inherited.length > 0) {
    const rows = inherited.map(([table, count]) => `${table} ${String(count)}`).join(', ');
    const { entries } = v.parse(WorkspacesSchema, await (await read('/api/user/workspaces')).json());
    const live = entries.find((workspace) => Date.now() - workspace.lastVisited < WORKSPACE_LEASE_MS);

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

  // A bare account inherits a single Workers AI model for its swarm judge. Its refusal ended every research swarm
  // in run 37880718948. Keys alone do not configure that route: keep the user's retry count, and cross providers.
  const catalogResponse = await read('/api/user/profile-catalog');

  if (!catalogResponse.ok) return { given, reset, finding: `reading ${account}'s profile catalog answered ${String(catalogResponse.status)}` };
  const { version, catalog } = v.parse(ProfileCatalogEnvelopeSchema, await catalogResponse.json());
  const model = DEFAULT_WORKERS_AI_MODEL_SPEC;

  if (catalog.tiers.deep?.model !== model || JSON.stringify(catalog.modelFallbacks?.[model]) !== JSON.stringify(DEFAULT_MODELS)) {
    const answer = await fetch(`${input.origin}/api/user/profile-catalog`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: version, catalog: {
        ...catalog, tiers: { ...catalog.tiers, deep: { ...catalog.tiers.deep, model } },
        modelFallbacks: { ...catalog.modelFallbacks, [model]: DEFAULT_MODELS },
      } }), signal: AbortSignal.timeout(CALL_MS),
    });

    if (!answer.ok) return { given, reset, finding: `configuring ${account}'s deep tier and provider fallback answered ${String(answer.status)}` };
    v.parse(ProfileCatalogEnvelopeSchema, await answer.json());
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

  const after = await listed(input, headers);

  if ('why' in after) return { stored, findings: [...findings, after.why] };

  for (const model of input.models) {
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

if (import.meta.main) {
  const asked = process.argv[2] ?? '';

  if (!URL.canParse(asked)) {
    console.error('usage: bun scripts/eval-provider-keys.ts <origin>');
    process.exit(2);
  }

  const origin = new URL(asked).origin;
  const identityEnv = evalWebIdentityEnv(origin);
  const matrix = evalMatrix(process.env, ARMS.map((arm) => arm.id));
  const identity = process.env[identityEnv]?.trim();
  const taskFiles = trackedFiles().filter(isEvalTask).map((file) => basename(file));

  // Every trial account a run of the full matrix and a deploy's pass act as; a deployment that predates them runs its trials as eval-service.
  const accounts = identity === undefined || identity === '' ? undefined
    : await trialAccountsAt({ origin, identity: { kind: 'secret', secret: identity } });

  if (accounts?.kind === 'shared') console.log(`eval-provider-keys: ${accounts.why}`);

  const { stored, findings, trials, notes } = await provisionEvalProviderKeys({
    origin, keysPath: EVAL_PROVIDER_KEYS, identity, identityEnv, models: matrix.models,
    trialAccounts: accounts?.kind === 'trial' ? [
      ...trialAccounts(taskFiles, { ...matrix, trials: Math.max(matrix.trials, DEFAULT_TRIALS) }),
      ...trialAccounts(taskFiles, { ...matrix, trials: 1, firstSlot: PASS_FIRST_SLOT }),
    ] : undefined,
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
