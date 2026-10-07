#!/usr/bin/env bun
/**
 * THE EVAL REVIEWER'S CODEX LOGINS, on a deployment that lacks them. The reviewer moves to the owner's ChatGPT Pro logins
 * (`REVIEW_ACCOUNTS`, evals/src/config.ts), and each is the eval identity's own sign-in through the product's device-code
 * flow: a login's refresh token rotates on use, so none is copied from a machine that holds one. For each login
 * `GET /api/user/credentials` does not list, this starts the sign-in for that account, prints where to approve it and
 * the code, and waits while the owner approves it in a browser. One the deployment holds is left alone, so a deploy asks
 * only after a reset wiped it. With no terminal to ask at, it asks nothing and says which login is missing. Then it reads
 * whether the deployment lists the reviewer's model on each login: the measurement `REVIEW_MODEL` waits on. It prints
 * outcomes and ChatGPT account ids, never a token; whatever is missing is a notice in the deploy's report and the exit
 * is 1.
 *   bun evals/scripts/reviewer-sign-in.ts <origin>
 */
import { setTimeout as sleep } from 'node:timers/promises';
import * as v from 'valibot';
import { accountCredentialKey, CODEX_CRED_KEY, DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { evalWebIdentityEnv } from '@kinu.run/test-utils';
import { codexReviewModel, REVIEW_ACCOUNTS } from '../src/config';
import { recordNotice } from '../../scripts/deploy-report';

const CredentialsSchema = v.array(v.looseObject({ key: v.string() }));

const StartSchema = v.object({ userCode: v.string(), portalURL: v.string(), pollIntervalSec: v.number() });

const PollSchema = v.object({ connected: v.boolean(), accountId: v.optional(v.string()), error: v.optional(v.string()) });

const ModelsSchema = v.looseObject({ models: v.array(v.looseObject({ spec: v.string() })) });

/** One call to the deployment as eval-service, its answer parsed by `schema`; a refusal throws in the deployment's words. */
async function answered<Schema extends v.GenericSchema>(schema: Schema, origin: string, path: string, init: RequestInit): Promise<v.InferOutput<Schema>> {
  const response = await fetch(`${origin}${path}`, init);

  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);

  return v.parse(schema, await response.json());
}

/** Sign `account` in by the device code, waiting on the owner's approval; the outcome, said without a token. */
async function signIn(origin: string, headers: Record<string, string>, account: string): Promise<string | null> {
  const started = await answered(StartSchema, origin, '/api/user/codex/start', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ account }),
  });

  console.log(`reviewer-sign-in: approve the reviewer's ChatGPT login ${account} at ${started.portalURL} with the code ${started.userCode}`);

  // The device code expires on OpenAI's side, which the poll answers as an error; nothing here bounds the wait.
  for (;;) {
    await sleep(started.pollIntervalSec * 1000);

    const polled = await answered(PollSchema, origin, '/api/user/codex/poll', { method: 'POST', headers });

    if (polled.connected) {
      console.log(`reviewer-sign-in: ${account} signed in at ${origin} as ChatGPT account ${polled.accountId ?? 'unnamed'}`);

      return null;
    }

    if (polled.error !== undefined) return `${account} was not signed in: ${polled.error}`;
  }
}

/** The login `account` held, or asked of the owner when it is not and a terminal is here to ask at; what is missing. */
async function provision(origin: string, headers: Record<string, string>, held: ReadonlySet<string>, account: string): Promise<string | null> {
  if (held.has(accountCredentialKey(CODEX_CRED_KEY, account))) {
    console.log(`reviewer-sign-in: ${origin} holds the reviewer's login ${account}`);

    return null;
  }

  if (process.stdin.isTTY !== true) return `${origin} lacks the reviewer's login ${account}, and no terminal is here to ask at: run bun evals/scripts/reviewer-sign-in.ts ${origin}`;

  try {
    return await signIn(origin, headers, account);
  } catch (error) {
    return `${account} was not signed in: ${String(error)}`;
  }
}

if (import.meta.main) {
  const asked = process.argv[2] ?? '';

  if (!URL.canParse(asked)) {
    console.error('usage: bun evals/scripts/reviewer-sign-in.ts <origin>');
    process.exit(2);
  }

  const origin = new URL(asked).origin;
  const identityEnv = evalWebIdentityEnv(origin);
  const secret = process.env[identityEnv]?.trim() ?? '';

  if (secret === '') {
    console.error(`reviewer-sign-in: ${identityEnv} is not set, so nothing can act as eval-service at ${origin}`);
    process.exit(1);
  }

  const headers = { [DEV_IDENTITY_HEADER]: secret };
  const held = new Set((await answered(CredentialsSchema, origin, '/api/user/credentials', { headers })).map((row) => row.key));
  const findings: string[] = [];

  for (const account of REVIEW_ACCOUNTS) {
    const missing = await provision(origin, headers, held, account);

    if (missing !== null) findings.push(missing);
  }

  const listed = new Set((await answered(ModelsSchema, origin, '/api/user/models', { headers })).models.map((model) => model.spec));

  for (const account of REVIEW_ACCOUNTS) {
    const spec = codexReviewModel(account);

    if (listed.has(spec)) console.log(`reviewer-sign-in: ${origin} lists ${spec} for eval-service`);
    else findings.push(`${origin} lists no ${spec} for eval-service`);
  }

  const report = process.env['KINU_DEPLOY_REPORT'] ?? '';

  for (const found of findings) {
    console.error(`reviewer-sign-in: ${found}`);

    if (report !== '') recordNotice(report, { phase: 'provision', what: "the eval reviewer's Codex logins", notice: found });
  }

  process.exit(findings.length === 0 ? 0 : 1);
}
