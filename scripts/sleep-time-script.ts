import { SLEEP_TIME_PROMPT_OPENING } from '../packages/core/src/utils/prompt-sections';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

/** Tier traffic carries no durable user knowledge; the memory lane still needs its own structured answer. */
export const sleepTimeScript = (request: ScriptedRequest): ScriptedAnswer | null => {
  if (request.available.length !== 0 || !request.userTexts[0]?.startsWith(SLEEP_TIME_PROMPT_OPENING)) return null;

  return { text: JSON.stringify({ upserts: [], decay: [] }) };
};
