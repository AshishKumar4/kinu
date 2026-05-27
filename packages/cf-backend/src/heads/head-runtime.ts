/**
 * CFHeadRuntime — concrete HeadRuntime that spawns Facets and runs the
 * merge LLM via Workers AI / AI Gateway.
 *
 * The orchestrator constructs this once and passes it into HeadController.
 * Each split:
 *   • spawnHead(input) → subAgent(HeadAgent, input.id) → stub.init(input)
 *     → returns SpawnedHead with run() = stub.run() and abort() = stub.abort()
 *   • mergeLLM(prompt, schema) → generateObject with the Zod merge schema
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
import { HeadAgent } from "./head-agent.js";

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
      // Facet stubs are obtained via subAgent(Class, name) on the parent agent.
      const stub = await orchestrator.subAgent(HeadAgent, input.id);
      await stub.init(input);
      return {
        id: input.id,
        async run(): Promise<HeadReport> {
          return (await stub.run()) as HeadReport;
        },
        async abort(reason: string): Promise<void> {
          try {
            await stub.abort(reason);
          } catch {
            // best-effort
          }
          try {
            await orchestrator.abortSubAgent(HeadAgent, input.id);
          } catch {
            // best-effort
          }
        },
      };
    },
    mergeLLM,
  };
}
