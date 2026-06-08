import { contextWindowForModel } from '@proteus/core';

export interface TextForContextEstimate {
  content: string;
}

export function modelDisplayName(spec: string | null | undefined): string {
  const raw = (spec ?? '').trim();
  if (!raw) return 'default';
  const modelId = stripKnownProvider(raw);
  const leaf = modelId.startsWith('@cf/') ? modelId.split('/').at(-1) ?? modelId : modelId;
  return leaf
    .replace(/^gpt-/, 'GPT-')
    .replace(/^kimi-k2/i, 'Kimi K2')
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function estimateContextTokens(messages: readonly TextForContextEstimate[], streamingText: string | null): number {
  const chars = messages.reduce((sum, msg) => sum + msg.content.length, 0) + (streamingText?.length ?? 0);
  return Math.max(0, Math.ceil(chars / 4));
}

export function formatContextUsage(modelSpec: string | null | undefined, usedTokens: number, reportedContextWindow?: number): string {
  const window = reportedContextWindow ?? contextWindowForModel(modelSpec ?? '');
  return `ctx ~${formatTokenCount(usedTokens)}/${formatTokenCount(window)}`;
}

function stripKnownProvider(spec: string): string {
  const known = ['workers-ai/', 'codex/', 'openai/', 'anthropic/', 'openrouter/', 'openai-compat/', 'ai-gateway/'];
  for (const prefix of known) {
    if (spec.startsWith(prefix)) return spec.slice(prefix.length);
  }
  return spec;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`;
  return String(tokens);
}

function trimFixed(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}
