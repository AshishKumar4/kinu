import * as v from 'valibot';
import type { ToolCallRecord } from './types';
import type { ToolOutcome } from '../tools/outcome';
import { codemodeProgramOf } from '../tools/codemode-reach';
import { stableStringify } from '../safety/argument-digest';
import { evidenceWindow, EVIDENCE_BUDGETS } from '../utils/evidence-window';
import { decodeJsonValue, isJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import { fnv1a64 } from '../utils/fnv1a';

export interface ToolCallInput {
  toolCallId?: string;
  name: string;
  args: JsonObject;
  result?: JsonValue;
  outcome?: ToolOutcome;
}

const ACTION_TARGET_CHARS = 80;

const TargetSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** A copy of its own: a kept slice, or a rope over slices, pins the whole argument or result string it was cut from (V8
 *  and JavaScriptCore alike), and re-slicing a concatenation still does on JavaScriptCore. UTF-16 code units copy exactly. */
const detached = (text: string): string => Buffer.from(text, 'utf16le').toString('utf16le');

function actionTarget(args: JsonObject): string {
  for (const key of ['path', 'op', 'command', 'code']) {
    const value = v.safeParse(TargetSchema, args[key]);

    if (value.success) return detached((value.output.split('\n')[0] ?? '').slice(0, ACTION_TARGET_CHARS));
  }

  return '';
}

/** Shapes mirror `scripts/secret-scan.ts`; private-key blocks go first. */
const PRIVATE_KEY_BLOCK = /-----BEGIN[^-]*PRIVATE KEY[^-]*-----[\s\S]*?-----END[^-]*PRIVATE KEY[^-]*-----|-----BEGIN[^-]*PRIVATE KEY[^-]*-----/gu;

const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/gu;

const AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/gu;

const PROVIDER_SECRET = /\b(?:[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})/gu;

const KINU_TOKEN = /\bp(?:ta|tc|dt)_[0-9a-f]{8,}/gu;

const StringSchema = v.string();

function obfuscateString(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, '[redacted private-key]')
    .replace(BEARER_TOKEN, '[redacted bearer]')
    .replace(AWS_ACCESS_KEY, '[redacted api-key]')
    .replace(PROVIDER_SECRET, '[redacted api-key]')
    .replace(KINU_TOKEN, '[redacted kinu-token]');
}

function obfuscateSecrets(value: JsonValue): JsonValue {
  if (v.is(StringSchema, value)) return obfuscateString(value);

  if (Array.isArray(value)) {
    let changed = false;

    const next = value.map((entry) => {
      const obfuscated = obfuscateSecrets(entry);

      if (obfuscated !== entry) changed = true;

      return obfuscated;
    });

    return changed ? next : value;
  }

  if (!isJsonObject(value)) return value;

  let changed = false;
  const next: JsonObject = {};

  for (const [field, fieldValue] of Object.entries(value)) {
    const obfuscated = obfuscateSecrets(fieldValue);

    if (obfuscated !== fieldValue) changed = true;
    next[field] = obfuscated;
  }

  return changed ? next : value;
}

const WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bworkspace\.writeFile\s*\(\s*['"`]([^'"`]+)/g,
  /(?:^|[|;&\n]|\s)>>?\s*(\S+)/g,
  /(?:^|[|;&\n]|\s)tee\s+(?:-\S+\s+)*(\S+)/g,
];

const REVISIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bworkspace\.readFile\s*\(\s*['"`]([^'"`]+)/g,
  /(?:^|[|;&\n]|\s)(?:cat|head|tail)\s+(?:-\S+\s+)*(\S+)/g,
  /(?:^|[|;&\n]|\s)rm\s+(?:-\S+\s+)*(\S+)/g,
  /\bgit\s+(?:checkout\s+--|restore)\s+(\S+)/g,
];

function stringLeaves(value: JsonValue, into: string[] = []): string[] {
  const text = v.safeParse(StringSchema, value);

  if (text.success) into.push(text.output);
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

function window(value: JsonValue): string {
  return detached(evidenceWindow(stableStringify(obfuscateSecrets(value)), EVIDENCE_BUDGETS.patternToolCall));
}

/** A call keeps only what its finished-turn readers read. */
export function compactToolCall(call: ToolCallInput): ToolCallRecord {
  const decoded = decodeJsonValue({ value: call.args });
  const text = stringLeaves(decoded);
  const written = pathsMatching(text, WRITE_PATTERNS);
  const revisited = pathsMatching(text, REVISIT_PATTERNS);
  const op = v.is(StringSchema, call.args.op) ? call.args.op : null;

  if (call.name === 'file' && v.is(StringSchema, call.args.path)) {
    if (op === 'write' || op === 'edit') written.add(call.args.path);

    if (op === 'read') revisited.add(call.args.path);
  }

  const record: ToolCallRecord = {
    name: call.name,
    argsWindow: window(call.args),
    target: actionTarget(call.args),
    op,
    argsDigest: Object.keys(call.args).length === 0 ? null : fnv1a64(`${call.name}:${stableStringify(decoded)}`),
    writtenPaths: [...written].map(detached),
    revisitedPaths: [...revisited].map(detached),
  };

  if (call.toolCallId !== undefined) record.toolCallId = call.toolCallId;

  if (call.outcome !== undefined) record.outcome = call.outcome;

  if (call.result !== undefined) record.resultWindow = window(call.result);

  if (call.name === 'eval') record.program = codemodeProgramOf(call.name, call.args);

  return record;
}
