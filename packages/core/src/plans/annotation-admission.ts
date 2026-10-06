// Review annotations as the store admits them.

import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { settleSync } from '../obs/effect';
import { renderThrownChain } from '../obs/index';
import { JsonArraySchema, isJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import type { DiffAnchor, PlanAnnotationMathTarget, PlanAnnotationTextPosition, ReviewAnnotation } from '../types/plans';

export const MAX_PLAN_ANNOTATIONS_BYTES = 256 * 1024;

const PLAN_ANNOTATION_FIELDS = new Set([
  'id', 'blockId', 'startOffset', 'endOffset', 'type', 'text', 'originalText',
  'createdA', 'author', 'startMeta', 'endMeta', 'mathTargets', 'anchor',
]);

const PLAN_ANNOTATION_POSITION_FIELDS = new Set(['parentTagName', 'parentIndex', 'textOffset']);

const PLAN_ANNOTATION_MATH_FIELDS = new Set(['blockId', 'tex', 'displayMode']);

const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());

const StringSchema = v.string();

const BooleanSchema = v.boolean();

const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const NonNegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));

export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

const LineSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const DiffSideSchema = v.picklist(['old', 'new']);

export const DiffAnchorSchema: v.GenericSchema<unknown, DiffAnchor> = v.pipe(
  v.variant('scope', [
    v.strictObject({ scope: v.literal('file'), path: NonEmptyStringSchema, baseline: StringSchema }),
    v.strictObject({
      scope: v.literal('lines'), path: NonEmptyStringSchema, side: DiffSideSchema, lineStart: LineSchema, lineEnd: LineSchema,
      baseline: StringSchema,
    }),
    v.strictObject({
      scope: v.literal('text'), path: NonEmptyStringSchema, side: DiffSideSchema, lineStart: LineSchema, lineEnd: LineSchema,
      charStart: NonNegativeIntegerSchema, charEnd: NonNegativeIntegerSchema, baseline: StringSchema,
    }),
  ]),
  v.check((anchor) => anchor.scope === 'file' || anchor.lineEnd >= anchor.lineStart, 'an anchor ends on or after its first line'),
  v.check((anchor) => anchor.scope !== 'text' || anchor.lineEnd > anchor.lineStart || anchor.charEnd > anchor.charStart,
    'an anchor on words covers at least one character'),
);

interface Refused { readonly error: string }

const refused = (error: string): Effect.Effect<never, Refused> => Effect.fail({ error });

