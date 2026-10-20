// CraftStore conflict detection and upsert; see docs/EVOLUTION.md "CraftStore Lifecycle".

import type { AgentRuntime } from '../types/agent-runtime';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { DEFAULT_CONFIG } from '../config';
import { isReservedCraftToolName } from './in-episode';
import { admitCraftedSource } from './source';

interface CraftCandidate {
  name: string;
  description: string;
  code: string;
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

/**
 * Rejects a reserved name, source that is not one expression, a misevolution veto or non-callable code before any
 * write, as `workspace.createTool` admits a tool; replaces a conflicting tool only while it is broken, which the
 * rewrite clears.
 */
export async function upsertCraftedTool(
  rt: AgentRuntime,
  extracted: CraftCandidate,
): Promise<{ accepted: boolean; vetoReason?: string }> {
  if (isReservedCraftToolName(extracted.name)) {
    return { accepted: false, vetoReason: `Tool name "${extracted.name}" is reserved: it collides with a built-in tool or the mcp_ prefix owned by MCP tools` };
  }

  const admitted = admitCraftedSource(extracted.code, extracted.name);

  if (!admitted.ok) return { accepted: false, vetoReason: `Unusable tool code for "${extracted.name}": ${admitted.error}` };
  const candidate = { ...extracted, code: admitted.code };
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
    const [existing] = conflicting;
    // A working tool is the agent's own; a pattern that keeps working replaces one that raises.
    const broken = rt.storage.sql<{ broken: string | null }>`SELECT broken FROM crafted_tools WHERE name = ${existing}`[0]?.broken ?? null;

    if (existing !== undefined && broken !== null) rt.craftStore.update(existing, { code: candidate.code, description: candidate.description });

    return { accepted: true };
  }

  rt.craftStore.create({
    name: candidate.name,
    description: candidate.description,
    code: candidate.code,
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
