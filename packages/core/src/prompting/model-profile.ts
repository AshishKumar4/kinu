import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { specWithoutAccount } from '../providers/types';

export type PromptModelFamily = 'kimi' | 'gpt' | 'claude' | 'gemini' | 'muse' | 'generic';


export interface PromptModelContext {
  id?: string;
  provider?: string;
  /** Null when no catalog row names it. */
  contextWindow?: number | null;
  /** Largest answer out of that window; absent when the catalog has not answered, never the window itself. */
  modelOutputLimit?: number | null;
  /** Whether it takes image input, as its catalog row says; absent counts as taking it, as the transport does. */
  seesImages?: boolean;
  /** Whether it calls tools, as its catalog row says; absent when no row names it, which counts as calling them. */
  callsTools?: boolean | undefined;
}

export interface PromptModelProfile {
  family: PromptModelFamily;
}

function resolveFamily(model?: PromptModelContext): PromptModelFamily {
  const text = `${model?.provider ?? ''} ${specWithoutAccount(model?.id ?? '')}`.toLowerCase();

  if (text.includes('kimi')) return 'kimi';

  if (text.includes('muse')) return 'muse';

  if (text.includes('claude') || text.includes('anthropic')) return 'claude';

  if (text.includes('gemini')) return 'gemini';

  if (text.includes('gpt') || text.includes('codex') || text.includes('openai')) return 'gpt';

  return 'generic';
}

export function resolvePromptModelProfile(model?: PromptModelContext): PromptModelProfile {
  return { family: resolveFamily(model) };
}

/** Refuses tools only where the model's catalog row says it calls none; a model no row names is given the benefit. */
export function assertToolsSupportedByModel(model: PromptModelContext | undefined, toolNames: readonly string[]): void {
  if (toolNames.length === 0 || model?.callsTools !== false) return;
  const id = model?.id ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : 'selected model';

  return settleSync(Effect.die(new Error(`${id} does not support tool calling; choose a tool-capable model for agent mode.`)));
}
