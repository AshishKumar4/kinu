/**
 * Canonical scaffold-safety patterns — the single source of truth.
 *
 * These gate what agent-authored scaffold (and GEPA-proposed scaffold)
 * source is allowed to contain. They were previously copy-pasted across
 * scaffold/modify.ts, evolution/gepa/scaffold-bridge.ts, and
 * evolution/gepa/tool-bridge.ts — a security blocklist that would drift
 * the moment one copy was edited. Import from here instead.
 *
 * Formal spec: ScaffoldSafety.lean — structural_gate_no_import.
 */

/** Constructs the scaffold sandbox must never reference — module loaders,
 *  the global object, and dynamic code-gen escape hatches. */
export const SCAFFOLD_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\b(require|import)\s*[\w("']/,
  /\bglobalThis\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
];

/** A scaffold must export the generator entry point `async function* run(rt, task)`. */
export const SCAFFOLD_REQUIRED_SIGNATURE = /async\s+function\s*\*\s*run\s*\(rt\s*,\s*task\s*\)/;

/** Human-readable list of the forbidden constructs — for prompt text that
 *  tells an LLM what it may not emit, so the prose can't drift from the
 *  enforced regexes. */
export const SCAFFOLD_FORBIDDEN_DESCRIPTION =
  'require/import, globalThis, eval(), and Function()';