function unsupportedField(value: JsonObject, allowed: ReadonlySet<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function admitTextPosition(value: JsonValue | undefined, field: string): Effect.Effect<PlanAnnotationTextPosition | undefined, Refused> {
  if (value === undefined) return Effect.succeed(undefined);

  if (!isJsonObject(value)) return refused(`${field} must be a text position`);
  const extra = unsupportedField(value, PLAN_ANNOTATION_POSITION_FIELDS);

  if (extra) return refused(`${field} has unsupported field ${extra}`);

  if (!v.is(NonEmptyStringSchema, value.parentTagName)
    || !v.is(NonNegativeIntegerSchema, value.parentIndex)
    || !v.is(NonNegativeIntegerSchema, value.textOffset)) {
    return refused(`${field} must contain a tag and non-negative integer offsets`);
  }

  return Effect.succeed({
    parentTagName: value.parentTagName,
    parentIndex: value.parentIndex,
    textOffset: value.textOffset,
  });
}

function admitMathTargets(value: JsonValue | undefined): Effect.Effect<readonly PlanAnnotationMathTarget[] | undefined, Refused> {
  if (value === undefined) return Effect.succeed(undefined);

  if (!Array.isArray(value)) return refused('mathTargets must be an array');

  return Effect.forEach(value, (target) => {
    if (!isJsonObject(target)) return refused('each math target must be an object');
    const extra = unsupportedField(target, PLAN_ANNOTATION_MATH_FIELDS);

    if (extra) return refused(`mathTargets has unsupported field ${extra}`);

    if (!v.is(NonEmptyStringSchema, target.blockId)
      || !v.is(StringSchema, target.tex)
      || !v.is(BooleanSchema, target.displayMode)) {
      return refused('each math target requires blockId, tex, and displayMode');
    }

    return Effect.succeed({ blockId: target.blockId, tex: target.tex, displayMode: target.displayMode });
  });
}

type Places = Pick<ReviewAnnotation, 'startMeta' | 'endMeta' | 'mathTargets' | 'anchor'>;

function admitPlaces(annotation: JsonObject): Effect.Effect<Places, Refused> {
  return Effect.gen(function* () {
    const startMeta = yield* admitTextPosition(annotation.startMeta, 'startMeta');
    const endMeta = yield* admitTextPosition(annotation.endMeta, 'endMeta');
    const mathTargets = yield* admitMathTargets(annotation.mathTargets);
    const anchor = annotation.anchor === undefined ? undefined : v.safeParse(DiffAnchorSchema, annotation.anchor);

    if (anchor?.success === false) return yield* refused(anchor.issues[0].message);
    const places: { -readonly [K in keyof Places]: Places[K] } = {};

    if (startMeta) places.startMeta = startMeta;

    if (endMeta) places.endMeta = endMeta;

    if (mathTargets) places.mathTargets = mathTargets;

    if (anchor?.success === true) places.anchor = anchor.output;

    return places;
  });
}

function admittedAnnotation(annotation: JsonValue, index: number): Effect.Effect<ReviewAnnotation, Refused> {
  return Effect.gen(function* () {
    if (!isJsonObject(annotation)) return yield* refused(`annotation ${index} must be an object`);
    const extra = unsupportedField(annotation, PLAN_ANNOTATION_FIELDS);

    if (extra) return yield* refused(`annotation ${index} has unsupported field ${extra}`);

    if (!v.is(NonEmptyStringSchema, annotation.id)
      || !v.is(NonEmptyStringSchema, annotation.blockId)) {
      return yield* refused(`annotation ${index} requires id and blockId`);
    }

    if (!v.is(NonNegativeIntegerSchema, annotation.startOffset)
      || !v.is(NonNegativeIntegerSchema, annotation.endOffset)
      || annotation.endOffset < annotation.startOffset) {
      return yield* refused(`annotation ${index} has invalid offsets`);
    }

    const type = annotation.type;

    if (type !== 'DELETION' && type !== 'COMMENT' && type !== 'GLOBAL_COMMENT') {
      return yield* refused(`annotation ${index} has invalid type`);
    }

    if (!v.is(StringSchema, annotation.originalText)
      || !v.is(NonNegativeNumberSchema, annotation.createdA)
      || (annotation.text !== undefined && !v.is(StringSchema, annotation.text))
      || (annotation.author !== undefined && !v.is(StringSchema, annotation.author))) {
      return yield* refused(`annotation ${index} has invalid text or author fields`);
    }

    const places = yield* Effect.mapError(admitPlaces(annotation), (place) => ({ error: `annotation ${index}: ${place.error}` }));

    const admitted: ReviewAnnotation = {
      id: annotation.id,
      blockId: annotation.blockId,
      startOffset: annotation.startOffset,
      endOffset: annotation.endOffset,
      type,
      originalText: annotation.originalText,
      createdA: annotation.createdA,
      ...places,
    };

    if (v.is(StringSchema, annotation.text)) Object.assign(admitted, { text: annotation.text });

    if (v.is(StringSchema, annotation.author)) Object.assign(admitted, { author: annotation.author });

    return admitted;
  });
}

export function admitReviewAnnotations(input: { value: unknown }): Result.Result<ReviewAnnotation[], Refused> {
  return settleSync(Effect.result(Effect.gen(function* () {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(input.value),
      catch: (cause) => ({ error: `annotations must be JSON-serializable: ${renderThrownChain({ cause })}` }),
    });

    if (byteLength(encoded) > MAX_PLAN_ANNOTATIONS_BYTES) return yield* refused('annotations exceed the maximum size of 256 KiB');
    const parsed = v.safeParse(JsonArraySchema, input.value);

    if (!parsed.success) return yield* refused('annotations must be an array');

    return yield* Effect.forEach(parsed.output, (annotation, index) => admittedAnnotation(annotation, index));
  })));
}
