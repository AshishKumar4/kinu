import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { specWithoutAccount, type ModelCapability } from '../providers/types';

export type PromptModelFamily = 'kimi' | 'gpt' | 'claude' | 'gemini' | 'muse' | 'generic';

export type PromptModelCapability = ModelCapability;

export interface PromptModelContext {
  id?: string;
  provider?: string;
  /** Null when no catalog row names it. */
  contextWindow?: number | null;
  /** Largest answer out of that window; absent when the catalog has not answered, never the window itself. */
  modelOutputLimit?: number | null;
}

export interface PromptModelProfile {
  family: PromptModelFamily;
  capabilities: ReadonlySet<PromptModelCapability>;
}

const TOOL_CAPABILITIES: PromptModelCapability[] = ['tools', 'streaming'];

const GPT_REASONING_CAPABILITIES: PromptModelCapability[] = [
  'tools',
  'streaming',
  'reasoning',
  'vision',
  'structured-outputs',
  'json-mode',
];

const KIMI_CAPABILITIES: PromptModelCapability[] = [
  'tools',
  'streaming',
  'reasoning',
  'vision',
  'structured-outputs',
  'prompt-caching',
];

function resolveFamily(model?: PromptModelContext): PromptModelFamily {
  const text = `${model?.provider ?? ''} ${specWithoutAccount(model?.id ?? '')}`.toLowerCase();

  if (text.includes('kimi')) return 'kimi';

  if (text.includes('muse')) return 'muse';

  if (text.includes('claude') || text.includes('anthropic')) return 'claude';

  if (text.includes('gemini')) return 'gemini';

  if (text.includes('gpt') || text.includes('codex') || text.includes('openai')) return 'gpt';

  return 'generic';
}

function inferredCapabilities(model: PromptModelContext | undefined, family: PromptModelFamily): PromptModelCapability[] {
  const text = `${model?.provider ?? ''} ${model?.id ?? ''}`.toLowerCase();

  if (text.includes('o4-mini') || text.includes('deepseek-r1')) {
    return ['streaming', 'reasoning'];
  }

  // Whole family: a new Kimi release must not drop to bare tools+streaming.
  if (family === 'kimi') return KIMI_CAPABILITIES;

  if (family === 'gpt') return GPT_REASONING_CAPABILITIES;

  return TOOL_CAPABILITIES;
}

export function resolvePromptModelProfile(model?: PromptModelContext): PromptModelProfile {
  const family = resolveFamily(model);

  return { family, capabilities: new Set(inferredCapabilities(model, family)) };
}

function modelSupportsTools(model?: PromptModelContext): boolean {
  return resolvePromptModelProfile(model).capabilities.has('tools');
}

export function assertToolsSupportedByModel(model: PromptModelContext | undefined, toolNames: readonly string[]): void {
  if (toolNames.length === 0 || modelSupportsTools(model)) return;
  const id = model?.id ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : 'selected model';

  return settleSync(Effect.die(new Error(`${id} does not support tool calling; choose a tool-capable model for agent mode.`)));
}
