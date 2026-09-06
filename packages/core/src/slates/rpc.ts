import * as v from 'valibot';
import type { Refusal } from '../obs/index';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { SlateDirectoryName } from './files';

const METHOD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** An app method forwarded as a POST route to another slate. */
export function isSlateMethodName(name: string): boolean {
  return METHOD_RE.test(name) && name !== 'constructor' && !name.startsWith('_');
}

/** A forwarded Slate call's JSON value or refusal. */
export type SlateCallResult =
  | { readonly ok: true; readonly value: JsonValue }
  | ({ readonly ok: false } & Refusal);

const VersionId = v.pipe(v.string(), v.minLength(1));
export const SlateOperationSchema = v.variant('op', [
  v.strictObject({ op: v.literal('list') }),
  v.strictObject({ op: v.literal('preview'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('call'), id: SlateDirectoryName, method: v.pipe(v.string(), v.check(isSlateMethodName)), args: v.optional(v.array(JsonValueSchema)) }),
  v.strictObject({ op: v.literal('commit'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('history'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('fork'), version: VersionId }),
  v.strictObject({ op: v.literal('restore'), id: SlateDirectoryName, version: VersionId }),
]);
export type SlateOperation = v.InferOutput<typeof SlateOperationSchema>;

export interface SlateSummary {
  readonly id: string;
  readonly title: string;
  readonly bindings: readonly string[];
}

export interface SlateProblem extends Refusal {
  readonly id: string;
}

export const SLATES_CHANGED_EVENT = 'slates_changed';

export interface SlatesChangedEvent {
  readonly type: typeof SLATES_CHANGED_EVENT;
  readonly ids: readonly string[];
}
