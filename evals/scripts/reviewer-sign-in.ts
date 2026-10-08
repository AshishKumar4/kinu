#!/usr/bin/env bun
/**
 * THE EVAL REVIEWER'S CHATGPT LOGIN, on a deployment that lacks it. The reviewer runs on the owner's ChatGPT Pro login
 * (`REVIEW_LOGIN`, evals/src/config.ts), the eval identity's own sign-in through the product's paste-back flow: a
 * login's refresh token rotates on use, so none is copied from a machine that holds one. When
 * `GET /api/user/credentials` does not list it, this starts the sign-in, prints where to sign in, and reads the address
 * the owner's browser lands on, pasted back here. Held, it is left alone, so a deploy asks only after a reset wiped it.
 * With no terminal to ask at, it asks nothing and says the login is missing. Then it reads whether the reviewer's model
 * answers a real call on it. It prints outcomes and the signed-in email, never a token; whatever is missing is a notice
 * in the deploy's report and the exit is 1.
 *   bun evals/scripts/reviewer-sign-in.ts <origin>
 */
import * as v from 'valibot';
import { DEV_IDENTITY_HEADER, ModelTestResultSchema } from '@kinu.run/core';
import { evalWebIdentityEnv } from '@kinu.run/test-utils';
import { REVIEW_LOGIN } from '../src/config';
import { recordNotice } from '../../scripts/deploy-report';

const CredentialsSchema = v.array(v.looseObject({ key: v.string() }));

const StartSchema = v.object({ authorizeUrl: v.string(), redirectUri: v.string() });

const FinishedSchema = v.object({ outcome: v.string(), email: v.nullable(v.string()) });

/** One call to the deployment as eval-service, its answer parsed by `schema`; a refusal throws in the deployment's words. */
async function answered<Schema extends v.GenericSchema>(schema: Schema, origin: string, path: string, init: RequestInit): Promise<v.InferOutput<Schema>> {
  const response = await fetch(`${origin}${path}`, init);

  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);

  return v.parse(schema, await response.json());
}

/** The next line typed here: the address the owner's browser landed on. */
async function pasted(): Promise<string> {
  for await (const line of console) return line.trim();

  return '';
}

/** Sign the reviewer's login in by paste-back, waiting on the owner; what went wrong, said without a token, or null. */
async function signIn(origin: string, headers: Record<string, string>): Promise<string | null> {
  const { account } = REVIEW_LOGIN;
  const posted = (body: string) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
  const started = await answered(StartSchema, origin, '/api/user/chatgpt/paste/start', posted(JSON.stringify({ account })));

  console.log(`reviewer-sign-in: sign the reviewer's ChatGPT login ${account} in at ${started.authorizeUrl}`);
  console.log(`reviewer-sign-in: then paste the address your browser lands on (${started.redirectUri}?…) and press Enter`);
  const finished = await answered(FinishedSchema, origin, '/api/user/chatgpt/paste/finish', posted(JSON.stringify({ url: await pasted() })));

  if (finished.outcome !== 'signed_in') return `${account} was not signed in: ${finished.outcome}`;
  console.log(`reviewer-sign-in: ${account} signed in at ${origin} as ${finished.email ?? 'an unnamed ChatGPT account'}`);

  return null;
}

/** The reviewer's login held, or asked of the owner when it is not and a terminal is here to ask at; what is missing. */
async function provision(origin: string, headers: Record<string, string>, held: boolean): Promise<string | null> {
  const { account } = REVIEW_LOGIN;

  if (held) {
    console.log(`reviewer-sign-in: ${origin} holds the reviewer's login ${account}`);

    return null;
  }

  if (process.stdin.isTTY !== true) return `${origin} lacks the reviewer's login ${account}, and no terminal is here to ask at: run bun evals/scripts/reviewer-sign-in.ts ${origin}`;

  try {
    return await signIn(origin, headers);
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
  const held = (await answered(CredentialsSchema, origin, '/api/user/credentials', { headers })).some((row) => row.key === REVIEW_LOGIN.key);
  const missing = await provision(origin, headers, held);
  const findings = missing === null ? [] : [missing];
  const { spec } = REVIEW_LOGIN;

  // A real call, as the reviewer will make it: the menu lists no account-qualified spec, and refuses a provider whose
  // several accounts have no default, so a listing cannot say whether `chatgpt@<account>/…` answers.
  const tested = await answered(ModelTestResultSchema, origin, '/api/user/models/test', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ spec }),
  });

  if (tested.ok) console.log(`reviewer-sign-in: ${spec} answers at ${origin}, first token in ${String(tested.firstTokenMs)} ms`);
  else findings.push(`${spec} does not answer at ${origin}: ${tested.message}`);

  const report = process.env['KINU_DEPLOY_REPORT'] ?? '';

  for (const found of findings) {
    console.error(`reviewer-sign-in: ${found}`);

    if (report !== '') recordNotice(report, { phase: 'provision', what: "the eval reviewer's ChatGPT login", notice: found });
  }

  process.exit(findings.length === 0 ? 0 : 1);
}
