import * as v from 'valibot';
import { DEV_IDENTITY_HEADER, JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { EVAL_WEB_IDENTITY_ENV } from '@kinu.run/test-utils';

const JsonObjectSchema = v.record(v.string(), JsonValueSchema);

const JsonText = v.pipe(v.string(), v.parseJson(), JsonValueSchema);

/**
 * Shapes the two catch-alls below would take for a credential though nobody keeps them secret, each told from one by its
 * structure: a chess position's piece placement (eight ranks of digits and both cases of letters between slashes, the
 * alphabet of base64), and a run's id, `run-<uuid>`, forty characters, which every ledger row names (7,130 rows of run
 * 37880718948's evidence read `"runId":"<opaque>"`, so no row said which run it belonged to).
 */
const FEN_PLACEMENT = '(?:[1-8pnbrqkPNBRQK]{1,8}/){7}[1-8pnbrqkPNBRQK]{1,8}';

const RUN_ID = 'run-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

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
  [new RegExp(`(?<![A-Za-z0-9+/])(?!${FEN_PLACEMENT}(?![A-Za-z0-9+/]))(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{32,}={0,2}`, 'g'), '<base64>'],
  [new RegExp(`\\b(?!${RUN_ID}\\b)[\\w-]{40,}\\b`, 'g'), '<opaque>'],
];

/** Shorter than this, a value is no credential worth the name, and scrubbing it would scrub words. */
const SHORTEST_SECRET = 8;

/**
 * The credentials a trial may run with, each deployment's browser-plane identity, in every spelling
 * a report could carry one: as written, inside a URL, and inside a JSON string.
 */
export function heldSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const secrets = Object.values(EVAL_WEB_IDENTITY_ENV)
    .map((name) => env[name]?.trim() ?? '')
    .filter((secret) => secret.length >= SHORTEST_SECRET);

  return [...new Set(secrets.flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))];
}

const HELD = heldSecrets(process.env);

/** `text` with the held credential replaced, and nothing else: a kept file stays the workspace's own. */
export function unheld(text: string, held: readonly string[] = HELD): string {
  return held.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, '<secret>'), text);
}

/** `text` with the held credential and every secret-shaped string replaced. */
export function redact(text: string, held: readonly string[] = HELD): string {
  return SECRETS.reduce((scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement), unheld(text, held));
}

/** Every string in a JSON value, scrubbed; keys are the product's own names and stay. */
export function redactJson(value: JsonValue, held: readonly string[] = HELD): JsonValue {
  if (v.is(v.string(), value)) return redact(value, held);

  if (Array.isArray(value)) return value.map((item) => redactJson(item, held));

  if (!v.is(JsonObjectSchema, value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, held)]));
}

/**
 * A JSON text with its string values scrubbed and everything else as written, or the text scrubbed whole when it is not
 * JSON (a file the agent wrote). Pretty when the text spans lines. Scrubbing the serialized text instead reads the `n`
 * of a `\n` escape and the long word after it as one token, and leaves `\<opaque>`, an escape JSON refuses: 22 ledger
 * rows of run 37880718948's evidence.
 */
function redactJsonText(text: string, held: readonly string[]): string {
  const parsed = v.safeParse(JsonText, text);

  if (!parsed.success) return redact(text, held);

  return `${JSON.stringify(redactJson(parsed.output, held), null, text.trim().includes('\n') ? 2 : undefined)}${text.endsWith('\n') ? '\n' : ''}`;
}

/** The text of the file at `path`, scrubbed so a structured file stays one: a `.jsonl` file row by row, a `.json` file whole. */
export function redactFile(path: string, text: string, held: readonly string[] = HELD): string {
  if (path.endsWith('.jsonl')) return text.split('\n').map((row) => row.trim() === '' ? row : redactJsonText(row, held)).join('\n');

  return path.endsWith('.json') ? redactJsonText(text, held) : redact(text, held);
}
