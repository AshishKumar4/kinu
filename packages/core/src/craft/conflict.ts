/**
 * CraftStore conflict detection and upsert.
 *
 * Architecture reference: docs/EVOLUTION.md — "CraftStore Lifecycle"
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { nowMs } from '../utils/date';
import { checkMisevolution, recordMisevolutionVeto } from '../scaffold/misevolution';
import { DEFAULT_CONFIG } from '../config';

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
) {
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

/**
 * Compile the candidate exactly the way the runtime will, and require a
 * callable back.
 *
 * A crafted tool is invoked by compiling its stored source into a function and
 * calling it (CLI: `new Function('return (' + code + ')')`; CF: the same
 * expression spliced into the sandbox). Until this gate existed the ONLY
 * admission test was "has a name, and does not start with `//`" — so an LLM
 * that answered the extraction prompt with a statement fragment, prose, or an
 * expression that throws the moment it is evaluated got that stored as a tool,
 * seeded with a score, and offered to every later turn. Observed in production:
 * a stored "tool" whose body was `await ({ runtime })(command)`.
 *
 * The probe runs through the execution seam rather than in core, for the same
 * reason the scaffold parse gate does: codegen is unavailable in the Workers
 * isolate but available inside every executor, so this is the one place the
 * check can run on both backends. Evaluating the candidate expression is not a
 * new exposure — it is the identical evaluation the first call would do, moved
 * ahead of the write, in the same sandbox.
 *
 * What it proves: the source parses, and it denotes a function. What it cannot
 * prove is that calling that function does anything useful — that is what the
 * invocation-grounded fitness in craft/in-episode.ts is for.
 */
async function compilesToCallable(rt: AgentRuntime, code: string): Promise<string | null> {
  const probe =
    `async () => { const candidate = (${code});` +
    ` if (typeof candidate !== 'function') throw new Error('crafted tool code is not a function');` +
    ' return true; }';
  const { error } = await rt.executor.execute(probe, []);
  return error ?? null;
}

/** Upsert: update existing if conflict found and new score is better, else create.
 *  Candidate code passes the fixed misevolution criteria AND compiles to a
 *  callable before any write — either rejection drops the candidate outright
 *  (existing tools stay untouched). */
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

  const compileError = await compilesToCallable(rt, candidate.code);
  if (compileError) {
    return { accepted: false, vetoReason: `Unusable tool code for "${candidate.name}": ${compileError}` };
  }

  const { conflicting } = checkConflictsBeforeAdding(rt, candidate);

  if (conflicting.length > 0) {
    // Replace the existing tool only if the new code scores significantly
    // better. ONE statement: content and quality move together, so a half-
    // written tool (new body, stale score — or the reverse) is impossible.
    const existingScore = rt.storage.sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = ${conflicting[0]!}
    `[0]?.score ?? 0;
    if (candidate.score > existingScore + 0.1) {
      void rt.storage.sql`
        UPDATE crafted_tools
        SET code = ${candidate.code}, description = ${candidate.description},
            params = ${candidate.params == null ? null : JSON.stringify(candidate.params)},
            updated_at = ${nowMs()}, score = ${candidate.score}, last_used_at = ${nowMs()}
        WHERE name = ${conflicting[0]!}
      `;
    }
    return { accepted: true };
  }

  // Creation seeds the neutral prior through the column defaults inside the
  // store's own INSERT — one statement, no second write to race it. The
  // extraction's own score lands with the first real observation.
  rt.craftStore.create({
    name: candidate.name,
    description: candidate.description,
    params: candidate.params ?? null,
    code: candidate.code,
    scope: 'local',
  });
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
