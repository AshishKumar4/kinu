/** Replaces minted ids and clock readings by order of appearance; shared by local and hosted parity tests. */
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const STEER = /\bsteer-[A-Za-z0-9_-]{12}\b/g;

const CLOCK_KEY = /(?:At|Ms|_at|_ms|timestamp)$/;

export interface ParityNormalizer {
  /** Every uuid and steer id inside a string, by order of appearance. */
  text(value: string): string;
  /** A JSON value walked: strings normalized, clock-named numbers blanked. */
  json(value: JsonValue): JsonValue;
  /** A whole-column id with no recognisable shape (event-log id, trace id). */
  opaque(value: string | null, kind: string): string | null;
}

export function parityNormalizer(): ParityNormalizer {
  const seen = new Map<string, string>();

  const name = (id: string, kind: string): string => {
    const known = seen.get(id);

    if (known !== undefined) return known;
    const minted = `<${kind}#${String(seen.size + 1)}>`;
    seen.set(id, minted);

    return minted;
  };

  const text = (value: string): string =>
    value.replace(UUID, (id) => name(id, 'uuid')).replace(STEER, (id) => name(id, 'steer'));

  const json = (value: JsonValue): JsonValue => {
    if (v.is(v.string(), value)) return text(value);

    if (Array.isArray(value)) return value.map(json);

    if (v.is(v.record(v.string(), JsonValueSchema), value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, CLOCK_KEY.test(key) && (v.is(v.number(), entry) || v.is(v.string(), entry)) ? '<clock>' : json(entry)]));
    }

    return value;
  };

  return {
    text,
    json,
    opaque: (value, kind) => value === null ? null : name(value, kind),
  };
}
