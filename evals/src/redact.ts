import * as v from 'valibot';
import { DEV_IDENTITY_HEADER, JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { PUBLIC_IDENTITY_ENV } from './session';

const JsonObjectSchema = v.record(v.string(), JsonValueSchema);

/**
 * The repository is public, so text a trial produced is scrubbed before it is stored or posted:
 * preview hosts carry a capability, and a tool error can echo a header. Patterns catch the
 * formats a secret usually has; the credential this process holds is caught by value, whatever
 * alphabet it is written in.
 */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\.kinu\.run\b/gi, '<preview>.kinu.run'],
  [/\bBearer\s+[\w.~+/=-]+/g, 'Bearer <redacted>'],
  [new RegExp(`(${DEV_IDENTITY_HEADER}["']?\\s*[:=]\\s*["']?)[^\\s"',;]+`, 'gi'), '$1<secret>'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt>'],
  [/\b(?:sk|pk|ptc|kinu|ghp|gho|github_pat)_[\w-]{12,}/g, '<token>'],
  [/\b[0-9a-f]{32,}\b/gi, '<hex>'],
  // Base64 splits into short words at `+`, `/` and `=`, so it is matched as one run of its own
  // alphabet that mixes both cases and digits, as random bytes do and paths and prose do not.
  [/(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{32,}={0,2}/g, '<base64>'],
  [/\b[\w-]{40,}\b/g, '<opaque>'],
];

/** Shorter than this, a value is no credential worth the name, and scrubbing it would scrub words. */
const SHORTEST_SECRET = 8;

/**
 * The credential a trial runs with, the eval-service's browser-plane identity, in every spelling
 * a report could carry it: as written, inside a URL, and inside a JSON string.
 */
export function heldSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const secret = env[PUBLIC_IDENTITY_ENV]?.trim() ?? '';

  if (secret.length < SHORTEST_SECRET) return [];

  return [...new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])];
}

const HELD = heldSecrets(process.env);

/** `text` with the held credential and every secret-shaped string replaced. */
export function redact(text: string, held: readonly string[] = HELD): string {
  const unheld = held.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, '<secret>'), text);

  return SECRETS.reduce((scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement), unheld);
}

/** Every string in a JSON value, scrubbed; keys are the product's own names and stay. */
export function redactJson(value: JsonValue, held: readonly string[] = HELD): JsonValue {
  if (v.is(v.string(), value)) return redact(value, held);

  if (Array.isArray(value)) return value.map((item) => redactJson(item, held));

  if (!v.is(JsonObjectSchema, value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, held)]));
}
