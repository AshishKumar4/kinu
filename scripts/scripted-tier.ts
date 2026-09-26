/**
 * Puts the eval accounts a deployed tier acts as on the scripted model: each account's `openai-compat` credential
 * points at the tiers' Worker and its default tier becomes the scripted model, so its workspaces, and the helpers and
 * swarm nodes they hire, all answer from `tierModel`. Run by the tier before its cases, against the build it drives.
 *   bun scripts/scripted-tier.ts <origin> <eval account>...
 */
import * as v from 'valibot';
import { EVAL_ACCOUNTS } from '@kinu.run/core';
import { resolveWebIdentity, webHeaders } from '../evals/src/session';
import { SCRIPTED_MODEL_ORIGIN } from '../packages/test-utils/src/scripted-model-spec';
import { defaultToScriptedModel, registerScriptedModel } from './scripted-model';

const [origin, ...accounts] = process.argv.slice(2);

if (origin === undefined || accounts.length === 0) {
  console.error('usage: bun scripts/scripted-tier.ts <origin> <eval account>...');
  process.exit(2);
}

for (const account of v.parse(v.array(v.picklist(EVAL_ACCOUNTS)), accounts)) {
  const identity = resolveWebIdentity(origin, { ...process.env, KINU_EVAL_ACCOUNT: account });

  if (identity.kind === 'absent') throw new Error(identity.remedy);
  const headers = webHeaders(identity.identity);

  await registerScriptedModel(origin, SCRIPTED_MODEL_ORIGIN, headers);
  await defaultToScriptedModel(origin, headers);
  console.error(`scripted-tier: the ${account} account at ${origin} runs on ${SCRIPTED_MODEL_ORIGIN}`);
}
