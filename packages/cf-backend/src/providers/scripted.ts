// The scripted provider — the one LanguageModel in this registry that does not
// reach a vendor.
//
// IT EXISTS FOR THE DEV-SERVER E2E TIER. The workerd pool cannot host a full
// ActorAgent turn (tests/workerd/steer-probe.ts carries the measurement), and
// every bun suite seeds its own transcript, so nothing ran two real turns end
// to end until tests/e2e drove a `wrangler dev` boot of this Worker — which is
// where the two 2026-09-08 defects lived (a pane COUNT naming a column the SDK
// never creates, and a second turn whose request dropped its own message). The
// probe needs a turn that streams a real answer with no vendor behind it; this
// provider's one model echoes the last user message it was handed, prefixed
// `echo:`, and calls no tools.
//
// REGISTERED ONLY UNDER `KINU_SCRIPTED_MODEL=1` — set on the e2e harness's own
// `wrangler dev`, never on a deployment. Without it the spec `scripted/<id>`
// fails normalization the same way every unknown provider does, so a workspace
// could not be created on it and no turn could ever reach it; refusing at
// `createModel` instead would let `setModel` persist a spec whose turn then
// fails mid-request, which is a worse refusal. `agent-registry.ts` holds the
// flag read; `tests/unit-scripted-provider.test.ts` holds both directions.
import type { LanguageModel } from 'ai';
import type { ModelProvider } from '@kinu.run/core';
import { scriptedTurnModel, type ScriptedTurnOptions } from '@kinu.run/test-utils/turn-model';

/** The var a `wrangler dev` boot carries to opt this provider in. */
export const SCRIPTED_MODEL_ENV = 'KINU_SCRIPTED_MODEL';

export function createScriptedProvider(): ModelProvider {
  return {
    id: 'scripted',
    label: 'Scripted (test-only)',
    isAvailable: () => true,
    listModels: () => [{
      id: 'echo',
      label: 'echo (scripted test model)',
      capabilities: ['tools', 'streaming'],
      contextWindow: 128_000,
      modelOutputLimit: 16_384,
    }],
    createModel(modelId): LanguageModel {
      return scriptedTurnModel({
        provider: 'scripted',
        modelId,
        doGenerate: (options: ScriptedTurnOptions) => {
          // The LAST user message — the one fact a turn must never lose. A
          // request carrying none is malformed, and echoing nothing would
          // answer green over the exact defect this model exists to expose,
          // so it throws rather than answer.
          const last = [...options.prompt].reverse().find((m) => m.role === 'user');

          if (!last) throw new Error('scripted/echo turn carried no user message');

          const text = Array.isArray(last.content)
            ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
            : last.content;

          return {
            content: [{ type: 'text' as const, text: `echo:${text}` }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: {
              inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 4, text: 4, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });
    },
  };
}
