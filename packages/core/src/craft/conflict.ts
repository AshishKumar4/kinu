/**
 * CraftStore conflict detection and upsert.
 *
 * Architecture reference: docs/EVOLUTION.md — "CraftStore Lifecycle"
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { nowMs } from '../utils/date.js';
import { checkMisevolution, recordMisevolutionVeto } from '../scaffold/misevolution.js';
import { DEFAULT_CONFIG } from '../config.js';

interface CraftCandidate {
  name: string;
  description: string;
  code: string;
  score: number;
  /** Declared parameter map. Extraction produces none (the body reads its own
   *  arguments); an imported tool carries the source workspace's declaration. */
  params?: Record<string, string> | null;
}

/** Check for name or semantic conflicts before adding a tool */
export function checkConflictsBeforeAdding(
  rt: AgentRuntime,
  candidate: CraftCandidate,
): { conflicting: string[] } {
  // Name conflict: exact match
  const exact = rt.craftStore.get(candidate.name);
  if (exact) return { conflicting: [candidate.name] };

  // Semantic conflict: FTS5 search for very similar descriptions
  const similar = rt.craftStore.search(candidate.description, 5);
  const highSimilarity = similar.filter(t => {
    const overlap = wordOverlap(t.description, candidate.description);
    return overlap > DEFAULT_CONFIG.craftStore.conflictSimilarityThreshold;
  });

  return { conflicting: highSimilarity.map(t => t.name) };
}

/** Upsert: update existing if conflict found and new score is better, else create.
 *  Extracted tool code passes the fixed misevolution criteria before any write —
 *  a veto rejects the candidate outright (existing tools stay untouched). */
export async function upsertCraftedTool(
  rt: AgentRuntime,
  candidate: CraftCandidate,
): Promise<{ accepted: boolean; vetoReason?: string }> {
  const misevolution = checkMisevolution(candidate.code);
  if (!misevolution.ok) {
    recordMisevolutionVeto(rt.storage.sql, {
      surface: 'craft', violation: misevolution, detail: `extracted tool "${candidate.name}" rejected`,
    });
    return { accepted: false, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
  }

  const { conflicting } = checkConflictsBeforeAdding(rt, candidate);

  if (conflicting.length > 0) {
    // Update existing tool if new code scores significantly better
    const existingScore = rt.storage.sql<{ score: number }>`
      SELECT score FROM craft_scores WHERE tool_name = ${conflicting[0]!}
    `[0];
    if (!existingScore || candidate.score > existingScore.score + 0.1) {
      rt.craftStore.update(conflicting[0]!, {
        code: candidate.code,
        description: candidate.description,
        ...(candidate.params !== undefined ? { params: candidate.params } : {}),
      });
      rt.storage.sql`
        UPDATE craft_scores SET score = ${candidate.score}, last_used_at = ${nowMs()}
        WHERE tool_name = ${conflicting[0]!}
      `;
    }
    return { accepted: true };
  }

  rt.craftStore.create({
    name: candidate.name,
    description: candidate.description,
    params: candidate.params ?? null,
    code: candidate.code,
    scope: 'local',
  });
  rt.storage.sql`
    INSERT INTO craft_scores (tool_name, score, uses, last_used_at)
    VALUES (${candidate.name}, ${candidate.score}, 0, ${nowMs()})
  `;
  return { accepted: true };
}

/** Word overlap ratio between two strings (Jaccard-like) */
function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}
