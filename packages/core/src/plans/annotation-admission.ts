// Review annotations as the store admits them: the one schema the plan review, the diff notes and their clients share.

import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { settleSync } from '../obs/effect';
import { renderThrownChain } from '../obs/index';
import type { DiffAnchor, NoteReply, ReviewAnnotation } from '../types/plans';

export const MAX_PLAN_ANNOTATIONS_BYTES = 256 * 1024;

const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());

const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const NonNegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));

export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

const LineSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const DiffSideSchema = v.picklist(['old', 'new']);

export const DiffAnchorSchema: v.GenericSchema<unknown, DiffAnchor> = v.pipe(
  v.variant('scope', [
    v.strictObject({ scope: v.literal('file'), path: NonEmptyStringSchema, baseline: v.string() }),
    v.strictObject({
      scope: v.literal('lines'), path: NonEmptyStringSchema, side: DiffSideSchema, lineStart: LineSchema, lineEnd: LineSchema,
      baseline: v.string(),
    }),
    v.strictObject({
      scope: v.literal('text'), path: NonEmptyStringSchema, side: DiffSideSchema, lineStart: LineSchema, lineEnd: LineSchema,
      charStart: NonNegativeIntegerSchema, charEnd: NonNegativeIntegerSchema, baseline: v.string(),
    }),
  ]),
  v.check((anchor) => anchor.scope === 'file' || anchor.lineEnd >= anchor.lineStart, 'an anchor ends on or after its first line'),
  v.check((anchor) => anchor.scope !== 'text' || anchor.lineEnd > anchor.lineStart || anchor.charEnd > anchor.charStart,
    'an anchor on words covers at least one character'),
);

const TextPositionSchema = v.strictObject({
  parentTagName: NonEmptyStringSchema, parentIndex: NonNegativeIntegerSchema, textOffset: NonNegativeIntegerSchema,
});

const MathTargetSchema = v.strictObject({ blockId: NonEmptyStringSchema, tex: v.string(), displayMode: v.boolean() });

const noteFields = {
  id: NonEmptyStringSchema,
  createdA: NonNegativeNumberSchema,
  revision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
};

const PassageNoteSchema = v.pipe(
  v.strictObject({
    ...noteFields,
    type: v.picklist(['COMMENT', 'DELETION']),
    blockId: NonEmptyStringSchema,
    startOffset: NonNegativeIntegerSchema,
    endOffset: NonNegativeIntegerSchema,
    originalText: v.string(),
    text: v.optional(v.string()),
    author: v.optional(v.string()),
    startMeta: v.optional(TextPositionSchema),
    endMeta: v.optional(TextPositionSchema),
    mathTargets: v.optional(v.array(MathTargetSchema)),
    anchor: v.optional(DiffAnchorSchema),
  }),
  v.check((note) => note.endOffset >= note.startOffset, 'invalid offsets: the end comes before the start'),
);

const GeneralNoteSchema = v.strictObject({
  ...noteFields,
  type: v.literal('GLOBAL_COMMENT'),
  text: NonEmptyStringSchema,
  author: v.optional(v.string()),
});

const NoteReplySchema = v.strictObject({
  ...noteFields,
  type: v.literal('REPLY'),
  inReplyTo: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  author: v.picklist(['owner', 'agent']),
});

/** One annotation. A passage note has its block, offsets and quote; a general note and a reply have none. */
export const ReviewAnnotationSchema: v.GenericSchema<unknown, ReviewAnnotation> = v.variant(
  'type', [PassageNoteSchema, GeneralNoteSchema, NoteReplySchema], 'invalid type: a note is a COMMENT, DELETION, GLOBAL_COMMENT or REPLY',
);

interface Refused { readonly error: string }

function issueText(issue: v.BaseIssue<unknown>): string {
  const key = issue.path?.map((item) => String(item.key)).join('.');

  if (issue.type === 'strict_object' && issue.expected === 'never') return `unsupported field ${key ?? ''}`.trim();

  return key === undefined ? issue.message : `${key}: ${issue.message}`;
}

/** Ids are unique, and a reply answers a note in the same list that is not itself a reply. */
function threadRefusal(notes: readonly ReviewAnnotation[]): string | null {
  const roots = new Set<string>();
  const seen = new Set<string>();

  for (const note of notes) {
    if (seen.has(note.id)) return `annotation id ${note.id} appears twice`;
    seen.add(note.id);

    if (note.type !== 'REPLY') roots.add(note.id);
  }

  const stray = notes.find((note): note is NoteReply => note.type === 'REPLY' && !roots.has(note.inReplyTo));

  return stray === undefined ? null : `reply ${stray.id} answers ${stray.inReplyTo}, which is not a note here`;
}

/** `kept`: notes already admitted beside these, which their replies may answer and their ids must not repeat. */
export function admitReviewAnnotations(input: { value: unknown; kept?: readonly ReviewAnnotation[] }): Result.Result<ReviewAnnotation[], Refused> {
  return settleSync(Effect.result(Effect.gen(function* () {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(input.value),
      catch: (cause) => ({ error: `annotations must be JSON-serializable: ${renderThrownChain({ cause })}` }),
    });

    if (byteLength(encoded) > MAX_PLAN_ANNOTATIONS_BYTES) return yield* Effect.fail({ error: 'annotations exceed the maximum size of 256 KiB' });

    if (!Array.isArray(input.value)) return yield* Effect.fail({ error: 'annotations must be an array' });
    const values: readonly unknown[] = input.value;

    const notes = yield* Effect.forEach(values, (value, index) => {
      const parsed = v.safeParse(ReviewAnnotationSchema, value);

      return parsed.success ? Effect.succeed(parsed.output) : Effect.fail({ error: `annotation ${index}: ${issueText(parsed.issues[0])}` });
    });

    const refusal = threadRefusal([...(input.kept ?? []), ...notes]);

    return refusal === null ? notes : yield* Effect.fail({ error: refusal });
  })));
}
