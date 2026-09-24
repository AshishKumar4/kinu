import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';

const JsonObjectSchema = v.record(v.string(), JsonValueSchema);

/**
 * The repository is public, so text a trial produced is scrubbed before it is stored or posted:
 * preview hosts carry a capability, and a tool error can echo a header.
 */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\.kinu\.run\b/gi, '<preview>.kinu.run'],
  [/\bBearer\s+[\w.~+/=-]+/g, 'Bearer <redacted>'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt>'],
  [/\b(?:sk|pk|ptc|kinu|ghp|gho|github_pat)_[\w-]{12,}/g, '<token>'],
  [/\b[0-9a-f]{32,}\b/gi, '<hex>'],
  [/\b[\w-]{40,}\b/g, '<opaque>'],
];

export function redact(text: string): string {
  return SECRETS.reduce((scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement), text);
}

/** Every string in a JSON value, scrubbed; keys are the product's own names and stay. */
export function redactJson(value: JsonValue): JsonValue {
  if (v.is(v.string(), value)) return redact(value);

  if (Array.isArray(value)) return value.map(redactJson);

  if (!v.is(JsonObjectSchema, value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]));
}
