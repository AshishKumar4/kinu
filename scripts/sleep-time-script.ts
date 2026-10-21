import { SLEEP_TIME_PROMPT_OPENING } from '../packages/core/src/utils/prompt-sections';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

/** Tier traffic carries no durable user knowledge: the memory lane's structured answer is an empty update. */
export const SLEEP_TIME_ANSWER = JSON.stringify({ upserts: [], decay: [] });

/** Whether a conversation is the memory lane's ask, by the prompt its first user text opens on. */
export const asksSleepTime = (firstUserText: string | undefined): boolean => firstUserText?.startsWith(SLEEP_TIME_PROMPT_OPENING) === true;

/** The memory lane still needs its own structured answer. */
export const sleepTimeScript = (request: ScriptedRequest): ScriptedAnswer | null => {
  if (request.available.length !== 0 || !asksSleepTime(request.userTexts[0])) return null;

  return { text: SLEEP_TIME_ANSWER };
};
