/**
 * Kinu codec — AI SDK v6 `ModelMessage[]` ⇄ ladder `Turn[]`.
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
 * Identity is id-less (Kinu ModelMessages carry no ids): content-hash keys
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
  UserModelMessage,
} from 'ai';
import {
  assistantModelMessageSchema,
  modelMessageSchema,
  toolModelMessageSchema,
  userModelMessageSchema,
} from 'ai';
import { fnv1a64 } from '@kinu.run/core';
import * as v from 'valibot';
import {
  assistantRunsStage,
  contentHashKey,
  keyDeduper,
  purgeErrorInputsStage,
  reasoningStage,
  skillsStage,
  supersedeReadsStage,
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
type UserPart = Exclude<UserModelMessage['content'], string>[number];
type ToolPart = ToolModelMessage['content'][number];
type NativeHandle = ModelMessage | AssistantPart | UserPart | ToolPart;

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

const TOOL_PAIR_HANDLE = Symbol('kinu-tool-pair');

interface StoredToolPairHandle extends ToolPairHandle {
  [TOOL_PAIR_HANDLE]: true;
}

type ToolItem = Extract<Item, { kind: 'tool' }>;

/** Images/files are priced flat: providers charge by media dimensions, not
 *  payload bytes, and a base64 blob would wildly overprice. Same scale as the
 *  pi adapter's image estimate (~1200 tokens). */
const ESTIMATED_MEDIA_CHARS = 4_800;
const TRANSCRIPT_PREVIEW_CHARS = 20_000;

export const kinuCodec: Codec<ModelMessage> = {
  encode(messages) {
    const claimKey = keyDeduper();
    return groupMessages(messages).map((group) => encodeGroup(group, claimKey));
  },

  decode(turns, _messages) {
    return turns.flatMap(decodeTurn);
  },

  // Chars/4 over the content Kinu actually serializes for the model —
  // the shared estimation scale (core countTokens); the engine's
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
      const native = turn.handle ? decodeTurn(turn) : { role: turn.role, content: syntheticText(turn.items) };
      return [
        `## ${turn.role.toUpperCase()} ${turn.key}`,
        '```json',
        JSON.stringify(native, binaryReplacer, 2),
        '```',
      ].join('\n');
    });
    return `# Kinu Compaction Raw Transcript\n\n${blocks.join('\n\n')}\n`;
  },
};

export const kinuConventions: Conventions = {
  // Skill bodies used to enter history as `skills` tool read/invoke outputs
  // (active skills render in the system prefix, outside messages), so the
  // skills stage pruned those loaded copies first — cheaply re-fetchable
  // duplicates. The `skills` tool is gone (read/create/edit/delete are now
  // workspace.readFile/writeFile/readdir calls inside execute_tools), so
  // isSkillBodyLoad's toolName match never fires for a NEW call — but it
  // still correctly identifies any `{toolName:'skills'}` calls already
  // sitting in durable history from before this migration, so a session with
  // older turns keeps pruning them with the same priority. Not extended to
  // detect a skill read done via execute_tools: that call's `code` is
  // free-form JS mixing arbitrary logic, so matching on it would be a
  // fragile heuristic (false positives on unrelated code, false negatives on
  // any indirection) where the old exact toolName match was exact. A skill
  // read via execute_tools falls through to the generic tool-result pruning
  // tiers (toolsOldStage / toolsRemainingStage) instead of this priority one.
  isSkillItem: (item) =>
    item.kind === 'tool' && isSkillBodyLoad(pairOf(item).call),
  tool: (item) => {
    const pair = pairOf(item);
    return {
      name: pair.call.toolName,
      input: pair.call.input,
      error: toolError(pair),
    };
  },
  // No in-band todo surface (task state lives in the jobs subsystem, outside
  // messages) and no per-item notes — those conventions are simply absent,
  // so the stages that would need them find nothing to act on.
};

