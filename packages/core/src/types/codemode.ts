/** The codemode sandbox contract, declared at the platform layer: the execution
 *  plane reads a provider's shape and the tools layer implements it. */

/** A provider's host-side result before the executor validates the VM boundary
 *  as JSON. Domain objects are allowed here; functions and symbols are not. */
export type CodemodeResult = object | string | number | boolean | null | undefined;

/**
 * A codemode sandbox provider: a named namespace of callable tools plus the
 * TypeScript declaration the model reads for it.
 *
 * `positionalArgs` states how the sandbox spreads a call: `ns.fn(a, b)` reaches
 * `execute(a, b)` when true, `execute({…})` when false. `prelude` is optional
 * sandbox-side JavaScript run after the namespace proxy exists, for members
 * that must be real in-sandbox functions (crafted tools are defined this way,
 * because their source closes over the other namespaces).
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

/** The ONE namespace every tool is callable in — native builtins and crafted
 *  tools alike — on every backend. */
export const CRAFTED_TOOL_NAMESPACE = 'tools';
