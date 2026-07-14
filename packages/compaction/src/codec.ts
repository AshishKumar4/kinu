/**
 * Proteus codec — AI SDK v6 `ModelMessage[]` ⇄ ladder `Turn[]`.
 *
 * Items are views with handles: every encoded item carries its native payload
 * (a content part, or the whole message for string-content/unknown shapes)
 * and decode re-emits untouched payloads VERBATIM — the same object
 * references, so unpruned history round-trips byte-identically and provider
 * options / vendor extensions survive without being modeled. Only what the
 * ladder changed is synthesized.
 *
 * Tool pairing is this codec's job: an assistant `tool-call` part and its
 * `tool-result` (a following `role:'tool'` message's part, or an inline
 * provider-executed result in the same assistant content) become ONE IR tool
 * item, so when the ladder drops it the full native footprint disappears —
 * the call part, the result part, and the carrier tool message if emptied.
 *
 * Identity is id-less (Proteus ModelMessages carry no ids): content-hash keys
 * with occurrence ordinals, stable across requests because durable history is
 * append-only. The turn stamp is derived from the deduped key — stamps feed
 * `assistantRunKey` (`role:stamp` seeds), so they must be content-derived and
 * distinct per turn or every equal-length assistant run would share one
 * summary key.
 */

import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
} from 'ai';
import { fnv1a64 } from '@proteus/core';
import {
  assistantRunsStage,
  contentHashKey,
  keyDeduper,
  reasoningStage,
  skillsStage,
  toolsOldStage,
  toolsRemainingStage,
  truncate,
  type Codec,
  type Conventions,
  type Item,
  type LadderSpec,
  type Turn,
} from '@better-compact/core';

type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];
type ToolMessagePart = ToolModelMessage['content'][number];

/** One IR tool item owns the call part and its paired result: when the ladder
 *  drops the item, every native footprint vanishes; when it survives, each
 *  part re-emits verbatim at its original position. */
export interface ToolPairHandle {
  call: ToolCallPart;
  /** Provider-executed result inline in the same assistant content. */
  inlineResult?: ToolResultPart;
  /** Result delivered by a following `role:'tool'` message. */
  result?: ToolResultPart;
}

type ToolItem = Extract<Item, { kind: 'tool' }>;

/** Images/files are priced flat: providers charge by media dimensions, not
 *  payload bytes, and a base64 blob would wildly overprice. Same scale as the
 *  pi adapter's image estimate (~1200 tokens). */
const ESTIMATED_MEDIA_CHARS = 4_800;
const TRANSCRIPT_PREVIEW_CHARS = 20_000;

export const proteusCodec: Codec<ModelMessage> = {
  encode(messages) {
    const claimKey = keyDeduper();
    return groupMessages(messages).map((group) => encodeGroup(group, claimKey));
  },

  decode(turns, _messages) {
    return turns.flatMap(decodeTurn);
  },

  // Chars/4 over the content Proteus actually serializes for the model —
  // the shared estimation scale (vendored countTokens); the engine's
  // measured provider-overhead delta corrects for what chars cannot see.
  estimateTurns(turns) {
    const chars = turns.reduce(
      (sum, turn) => sum + turn.items.reduce((acc, item) => acc + charsOfItem(item), 0),
      0,
    );
    return Math.max(0, Math.round(chars / 4));
  },

  estimateItem(item) {
    return Math.max(0, Math.round(charsOfPair(pairOf(item)) / 4));
  },

  transcriptLine(item) {
    if (item.kind === 'synthetic') return item.text;
    if (item.kind === 'text') return item.text;
    if (item.kind === 'reasoning') return `[reasoning]\n${reasoningText(item.handle)}`;
    if (item.kind === 'tool') return formatToolPair(pairOf(item));
    return formatOpaque(item.handle);
  },

  // Whole-document override: raw JSON of each turn's native messages (binary
  // payloads flattened to size placeholders), so the reference transcript is
  // a lossless read-back surface — the agent recovers EXACT prior text and
  // tool output instead of a preview.
  transcriptDocument(turns) {
    const blocks = turns.map((turn) => {
      const native = turn.handle ?? { role: turn.role, content: syntheticText(turn.items) };
      return [
        `## ${turn.role.toUpperCase()} ${turn.key}`,
        '```json',
        JSON.stringify(native, binaryReplacer, 2),
        '```',
      ].join('\n');
    });
    return `# Proteus Compaction Raw Transcript\n\n${blocks.join('\n\n')}\n`;
  },
};

