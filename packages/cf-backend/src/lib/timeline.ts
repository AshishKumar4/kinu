/**
 * Run Timeline projection — pure functions that normalize the agent's three
 * event sources (durable run_events, evolution_events, MCTS search_nodes) into
 * the single ordered TimelineSpan shape the spine renders. Kept pure +
 * separate from the Durable Object so they are unit-testable without booting
 * the agent (see lib/timeline.test.ts).
 */

import type { RunEvent } from "@proteus/core";
import type { TimelineSpan, TimelineKind } from "./protocol.js";

export function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Map a crafted/builtin tool name to a timeline kind. */
export function toolKindFor(name: string): TimelineKind {
  if (name === "run") return "runtime-exec";
  if (name === "think") return "mcts";
  if (name === "skills") return "skills";
  return "tool-call";
}

/** Map an evolution_events.type to a timeline kind. */
export function classifyEvolutionType(type: string): TimelineKind {
  if (type === "turn_complete") return "llm-turn";
  if (type === "reflection") return "reflection";
  if (type.startsWith("scaffold")) return "scaffold";
  if (type.startsWith("mcts")) return "mcts";
  if (type === "consolidation" || type === "craft_discovered") return "craft";
  if (type === "fiber_recovered") return "recovery";
  if (type.startsWith("gepa")) return "gepa";
  if (type.startsWith("curriculum")) return "curriculum";
  return "other";
}

/** Project a durable RunEvent onto a unified TimelineSpan. */
export function runEventToSpan(e: RunEvent): TimelineSpan {
  const ts = Date.parse(e.timestamp) || Date.now();
  const base = { ts, source: "run" as const, rawType: e.type };
  switch (e.type) {
    case "run_start":
      return { ...base, kind: "trigger", label: "Run started", detail: e.userMessage };
    case "turn_start":
      return { ...base, kind: "llm-turn", label: `Turn ${e.turnIndex}` };
    case "tool_call_start":
      return { ...base, kind: toolKindFor(e.name), label: e.name, refId: e.toolCallId };
    case "tool_call_end":
      return {
        ...base, kind: toolKindFor(e.name), label: e.error ? `${e.name} failed` : e.name,
        detail: e.error, elapsedMs: e.durationMs, refId: e.toolCallId,
      };
    case "step_finish":
      return { ...base, kind: "llm-turn", label: `Step ${e.stepIndex}`, detail: e.reason };
    case "head_split":
      return { ...base, kind: "head-split", label: "Heads split", detail: e.rationale, data: { rootId: e.rootId, headIds: e.headIds }, refId: e.rootId };
    case "head_merge":
      return { ...base, kind: "head-merge", label: `Heads merged (${e.headCount})`, detail: e.mergedNarrative?.slice(0, 200), refId: e.rootId };
    case "scaffold_promotion":
      return { ...base, kind: "scaffold", label: `Scaffold promoted v${e.fromVersion} → v${e.toVersion}` };
    case "scaffold_rollback":
      return { ...base, kind: "scaffold", label: `Scaffold rolled back v${e.fromVersion} → v${e.toVersion}` };
    case "memory_write":
      return { ...base, kind: "craft", label: "Memory write", detail: `${e.path} (${e.bytes}b)` };
    case "fiber_recovered":
      return { ...base, kind: "recovery", label: `Recovered fiber "${e.fiberName}"` };
    case "error":
      return { ...base, kind: "error", label: "Error", detail: e.message };
    case "turn_end":
      return { ...base, kind: "llm-turn", label: `Turn ${e.turnIndex} done`, detail: e.tokenUsage ? `${e.tokenUsage.input}+${e.tokenUsage.output} tok` : undefined };
    case "run_end":
      return { ...base, kind: e.reason === "aborted" ? "abort" : "other", label: e.reason ? `Run ended (${e.reason})` : "Run ended" };
    default:
      return { ...base, kind: "other", label: (e as { type: string }).type };
  }
}
