/** The two model calls a toolless MCTS branch answers (explore, reflection), shared by every branch substrate. */

import { generateText, type LanguageModel } from 'ai';
import { beginModelOperation, type ModelOperationSink } from '../events/model-call';
import type { BranchExploration, BranchReflection } from '../types/agent-runtime';
import type { ProviderOptions } from '../strategy/effort';
import { normalizeUsage } from '../usage';
import { explorePrompt, reflectionPrompt, type ExplorePromptInput } from './explore-prompt';

/** The model a branch runs on, with the effort its route derived. */
export interface BranchRoute {
  readonly model: LanguageModel;
  readonly providerOptions?: ProviderOptions;
}

/** A hosted branch's operation frame; the CLI's worker has none. */
export interface BranchCallFrame {
  readonly operations: ModelOperationSink | undefined;
  readonly spec: string;
}

export async function branchCompletion(
  route: BranchRoute,
  prompt: { readonly system?: string; readonly user: string },
  frame?: BranchCallFrame,
): Promise<{ text: string; usage: BranchExploration['usage'] }> {
  const call: Parameters<typeof generateText>[0] = {
    model: route.model,
    messages: [{ role: 'user', content: prompt.user }],
  };

  if (prompt.system !== undefined) call.system = prompt.system;

  if (route.providerOptions) call.providerOptions = route.providerOptions;

  const operation = beginModelOperation(
    { source: 'mcts', operations: frame?.operations }, 'complete', { spec: frame?.spec },
  );

  let result;

  try {
    result = await generateText(call);
  } catch (cause) {
    operation.failed({ cause });
    throw cause;
  }

  const usage = normalizeUsage(result.usage);
  operation.completed({ usage, modelId: frame?.spec ?? result.response.modelId });

  return { text: result.text.trim(), usage };
}

export function exploreRollout(route: BranchRoute, input: ExplorePromptInput): Promise<BranchExploration> {
  return branchCompletion(route, explorePrompt(input));
}

/** The post-mortem on one attempt. `attempt` is empty on a substrate with no trace store. */
export function reflectRollout(
  route: BranchRoute,
  input: { readonly task: string; readonly attempt: string; readonly outcome?: string },
): Promise<BranchReflection> {
  return branchCompletion(route, { user: reflectionPrompt(input.task, input.attempt, input.outcome) });
}
