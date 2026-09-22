import * as v from 'valibot';
import type { Refusal } from '../obs/index';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import type { WorkMode } from '../types/turn';
import { requireWorkModePermission } from '../execution/work-mode';
import { LiveShareVisibilitySchema } from './live-share-visibility';

const METHOD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Source string for the generated runner, which cannot import this module. */
export const SLATE_METHOD_NAME_SOURCE = METHOD_RE.source;

/** Defined here because `SlateFiles` imports the vendored runtime, which cannot load in a browser. */
export const SlateDirectoryName = v.pipe(v.string(), v.minLength(1),
  v.check((name) => !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..', 'Slate id must be one directory name'));

export function isSlateMethodName(name: string): boolean {
  return METHOD_RE.test(name) && name !== 'constructor' && !name.startsWith('_');
}

/** The refusal is a value so it crosses a Durable Object RPC boundary intact. */
export type SlateAnswer<Value> =
  | { readonly ok: true; readonly value: Value }
  | ({ readonly ok: false } & Refusal);

export type SlateCallResult = SlateAnswer<JsonValue>;

const VersionId = v.pipe(v.string(), v.minLength(1));

const ShareId = v.pipe(v.string(), v.minLength(1));

const IncludedPaths = v.array(v.pipe(v.string(), v.check((name) => name !== '' && !name.includes('/') && name !== '.' && name !== '..', 'An included path is one top-level name')));

export const SlateOperationSchema = v.variant('op', [
  v.strictObject({ op: v.literal('list') }),
  v.strictObject({ op: v.literal('preview'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('call'), id: SlateDirectoryName, method: v.pipe(v.string(), v.check(isSlateMethodName)), args: v.optional(v.array(JsonValueSchema)) }),
  v.strictObject({ op: v.literal('commit'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('history'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('fork'), version: VersionId }),
  v.strictObject({ op: v.literal('restore'), id: SlateDirectoryName, version: VersionId }),
  // Ends processes, durable application and tree; versions stay.
  v.strictObject({ op: v.literal('remove'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('inspect'), id: SlateDirectoryName, version: VersionId, include: v.optional(IncludedPaths) }),
  v.strictObject({ op: v.literal('publish'), id: SlateDirectoryName, version: VersionId, include: v.optional(IncludedPaths) }),
  v.strictObject({ op: v.literal('unshare'), share: ShareId }),
  v.strictObject({ op: v.literal('shares') }),
  v.strictObject({ op: v.literal('graph'), id: SlateDirectoryName }),
  v.strictObject({
    op: v.literal('share'), id: SlateDirectoryName,
    visibility: LiveShareVisibilitySchema,
    approved: v.array(v.strictObject({ slate: v.string(), binding: v.string(), member: v.string() })),
    fork: v.optional(v.boolean()),
  }),
  v.strictObject({ op: v.literal('liveShares') }),
  v.strictObject({ op: v.literal('viewerRequests'), share: ShareId }),
]);

export type SlateOperation = v.InferOutput<typeof SlateOperationSchema>;

const READ_ONLY_OPERATIONS: Record<SlateOperation['op'], boolean> = {
  list: true, history: true, inspect: true, shares: true,
  graph: true, liveShares: true, viewerRequests: true,
  preview: false, call: false, commit: false, fork: false, restore: false, remove: false, publish: false, unshare: false,
  share: false,
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
