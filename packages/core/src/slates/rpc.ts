import * as v from 'valibot';
import type { Refusal } from '../obs/index';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import type { WorkMode } from '../types/turn';
import { requireWorkModePermission } from '../execution/work-mode';

const METHOD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** The method-name rule as a source string, for the generated runner that
 *  applies the same test without importing this module. */
export const SLATE_METHOD_NAME_SOURCE = METHOD_RE.source;

/** A slate id as one directory name. Defined HERE rather than beside the
 *  worker-only `SlateFiles`: that module imports the vendored agent-core
 *  runtime, which cannot load in a browser, while this operation schema —
 *  and every client that validates against it — must. */
export const SlateDirectoryName = v.pipe(v.string(), v.minLength(1),
  v.check((name) => !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..', 'Slate id must be one directory name'));

/** An app method forwarded as a POST route to another slate. */
export function isSlateMethodName(name: string): boolean {
  return METHOD_RE.test(name) && name !== 'constructor' && !name.startsWith('_');
}

/** A slate plane answer: the value, or the refusal as a value, so it crosses
 *  a Durable Object RPC boundary with its reason intact. */
export type SlateAnswer<Value> =
  | { readonly ok: true; readonly value: Value }
  | ({ readonly ok: false } & Refusal);

/** A forwarded Slate call's JSON value or refusal. */
export type SlateCallResult = SlateAnswer<JsonValue>;

const VersionId = v.pipe(v.string(), v.minLength(1));

const ShareId = v.pipe(v.string(), v.minLength(1));

/** Top-level names of the version's tree the blueprint carries. */
const IncludedPaths = v.array(v.pipe(v.string(), v.check((name) => name !== '' && !name.includes('/') && name !== '.' && name !== '..', 'An included path is one top-level name')));

export const SlateOperationSchema = v.variant('op', [
  v.strictObject({ op: v.literal('list') }),
  v.strictObject({ op: v.literal('preview'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('call'), id: SlateDirectoryName, method: v.pipe(v.string(), v.check(isSlateMethodName)), args: v.optional(v.array(JsonValueSchema)) }),
  v.strictObject({ op: v.literal('commit'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('history'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('fork'), version: VersionId }),
  v.strictObject({ op: v.literal('restore'), id: SlateDirectoryName, version: VersionId }),
  // Blueprints: what a version would export, publishing it, and the rows.
  v.strictObject({ op: v.literal('inspect'), id: SlateDirectoryName, version: VersionId, include: v.optional(IncludedPaths) }),
  v.strictObject({ op: v.literal('publish'), id: SlateDirectoryName, version: VersionId, include: v.optional(IncludedPaths) }),
  v.strictObject({ op: v.literal('unshare'), share: ShareId }),
  v.strictObject({ op: v.literal('shares') }),
]);

export type SlateOperation = v.InferOutput<typeof SlateOperationSchema>;

const READ_ONLY_OPERATIONS: Record<SlateOperation['op'], boolean> = {
  list: true, history: true, inspect: true, shares: true,
  preview: false, call: false, commit: false, fork: false, restore: false, publish: false, unshare: false,
};

/** The parsed operation contract: listing, history, inspection and the share rows read; every other operation can change resources or run authored code. */
export function requireSlateWorkMode(operation: SlateOperation, mode: WorkMode): void {
  requireWorkModePermission(mode, READ_ONLY_OPERATIONS[operation.op], 'workspace.slate.' + operation.op);
}

export interface SlateSummary {
  readonly id: string;
  readonly title: string;
  readonly bindings: readonly string[];
  /** Existing caller-scoped resident for exposed-port preview deduplication. */
  readonly port?: number;
}

export interface SlateProblem extends Refusal {
  readonly id: string;
}

export const SLATES_CHANGED_EVENT = 'slates_changed';

export interface SlatesChangedEvent {
  readonly type: typeof SLATES_CHANGED_EVENT;
  readonly ids: readonly string[];
}
