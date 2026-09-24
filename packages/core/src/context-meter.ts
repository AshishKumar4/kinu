/**
 * Locally measured composition of a step's request; providers report only totals.
 * Chars are exact; token counts are chars/divisor, never fitted to the provider's total.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import * as v from 'valibot';
import { CHARS_PER_TOKEN } from './llm';
import { diagnostics, renderThrownChain } from './obs/index';
import { DYNAMIC_CONTEXT_OPEN_TAG, splitPromptSections } from './prompting/sections';

/** Coarse on purpose: the four things an operator can act on. */
export type ContextPlane = 'system' | 'tools' | 'messages' | 'ephemeral';

export interface ContextSegment {
  readonly plane: ContextPlane;
  readonly label: string;
  readonly chars: number;
  readonly items: number;
}

export interface ContextComposition {
  readonly segments: readonly ContextSegment[];
  readonly measuredChars: number;
  readonly charsPerToken: number;
  /** An estimate; the provider's inputTokens is the authority. */
  readonly estimatedTokens: number;
}

/** Structural rather than the AI SDK's `ToolSet` so the meter stays a leaf. */
export type ToolDefsLike = Readonly<Record<string, { description?: string; inputSchema?: unknown } | undefined>>;

export type SystemText = string | SystemModelMessage | undefined;

function systemText(system: SystemText): string {
  if (system === undefined) return '';
  const text = v.safeParse(v.string(), system);

  return text.success ? text.output : v.parse(v.object({ content: v.string() }), system).content;
}

/** Structured content is measured as the JSON the provider tokenizes; unguarded so it never reads as zero. */
function messageChars(message: ModelMessage): number {
  const content = message.content;
  const text = v.safeParse(v.string(), content);

  if (text.success) return text.output.length;

  return JSON.stringify(content)?.length ?? 0;
}

/** Live-state blocks ride as user messages but are not conversation. */
function isEphemeral(message: ModelMessage): boolean {
  const content = v.safeParse(v.string(), message.content);

  return message.role === 'user'
    && content.success
    && content.output.startsWith(DYNAMIC_CONTEXT_OPEN_TAG);
}

function toolChars(name: string, def: { description?: string; inputSchema?: unknown } | undefined): number {
  if (!def) return 0;
  let schema = 0;

  try {
    schema = def.inputSchema === undefined ? 0 : (JSON.stringify(def.inputSchema)?.length ?? 0);
  } catch (error) {
    diagnostics.event('context_meter.schema_unmeasurable', { error: renderThrownChain({ cause: error }) });
  }

  return name.length + (def.description?.length ?? 0) + schema;
}

/** Segments come out in wire order: system sections, tools, then message planes. */
export function measureContext(input: {
  system?: SystemText;
  tools?: ToolDefsLike | undefined;
  messages: readonly ModelMessage[];
}): ContextComposition {
  const segments: ContextSegment[] = [];

  for (const section of splitPromptSections(systemText(input.system))) {
    segments.push({ plane: 'system', label: section.title, chars: section.chars, items: 1 });
  }

  for (const [name, def] of Object.entries(input.tools ?? {})) {
    const chars = toolChars(name, def);

    if (chars > 0) segments.push({ plane: 'tools', label: name, chars, items: 1 });
  }

  // Fold per role: a per-message row would be unbounded.
  const roles = new Map<string, { chars: number; items: number }>();
  let ephemeralChars = 0;
  let ephemeralItems = 0;

  for (const message of input.messages) {
    const chars = messageChars(message);

    if (isEphemeral(message)) {
      ephemeralChars += chars;
      ephemeralItems++;
      continue;
    }

    const row = roles.get(message.role) ?? { chars: 0, items: 0 };
    row.chars += chars;
    row.items++;
    roles.set(message.role, row);
  }

  for (const [role, row] of roles) {
    segments.push({ plane: 'messages', label: role, chars: row.chars, items: row.items });
  }

  if (ephemeralItems > 0) {
    segments.push({ plane: 'ephemeral', label: 'dynamic_context', chars: ephemeralChars, items: ephemeralItems });
  }

  const measuredChars = segments.reduce((sum, s) => sum + s.chars, 0);

  return {
    segments,
    measuredChars,
    charsPerToken: CHARS_PER_TOKEN,
    estimatedTokens: Math.ceil(measuredChars / CHARS_PER_TOKEN),
  };
}

/** Written by the step pipeline and drained at `step_finish`, pairing each measurement with its request's usage. */
export class TurnContextMeter {
  private system: SystemText;
  private tools: ToolDefsLike | undefined;
  private latest: ContextComposition | undefined;

  openTurn(input: { system?: SystemText; tools?: ToolDefsLike | undefined }): void {
    this.system = input.system;
    this.tools = input.tools;
    this.latest = undefined;
  }

  measure(messages: readonly ModelMessage[]): void {
    this.latest = measureContext({ system: this.system, tools: this.tools, messages });
  }

  /** Undefined when nothing measured the step; callers report no breakdown rather than an empty one. */
  take(): ContextComposition | undefined {
    const latest = this.latest;
    this.latest = undefined;

    return latest;
  }
}
