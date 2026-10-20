/**
 * Puts one eval account a deployed tier acts as on the scripted model, and proves the deployment reaches it. The
 * account's `openai-compat` credential points at the tiers' Worker and its default tier becomes the scripted model, so
 * its workspaces, and the helpers and swarm nodes they hire, all answer from `tierModel`; its search chain is chosen
 * (`chooseSearch`), and `gateway` signs in to Cloudflare. Run by the tier before its cases, against the build it drives,
 * with that account's CLI bearer in KINU_TOKEN.
 *   bun scripts/scripted-tier.ts <origin> <eval account>
 *
 * Two kinds of request reach the scripted model's host, routed differently (scripts/scripted-model-worker.jsonc), and
 * each is proven the way a case makes it. A hosted turn's call comes from the workspace's Durable Object, whose fetch
 * runs the zone's routes first: measured 2026-09-25, with the host a Custom Domain alone, production's `*.kinu.run/*`
 * answered every such call with its preview 404. So one turn runs in a fresh workspace of the account, and its reply
 * must be the script's own. The deployment's provider proxy fetches from its request context, which skips same-zone
 * routes and reaches the host's Custom Domain, so the model list is read through it too.
 */
import * as v from 'valibot';
import { EVAL_ACCOUNTS, PROVIDER_PROXY_PATH, PROXY_CRED_HEADER, PROXY_TARGET_HEADER } from '@kinu.run/core';
import { resolvePublicSessionPlan } from '../evals/src/session';
import { resolveWebIdentity, webHeaders } from '../evals/src/workspace-roster';
import {
  SCRIPTED_MODEL_ID, SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN, SCRIPTED_MODEL_SPEC,
} from '../packages/test-utils/src/scripted-model-spec';
import { SCRIPTED_CREDENTIAL, chooseSearch, connectCloudflare, defaultToScriptedModel, registerScriptedModel } from './scripted-model';
import { FALLBACK_ANSWER } from './scripted-protocol';

const [origin, named, ...rest] = process.argv.slice(2);

/** A Cloudflare API token with Workers AI Read and AI Gateway Read, and the account it reaches. */
const GATEWAY_TOKEN_ENV = 'WEBSEARCH_CF_TOKEN';

const GATEWAY_ACCOUNT_ENV = 'WEBSEARCH_CF_ACCOUNT';

const token = process.env.KINU_TOKEN?.trim() ?? '';

/** The scripted model Worker's `SCRIPTED_MODEL_KEY`, stored as the account's API key; it answers nothing else. */
const modelKey = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

if (modelKey === '') {
  console.error(`scripted-tier: ${SCRIPTED_MODEL_KEY_ENV} is not set, so the scripted model Worker would refuse every call.`);
  process.exit(2);
}

if (origin === undefined || named === undefined || rest.length > 0 || token === '') {
  console.error('usage: KINU_TOKEN=<the account\'s CLI bearer> bun scripts/scripted-tier.ts <origin> <eval account>');
  process.exit(2);
}

const account = v.parse(v.picklist(EVAL_ACCOUNTS), named);

const env = { ...process.env, KINU_EVAL_ACCOUNT: account };

const identity = resolveWebIdentity(origin, env);

if (identity.kind === 'absent') throw new Error(identity.remedy);

const headers = webHeaders(identity.identity);

await registerScriptedModel(origin, SCRIPTED_MODEL_ORIGIN, headers, modelKey);

await chooseSearch(origin, headers, account);

// `gateway` signs in to Cloudflare (EVAL_ACCOUNTS): its searches bill its own account's gateway.
if (account === 'gateway') {
  const cloudflare = v.safeParse(v.object({
    [GATEWAY_TOKEN_ENV]: v.pipe(v.string(), v.minLength(1)),
    [GATEWAY_ACCOUNT_ENV]: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/)),
  }), process.env);

  if (!cloudflare.success) {
    console.error(`scripted-tier: the gateway account signs in to Cloudflare with ${GATEWAY_TOKEN_ENV} on ${GATEWAY_ACCOUNT_ENV}, and one is not set.`);
    process.exit(2);
  }

  await connectCloudflare(origin, headers, { token: cloudflare.output[GATEWAY_TOKEN_ENV], accountId: cloudflare.output[GATEWAY_ACCOUNT_ENV] });
}

await defaultToScriptedModel(origin, headers);

const unreached: string[] = [];

const listed = await fetch(`${origin}${PROVIDER_PROXY_PATH}/forward`, {
  headers: {
    authorization: `Bearer ${token}`,
    [PROXY_CRED_HEADER]: SCRIPTED_CREDENTIAL,
    [PROXY_TARGET_HEADER]: `${SCRIPTED_MODEL_ORIGIN}/models`,
  },
});

const body = await listed.text();

if (!listed.ok || !body.includes(`"${SCRIPTED_MODEL_ID}"`)) {
  unreached.push(`the provider proxy's read answered ${String(listed.status)} ${body.slice(0, 300)}`);
}

// An ask no script claims, so the reply is the script's fallback: any other reply came from somewhere else.
const resolution = resolvePublicSessionPlan('scripted-tier', SCRIPTED_MODEL_SPEC, env);

if (resolution.kind !== 'ready') throw new Error(resolution.remedy);

const session = await resolution.plan.open({
  subject: `scripted-tier-${account}`,
  purpose: "Proves the deployment's hosted turns reach the tiers' scripted model.",
  genesis: false,
});

try {
  const turn = await session.prompt('Say anything at all.');

  if (turn.landed !== 'turn' || turn.hadError || turn.text.trim() !== FALLBACK_ANSWER) {
    unreached.push(`a hosted turn ${turn.landed === 'turn' ? `replied ${JSON.stringify(turn.text.slice(0, 300))}`
      + `${turn.hadError ? ' in error' : ''}` : 'never ran'}, not the script's ${JSON.stringify(FALLBACK_ANSWER)}`);
  }
} finally {
  await session.teardown();
}

if (unreached.length > 0) {
  console.error(`scripted-tier: the ${account} account at ${origin} does not reach ${SCRIPTED_MODEL_ORIGIN}: `
    + unreached.join('; '));
  process.exit(1);
}

console.error(`scripted-tier: the ${account} account at ${origin} runs on ${SCRIPTED_MODEL_ORIGIN}, `
  + 'which both a hosted turn and the provider proxy reach');
