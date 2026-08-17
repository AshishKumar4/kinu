/**
 * Cross-workspace experience transfer — the shared vocabulary.
 *
 * Agent-KB (arXiv:2507.06229) is the evidence that experience transfers
 * between agents at all: a shared hierarchical knowledge base moved GAIA and
 * SWE-bench by double digits, and auto-refined knowledge nearly matched
 * hand-written knowledge. Proteus already earns three kinds of experience per
 * workspace and shares none of it — crafted tools, corroborated lessons, and
 * keyed facts.
 *
 * Three kinds, one row shape. The payload is a discriminated union so a
 * consumer never has to guess which columns are meaningful for which kind, and
 * the library stores it as one JSON column rather than a sparse table.
 */

import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '../utils/json.js';

/** The kinds of experience a workspace can transfer. Order is the canonical
 *  one — the CHECK constraint and every enum surface derive from this list. */
export const EXPERIENCE_KINDS = ['craft', 'lesson', 'fact'] as const;

export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

/** The transferable content, per kind.
 *
 *  `craft.score` is the source workspace's effective EMA at publish time; the
 *  importing side uses it as the conflict-resolution score, exactly as an
 *  extracted tool's own score is used. */
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
  | { kind: 'fact'; key: string; value: JsonValue; confidence: number };

/** What a workspace offers the owner's library, before the library stamps
 *  identity and provenance onto it. */
export interface PublishableCandidate {
  kind: ExperienceKind;
  /** Stable within (source workspace, kind): the craft name, the fact key, or
   *  the lesson's ledger id. Re-publishing the same key replaces the entry. */
  key: string;
  title: string;
  payload: ExperiencePayload;
  /** The local evidence that made this publishable, in one line. Travels with
   *  the entry so the importing agent judges the claim, not just the text. */
  evidence: string;
}

/** A published entry in the owner's library. */
export interface ExperienceEntry extends PublishableCandidate {
  id: string;
  sourceWorkspace: string;
  publishedAt: number;
}

/** The text the misevolution gate reads for an entry.
 *
 *  Every kind is included, not just crafted code: the paper's thesis is that
 *  alignment decays through the agent's MEMORY and prompts as much as through
 *  its tools, and an imported lesson lands in MEMORY.md while an imported fact
 *  lands in the per-turn facts block. The gate is a textual tripwire, so it
 *  reads exactly the text that will end up inside this agent. */
export function misevolutionSourceOf(payload: ExperiencePayload): string {
  switch (payload.kind) {
    case 'craft':
      return `${payload.description}\n${payload.code}`;
    case 'lesson':
      return payload.text;
    case 'fact':
      return `${payload.key}: ${JSON.stringify(payload.value)}`;
  }
}

/** A short human/LLM-readable rendering of the payload — what a search hit
 *  shows so the agent can judge an entry before importing it. */
export function describePayload(payload: ExperiencePayload, maxChars = 400): string {
  const text = payload.kind === 'craft'
    ? `${payload.description}\n${payload.code}`
    : payload.kind === 'lesson'
      ? payload.text
      : `${payload.key} = ${JSON.stringify(payload.value)}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Free-text projection of an entry, materialized into the library's
 *  `search_text` column so FTS5 ranks over the payload and not just the title. */
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
]);

/** Parse a stored payload back into its union. Returns null for anything that
 *  does not match the kind's shape — a malformed row is skipped, never coerced
 *  into a half-populated craft. Text that is not JSON at all is storage
 *  corruption rather than a row shape, and propagates. */
export function parseExperiencePayload(json: string): ExperiencePayload | null {
  const rawPayload: unknown = JSON.parse(json);
  const decoded = v.safeParse(ExperiencePayloadSchema, rawPayload);
  return decoded.success ? decoded.output : null;
}
