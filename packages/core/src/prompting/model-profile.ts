import type { ModelCapability } from '../providers/types';

export type PromptModelFamily = 'kimi' | 'gpt' | 'generic';

/** Same vocabulary as the provider catalogs — one capability taxonomy. */
export type PromptModelCapability = ModelCapability;

export interface PromptModelContext {
  id?: string;
  provider?: string;
  family?: PromptModelFamily;
  reasoning?: boolean;
  capabilities?: readonly string[];
  contextWindow?: number;
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
/** Shared by the reasoning-era Kimi line (k2.6, k2.7-code, k3): all report
 *  tools + reasoning + image input + a cached-input rate. */
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
  if (text.includes('gpt') || text.includes('codex') || text.includes('openai')) return 'gpt';
  return 'generic';
}

function inferredCapabilities(model: PromptModelContext | undefined, family: PromptModelFamily): PromptModelCapability[] {
  // Catalog-reported capabilities (ModelInfo.capabilities) are authoritative.
  if (model?.capabilities?.length) {
    const out = model.capabilities.map(normalizeCapability).filter((c): c is PromptModelCapability => !!c);
    if (model.reasoning && !out.includes('reasoning')) out.push('reasoning');
    return out;
  }
  // Last-resort id-substring heuristics for callers that pass only a model id.
  const text = `${model?.provider ?? ''} ${model?.id ?? ''}`.toLowerCase();
  if (text.includes('o4-mini') || text.includes('deepseek-r1')) {
    return ['streaming', 'reasoning'];
  }
  // Whole family, not one pinned version — a new Kimi release must not silently
  // drop to bare tools+streaming when the catalog is unreachable.
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
