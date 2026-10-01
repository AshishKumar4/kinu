/**
 * The scripted model the product tiers run on: background memory, the durability canary's calls, the flows',
 * the first-run cases', then the fallback answer.
 * One model for every tier and every origin, a local server in a suite and the deployed Worker alike, so a row answers
 * the same wherever it runs. Each script owns only the words its rows send, so none answers another's.
 */
import { firstRunScript } from '../tests/first-run/scripted';
import { SLEEP_TIME_PROMPT_OPENING } from '../packages/core/src/utils/prompt-sections';
import { canaryScript } from './canary-script';
import { flowsScript } from './flows-script';
import { FALLBACK_ANSWER, type ScriptedAnswer, type ScriptedModel, type ScriptedRequest } from './scripted-protocol';

/** Tier traffic carries no durable user knowledge; the memory lane still needs its own structured answer. */
const sleepTimeScript = (request: ScriptedRequest): ScriptedAnswer | null => {
  if (request.available.length !== 0 || !request.userTexts[0]?.startsWith(SLEEP_TIME_PROMPT_OPENING)) return null;

  return { text: JSON.stringify({ upserts: [], decay: [] }) };
};

export const tierModel: ScriptedModel = (request) => sleepTimeScript(request) ?? canaryScript(request) ?? flowsScript(request) ?? firstRunScript(request) ?? { text: FALLBACK_ANSWER };
