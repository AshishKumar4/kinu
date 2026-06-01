/**
 * CFHeadRuntime — concrete HeadRuntime for the branching-heads primitive.
 *
 * Heads run as ExplorationAgent Facets in head mode (initHead + runAsHead).
 * The same Facet class powers MCTS branches in MCTS mode; head mode is a
 * different ToolSet + a multi-step inference loop on top of the same
 * parallel-spawn infrastructure.
 */

import { generateObject } from "ai";
import type {
  HeadRuntime, SpawnedHead, HeadInput, HeadReport, MergeLLMFn,
} from "@proteus/core";
import { type MergeOutput, effortFor, createAgentConfigStore } from "@proteus/core";
import type { Think } from "@cloudflare/think";
import { ExplorationAgent } from "../exploration.js";
import { createAgentProviderRegistry } from "../providers/agent-registry.js";
import { aiSchema } from "../ai-schema.js";
import type { UserDO } from "../user/user-do.js";

/** Agent surface this head runtime needs — `env` is protected on the DO base
 *  but the orchestrator (a subclass) passes `this` cast to this view. */
type HeadHost = Think<Env> & { readonly env: Env };

export function createCFHeadRuntime(orchestrator: HeadHost, ownerUserId: string): HeadRuntime {
  // Auth flows through the orchestrator's owner UserDO stub. ownerUserId
  // is read once from agent_soul by the orchestrator and threaded down.
  const userDOStub = orchestrator.env.UserDO.get(
    orchestrator.env.UserDO.idFromName(ownerUserId),
  ) as DurableObjectStub<UserDO>;
  const reg = createAgentProviderRegistry({
    env: orchestrator.env,
    userDOStub,
    appTitle: 'Proteus (heads)',
  });

  const config = createAgentConfigStore(
    orchestrator.sql.bind(orchestrator) as unknown as import('@proteus/core').SqlExecutor,
  );
  const mergeLLM: MergeLLMFn = async (prompt, schema): Promise<MergeOutput> => {
    const stored = config.getModel();
    const model = reg.resolveModel(reg.normalizeSpecSync(stored));
    const { object } = await generateObject({
      model,
      schema: aiSchema<MergeOutput>(schema),
      prompt,
      maxOutputTokens: 4096,
      ...effortFor('head_merge'),
    });
    return object;
  };

  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const stub = await orchestrator.subAgent(ExplorationAgent, input.id);
      await stub.setOwner(ownerUserId);
      await stub.initHead(input);
      return {
        id: input.id,
        async run(): Promise<HeadReport> {
          return (await stub.runAsHead()) as HeadReport;
        },
        async abort(reason: string): Promise<void> {
          try { await stub.abortHead(reason); } catch { /* nop */ }
          try { await orchestrator.abortSubAgent(ExplorationAgent, input.id); } catch { /* nop */ }
        },
      };
    },
    mergeLLM,
  };
}
