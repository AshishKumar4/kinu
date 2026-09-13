import type { LanguageModel, ToolSet } from 'ai';
import type { ModelCallSpend } from '../events/model-call';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import { resolveModelRoute } from '../profiles/model-route';
import { parseModelSpec } from '../providers/types';
import { reasoningEffortOptions } from '../strategy/effort';
import { buildSystemPromptSync, currentDateForPrompt } from '../prompt';
import { createScaffoldCallTool, createScaffoldDefaultInference, createScaffoldLLMStream } from '../orchestrator/scaffold-host';
import type { ScaffoldRunControl } from '../scaffold/executor';
import type { ScaffoldReplayContext, ScaffoldSurface } from './control';
import type { PromptModelContext } from '../prompting/model-profile';
import { currentOperationProfile, operationProfileStream, resolveOperationProfile, runOperationProfile,
  withOperationProfile, type OperationProfile } from '../profiles/operation';

export interface ScaffoldCandidateBinding extends ScaffoldRunControl {
  readonly rt: AgentRuntime;
  readonly profile: () => Promise<ResolvedTurnProfile>;
  readonly bindModel: (spec: string) => LanguageModel;
  readonly modelContext: (spec: string) => Promise<PromptModelContext>;
  readonly tools: () => ToolSet;
  readonly spend: ModelCallSpend;
  readonly callScope?: string;
  readonly history: ScaffoldSurface['history'];
}

function candidateTools(binding: ScaffoldCandidateBinding, context: OperationProfile): ToolSet {
  const allowed = new Set(context.profile.allowedTools);

  return withOperationProfile(Object.fromEntries(
    Object.entries(runOperationProfile(context, binding.tools)).filter(([name]) => allowed.has(name)),
  ), context);
}

export function createScaffoldCandidateSurface(
  binding: ScaffoldCandidateBinding,
  task: string,
  context?: ScaffoldReplayContext,
): ScaffoldSurface {
  const callTool = createScaffoldCallTool(() => {
    const operation = currentOperationProfile(binding.rt.actor);

    if (!operation) throw new Error('the scaffold tool call has no operation profile');

    return candidateTools(binding, operation);
  }, binding.callScope, binding.signal, binding.assertActive);

  const request = async () => {
    const context = await resolveOperationProfile({ actor: binding.rt.actor, resolve: binding.profile });
    const route = resolveModelRoute('scaffold', context.profile);
    const tools = candidateTools(binding, context);
    const modelContext = await binding.modelContext(route.model);

    return {
      context,
      options: {
        model: binding.bindModel(route.model), spec: route.model, modelContext,
        tools: () => tools, spend: binding.spend,
        signal: binding.signal, assertActive: binding.assertActive,
        streamOptions: { providerOptions: reasoningEffortOptions(route.reasoningEffort, parseModelSpec(route.model).provider) },
      },
    };
  };

  return {
    callTool: async (name, args) => {
      const operation = await resolveOperationProfile({ actor: binding.rt.actor, resolve: binding.profile });

      return runOperationProfile(operation, () => callTool(name, args));
    },
    history: binding.history,
    llmStream: async function* (call) {
      const resolved = await request();
      yield* operationProfileStream(createScaffoldLLMStream(resolved.options)(call), resolved.context);
    },
    defaultInference: async function* () {
      const resolved = await request();
      yield* operationProfileStream(createScaffoldDefaultInference(resolved.options, {
        system: buildSystemPromptSync(binding.rt, {
          model: { id: resolved.options.spec }, currentDate: currentDateForPrompt(),
        }),
        history: context && context.length > 0 ? [...context] : [{ role: 'user', content: task }],
      })(), resolved.context);
    },
  };
}