export const proteusConventions: Conventions = {
  // Skill bodies enter history as `skills` tool read/invoke outputs (active
  // skills render in the system prefix, outside messages). Those loaded
  // bodies are re-readable on demand, so the skills stage prunes them first.
  isSkillItem: (item) =>
    item.kind === 'tool' && isSkillBodyLoad(pairOf(item).call),
  // No in-band todo surface (task state lives in the jobs subsystem, outside
  // messages) and no per-item notes — those conventions are simply absent,
  // so the stages that would need them find nothing to act on.
};

export const proteusSpec: LadderSpec = {
  codec: proteusCodec,
  conventions: proteusConventions,
  stages: [skillsStage, toolsOldStage, reasoningStage, toolsRemainingStage, assistantRunsStage],
};

// ── encode ────────────────────────────────────────────────────────────────

/** A Turn is one user message, or one assistant message plus the `tool`
 *  messages that answer it. Non-user messages with no preceding assistant
 *  (headless tool results, stray system messages) form their own run. */
function groupMessages(messages: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  let run: ModelMessage[] | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      groups.push([message]);
      run = null;
    } else if (message.role === 'assistant' || run === null) {
      run = [message];
      groups.push(run);
    } else {
      run.push(message);
    }
  }
  return groups;
}

function encodeGroup(group: ModelMessage[], claimKey: (base: string) => string): Turn {
  const first = group[0];
  const key = claimKey(contentHashKey(group));
  const items: Item[] = [];
  const pendingCalls = new Map<string, ToolPairHandle>();

  for (const message of group) {
    if (message.role === 'assistant') {
      encodeAssistant(message, key, items, pendingCalls);
    } else if (message.role === 'user') {
      if (typeof message.content === 'string') {
        items.push({ kind: 'text', key: `${key}#${items.length}`, text: message.content, handle: message });
      } else {
        for (const part of message.content) {
          items.push(
            part.type === 'text'
              ? { kind: 'text', key: `${key}#${items.length}`, text: part.text, handle: part }
              : { kind: 'opaque', key: `${key}#${items.length}`, handle: part },
          );
        }
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result' && bindResult(pendingCalls, part)) continue;
        items.push({ kind: 'opaque', key: `${key}#${items.length}`, handle: part });
      }
    } else {
      items.push({ kind: 'opaque', key: `${key}#${items.length}`, handle: message });
    }
  }

  return {
    key,
    stamp: stampOf(key),
    role: first.role === 'user' ? 'user' : 'assistant',
    items,
    handle: group,
  };
}

function encodeAssistant(
  message: AssistantModelMessage,
  turnKey: string,
  items: Item[],
  pendingCalls: Map<string, ToolPairHandle>,
): void {
  if (typeof message.content === 'string') {
    items.push({ kind: 'text', key: `${turnKey}#${items.length}`, text: message.content, handle: message });
    return;
  }
  for (const part of message.content) {
    if (part.type === 'text') {
      items.push({ kind: 'text', key: `${turnKey}#${items.length}`, text: part.text, handle: part });
    } else if (part.type === 'reasoning') {
      items.push({ kind: 'reasoning', key: `${turnKey}#${items.length}`, handle: part });
    } else if (part.type === 'tool-call') {
      const pair: ToolPairHandle = { call: part };
      pendingCalls.set(part.toolCallId, pair);
      items.push({ kind: 'tool', key: `${turnKey}#${items.length}`, callId: part.toolCallId, handle: pair });
    } else if (part.type === 'tool-result') {
      const pair = pendingCalls.get(part.toolCallId);
      if (pair && !pair.inlineResult && !pair.result) {
        pair.inlineResult = part;
      } else {
        items.push({ kind: 'opaque', key: `${turnKey}#${items.length}`, handle: part });
      }
    } else {
      items.push({ kind: 'opaque', key: `${turnKey}#${items.length}`, handle: part });
    }
  }
}

