/**
 * Puts one eval account a deployed tier acts as on the scripted model, and proves the deployment reaches it. The
 * account's `openai-compat` credential points at the tiers' Worker and its default tier becomes the scripted model, so
 * its workspaces, and the helpers and swarm nodes they hire, all answer from `tierModel`. Run by the tier before its
 * cases, against the build it drives, with that account's CLI bearer in KINU_TOKEN.
 *   bun scripts/scripted-tier.ts <origin> <eval account>
 *
 * The proof is a read of the model list through the deployment's own provider proxy, so it is the product's Worker
 * that fetches the scripted model, the path every scripted turn takes. A fetch from here cannot stand in for it: a
 * route's Worker runs before a Custom Domain's, which is treated as an origin, and a Worker's fetch on its own zone
 * reaches a Custom Domain directly (Custom Domains docs). So production's `*.kinu.run/*` route answers an outside
 * request for the scripted model's host itself, with its preview-host 404.
 */
import * as v from 'valibot';
import { EVAL_ACCOUNTS, PROVIDER_PROXY_PATH, PROXY_CRED_HEADER, PROXY_TARGET_HEADER } from '@kinu.run/core';
import { resolveWebIdentity, webHeaders } from '../evals/src/session';
import { SCRIPTED_MODEL_ID, SCRIPTED_MODEL_ORIGIN } from '../packages/test-utils/src/scripted-model-spec';
import { SCRIPTED_CREDENTIAL, defaultToScriptedModel, registerScriptedModel } from './scripted-model';

const [origin, named, ...rest] = process.argv.slice(2);

const token = process.env.KINU_TOKEN?.trim() ?? '';

if (origin === undefined || named === undefined || rest.length > 0 || token === '') {
  console.error('usage: KINU_TOKEN=<the account\'s CLI bearer> bun scripts/scripted-tier.ts <origin> <eval account>');
  process.exit(2);
}

const account = v.parse(v.picklist(EVAL_ACCOUNTS), named);

const identity = resolveWebIdentity(origin, { ...process.env, KINU_EVAL_ACCOUNT: account });

if (identity.kind === 'absent') throw new Error(identity.remedy);

const headers = webHeaders(identity.identity);

await registerScriptedModel(origin, SCRIPTED_MODEL_ORIGIN, headers);

await defaultToScriptedModel(origin, headers);

const listed = await fetch(`${origin}${PROVIDER_PROXY_PATH}/forward`, {
  headers: {
    authorization: `Bearer ${token}`,
    [PROXY_CRED_HEADER]: SCRIPTED_CREDENTIAL,
    [PROXY_TARGET_HEADER]: `${SCRIPTED_MODEL_ORIGIN}/models`,
  },
});

const body = await listed.text();

if (!listed.ok || !body.includes(`"${SCRIPTED_MODEL_ID}"`)) {
  console.error(`scripted-tier: ${origin} does not reach ${SCRIPTED_MODEL_ORIGIN}: its proxy answered `
    + `${String(listed.status)} ${body.slice(0, 300)}`);
  process.exit(1);
}

console.error(`scripted-tier: the ${account} account at ${origin} runs on ${SCRIPTED_MODEL_ORIGIN}, which it reaches`);
