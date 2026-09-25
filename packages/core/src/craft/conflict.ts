// CraftStore conflict detection and upsert; see docs/EVOLUTION.md "CraftStore Lifecycle".

import type { AgentRuntime } from '../types/agent-runtime';
import { nowMs } from '../utils/date';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { DEFAULT_CONFIG } from '../config';

interface CraftCandidate {
  name: string;
  description: string;
  code: string;
  score: number;
  /** Null for extracted tools; imported tools carry the source workspace's declaration. */
  params?: Record<string, string> | null;
}

export function checkConflictsBeforeAdding(
  rt: AgentRuntime,
  candidate: CraftCandidate,
) {
  const exact = rt.craftStore.get(candidate.name);

  if (exact) return { conflicting: [candidate.name] };

  const similar = rt.craftStore.search(candidate.description, 5);

  const highSimilarity = similar.filter(t => {
    const overlap = wordOverlap(t.description, candidate.description);

    return overlap > DEFAULT_CONFIG.craftStore.conflictSimilarityThreshold;
  });

  return { conflicting: highSimilarity.map(t => t.name) };
}

// Probes through the executor because codegen is unavailable in the Workers isolate;
// proves only that the source parses to a function, not that it is useful.

async function compilesToCallable(rt: AgentRuntime, code: string): Promise<string | null> {
  const probe =
    `async () => { const candidate = (${code});` +
    ` if (typeof candidate !== 'function') throw new Error('crafted tool code is not a function');` +
    ' return true; }';

  const { error } = await rt.executor.execute(probe, []);

  return error ?? null;
}

/** Rejects on misevolution veto or non-callable code before any write; replaces a conflict only on a better score. */
export async function upsertCraftedTool(
  rt: AgentRuntime,
  candidate: CraftCandidate,
): Promise<{ accepted: boolean; vetoReason?: string }> {
  const misevolution = checkMisevolutionForSurface({ code: candidate.code }, 'craft');

  if (!misevolution.ok) {
    recordMisevolutionVeto(rt.storage.sql, rt.actor, {
      surface: 'craft', violation: misevolution, detail: `extracted tool "${candidate.name}" rejected`,
    });

    return { accepted: false, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
  }

  const compileError = await compilesToCallable(rt, candidate.code);

  if (compileError) {
    return { accepted: false, vetoReason: `Unusable tool code for "${candidate.name}": ${compileError}` };
  }

  const { conflicting } = checkConflictsBeforeAdding(rt, candidate);

  if (conflicting.length > 0) {
    // One statement so body and score never diverge.
    const existingScore = rt.storage.sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = ${conflicting[0]}
    `[0]?.score ?? 0;

    if (candidate.score > existingScore + 0.1) {
      void rt.storage.sql`
        UPDATE crafted_tools
        SET code = ${candidate.code}, description = ${candidate.description},
            params = ${candidate.params == null ? null : JSON.stringify(candidate.params)},
            updated_at = ${nowMs()}, score = ${candidate.score}, last_used_at = ${nowMs()}
        WHERE name = ${conflicting[0]}
      `;
    }

    return { accepted: true };
  }

  // Column defaults seed the neutral prior; the extraction score lands with the first real observation.
  rt.craftStore.create({
    name: candidate.name,
    description: candidate.description,
    params: candidate.params ?? null,
    code: candidate.code,
    scope: 'local',
  });

  return { accepted: true };
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;

  return union === 0 ? 0 : intersection / union;
}
