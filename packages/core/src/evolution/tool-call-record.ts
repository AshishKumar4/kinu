import * as v from 'valibot';
import type { ToolCallRecord } from './types';
import type { ToolOutcome } from '../tools/outcome';
import { codemodeProgramOf } from '../tools/codemode-reach';
import { stableStringify } from '../safety/argument-digest';
import { evidenceWindow, EVIDENCE_BUDGETS } from '../utils/evidence-window';
import { isJsonObject, type JsonObject, type JsonValue, isJsonString } from '../utils/json';
import { fnv1a64 } from '../utils/fnv1a';
import { detached } from '../utils/text';
import { redactSecrets } from '../safety/secret-patterns';

export interface ToolCallInput {
  toolCallId?: string;
  name: string;
  args: JsonObject;
  result?: JsonValue;
  outcome?: ToolOutcome;
}

const ACTION_TARGET_CHARS = 80;

const TargetSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** Redacted before it is cut, so a credential the cut would split is masked whole. */
function actionTarget(args: JsonObject): string {
  for (const key of ['path', 'op', 'command', 'code']) {
    const value = v.safeParse(TargetSchema, args[key]);

    if (value.success) return detached((redactSecrets(value.output).split('\n')[0] ?? '').slice(0, ACTION_TARGET_CHARS));
  }

  return '';
}

/** Every string `value` holds, through the one secret policy (`redactSecrets`); the same value where none changed. */
function redactLeaves(value: JsonValue): JsonValue {
  if (isJsonString(value)) return redactSecrets(value);

  if (Array.isArray(value)) {
    const next = value.map(redactLeaves);

    return next.some((entry, at) => entry !== value[at]) ? next : value;
  }

  if (!isJsonObject(value)) return value;
  const next = Object.fromEntries(Object.entries(value).map(([field, fieldValue]) => [field, redactLeaves(fieldValue)]));

  return Object.keys(next).some((field) => next[field] !== value[field]) ? next : value;
}

const WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:file|fs)\.(?:write|edit)\s*\(\s*['"`]([^'"`]+)/g,
  /(?:^|[|;&\n]|\s)>>?\s*(\S+)/g,
  /(?:^|[|;&\n]|\s)tee\s+(?:-\S+\s+)*(\S+)/g,
];

const REVISIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:file|fs)\.(?:read|text)\s*\(\s*['"`]([^'"`]+)/g,
  /(?:^|[|;&\n]|\s)(?:cat|head|tail)\s+(?:-\S+\s+)*(\S+)/g,
  /(?:^|[|;&\n]|\s)rm\s+(?:-\S+\s+)*(\S+)/g,
  /\bgit\s+(?:checkout\s+--|restore)\s+(\S+)/g,
];

function stringLeaves(value: JsonValue, into: string[] = []): string[] {
  if (isJsonString(value)) into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, into);
  else if (isJsonObject(value)) {
    for (const item of Object.values(value)) stringLeaves(item, into);
  }

  return into;
}

/** Only path-shaped tokens count, keeping English words and `>` comparisons out of the path sets. */
function normalizePath(raw: string): string | null {
  const path = raw.replace(/^['"`]+/, '').replace(/['"`;,)]+$/, '');

  return /[/.]/.test(path) ? path : null;
}

function pathsMatching(text: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>): Set<string> {
  const found = new Set<string>();

  for (const chunk of text) {
    for (const pattern of patterns) {
      for (const match of chunk.matchAll(pattern)) {
        const path = match[1] === undefined ? null : normalizePath(match[1]);

        if (path) found.add(path);
      }
    }
  }

  return found;
}

/** `serialized`: `value`'s stable serialization, where the caller already took it; the window takes it again only for a
 *  value whose secrets it redacted. */
function window(value: JsonValue, serialized?: string): string {
  const redacted = redactLeaves(value);
  const text = redacted === value && serialized !== undefined ? serialized : stableStringify(redacted);

  return detached(evidenceWindow(text, EVIDENCE_BUDGETS.patternToolCall));
}

/** A call keeps only what its finished-turn readers read. */
export function compactToolCall(call: ToolCallInput): ToolCallRecord {
  const text = stringLeaves(call.args);
  const written = pathsMatching(text, WRITE_PATTERNS);
  const revisited = pathsMatching(text, REVISIT_PATTERNS);
  const op = call.args.op !== undefined && isJsonString(call.args.op) ? call.args.op : null;

  if (call.name === 'file' && call.args.path !== undefined && isJsonString(call.args.path)) {
    if (op === 'write' || op === 'edit') written.add(call.args.path);

    if (op === 'read') revisited.add(call.args.path);
  }

  // The arguments' stable serialization, taken once for their digest and their window.
  const serialized = stableStringify(call.args);

  const record: ToolCallRecord = {
    name: call.name,
    argsWindow: window(call.args, serialized),
    target: actionTarget(call.args),
    op: op === null ? null : detached(redactSecrets(op)),
    argsDigest: Object.keys(call.args).length === 0 ? null : fnv1a64(`${call.name}:${serialized}`),
    // Found in the arguments as written, then kept as every other projection is: through the secret policy.
    writtenPaths: [...written].map((path) => detached(redactSecrets(path))),
    revisitedPaths: [...revisited].map((path) => detached(redactSecrets(path))),
  };

  if (call.toolCallId !== undefined) record.toolCallId = call.toolCallId;

  if (call.outcome !== undefined) record.outcome = call.outcome;

  if (call.result !== undefined) record.resultWindow = window(call.result);

  if (call.name === 'eval') record.program = redactSecrets(codemodeProgramOf(call.name, call.args));

  return record;
}
