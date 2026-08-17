/**
 * TurnContextMeter — what the request that produced a step was actually made of.
 *
 * The provider tells us the TOTALS and nothing else: `usage.inputTokens` is
 * authoritative and `usage.cachedInputTokens` says how much of it was a cache
 * read. No provider reports which parts of the prompt those tokens came from.
 * So the breakdown is measured HERE, locally, over the same arrays the request
 * was built from — and it is an estimate, structurally, forever.
 *
 * The two numbers therefore disagree, and this module is built so a reader can
 * see by how much rather than be told a reconciled fiction:
 *
 *   • every segment's `chars` is EXACT — a character count of the text that
 *     went out, not a guess
 *   • `charsPerToken` is carried on the measurement itself, so the estimate
 *     names its own divisor instead of hiding it
 *   • `estimatedTokens` is chars/divisor and nothing else — it is never scaled,
 *     normalised or fitted to the provider's total
 *
 * The consumer prints the provider's total, prints this, and prints the
 * residual between them. A breakdown massaged to sum to the API total would
 * read better and mean less.
 *
 * Tokenizers are per-model and per-provider; the divisor is a blend, not a
 * truth. Expect single-digit-percent disagreement on prose and worse on dense
 * JSON (tool schemas, tool results), which tokenizes denser than 4 chars/token.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import * as v from 'valibot';
import { CHARS_PER_TOKEN } from './llm.js';
import { DYNAMIC_CONTEXT_OPEN_TAG, splitPromptSections } from './prompting/sections.js';

/** The four planes that fill a request. Kept coarse on purpose: these are the
 *  four things an operator can actually act on (trim the prompt, drop a tool,
 *  compact the history, shrink the live-state block). */
export type ContextPlane = 'system' | 'tools' | 'messages' | 'ephemeral';

/** One measured row of the composition. */
export interface ContextSegment {
  readonly plane: ContextPlane;
  /** A prompt section heading, a tool name, or a message role. */
  readonly label: string;
  /** Exact character count of what went out under this label. */
  readonly chars: number;
  /** Items folded into this row — messages of a role, always 1 for a tool or
   *  a prompt section. */
  readonly items: number;
}

/** What one step's request was made of, measured locally. */
export interface ContextComposition {
  readonly segments: readonly ContextSegment[];
  /** Sum of every segment's chars. Exact. */
  readonly measuredChars: number;
  /** The divisor behind `estimatedTokens`, carried so the estimate is
   *  auditable rather than authoritative-looking. */
  readonly charsPerToken: number;
  /** measuredChars / charsPerToken. An ESTIMATE — the provider's own
   *  inputTokens is the authority and the two will not agree. */
  readonly estimatedTokens: number;
}

/** The minimal shape of a tool definition that reaches the wire. Structural
 *  rather than the AI SDK's `ToolSet` so the meter stays a leaf. */
export type ToolDefsLike = Readonly<Record<string, { description?: string; inputSchema?: unknown } | undefined>>;

/** The system channel as each backend holds it: Think's TurnConfig is
 *  string-typed, the CLI's cache plan carries a SystemModelMessage. */
export type SystemText = string | SystemModelMessage | undefined;

function systemText(system: SystemText): string {
  if (system === undefined) return '';
  const text = v.safeParse(v.string(), system);
  return text.success ? text.output : v.parse(v.object({ content: v.string() }), system).content;
}

/** Characters one message contributes. A string content is its own length;
 *  structured content is measured as the JSON it is serialised to on the way
 *  out, which is what the provider tokenizes — so a content this cannot
 *  serialise is a content the request itself cannot carry, and measuring it as
 *  zero would report a full context as an empty one. */
function messageChars(message: ModelMessage): number {
  const content = message.content;
  const text = v.safeParse(v.string(), content);
  if (text.success) return text.output.length;
  return JSON.stringify(content)?.length ?? 0;
}

/** True for the ephemeral live-state blocks the step pipeline weaves in. They
 *  ride as user messages but are not conversation, and an operator reading a
 *  context breakdown needs them separated from what the user actually said. */
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
  } catch {
    schema = 0;
  }
  return name.length + (def.description?.length ?? 0) + schema;
}

/**
 * Measure one composed request.
 *
 * `system` and `tools` are per-turn constants; `messages` is the per-step
 * array. Segments come out in wire order — system sections, then tools, then
 * the message planes — so the rendered breakdown reads like the request.
 */
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

  // Roles fold together — a per-message row would be unbounded, and "what is
  // my history costing me" is a per-role question. Ephemeral blocks are pulled
  // out of `user` because they are runtime state, not conversation.
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

/**
 * The turn's meter. Owned by the TurnAccumulator next to the other per-turn
 * accounting, written by the step pipeline (the one place that holds the final
 * composed array), and drained at `step_finish` so the measurement is paired
 * with the usage of the very request it measured.
 */
export class TurnContextMeter {
  private system: SystemText;
  private tools: ToolDefsLike | undefined;
  private latest: ContextComposition | undefined;

  /** Turn assembly hands over the per-turn constants. Tool definitions ride
   *  every request of the turn and are a large, otherwise invisible share of
   *  it, so they are measured rather than assumed small. */
  openTurn(input: { system?: SystemText; tools?: ToolDefsLike | undefined }): void {
    this.system = input.system;
    this.tools = input.tools;
    this.latest = undefined;
  }

  /** Measure the final message array for one step. */
  measure(messages: readonly ModelMessage[]): void {
    this.latest = measureContext({ system: this.system, tools: this.tools, messages });
  }

  /** The newest measurement, consumed. Undefined when the step ran without one
   *  (no pipeline, or a backend that never opened the turn) — the caller then
   *  reports no breakdown rather than an empty one, which would read as "the
   *  request was empty". */
  take(): ContextComposition | undefined {
    const latest = this.latest;
    this.latest = undefined;
    return latest;
  }

  reset(): void {
    this.system = undefined;
    this.tools = undefined;
    this.latest = undefined;
  }
}
