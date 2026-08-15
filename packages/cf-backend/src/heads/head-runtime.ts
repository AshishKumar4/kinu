/**
 * CFHeadRuntime — concrete HeadRuntime for the branching-heads primitive.
 *
 * Heads run as ExplorationAgent Facets in head mode (initHead + runAsHead).
 * The same Facet class powers MCTS branches in MCTS mode; head mode is a
 * different ToolSet + a multi-step inference loop on top of the same
 * parallel-spawn infrastructure.
 */

import type {
  HeadRuntime, HeadGrounding, SpawnedHead, HeadInput, MergeLLMFn, SqlExecutor,
} from "@proteus/core";
import {
  generateJson,
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
import type { UserDO } from "../user/user-do.js";
import type { UserCaller } from "../user/workspace-capability.js";

type HeadHost = Think<Env>;

export function createCFHeadRuntime(
  orchestrator: HeadHost,
  env: Env,
  sql: SqlExecutor,
  ownerUserId: string,
  capabilityToken: () => Promise<string | null>,
  parentWorkspaceName: string,
  grounding?: HeadGrounding,
): HeadRuntime {
  // Auth flows through the orchestrator's owner UserDO stub. ownerUserId
  // is read once from workspace_identity by the orchestrator and threaded down,
  // as is the workspace capability token every privileged call presents.
  // SAFETY: Env.UserDO is generated from the UserDO binding, whose stubs implement UserDO RPC methods.
  const userDOStub = env.UserDO.get(env.UserDO.idFromName(ownerUserId)) as DurableObjectStub<UserDO>;
  const caller = async (): Promise<UserCaller> => {
    const workspaceToken = await capabilityToken();
    if (!workspaceToken) throw new Error('This workspace has not been issued a capability token yet.');
    return { workspaceToken };
  };
  const reg = createAgentProviderRegistry({
    env,
    userDO: { stub: userDOStub, caller },
    appTitle: 'Proteus (heads)',
    workersAI: { sessionAffinity: agentAffinityKey(orchestrator.name) },
  });

  const config = createAgentConfigStore(sql);
  const mergeLLM: MergeLLMFn = async (prompt): Promise<MergeOutput> => {
    const stored = config.getModel();
    const spec = reg.normalizeSpecSync(stored);
    const model = reg.resolveModel(spec);
    const providerOptions = reasoningEffortOptions('low', parseModelSpec(spec).provider);
    return providerOptions
      ? generateJson({ model, schema: MergeOutputSchema, prompt, providerOptions })
      : generateJson({ model, schema: MergeOutputSchema, prompt });
  };

  const runtime: HeadRuntime = {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      // Facet actors share their parent workspace's identity for UserDO/MCP
      // ownership. The spawning actor's facet name is not a registered
      // workspace and must never escape as caller identity.
      return spawnHeadFacet(orchestrator, input, {
        ownerUserId,
        capabilityToken: await capabilityToken(),
        sharedParent: parentWorkspaceName,
      });
    },
    mergeLLM,
  };
  if (grounding) runtime.grounding = grounding;
  return runtime;
}
