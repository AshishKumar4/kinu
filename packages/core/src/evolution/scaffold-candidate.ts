import type { LanguageModel, ToolSet } from 'ai';
import type { ModelCallSpend } from '../events/model-call';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import { resolveModelRoute } from '../profiles/model-route';
import { parseModelSpec } from '../providers/types';
import { reasoningEffortOptions } from '../strategy/effort';
import { buildSystemPromptSync, currentDateForPrompt } from '../prompt';
import { createScaffoldDefaultInference, createScaffoldLLMStream } from '../orchestrator/scaffold-host';
import type { ScaffoldRunControl } from '../scaffold/executor';
import type { ScaffoldReplayContext, ScaffoldSurface } from './control';

export interface ScaffoldCandidateBinding extends ScaffoldRunControl {
  readonly rt: AgentRuntime;
  readonly profile: () => Promise<ResolvedTurnProfile>;
  readonly bindModel: (spec: string) => LanguageModel;
  readonly tools: ToolSet;
  readonly spend: ModelCallSpend;
  readonly callTool: ScaffoldSurface['callTool'];
  readonly history: ScaffoldSurface['history'];
}

export function createScaffoldCandidateSurface(
  binding: ScaffoldCandidateBinding,
  task: string,
  context?: ScaffoldReplayContext,
): ScaffoldSurface {
  const request = async () => {
    const route = resolveModelRoute('scaffold', await binding.profile());

    return {
      model: binding.bindModel(route.model), spec: route.model,
      tools: () => binding.tools, spend: binding.spend,
      signal: binding.signal, assertActive: binding.assertActive,
      streamOptions: { providerOptions: reasoningEffortOptions(route.reasoningEffort, parseModelSpec(route.model).provider) },
    };
  };

  return {
    callTool: binding.callTool,
    history: binding.history,
    llmStream: async function* (call) {
      yield* createScaffoldLLMStream(await request())(call);
    },
    defaultInference: async function* () {
      const resolved = await request();
      yield* createScaffoldDefaultInference(resolved, {
        system: buildSystemPromptSync(binding.rt, {
          model: { id: resolved.spec }, currentDate: currentDateForPrompt(),
        }),
        modelContext: { id: resolved.spec },
        history: context && context.length > 0 ? [...context] : [{ role: 'user', content: task }],
      })();
    },
  };
}
