/** Host-side result before JSON validation at the VM boundary; no functions or symbols. */
export type CodemodeResult = object | string | number | boolean | null | undefined;

/**
 * `positionalArgs`: `ns.fn(a, b)` reaches `execute(a, b)`, else `execute({…})`. `prelude` runs in the
 * sandbox after the namespace proxy exists, for members that must be real in-sandbox functions.
 */
export interface CodemodeProvider {
  readonly name: string;
  readonly tools: Record<string, {
    readonly description: string;
    readonly planAllowed?: boolean;
    readonly execute: (...args: unknown[]) => Promise<CodemodeResult>;
  }>;
  readonly types?: string;
  readonly positionalArgs?: boolean;
  readonly prelude?: string;
}

/** The one namespace every tool, builtin or crafted, is callable in on every backend. */
export const CRAFTED_TOOL_NAMESPACE = 'tools';
