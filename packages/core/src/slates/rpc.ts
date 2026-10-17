import * as v from 'valibot';
import type { Refusal } from '../obs/index';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import type { WorkMode } from '../types/turn';
import { requireWorkModePermission } from '../execution/work-mode';
import { LiveShareVisibilitySchema } from './live-share-visibility';
import { ShareStartSchema } from './share-modes';

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
  | { readonly ok: true; readonly value: Value; readonly listing?: 'pending' }
  | ({ readonly ok: false } & Refusal);

export type SlateCallResult = SlateAnswer<JsonValue>;

/**
 * `agent.ask`'s answer, at once: the agent's reply as UTF-8 text, written as the agent writes it. A message that never
 * lands in a turn ends it with why.
 */
interface SlateReply {
  readonly reply: ReadableStream<Uint8Array>;
}

/** What a slate's own call on its surface answers: JSON, a stream of text (`ai.stream`), or a reply (`agent.ask`). */
export type SlateSurfaceValue = JsonValue | ReadableStream<Uint8Array> | SlateReply;

/** Whether an answer is JSON, as every answer is but a streamed one. */
export function isJsonAnswer(value: SlateSurfaceValue): value is JsonValue {
  return !(value instanceof ReadableStream) && !(value !== null && typeof value === 'object' && 'reply' in value && value.reply instanceof ReadableStream);
}

export type SlateSurfaceResult = SlateAnswer<SlateSurfaceValue>;

const VersionId = v.pipe(v.string(), v.minLength(1));

const ShareId = v.pipe(v.string(), v.minLength(1));

const IncludedPaths = v.array(v.pipe(v.string(), v.check((name) => name !== '' && !name.includes('/') && name !== '.' && name !== '..', 'An included path is one top-level name')));

/** A file of a slate's tree as an editor names it: relative, plain segments, nothing of its dependencies or its history. */
export const SlateFilePath = v.pipe(
  v.string(),
  v.regex(/^[\w.-]+(?:\/[\w.-]+)*$/u, 'A slate file is a relative path of plain names'),
  v.check((path) => !path.split('/').some((part) => part === '.' || part === '..'), 'A slate file path stays inside the slate'),
  v.check((path) => !/^(?:node_modules|\.git)(?:\/|$)/u.test(path), 'A slate file is its source, not its dependencies or history'),
);

/** An editor's change to a shared slate's files: each path's new text, or null to delete it. */
export const SlateFileChangeSchema = v.pipe(v.record(SlateFilePath, v.nullable(v.string())), v.check((files) => Object.keys(files).length > 0, 'A change names a file'));

export type SlateFileChange = v.InferOutput<typeof SlateFileChangeSchema>;

/** A shared slate's text files, as an editor's agent reads them. */
export const SharedSlateFilesSchema = v.object({ files: v.array(v.object({ path: v.string(), text: v.string() })) });

export type SharedSlateFiles = v.InferOutput<typeof SharedSlateFilesSchema>;

/** Another workspace's slate, shared with this workspace's owner to edit: its workspace and its directory there. */
const SharedSlateAddress = { workspace: v.pipe(v.string(), v.minLength(1)), slate: SlateDirectoryName };

export const SlateOperationSchema = v.variant('op', [
  v.strictObject({ op: v.literal('list') }),
  v.strictObject({ op: v.literal('preview'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('methods'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('call'), id: SlateDirectoryName, method: v.pipe(v.string(), v.check(isSlateMethodName)), args: v.optional(v.array(JsonValueSchema)) }),
  v.strictObject({ op: v.literal('commit'), id: SlateDirectoryName }),
  v.strictObject({ op: v.literal('history'), id: SlateDirectoryName, after: v.optional(VersionId) }),
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
    approved: v.array(v.strictObject({ slate: v.string(), namespace: v.string(), member: v.string() })),
    fork: v.optional(v.boolean()),
    start: v.optional(ShareStartSchema),
  }),
  v.strictObject({ op: v.literal('liveShares') }),
  v.strictObject({ op: v.literal('viewerRequests'), share: ShareId }),
  // Keeps an answer's `<slate-ui>` page, addressed as the chat draws it, as a slate with files under its title.
  v.strictObject({ op: v.literal('save'), page: v.pipe(v.string(), v.minLength(1)) }),
  // A slate someone shared with this workspace's owner to edit: its files read, and changed, in its owner's workspace.
  v.strictObject({ op: v.literal('sharedFiles'), ...SharedSlateAddress }),
  v.strictObject({ op: v.literal('sharedEdit'), ...SharedSlateAddress, files: SlateFileChangeSchema }),
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
  history: { on: 'slate', params: ['after'] },
  remove: { on: 'slate', params: [] },
  graph: { on: 'slate', params: [] },
  restore: { on: 'slate', params: ['version'] },
  inspect: { on: 'slate', params: ['version', 'include'] },
  publish: { on: 'slate', params: ['version', 'include'] },
  share: { on: 'slate', params: ['...'] },
  save: { on: 'directory', params: ['page'] },
  sharedFiles: { on: 'directory', params: ['workspace', 'slate'] },
  sharedEdit: { on: 'directory', params: ['workspace', 'slate', 'files'] },
} as const satisfies Record<Exclude<SlateOperation['op'], 'call'>, SlateMemberSpec>;

function programMember(operation: SlateOperation): string {
  if (operation.op === 'call') return `workspace.slates.${operation.id}.${operation.method}`;

  return 'id' in operation ? `workspace.slates.${operation.id}.$${operation.op}` : `workspace.slates.$${operation.op}`;
}

const READ_ONLY_OPERATIONS: Record<SlateOperation['op'], boolean> = {
  list: true, history: true, inspect: true, shares: true,
  graph: true, liveShares: true, viewerRequests: true, sharedFiles: true,
  preview: false, methods: false, call: false, commit: false, fork: false, restore: false, remove: false, publish: false, unshare: false,
  share: false, save: false, sharedEdit: false,
};

/** Reads run in Plan; the rest change resources or run authored code, as `methods` does by booting the slate. */
export function requireSlateWorkMode(operation: SlateOperation, mode: WorkMode): void {
  requireWorkModePermission(mode, READ_ONLY_OPERATIONS[operation.op], programMember(operation));
}

export interface SlateSummary {
  readonly id: string;
  readonly title: string;
  /** The port its application holds, so the preview listing does not show the slate a second time. */
  readonly port?: number;
}

export interface SlateProblem extends Refusal {
  readonly id: string;
}

export const SLATES_CHANGED_EVENT = 'slates_changed';

/** A directory name for a slate called `title`, free in `/slates`: its words lower-cased and joined by dashes. */
export function slateIdFor(title: string, taken: (id: string) => boolean): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '') || 'page';
  const candidate = (n: number): string => (n === 1 ? base : `${base}-${String(n)}`);
  let n = 1;

  while (taken(candidate(n))) n += 1;

  return candidate(n);
}
