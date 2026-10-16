/**
 * A function's input contract: what its one argument may be, as a slate declares it per function in its package.json
 * (`slate.functions.<fn>.input`). A lend admits only input inside it (the model's `dom`).
 */
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';

/**
 * A bounded data-only codec for a lent function's input: what reaches the function is checked against it at admission
 * (the model's `dom`). `text`, `json` and `any` take free input; `any` is what a function that declares no contract
 * takes: whatever its call carries.
 */
export type Codec =
  | { readonly kind: 'any' }
  | { readonly kind: 'none' }
  | { readonly kind: 'enum'; readonly values: readonly (string | number | boolean)[] }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'text'; readonly maxLength: number }
  | { readonly kind: 'json'; readonly maxBytes: number };

export const CodecSchema: v.GenericSchema<Codec> = v.variant('kind', [
  v.object({ kind: v.literal('any') }),
  v.object({ kind: v.literal('none') }),
  v.object({ kind: v.literal('enum'), values: v.array(v.union([v.string(), v.number(), v.boolean()])) }),
  v.object({ kind: v.literal('integer'), min: v.number(), max: v.number() }),
  v.object({ kind: v.literal('text'), maxLength: v.number() }),
  v.object({ kind: v.literal('json'), maxBytes: v.number() }),
]);

/** What a function that declares no contract takes. */
export const UNDECLARED: Codec = { kind: 'any' };

/** Takes free input: what someone types reaches the service. */
export function codecIsFree(codec: Codec): boolean {
  return codec.kind === 'text' || codec.kind === 'json' || codec.kind === 'any';
}

/** The model's `dom.contains arg`. */
export function codecAdmits(codec: Codec, input: JsonValue): boolean {
  switch (codec.kind) {
    case 'any': return true;
    case 'none': return input === null;
    case 'enum': return codec.values.some((value) => value === input);
    case 'integer': return typeof input === 'number' && Number.isInteger(input) && input >= codec.min && input <= codec.max;
    case 'text': return typeof input === 'string' && input.length <= codec.maxLength;
    case 'json': return new TextEncoder().encode(JSON.stringify(input)).length <= codec.maxBytes;
  }
}
