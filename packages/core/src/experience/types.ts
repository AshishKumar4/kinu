// Shared vocabulary for experience transfer (Agent-KB, arXiv:2507.06229); payloads are stored as one JSON column.

import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { JsonValueSchema, type JsonValue } from '../utils/json';

/** Canonical order: the CHECK constraint and every enum surface derive from this list. */
export const EXPERIENCE_KINDS = ['craft', 'lesson', 'fact', 'scaffold'] as const;

export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

/** `craft.score` is the source's effective EMA at publish time; `scaffold.version` is provenance only (importers renumber). */
export type ExperiencePayload =
  | {
      kind: 'craft';
      name: string;
      description: string;
      code: string;
      score: number;
    }
  | { kind: 'lesson'; text: string }
  | { kind: 'fact'; key: string; value: JsonValue; confidence: number }
  | { kind: 'scaffold'; version: number; rationale: string; code: string };

/** A published entry; its kind is its payload's: `payload.kind` is the one discriminator, and the store's `kind` column
 *  was written from it. */
export interface ExperienceEntry {
  id: string;
  /** Stable within (source workspace, kind). */
  key: string;
  title: string;
  payload: ExperiencePayload;
  /** One-line local evidence, so a reader judges the claim and not just the text. */
  evidence: string;
  sourceWorkspace: string;
  publishedAt: number;
}

const ExperiencePayloadSchema: v.GenericSchema<ExperiencePayload> = v.variant('kind', [
  v.object({
    kind: v.literal('craft'),
    name: v.string(),
    description: v.string(),
    code: v.string(),
    score: v.number(),
  }),
  v.object({ kind: v.literal('lesson'), text: v.string() }),
  v.object({
    kind: v.literal('fact'),
    key: v.string(),
    value: JsonValueSchema,
    confidence: v.number(),
  }),
  v.object({
    kind: v.literal('scaffold'),
    version: v.number(),
    rationale: v.string(),
    code: v.string(),
  }),
]);

/** Null for non-JSON or shape mismatch: malformed rows are skipped, never coerced. */
export function parseExperiencePayload(json: string): ExperiencePayload | null {
  const rawPayload: unknown = tolerate(() => JSON.parse(json), 'malformed-input');

  if (rawPayload === undefined) return null;
  const decoded = v.safeParse(ExperiencePayloadSchema, rawPayload);

  return decoded.success ? decoded.output : null;
}
