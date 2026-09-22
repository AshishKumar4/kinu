/** Scaffold-safety patterns shared by scaffold/modify.ts and evolution/gepa/scaffold-bridge.ts. */

/** Module loaders, the global object, and dynamic code-gen escape hatches. */
export const SCAFFOLD_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\b(require|import)\s*[\w("']/,
  /\bglobalThis\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
];

export const SCAFFOLD_REQUIRED_SIGNATURE = /async\s+function\s*\*\s*run\s*\(rt\s*,\s*task\s*\)/;

/** Prose list of the forbidden constructs for LLM prompts. */
export const SCAFFOLD_FORBIDDEN_DESCRIPTION =
  'require/import, globalThis, eval(), and Function()';
