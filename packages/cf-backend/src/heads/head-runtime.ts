/**
 * CFHeadRuntime — concrete HeadRuntime for the branching-heads primitive.
 *
 * Heads run as ExplorationAgent Facets in head mode (initHead + runAsHead).
 * The same Facet class powers MCTS branches in MCTS mode; head mode is a
 * different ToolSet + a multi-step inference loop on top of the same
 * parallel-spawn infrastructure.
 */

import type {
  HeadRuntime, HeadGrounding, SpawnedHead, HeadInput, MergeLLMFn,
} from "@proteus/core";
import {
  type MergeOutput,
  MergeOutputSchema,
  createAgentConfigStore,
  parseModelSpec,
  reasoningEffortOptions,
} from "@proteus/core";
import type { Think } from "@cloudflare/think";
import { spawnHeadFacet } from "../facet-spawn.js";
import { createAgentProviderRegistry } from "../providers/agent-registry.js";
import { agentAffinityKey } from "@proteus/core";
import { generateJson } from "../lib/generate-json.js";
import type { UserDO } from "../user/user-do.js";

/** Agent surface this head runtime needs — `env` is protected on the DO base
 *  but the orchestrator (a subclass) passes `this` cast to this view. */
type HeadHost = Think<Env> & { readonly env: Env };

export function createCFHeadRuntime(
  orchestrator: HeadHost,
  ownerUserId: string,
  parentWorkspaceName: string,
  grounding?: HeadGrounding,
): HeadRuntime {
  // Auth flows through the orchestrator's owner UserDO stub. ownerUserId
  // is read once from workspace_identity by the orchestrator and threaded down.
  const userDOStub = orchestrator.env.UserDO.get(
    orchestrator.env.UserDO.idFromName(ownerUserId),
  ) as DurableObjectStub<UserDO>;
  const reg = createAgentProviderRegistry({
    env: orchestrator.env,
    userDOStub,
    appTitle: 'Proteus (heads)',
    workersAI: { sessionAffinity: agentAffinityKey(orchestrator.name) },
  });

  const config = createAgentConfigStore(
    orchestrator.sql.bind(orchestrator) as unknown as import('@proteus/core').SqlExecutor,
  );
  const mergeLLM: MergeLLMFn = async (prompt): Promise<MergeOutput> => {
    const stored = config.getModel();
    const spec = reg.normalizeSpecSync(stored);
    const model = reg.resolveModel(spec);
    const providerOptions = reasoningEffortOptions('low', parseModelSpec(spec).provider);
    return generateJson({
      model,
      schema: MergeOutputSchema,
      prompt,
      ...(providerOptions ? { providerOptions } : {}),
    });
  };

  return {
    spawnHead(input: HeadInput): Promise<SpawnedHead> {
      // Facet actors share their parent workspace's identity for UserDO/MCP
      // ownership. The spawning actor's facet name is not a registered
      // workspace and must never escape as caller identity.
      return spawnHeadFacet(orchestrator, input, {
        ownerUserId,
        sharedParent: parentWorkspaceName,
      });
    },
    mergeLLM,
    ...(grounding ? { grounding } : {}),
  };
}
