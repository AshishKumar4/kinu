#!/usr/bin/env bun
/**
 * EVAL-SERVICE'S PROVIDER KEYS, STORED AGAIN AFTER A RESET. A reset deletes every Durable Object of a deployment, and
 * eval-service's provider credentials with them, so the eval pass would find no model. After a reset, and before the
 * tiers and the evals, the deploy stores each key again through the product's own route, as eval-service, and then asks
 * the deployment which models eval-service can run: every model the eval pass runs must be among them.
 *
 *   bun scripts/eval-provider-keys.ts <origin>
 *
 * The keys are {@link EVAL_PROVIDER_KEYS}, `{"<credential>.bearer": "<key>"}`, each stored with
 * `POST <origin>/api/user/credentials/<credential>` and the body `{"kind":"bearer","token":"<key>"}`, carrying the
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
import { recordStep } from './deploy-report';

/** Where the operator keeps eval-service's provider keys: outside every checkout, mode 600. */
export const EVAL_PROVIDER_KEYS = join(homedir(), '.config', 'kinu', 'eval-provider-keys.json');

const KeysSchema = v.record(v.pipe(v.string(), v.regex(/^[\w.-]+\.bearer$/u)), v.pipe(v.string(), v.minLength(1)));

const ModelsSchema = v.looseObject({ models: v.array(v.looseObject({ spec: v.string() })) });

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

/** Stores every key, then checks the eval models are listed; the findings, one line each, empty when all is well. */
export async function provisionEvalProviderKeys(input: Provisioning): Promise<string[]> {
  if (input.identity === undefined || input.identity === '') {
    return [`${input.identityEnv} is not set, so nothing can act as eval-service at ${input.origin}`];
  }

  const headers = { [DEV_IDENTITY_HEADER]: input.identity };
  const findings: string[] = [];

  if (!existsSync(input.keysPath)) {
    findings.push(`${input.keysPath} does not exist, so eval-service holds no provider key at ${input.origin}`);
  } else {
    const keys = v.safeParse(KeysSchema, JSON.parse(readFileSync(input.keysPath, 'utf8')));

    if (!keys.success) {
      findings.push(`${input.keysPath} is not {"<credential>.bearer": "<key>"}: ${v.summarize(keys.issues).split('\n')[0] ?? ''}`);
    } else if (Object.keys(keys.output).length === 0) {
      findings.push(`${input.keysPath} holds no key`);
    } else {
      for (const [name, token] of Object.entries(keys.output)) {
        const credential = name.slice(0, -'.bearer'.length);

        const answer = await fetch(`${input.origin}/api/user/credentials/${encodeURIComponent(credential)}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'bearer', token }),
          signal: AbortSignal.timeout(CALL_MS),
        });

        if (!answer.ok) findings.push(`storing ${credential} for eval-service answered ${String(answer.status)}`);
      }
    }
  }

  const listed = await fetch(`${input.origin}/api/user/models`, { headers, signal: AbortSignal.timeout(CALL_MS) });

  if (!listed.ok) return [...findings, `listing eval-service's models answered ${String(listed.status)}`];
  const specs = new Set(v.parse(ModelsSchema, await listed.json()).models.map((model) => model.spec));

  for (const model of input.models) {
    if (!specs.has(model)) findings.push(`eval-service at ${input.origin} lists no ${model}, so the eval pass cannot run it`);
  }

  return findings;
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

  const findings = await provisionEvalProviderKeys({
    origin, keysPath: EVAL_PROVIDER_KEYS, identity: process.env[identityEnv]?.trim(), identityEnv, models,
  });

  const report = process.env['KINU_DEPLOY_REPORT'] ?? '';

  for (const found of findings) {
    console.error(`eval-provider-keys: ${found}`);

    if (report !== '') recordStep(report, { phase: 'provision', what: 'eval-service\'s provider keys', finding: found });
  }

  if (findings.length === 0) console.log(`eval-provider-keys: eval-service at ${origin} lists every eval model: ${models.join(', ')}`);
  process.exit(findings.length === 0 ? 0 : 1);
}
