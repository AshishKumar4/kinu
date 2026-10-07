/** Host-side result before JSON validation at the VM boundary; no functions or symbols. */
export type CodemodeResult = object | string | number | boolean | null | undefined;

/**
 * `positionalArgs`: `ns.fn(a, b)` reaches `execute(a, b)`, else `execute({…})`. `prelude` runs in the
 * sandbox after the namespace proxy exists, for members that must be real in-sandbox functions.
 */
/** A member's whole declaration, and the call form that names it where a native tool already declares it. */
export interface MemberDeclaration {
  readonly full: string;
  readonly call: string;
}

export interface CodemodeProvider {
  readonly name: string;
  readonly tools: Record<string, {
    readonly description: string;
    readonly planAllowed?: boolean;
    readonly execute: (...args: unknown[]) => Promise<CodemodeResult>;
  }>;
  readonly types?: string;
  /** Per member, rendered from its schema; the namespace is composed from these, never from `types`. */
  readonly declarations?: Readonly<Record<string, MemberDeclaration>>;
  readonly positionalArgs?: boolean;
  readonly prelude?: string;
}

/** The one namespace every tool, builtin or crafted, is callable in on every backend. */
export const CRAFTED_TOOL_NAMESPACE = 'tools';

/** A crafted tool body, as its declaration, its parse refusal and its veto all describe it. */
export const CRAFTED_TOOL_BODY = 'one async function, not an eval script (no top-level `return`): '
  + '`async (args) => JSON.parse(await workspace.readFile(args.path))`';

/** How a program, or a tool body, reaches the workspace's files. */
export const WORKSPACE_FILE_BINDINGS = 'read a file with `await workspace.readFile(path)` and write one with '
  + '`await workspace.writeFile(path, content)`';
