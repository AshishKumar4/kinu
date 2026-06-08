import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import { runChat } from '@proteus/core';
import { createLocalModelResolver } from '@proteus/cli-backend';
import {
  commitCloudLocalTurn,
  invokeCloudLocalTool,
  prepareCloudLocalTurn,
  type CloudTurnResult,
} from './cloud-api.js';
import {
  createCodexAuthStore,
  resolveLLMConfig,
  resolveProviderCredentials,
} from './config.js';

export type CloudLocalTurnEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolName: string; result: string }
  | { type: 'step-finish'; stepIndex: number };

export async function runCloudTurnWithLocalModel(opts: {
  origin: string;
  token: string;
  name: string;
  prompt: string;
  cwd: string;
  onEvent?: (event: CloudLocalTurnEvent) => void;
}): Promise<CloudTurnResult> {
  const prepared = await prepareCloudLocalTurn(opts.origin, opts.token, opts.name, opts.prompt, opts.cwd);
  const llmConfig = resolveLLMConfig({ model: prepared.modelSpec ?? undefined });
  const resolver = createLocalModelResolver({
    llm: llmConfig,
    credentials: resolveProviderCredentials(),
    codexAuthStore: createCodexAuthStore(),
  });
  const modelSpec = resolver.normalizeSpecSync(prepared.modelSpec ?? null);
  const model = resolver.resolveModel(prepared.modelSpec ?? null);
  const tools = buildRemoteToolSet({
    origin: opts.origin,
    token: opts.token,
    name: opts.name,
    turnId: prepared.turnId,
    descriptors: prepared.tools,
  });

  const toolCalls: Array<{ name: string; args: unknown; result?: unknown }> = [];
  let text = '';
  let steps = 0;

  try {
    for await (const ev of runChat({
      model,
      modelContext: { id: modelSpec },
      system: prepared.system,
      history: asModelMessages(prepared.history),
      tools,
      maxSteps: prepared.maxSteps,
    })) {
      if (ev.type === 'text-delta') {
        text += ev.delta;
        opts.onEvent?.(ev);
      } else if (ev.type === 'tool-call') {
        toolCalls.push({ name: ev.toolName, args: ev.args });
        opts.onEvent?.(ev);
      } else if (ev.type === 'tool-result') {
        const last = [...toolCalls].reverse().find((t) => t.name === ev.toolName && t.result === undefined);
        if (last) last.result = ev.result;
        else toolCalls.push({ name: ev.toolName, args: {}, result: ev.result });
        opts.onEvent?.(ev);
      } else if (ev.type === 'step-finish') {
        steps = ev.stepIndex;
        opts.onEvent?.(ev);
      } else if (ev.type === 'done') {
        text = ev.text;
      }
    }

    return await commitCloudLocalTurn(opts.origin, opts.token, opts.name, {
      turnId: prepared.turnId,
      prompt: opts.prompt,
      text,
      toolCalls,
      steps,
      hadError: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await commitCloudLocalTurn(opts.origin, opts.token, opts.name, {
      turnId: prepared.turnId,
      prompt: opts.prompt,
      text,
      toolCalls,
      steps,
      hadError: true,
      error: message,
    }).catch(() => {});
    throw err;
  }
}

function buildRemoteToolSet(opts: {
  origin: string;
  token: string;
  name: string;
  turnId: string;
  descriptors: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}): ToolSet {
  const out: ToolSet = {};
  for (const descriptor of opts.descriptors) {
    out[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args: unknown) => {
        const result = await invokeCloudLocalTool(opts.origin, opts.token, opts.name, {
          turnId: opts.turnId,
          toolName: descriptor.name,
          args,
        });
        if (result.ok) return result.result;
        return { error: result.error ?? `Tool ${descriptor.name} failed.` };
      },
    });
  }
  return out;
}

function asModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ModelMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const role = item.role;
    const content = item.content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      out.push({ role, content });
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
