/**
 * The View spec — a declarative dashboard the agent authors and the host draws.
 *
 * The bet this file encodes: the agent supplies DATA describing a layout, never
 * code and never markup. Everything a spec can say is a member of a fixed
 * vocabulary that maps onto components the host already ships, so the security
 * review happens once, here, and holds for every view the agent will ever
 * write. There is no `html` block, no `script`, no `iframe`, no `img`, and no
 * field anywhere in the schema that carries a URL — which is why the renderer
 * needs no sanitiser and the app keeps its "no HTML-injection sink" property
 * (see `cf-backend/src/lib/security-headers.ts`).
 *
 * There is also no interactive control in the vocabulary. A view cannot draw a
 * button, a form, an input or a link, so it cannot draw something that looks
 * like an Approve control. That is an absence in the type, not a rule a
 * reviewer has to keep enforcing.
 *
 * Validation is fail-closed: `v.strictObject` rejects unknown keys rather than
 * stripping them, so a spec written against a vocabulary we do not have is an
 * error the model sees, not a silently half-rendered page.
 */

import * as v from 'valibot';
import { RESERVED_VIEW_TITLES, VIEW_DATA_SOURCES, normalizeViewTitle } from './sources.js';

/** Bumped only when an old spec would render wrongly under new rules. */
export const VIEW_SPEC_VERSION = 1;

/** Bounds. Every one of these is a denial-of-service answer as much as a taste
 *  judgement: the renderer walks whatever the spec contains. */
export const VIEW_LIMITS = {
  titleChars: 48,
  labelChars: 64,
  markdownChars: 4000,
  blocks: 24,
  sectionBlocks: 12,
  columns: 8,
  kvRows: 16,
  rows: 200,
  specBytes: 32_768,
} as const;

/** A dotted read path into an RPC result. No indexing, no wildcards, no
 *  prototype rungs — the resolver refuses those again at read time, but a spec
 *  that names one never gets stored. */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

const dataPath = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'path must be dotted field names'),
  v.maxLength(120),
  v.check(
    (value) => value.split('.').every((part) => !FORBIDDEN_PATH_SEGMENTS.has(part)),
    'path may not walk the prototype chain',
  ),
);

const label = v.pipe(v.string(), v.minLength(1), v.maxLength(VIEW_LIMITS.labelChars));

const SourceSchema = v.strictObject({
  rpc: v.picklist(VIEW_DATA_SOURCES, 'unknown data source'),
  /** Row budget for sources that take one. Clamped here, again at call time. */
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(VIEW_LIMITS.rows))),
  /** Where inside the result the block's data lives. Omitted = the whole result. */
  path: v.optional(dataPath),
});

const ColumnSchema = v.strictObject({
  field: dataPath,
  label,
  /** How the cell is drawn. Every arm is host-owned chrome. */
  as: v.optional(v.picklist(['text', 'number', 'badge', 'time'])),
});

const StatBlock = v.strictObject({
  type: v.literal('stat'),
  label,
  source: SourceSchema,
  /** `count` counts an array; `value` prints a scalar. */
  agg: v.optional(v.picklist(['count', 'value'])),
  suffix: v.optional(v.pipe(v.string(), v.maxLength(12))),
});

const TableBlock = v.strictObject({
  type: v.literal('table'),
  title: v.optional(label),
  source: SourceSchema,
  columns: v.pipe(v.array(ColumnSchema), v.minLength(1), v.maxLength(VIEW_LIMITS.columns)),
});

const ListBlock = v.strictObject({
  type: v.literal('list'),
  title: v.optional(label),
  source: SourceSchema,
  /** Which field of each row to print. Omitted = the row itself, stringified. */
  field: v.optional(dataPath),
});

const KvBlock = v.strictObject({
  type: v.literal('kv'),
  title: v.optional(label),
  source: SourceSchema,
  rows: v.pipe(v.array(ColumnSchema), v.minLength(1), v.maxLength(VIEW_LIMITS.kvRows)),
});

const MarkdownBlock = v.strictObject({
  type: v.literal('markdown'),
  /** Rendered through the app's existing `MarkdownContent`: remark-gfm only,
   *  no rehype-raw, so embedded HTML is escaped rather than parsed. */
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(VIEW_LIMITS.markdownChars)),
});

/** Leaves are everything that draws data. Sections group leaves and nothing
 *  else — one level, so the renderer's recursion is bounded by the type rather
 *  than by a depth counter. */
const LeafBlockSchema = v.variant('type', [StatBlock, TableBlock, ListBlock, KvBlock, MarkdownBlock]);

const SectionBlock = v.strictObject({
  type: v.literal('section'),
  title: label,
  blocks: v.pipe(v.array(LeafBlockSchema), v.minLength(1), v.maxLength(VIEW_LIMITS.sectionBlocks)),
});

const BlockSchema = v.variant('type', [
  StatBlock, TableBlock, ListBlock, KvBlock, MarkdownBlock, SectionBlock,
]);

export const ViewSpecSchema = v.strictObject({
  v: v.literal(VIEW_SPEC_VERSION),
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(VIEW_LIMITS.titleChars),
    v.check(
      (value) => !RESERVED_VIEW_TITLES.includes(normalizeViewTitle(value)),
      'that title belongs to a surface the host owns',
    ),
  ),
  /** One line under the tab title. Not required; not a place for instructions. */
  subtitle: v.optional(v.pipe(v.string(), v.maxLength(VIEW_LIMITS.labelChars * 2))),
  blocks: v.pipe(v.array(BlockSchema), v.minLength(1), v.maxLength(VIEW_LIMITS.blocks)),
  /** Auto-refresh cadence. Floored so a view cannot become a request loop. */
  refreshMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(5_000), v.maxValue(3_600_000))),
});

export type ViewSpec = v.InferOutput<typeof ViewSpecSchema>;
export type ViewBlock = v.InferOutput<typeof BlockSchema>;
export type ViewLeafBlock = v.InferOutput<typeof LeafBlockSchema>;
export type ViewSource = v.InferOutput<typeof SourceSchema>;
export type ViewColumn = v.InferOutput<typeof ColumnSchema>;

export type ViewSpecResult =
  | { ok: true; spec: ViewSpec }
  | { ok: false; error: string };

/**
 * Parse an untrusted value into a spec.
 *
 * Called at write time so a bad spec is the model's problem, and again at read
 * time because the VFS the live spec sits in is agent-writable — the same
 * reason `applyPromotionDecision` re-runs the misevolution check against
 * on-disk scaffold code instead of trusting what it accepted earlier.
 */
export function parseViewSpec(input: unknown): ViewSpecResult {
  const result = v.safeParse(ViewSpecSchema, input);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.map((p) => String(p.key)).join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    return { ok: false, error: `view spec invalid — ${issues}` };
  }
  return { ok: true, spec: result.output };
}

/** Read a dotted path out of an RPC result. Returns `undefined` rather than
 *  throwing: a source whose shape moved should leave a blank cell, not break
 *  the surface. Guards the prototype chain a second time — cheap, and the spec
 *  on disk is agent-writable. */
export function resolveViewPath(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