function bindResult(pendingCalls: Map<string, ToolPairHandle>, result: ToolResultPart): boolean {
  const pair = pendingCalls.get(result.toolCallId);
  if (!pair || pair.result || pair.inlineResult) return false;
  pair.result = result;
  return true;
}

/** Content-derived numeric stamp (48 bits of the key's hash). Ladder range
 *  hashes fold edit-sensitivity into the content-hash key itself; the stamp
 *  exists so assistant-run summary keys (`role:stamp` seeds) stay distinct
 *  per run and stable across requests. */
function stampOf(key: string): number {
  return Number.parseInt(fnv1a64(key).slice(0, 12), 16);
}

// ── decode ────────────────────────────────────────────────────────────────

/** Reference-identity survival sets over a turn's (possibly pruned) items. */
interface Survival {
  handles: Set<unknown>;
  calls: Set<ToolCallPart>;
  inlineResults: Set<ToolResultPart>;
  results: Set<ToolResultPart>;
}

function decodeTurn(turn: Turn): ModelMessage[] {
  const group = turn.handle as ModelMessage[] | undefined;
  if (!group) {
    // Ladder-synthesized turn (reference message, prefix summary).
    const text = syntheticText(turn.items);
    if (!text) return [];
    return [turn.role === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: text }];
  }

  const survival = collectSurvival(turn.items);
  const synthetic = syntheticText(turn.items);
  const hasAssistant = group.some((message) => message.role === 'assistant');
  const out: ModelMessage[] = [];

  for (const message of group) {
    if (message.role === 'assistant') {
      const rebuilt = rebuildAssistant(message, survival, synthetic);
      if (rebuilt) out.push(rebuilt);
    } else if (message.role === 'user') {
      // No stage ever removes user items; user messages re-emit verbatim.
      out.push(message);
    } else if (message.role === 'tool') {
      const rebuilt = rebuildToolMessage(message, survival);
      if (rebuilt) out.push(rebuilt);
    } else if (survival.handles.has(message)) {
      out.push(message);
    }
  }
  // Synthetic replacement text with no assistant message to carry it (a
  // collapsed headless run) re-emits as a user-role notice.
  if (synthetic && !hasAssistant) out.unshift({ role: 'user', content: synthetic });
  return out;
}

function collectSurvival(items: Item[]): Survival {
  const survival: Survival = {
    handles: new Set(),
    calls: new Set(),
    inlineResults: new Set(),
    results: new Set(),
  };
  for (const item of items) {
    if (item.kind === 'synthetic') continue;
    if (item.kind === 'tool') {
      const pair = pairOf(item);
      survival.calls.add(pair.call);
      if (pair.inlineResult) survival.inlineResults.add(pair.inlineResult);
      if (pair.result) survival.results.add(pair.result);
    } else {
      survival.handles.add(item.handle);
    }
  }
  return survival;
}

/** Walk the ORIGINAL content in order, keeping each part iff its item
 *  survived the ladder — order preservation is structural, and an untouched
 *  message re-emits as the same object (byte-verbatim). Synthetic text
 *  (todo state, "[tool calls cleared]" markers, run summaries) appends at
 *  the end, mirroring where the stages append their items. */
function rebuildAssistant(
  message: AssistantModelMessage,
  survival: Survival,
  synthetic: string,
): AssistantModelMessage | null {
  if (typeof message.content === 'string') {
    const textSurvives = survival.handles.has(message);
    if (textSurvives && !synthetic) return message;
    const text = [textSurvives ? message.content : '', synthetic].filter(Boolean).join('\n\n');
    return text ? { ...message, content: text } : null;
  }

  const parts: AssistantPart[] = [];
  let changed = false;
  for (const part of message.content) {
    if (assistantPartSurvives(part, survival)) parts.push(part);
    else changed = true;
  }
  if (synthetic) {
    parts.push({ type: 'text', text: synthetic });
    changed = true;
  }
  if (!changed) return message;
  if (parts.length === 0) return null;
  return { ...message, content: parts };
}

function assistantPartSurvives(part: AssistantPart, survival: Survival): boolean {
  if (part.type === 'tool-call') return survival.calls.has(part);
  if (part.type === 'tool-result') return survival.inlineResults.has(part) || survival.handles.has(part);
  return survival.handles.has(part);
}