export const kinuSpec: LadderSpec = {
  codec: kinuCodec,
  conventions: kinuConventions,
  stages: [
    skillsStage,
    supersedeReadsStage,
    purgeErrorInputsStage,
    toolsOldStage,
    reasoningStage,
    toolsRemainingStage,
    assistantRunsStage,
  ],
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
      if (isString(message.content)) {
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
  if (isString(message.content)) {
    items.push({ kind: 'text', key: `${turnKey}#${items.length}`, text: message.content, handle: message });
    return;
  }
  for (const part of message.content) {
    if (part.type === 'text') {
      items.push({ kind: 'text', key: `${turnKey}#${items.length}`, text: part.text, handle: part });
    } else if (part.type === 'reasoning') {
      items.push({ kind: 'reasoning', key: `${turnKey}#${items.length}`, handle: part });
    } else if (part.type === 'tool-call') {
      const pair: StoredToolPairHandle = { [TOOL_PAIR_HANDLE]: true, call: part };
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
  handles: Set<NativeHandle>;
  results: Set<ToolResultPart>;
}

function decodeTurn(turn: Turn): ModelMessage[] {
  if (turn.handle === undefined) {
    // Ladder-synthesized turn (reference message, prefix summary).
    const text = syntheticText(turn.items);
    if (!text) return [];
    return [turn.role === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: text }];
  }
  if (!isModelMessageGroup(turn.handle)) {
    throw new Error(`compaction codec: invalid native turn handle for ${turn.key}`);
  }
  const group = turn.handle;

  const survival = collectSurvival(turn.items);
  const hasAssistant = group.some((message) => message.role === 'assistant');
  const out: ModelMessage[] = [];

  for (const message of group) {
    if (message.role === 'assistant') {
      const rebuilt = rebuildAssistant(message, turn.items);
      if (rebuilt) out.push(rebuilt);
    } else if (message.role === 'user') {
      const rebuilt = rebuildUser(message, turn.items);
      if (rebuilt) out.push(rebuilt);
    } else if (message.role === 'tool') {
      const rebuilt = rebuildToolMessage(message, survival);
      if (rebuilt) out.push(rebuilt);
    } else if (survival.handles.has(message)) {
      out.push(message);
    }
  }
  // Synthetic replacement text with no assistant message to carry it (a
  // collapsed headless run) re-emits as a user-role notice.
  const synthetic = syntheticText(turn.items);
  if (synthetic && !hasAssistant && !group.some((message) => message.role === 'user')) {
    out.unshift({ role: 'user', content: synthetic });
  }
  return out;
}

function collectSurvival(items: Item[]): Survival {
  const survival: Survival = {
    handles: new Set(),
    results: new Set(),
  };
  for (const item of items) {
    if (item.kind === 'synthetic') continue;
    if (item.kind === 'tool') {
      const pair = pairOf(item);
      if (pair.result) survival.results.add(pair.result);
    } else {
      survival.handles.add(nativeHandle(item.handle));
    }
  }
  return survival;
}

/** Rebuild in IR order so a synthetic tool stub occupies the native position
 *  of the tool item it replaced. Untouched messages retain object identity. */
function rebuildAssistant(
  message: AssistantModelMessage,
  items: Item[],
): AssistantModelMessage | null {
  if (isString(message.content)) {
    const textSurvives = items.some((item) => item.kind === 'text' && item.handle === message);
    const synthetic = syntheticText(items);
    if (textSurvives && !synthetic) return message;
    const text = [textSurvives ? message.content : '', synthetic].filter(Boolean).join('\n\n');
    return text ? { ...message, content: text } : null;
  }

  if (
    !items.some((item) => item.kind === 'synthetic') &&
    message.content.every((part) => assistantPartSurvives(part, items))
  ) {
    return message;
  }

  const survivingCalls = new Set(
    items
      .filter((item): item is ToolItem => item.kind === 'tool')
      .map((item) => pairOf(item).call),
  );
  const removedCalls = message.content.filter(
    (part): part is ToolCallPart => part.type === 'tool-call' && !survivingCalls.has(part),
  );
  const stubs = items.filter(
    (item): item is Extract<Item, { kind: 'synthetic' }> =>
      item.kind === 'synthetic' && isToolStub(item),
  );
  const stubByCall = new Map(
    removedCalls.slice(0, stubs.length).map((call, index) => [call, stubs[index]]),
  );

  const parts: AssistantPart[] = [];
  for (const part of message.content) {
    if (part.type === 'tool-call') {
      const stub = stubByCall.get(part);
      if (stub) parts.push({ type: 'text', text: stub.text });
      else if (assistantPartSurvives(part, items)) parts.push(part);
    } else if (assistantPartSurvives(part, items)) {
      parts.push(part);
    }
  }
  for (const item of items) {
    if (item.kind === 'synthetic' && !isToolStub(item)) {
      parts.push({ type: 'text', text: item.text });
    }
  }
  if (parts.length === 0) return null;
  if (sameParts(parts, message.content)) return message;
  return { ...message, content: parts };
}

function assistantPartSurvives(part: AssistantPart, items: Item[]): boolean {
  if (part.type === 'tool-call') {
    return items.some((item) => item.kind === 'tool' && pairOf(item).call === part);
  }
  if (part.type === 'tool-result') {
    return items.some(
      (item) =>
        (item.kind === 'tool' && pairOf(item).inlineResult === part) ||
        (item.kind === 'opaque' && item.handle === part),
    );
  }
  return items.some(
    (item) => item.kind !== 'synthetic' && item.kind !== 'tool' && item.handle === part,
  );
}

function isToolStub(item: Item): boolean {
  return item.kind === 'synthetic' && item.text.startsWith('[tool:');
}

function rebuildUser(message: UserModelMessage, items: Item[]): UserModelMessage | null {
  if (isString(message.content)) {
    const textSurvives = items.some((item) => item.kind === 'text' && item.handle === message);
    const synthetic = syntheticText(items);
    if (textSurvives && !synthetic) return message;
    const text = [textSurvives ? message.content : '', synthetic].filter(Boolean).join('\n\n');
    return text ? { ...message, content: text } : null;
  }

  const parts: UserPart[] = [];
  const originalParts = new Set<UserPart>(message.content);
  for (const item of items) {
    if (item.kind === 'synthetic') {
      parts.push({ type: 'text', text: item.text });
    } else if ((item.kind === 'text' || item.kind === 'opaque') && isUserPart(item.handle)
      && originalParts.has(item.handle)) {
      parts.push(item.handle);
    }
  }
  if (parts.length === 0) return null;
  if (sameParts(parts, message.content)) return message;
  return { ...message, content: parts };
}

function sameParts<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
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
  if (!isStoredToolPairHandle(item.handle)) {
    throw new Error(`compaction codec: invalid tool-pair handle for ${item.key}`);
  }
  return item.handle;
}

/** Matches a legacy `{toolName:'skills', action:'read'|'invoke'}` call —
 *  see the isSkillItem comment above for why this is intentionally NOT kept
 *  in step with the current action set (the tool itself is gone). */
function isSkillBodyLoad(call: ToolCallPart): boolean {
  return call.toolName === 'skills' && v.is(SkillBodyLoadSchema, call.input);
}

function toolError(pair: ToolPairHandle): string | undefined {
  const output = (pair.result ?? pair.inlineResult)?.output;
  if (!output) return undefined;
  if (output.type === 'error-text') return output.value;
  if (output.type === 'error-json') return previewJson(output.value);
  if (output.type === 'execution-denied') return output.reason ?? 'execution denied';
  return undefined;
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

function charsOfOpaque<Handle>(handle: Handle): number {
  const value = nativeHandle(handle);
  if ((isAssistantPart(value) || isUserPart(value))
      && (value.type === 'image' || value.type === 'file')) return ESTIMATED_MEDIA_CHARS;
  if (isModelMessage(value)) {
    return isString(value.content) ? value.content.length : jsonLength(value.content);
  }
  return jsonLength(value);
}

function reasoningText<Handle>(handle: Handle): string {
  return isAssistantPart(handle) && handle.type === 'reasoning' ? handle.text : '';
}

function jsonLength<Value>(value: Value): number {
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

function formatOpaque<Handle>(handle: Handle): string {
  const value = nativeHandle(handle);
  if ((isAssistantPart(value) || isUserPart(value)) && value.type === 'image') {
    return `[image ${value.mediaType ?? 'unknown'}]`;
  }
  if ((isAssistantPart(value) || isUserPart(value)) && value.type === 'file') {
    return `[file ${value.mediaType ?? 'unknown'}]`;
  }
  if (isToolPart(value) && value.type === 'tool-result') {
    return `[orphaned tool result:${value.toolName}] callId=${value.toolCallId}\n${truncate(resultText(value), TRANSCRIPT_PREVIEW_CHARS)}`;
  }
  if (isModelMessage(value)) {
    return `[${value.role}] ${isString(value.content) ? value.content : previewJson(value.content)}`;
  }
  return `[${value.type}] ${previewJson(value)}`;
}

function previewJson<Value>(value: Value): string {
  if (value === undefined) return '';
  try {
    return truncate(
      isString(value) ? value : JSON.stringify(value, binaryReplacer),
      TRANSCRIPT_PREVIEW_CHARS,
    );
  } catch {
    return truncate(String(value), TRANSCRIPT_PREVIEW_CHARS);
  }
}

/** Binary payloads (image/file bytes) flatten to a size placeholder; every
 *  textual field serializes exactly. */
function binaryReplacer<Value>(_key: string, value: Value): Value | string {
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  return value;
}

const StringSchema = v.string();
const SkillBodyLoadSchema = v.object({ action: v.picklist(['read', 'invoke']) });
interface ToolPairMarker {
  [TOOL_PAIR_HANDLE]: unknown;
}
const ToolPairMarkerSchema = v.custom<ToolPairMarker>((input) => {
  if (!v.is(v.object({}), input)) return false;
  return TOOL_PAIR_HANDLE in input;
});

function isString<Value>(value: Value): value is Value & string {
  return v.is(StringSchema, value);
}

function isStoredToolPairHandle<Value>(value: Value): value is Value & StoredToolPairHandle {
  const parsed = v.safeParse(ToolPairMarkerSchema, value);
  return parsed.success && parsed.output[TOOL_PAIR_HANDLE] === true;
}

function isModelMessageGroup<Value>(value: Value): value is Value & ModelMessage[] {
  return Array.isArray(value) && value.every((message) => modelMessageSchema.safeParse(message).success);
}

function isModelMessage<Value>(value: Value): value is Value & ModelMessage {
  return modelMessageSchema.safeParse(value).success;
}

function isAssistantPart<Value>(value: Value): value is Value & AssistantPart {
  return assistantModelMessageSchema.safeParse({ role: 'assistant', content: [value] }).success;
}

function isUserPart<Value>(value: Value): value is Value & UserPart {
  return userModelMessageSchema.safeParse({ role: 'user', content: [value] }).success;
}

function isToolPart<Value>(value: Value): value is Value & ToolPart {
  return toolModelMessageSchema.safeParse({ role: 'tool', content: [value] }).success;
}

function isNativeHandle<Value>(value: Value): value is Value & NativeHandle {
  return isModelMessage(value) || isAssistantPart(value) || isUserPart(value) || isToolPart(value);
}

function nativeHandle<Value>(value: Value): Value & NativeHandle {
  if (!isNativeHandle(value)) throw new Error('compaction codec: invalid native item handle');
  return value;
}
