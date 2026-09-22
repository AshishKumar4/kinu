import type { ModelCapability } from '../providers/types';

export type PromptModelFamily = 'kimi' | 'gpt' | 'claude' | 'gemini' | 'generic';

export type PromptModelCapability = ModelCapability;

export interface PromptModelContext {
  id?: string;
  provider?: string;
  family?: PromptModelFamily;
  reasoning?: boolean;
  capabilities?: readonly string[];
  contextWindow?: number;
  /** Whether `contextWindow` was measured for this model rather than a stand-in. */
  windowMeasured?: boolean;
  /** Largest answer out of that window; absent when the catalog has not answered, never the window itself. */
  modelOutputLimit?: number | null;
}

export interface PromptModelProfile {
  id?: string;
  provider?: string;
  family: PromptModelFamily;
  capabilities: ReadonlySet<PromptModelCapability>;
  contextWindow?: number;
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

function normalizeCapability(raw: string): PromptModelCapability | null {
  switch (raw) {
    case 'tools':
    case 'vision':
    case 'reasoning':
    case 'json-mode':
    case 'streaming':
      return raw;
    case 'structured-output':
    case 'structured-outputs':
      return 'structured-outputs';
    case 'computer-use':
    case 'computer_use':
      return 'computer-use';
    case 'prompt-cache':
    case 'prompt-caching':
      return 'prompt-caching';
    default:
      return null;
  }
}

function resolveFamily(model?: PromptModelContext): PromptModelFamily {
  if (model?.family) return model.family;
  const text = `${model?.provider ?? ''} ${model?.id ?? ''}`.toLowerCase();

  if (text.includes('kimi')) return 'kimi';

  if (text.includes('claude') || text.includes('anthropic')) return 'claude';

  if (text.includes('gemini')) return 'gemini';

  if (text.includes('gpt') || text.includes('codex') || text.includes('openai')) return 'gpt';

  return 'generic';
}

function inferredCapabilities(model: PromptModelContext | undefined, family: PromptModelFamily): PromptModelCapability[] {
  if (model?.capabilities?.length) {
    const out = model.capabilities.map(normalizeCapability).filter((c): c is PromptModelCapability => c !== null);

    if (model.reasoning && !out.includes('reasoning')) out.push('reasoning');

    return out;
  }

  const text = `${model?.provider ?? ''} ${model?.id ?? ''}`.toLowerCase();

  if (text.includes('o4-mini') || text.includes('deepseek-r1')) {
    return ['streaming', 'reasoning'];
  }

  // Whole family: a new Kimi release must not drop to bare tools+streaming when the catalog is unreachable.
  if (family === 'kimi') return KIMI_CAPABILITIES;

  if (family === 'gpt') return GPT_REASONING_CAPABILITIES;

  return TOOL_CAPABILITIES;
}

export function resolvePromptModelProfile(model?: PromptModelContext): PromptModelProfile {
  const family = resolveFamily(model);

  return {
    id: model?.id,
    provider: model?.provider,
    family,
    capabilities: new Set(inferredCapabilities(model, family)),
    contextWindow: model?.contextWindow,
  };
}

export function modelSupportsTools(model?: PromptModelContext): boolean {
  return resolvePromptModelProfile(model).capabilities.has('tools');
}

export function assertToolsSupportedByModel(model: PromptModelContext | undefined, toolNames: readonly string[]): void {
  if (toolNames.length === 0 || modelSupportsTools(model)) return;
  const id = model?.id ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : 'selected model';
  throw new Error(`${id} does not support tool calling; choose a tool-capable model for agent mode.`);
}
