#!/usr/bin/env bun
/**
 * EVAL-SERVICE'S PROVIDER KEYS, ON EVERY DEPLOYMENT IT DRIVES. A reset deletes every Durable Object of a deployment,
 * eval-service's provider credentials with them, and a deploy can reach a deployment whose reset ran in another
 * run; so before the tiers and the evals, every staging and promotion deploy asks the deployment which models
 * eval-service can run, stores through the product's own route each key whose provider it does not list, and asks
 * again: every model the eval pass runs must then be listed.
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
import { join } from 'node:path';
import * as v from 'valibot';
import { DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { evalWebIdentityEnv } from '@kinu.run/test-utils';
import { evalMatrix } from '../evals/src/config';
import { ARMS } from '../evals/src/target';
import { catalogCredKey } from '../packages/core/src/providers/catalog';
import { recordStep } from './deploy-report';

/** Where the operator keeps eval-service's provider keys: outside every checkout, mode 600. */
export const EVAL_PROVIDER_KEYS = join(homedir(), '.config', 'kinu', 'eval-provider-keys.json');

const KeysSchema = v.record(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]*\.bearer$/u)), v.pipe(v.string(), v.minLength(1)));

const ModelsSchema = v.looseObject({ models: v.array(v.looseObject({ spec: v.string(), provider: v.string() })) });

/** How long one call to the deployment may take, as the deploy's smoke test bounds its own with `curl --max-time`. */
const CALL_MS = 30_000;

export interface Provisioning {
  readonly origin: string;
  readonly keysPath: string;
  /** The deployment's DEV_IDENTITY_SECRET, and the variable it came from, for a finding that names it. */
  readonly identity: string | undefined;
  readonly identityEnv: string;
  /** The models the eval pass runs. */
  readonly models: readonly string[];
}

/** What eval-service lists: the providers it can run, and every model spec. */
interface Listed {
  readonly providers: ReadonlySet<string>;
  readonly specs: ReadonlySet<string>;
}

async function listed(input: Provisioning, headers: Record<string, string>): Promise<Listed | { readonly why: string }> {
  const answer = await fetch(`${input.origin}/api/user/models`, { headers, signal: AbortSignal.timeout(CALL_MS) });

  if (!answer.ok) return { why: `listing eval-service's models answered ${String(answer.status)}` };
  const { models } = v.parse(ModelsSchema, await answer.json());

  return { providers: new Set(models.map((model) => model.provider)), specs: new Set(models.map((model) => model.spec)) };
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
}

/** Stores each key whose provider eval-service does not list, then checks every eval model is listed. */
export async function provisionEvalProviderKeys(input: Provisioning): Promise<Provisioned> {
  if (input.identity === undefined || input.identity === '') {
    return { stored: [], findings: [`${input.identityEnv} is not set, so nothing can act as eval-service at ${input.origin}`] };
  }

  const headers = { [DEV_IDENTITY_HEADER]: input.identity };
  const before = await listed(input, headers);

  if ('why' in before) return { stored: [], findings: [before.why] };
  const file = keysIn(input.keysPath);
  const findings: string[] = 'why' in file ? [file.why] : [];
  const stored: string[] = [];
  const held = new Set([...before.providers].map((provider) => catalogCredKey(provider)));

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

  const after = stored.length === 0 ? before : await listed(input, headers);

  if ('why' in after) return { stored, findings: [...findings, after.why] };

  for (const model of input.models) {
    if (!after.specs.has(model)) findings.push(`eval-service at ${input.origin} lists no ${model}, so the eval pass cannot run it`);
  }

  return { stored, findings };
}

if (import.meta.main) {
  const asked = process.argv[2] ?? '';

  if (!URL.canParse(asked)) {
    console.error('usage: bun scripts/eval-provider-keys.ts <origin>');
    process.exit(2);
  }

  const origin = new URL(asked).origin;
  const identityEnv = evalWebIdentityEnv(origin);
  const models = evalMatrix(process.env, ARMS.map((arm) => arm.id)).models;

  const { stored, findings } = await provisionEvalProviderKeys({
    origin, keysPath: EVAL_PROVIDER_KEYS, identity: process.env[identityEnv]?.trim(), identityEnv, models,
  });

  const report = process.env['KINU_DEPLOY_REPORT'] ?? '';

  for (const found of findings) {
    console.error(`eval-provider-keys: ${found}`);

    if (report !== '') recordStep(report, { phase: 'provision', what: 'eval-service\'s provider keys', finding: found });
  }

  console.log(`eval-provider-keys: stored ${stored.length === 0 ? 'no key, eval-service holding every one' : stored.join(', ')} at ${origin}`
    + `${findings.length === 0 ? `; it lists every eval model: ${models.join(', ')}` : ''}`);
  process.exit(findings.length === 0 ? 0 : 1);
}
