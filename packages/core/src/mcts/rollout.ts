/**
 * The two model calls a toolless MCTS branch answers: one explore, one
 * reflection.
 *
 * Every branch substrate runs this: a hosted facet, a local child process, and
 * the inline closure a host without facets falls back to. The backend supplies
 * the routed model and its provider options as data and keeps what only it
 * holds, its trace store and its operation frame. The question, the request
 * shape and the reading of the answer live here once.
 */

import { generateText, type LanguageModel } from 'ai';
import type { BranchExploration, BranchReflection } from '../types/agent-runtime';
import type { ProviderOptions } from '../strategy/effort';
import { normalizeUsage } from '../usage';
import { explorePrompt, reflectionPrompt, type ExplorePromptInput } from './explore-prompt';

/** The model a branch runs on, with the effort its route derived. */
export interface BranchRoute {
  readonly model: LanguageModel;
  readonly providerOptions?: ProviderOptions;
}

async function completion(
  route: BranchRoute,
  system: string | undefined,
  user: string,
): Promise<{ text: string; usage: BranchExploration['usage'] }> {
  const call: Parameters<typeof generateText>[0] = {
    model: route.model,
    messages: [{ role: 'user', content: user }],
  };
  if (system !== undefined) call.system = system;
  if (route.providerOptions) call.providerOptions = route.providerOptions;
  const result = await generateText(call);
  return { text: result.text.trim(), usage: normalizeUsage(result.usage) };
}

/** One candidate approach, asked the way every sibling is asked. */
export function exploreRollout(route: BranchRoute, input: ExplorePromptInput): Promise<BranchExploration> {
  const { system, user } = explorePrompt(input);
  return completion(route, system, user);
}

/** The post-mortem on one attempt. `attempt` is empty on a substrate with no trace store. */
export function reflectRollout(
  route: BranchRoute,
  input: { readonly task: string; readonly attempt: string; readonly outcome?: string },
): Promise<BranchReflection> {
  return completion(route, undefined, reflectionPrompt(input.task, input.attempt, input.outcome));
}
