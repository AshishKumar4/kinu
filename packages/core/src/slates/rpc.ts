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
  v.strictObject({ op: v.literal('methods'), id: SlateDirectoryName }),
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

type SlateMemberSpec = { readonly on: 'directory' | 'slate'; readonly params: readonly string[] };

/** Each operation but `call` as a program member, `$<op>` on `workspace.slates` or on one slate; params are its fields in order, `...` spreads options. */
export const SLATE_PROGRAM_MEMBERS = {
  list: { on: 'directory', params: [] },
  fork: { on: 'directory', params: ['version'] },
  shares: { on: 'directory', params: [] },
  liveShares: { on: 'directory', params: [] },
  unshare: { on: 'directory', params: ['share'] },
  viewerRequests: { on: 'directory', params: ['share'] },
  preview: { on: 'slate', params: [] },
  methods: { on: 'slate', params: [] },
  commit: { on: 'slate', params: [] },
  history: { on: 'slate', params: [] },
  remove: { on: 'slate', params: [] },
  graph: { on: 'slate', params: [] },
  restore: { on: 'slate', params: ['version'] },
  inspect: { on: 'slate', params: ['version', 'include'] },
  publish: { on: 'slate', params: ['version', 'include'] },
  share: { on: 'slate', params: ['...'] },
} as const satisfies Record<Exclude<SlateOperation['op'], 'call'>, SlateMemberSpec>;

function programMember(operation: SlateOperation): string {
  if (operation.op === 'call') return `workspace.slates.${operation.id}.${operation.method}`;

  return 'id' in operation ? `workspace.slates.${operation.id}.$${operation.op}` : `workspace.slates.$${operation.op}`;
}

const READ_ONLY_OPERATIONS: Record<SlateOperation['op'], boolean> = {
  list: true, history: true, inspect: true, shares: true,
  graph: true, liveShares: true, viewerRequests: true,
  preview: false, methods: false, call: false, commit: false, fork: false, restore: false, remove: false, publish: false, unshare: false,
  share: false,
};

/** Reads run in Plan; the rest change resources or run authored code, as `methods` does by booting the slate. */
export function requireSlateWorkMode(operation: SlateOperation, mode: WorkMode): void {
  requireWorkModePermission(mode, READ_ONLY_OPERATIONS[operation.op], programMember(operation));
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
