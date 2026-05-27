/**
 * CFHeadRuntime — concrete HeadRuntime for the branching-heads primitive.
 *
 * Heads run as ExplorationAgent Facets in head mode (initHead + runAsHead).
 * The same Facet class powers MCTS branches in MCTS mode (explore + evaluate);
 * head mode is a different ToolSet + a multi-step inference loop on top of
 * the same parallel-spawn infrastructure.
 *
 * Constructed once per chat agent; passed into HeadController.
 */

import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  HeadRuntime, SpawnedHead, HeadInput, HeadReport, MergeLLMFn,
} from "@proteus/core";
import { MergeOutputSchema, type MergeOutput } from "@proteus/core";
import type { Think } from "@cloudflare/think";
import { ExplorationAgent } from "../exploration.js";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

function getModel(env: Env, modelId?: string): LanguageModel {
  const id = modelId ?? DEFAULT_MODEL;
  const e = env as Env & Record<string, string>;
  if (e.AI && typeof e.AI !== "string") {
    return createWorkersAI({ binding: e.AI })(id);
  }
  const compatId = id.startsWith("workers-ai/") ? id : `workers-ai/${id}`;
  return createOpenAICompatible({
    name: "workers-ai",
    baseURL: e.AI_GATEWAY_URL ?? "",
    headers: { Authorization: e.AI_GATEWAY_AUTH ?? "" },
  }).chatModel(compatId);
}

export function createCFHeadRuntime(orchestrator: Think<Env>): HeadRuntime {
  const mergeLLM: MergeLLMFn = async (prompt, schema): Promise<MergeOutput> => {
    const model = getModel(orchestrator.env);
    const { object } = await generateObject({
      model,
      schema: schema as typeof MergeOutputSchema,
      prompt,
      maxOutputTokens: 4096,
    });
    return object as MergeOutput;
  };

  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const stub = await orchestrator.subAgent(ExplorationAgent, input.id);
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
