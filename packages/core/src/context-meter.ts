/**
 * Locally measured composition of a step's request; providers report only totals.
 * Chars are exact; token counts are chars/divisor, never fitted to the provider's total.
 */

import { asSchema, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai';
import * as v from 'valibot';
import { CHARS_PER_TOKEN } from './token-estimate';
import { JsonObjectSchema } from './utils/json';
import { Effect } from 'effect';
import { diagnostics, renderThrownChain, settleSync } from './obs/index';
import { DYNAMIC_CONTEXT_OPEN_TAG, splitPromptSections } from './utils/prompt-sections';

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
export type ToolDefsLike = Readonly<Record<string, Partial<Pick<ToolSet[string], 'description' | 'inputSchema'>> | undefined>>;

export type SystemText = string | SystemModelMessage | undefined;

function systemText(system: SystemText): string {
  if (system === undefined) return '';
  const text = v.safeParse(v.string(), system);

  return text.success ? text.output : v.parse(v.object({ content: v.string() }), system).content;
}

/** Frozen messages and a turn's schemas are measured once. */
const MEASURED = new WeakMap<object, number>();

/** Structured content is measured as the JSON the provider tokenizes; unguarded so it never reads as zero. */
function messageChars(message: ModelMessage): number {
  const held = MEASURED.get(message);

  if (held !== undefined) return held;
  const chars = typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content)?.length ?? 0;
  MEASURED.set(message, chars);

  return chars;
}

/** Live-state blocks ride as user messages but are not conversation. */
function isEphemeral(message: ModelMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(DYNAMIC_CONTEXT_OPEN_TAG);
}

/** Counted as the JSON Schema the provider is sent. */
function toolChars(name: string, def: ToolDefsLike[string]): Effect.Effect<number, never> {
  if (!def) return Effect.succeed(0);

  return Effect.map(schemaChars(def), (schema) => name.length + (def.description?.length ?? 0) + schema);
}

function schemaChars(def: NonNullable<ToolDefsLike[string]>): Effect.Effect<number, never> {
  const held = def.inputSchema === undefined ? undefined : MEASURED.get(def.inputSchema);

  if (held !== undefined) return Effect.succeed(held);

  return Effect.try({
    try: () => {
      const sent = def.inputSchema === undefined ? undefined : v.safeParse(JsonObjectSchema, asSchema(def.inputSchema).jsonSchema);

      if (sent?.success === false) diagnostics.event('context_meter.schema_unmeasurable', { error: 'its JSON Schema is not ready synchronously' });

      if (sent?.success !== true) return 0;
      const chars = JSON.stringify(sent.output).length;

      if (def.inputSchema !== undefined) MEASURED.set(def.inputSchema, chars);

      return chars;
    },
    catch: (cause) => ({ cause }),
  }).pipe(Effect.catch((thrown) => {
    diagnostics.event('context_meter.schema_unmeasurable', { error: renderThrownChain(thrown) });

    return Effect.succeed(0);
  }));
}

/** Segments come out in wire order: system sections, tools, then message planes. */
export function measureContext(input: {
  system?: SystemText;
  tools?: ToolDefsLike | undefined;
  messages: readonly ModelMessage[];
}): ContextComposition {
  return settleSync(Effect.map(toolSegments(input.tools ?? {}), (toolRows) => composition(input, toolRows)));
}

function toolSegments(tools: ToolDefsLike): Effect.Effect<ContextSegment[], never> {
  return Effect.map(
    Effect.all(Object.entries(tools).map(([name, def]) => Effect.map(toolChars(name, def), (chars): ContextSegment => ({ plane: 'tools', label: name, chars, items: 1 })))),
    (rows) => rows.filter((row) => row.chars > 0),
  );
}

function composition(input: Parameters<typeof measureContext>[0], toolRows: readonly ContextSegment[]): ContextComposition {
  const segments: ContextSegment[] = [];

  for (const section of splitPromptSections(systemText(input.system))) {
    segments.push({ plane: 'system', label: section.title, chars: section.chars, items: 1 });
  }

  segments.push(...toolRows);

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

/** What a turn fixes before its first request. */
interface TurnConstants {
  readonly system?: SystemText;
  readonly tools?: ToolDefsLike | undefined;
}

/** One per turn, made by `runChat`: the step pipeline writes it and each `step-finish` event drains it, pairing a
 *  measurement with its request's usage. */
export class TurnContextMeter {
  private readonly turn: TurnConstants;
  private latest: ContextComposition | undefined;

  constructor(turn: TurnConstants) {
    this.turn = turn;
  }

  measure(messages: readonly ModelMessage[]): void {
    this.latest = measureContext({ ...this.turn, messages });
  }

  /** Undefined when nothing measured the step; callers report no breakdown rather than an empty one. */
  take(): ContextComposition | undefined {
    const latest = this.latest;
    this.latest = undefined;

    return latest;
  }
}
