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
      params: Record<string, string> | null;
      code: string;
      score: number;
    }
  | { kind: 'lesson'; text: string }
  | { kind: 'fact'; key: string; value: JsonValue; confidence: number }
  | { kind: 'scaffold'; version: number; rationale: string; code: string };

export interface PublishableCandidate {
  kind: ExperienceKind;
  /** Stable within (source workspace, kind); re-publishing the same key replaces the entry. */
  key: string;
  title: string;
  payload: ExperiencePayload;
  /** One-line local evidence, so the importer judges the claim and not just the text. */
  evidence: string;
}

export interface ExperienceEntry extends PublishableCandidate {
  id: string;
  sourceWorkspace: string;
  publishedAt: number;
}

/** Exactly the text that will land inside the agent, for every kind (memory decays alignment as much as tools). */
export function misevolutionSourceOf(payload: ExperiencePayload): string {
  return payloadText(payload, ': ');
}

function payloadText(payload: ExperiencePayload, factSeparator: string): string {
  switch (payload.kind) {
    case 'craft':
      return `${payload.description}\n${payload.code}`;
    case 'lesson':
      return payload.text;
    case 'fact':
      return `${payload.key}${factSeparator}${JSON.stringify(payload.value)}`;
    case 'scaffold':
      return `${payload.rationale}\n${payload.code}`;
  }
}

export function describePayload(payload: ExperiencePayload, maxChars = 400): string {
  const text = payloadText(payload, ' = ');

  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Materialized into `search_text` so FTS5 ranks over the payload, not just the title. */
export function experienceSearchText(candidate: PublishableCandidate): string {
  return [candidate.title, candidate.key, candidate.evidence, describePayload(candidate.payload, 4000)]
    .join('\n');
}

const ExperiencePayloadSchema: v.GenericSchema<ExperiencePayload> = v.variant('kind', [
  v.object({
    kind: v.literal('craft'),
    name: v.string(),
    description: v.string(),
    params: v.nullable(v.record(v.string(), v.string())),
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