function rebuildToolMessage(message: ToolModelMessage, survival: Survival): ToolModelMessage | null {
  const parts = message.content.filter((part) =>
    part.type === 'tool-result'
      ? survival.results.has(part) || survival.handles.has(part)
      : survival.handles.has(part),
  );
  if (parts.length === message.content.length) return message;
  if (parts.length === 0) return null;
  return { ...message, content: parts };
}

function syntheticText(items: Item[]): string {
  return items
    .filter((item): item is Extract<Item, { kind: 'synthetic' }> => item.kind === 'synthetic')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
}

function pairOf(item: ToolItem): ToolPairHandle {
  return item.handle as ToolPairHandle;
}

function isSkillBodyLoad(call: ToolCallPart): boolean {
  if (call.toolName !== 'skills') return false;
  const input = call.input;
  if (typeof input !== 'object' || input === null) return false;
  const action = (input as { action?: unknown }).action;
  return action === 'read' || action === 'invoke';
}

// ── estimation ────────────────────────────────────────────────────────────

function charsOfItem(item: Item): number {
  if (item.kind === 'text') return item.text.length;
  if (item.kind === 'synthetic') return item.text.length;
  if (item.kind === 'reasoning') return reasoningText(item.handle).length;
  if (item.kind === 'tool') return charsOfPair(pairOf(item));
  return charsOfOpaque(item.handle);
}

function charsOfPair(pair: ToolPairHandle): number {
  let chars = pair.call.toolName.length + jsonLength(pair.call.input);
  if (pair.inlineResult) chars += charsOfResultOutput(pair.inlineResult);
  if (pair.result) chars += charsOfResultOutput(pair.result);
  return chars;
}

function charsOfResultOutput(part: ToolResultPart): number {
  const output = part.output;
  if (output.type === 'text') return output.value.length;
  if (output.type === 'json') return jsonLength(output.value);
  return jsonLength(output);
}

function charsOfOpaque(handle: unknown): number {
  const part = handle as { type?: unknown; role?: unknown };
  if (part.type === 'image' || part.type === 'file') return ESTIMATED_MEDIA_CHARS;
  if (typeof part.role === 'string') {
    const content = (handle as { content?: unknown }).content;
    return typeof content === 'string' ? content.length : jsonLength(content);
  }
  return jsonLength(handle);
}

function reasoningText(handle: unknown): string {
  const text = (handle as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value, binaryReplacer)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

// ── transcript rendering ──────────────────────────────────────────────────

function formatToolPair(pair: ToolPairHandle): string {
  const result = pair.result ?? pair.inlineResult;
  return [
    `[tool:${pair.call.toolName}] callId=${pair.call.toolCallId}`,
    `input=${previewJson(pair.call.input)}`,
    result ? `output=${truncate(resultText(result), TRANSCRIPT_PREVIEW_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function resultText(part: ToolResultPart): string {
  const output = part.output;
  if (output.type === 'text') return output.value;
  if (output.type === 'json') return previewJson(output.value);
  return previewJson(output);
}

function formatOpaque(handle: unknown): string {
  const part = handle as { type?: string; role?: string; mediaType?: string; toolName?: string; toolCallId?: string };
  if (part.type === 'image') return `[image ${part.mediaType ?? 'unknown'}]`;
  if (part.type === 'file') return `[file ${part.mediaType ?? 'unknown'}]`;
  if (part.type === 'tool-result') {
    return `[orphaned tool result:${part.toolName}] callId=${part.toolCallId}\n${truncate(resultText(handle as ToolResultPart), TRANSCRIPT_PREVIEW_CHARS)}`;
  }
  if (typeof part.role === 'string') {
    const content = (handle as { content?: unknown }).content;
    return `[${part.role}] ${typeof content === 'string' ? content : previewJson(content)}`;
  }
  return `[${part.type ?? 'unknown'}] ${previewJson(handle)}`;
}

function previewJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return truncate(
      typeof value === 'string' ? value : JSON.stringify(value, binaryReplacer),
      TRANSCRIPT_PREVIEW_CHARS,
    );
  } catch {
    return truncate(String(value), TRANSCRIPT_PREVIEW_CHARS);
  }
}

/** Binary payloads (image/file bytes) flatten to a size placeholder; every
 *  textual field serializes exactly. */
function binaryReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  return value;
}
