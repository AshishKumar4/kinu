/**
 * The crafted-tool sandbox contract: one callable form, one correction.
 *
 * A crafted tool is a durable model-authored artifact. The experience library
 * carries it between workspaces, and therefore between backends, so the shape
 * the model must write to call one is a CROSS-BACKEND contract rather than a
 * per-sandbox detail. It drifted: the CF sandbox made crafted tools callable
 * only as `tools.<name>`, while the CLI sandbox bound the same set under BOTH
 * `tools.<name>` and `codemode.<name>` — so code the model wrote against the
 * alias on a local workspace threw on a cloud one, and each side spelled its
 * own version of the sentence that explains the difference.
 *
 * The canonical form is `tools.<name>(args)`. `codemode.<name>` stays DECLARED,
 * because createCodeTool builds the types the model reads from the provider
 * namespaces and a crafted tool that appears nowhere in those types is a tool
 * the model cannot discover — but it is declared as a refusing alias, not a
 * callable twin.
 *
 * The alias refuses by THROWING, never by returning an error value. A returned
 * `{error}` is a value the model reads as a result and the runtime reads as a
 * successful call, which is a wrong answer twice over, and it would let an
 * in-episode fitness observation be taken on a call that never ran.
 *
 * Everything model-visible here is built from the two namespace constants, so
 * a prompt line, a docstring or a correction sentence cannot name a namespace
 * this module does not declare.
 */

/** The namespace crafted tools are CALLABLE in, on every backend. */
export const CRAFTED_TOOL_NAMESPACE = 'tools';

/** The namespace crafted tools are DECLARED in and refuse from. Present so the
 *  generated sandbox types list the tool; never callable. */
export const CRAFTED_TOOL_ALIAS_NAMESPACE = 'codemode';

/**
 * The one sentence a model gets when it reaches for the alias. Written once
 * here because it was written twice — CF threw its own copy and the CLI's
 * header comment described the opposite rule — and two copies of a correction
 * is how the correction itself becomes wrong on one side.
 *
 * Both forms are built from the constants above rather than typed out, so this
 * sentence cannot name a namespace the module does not declare.
 */
export function craftedNamespaceCorrection(name: string): string {
  return `Crafted tools are callable as ${CRAFTED_TOOL_NAMESPACE}.${name}(args) in this sandbox, `
    + `not ${CRAFTED_TOOL_ALIAS_NAMESPACE}.${name}(args).`;
}

/** What a crafted tool with no stored description is labelled. One spelling,
 *  so the advertised set reads the same however it was assembled. */
export function craftedToolDescription(name: string, description?: string): string {
  return description || `Crafted tool: ${name}`;
}

/** A declared-but-refusing `codemode.<name>` entry, in the shape
 *  createCodeTool's `options.tools` takes. */
export interface CraftedDispatcherEntry {
  readonly description: string;
  readonly execute: () => Promise<never>;
}

/**
 * The alias entry for one crafted tool. Both sandboxes build their `codemode`
 * namespace from this, so the name is declared in the model-visible types on
 * both and the refusal is the same refusal.
 */
export function craftedDispatcherEntry(name: string, description?: string): CraftedDispatcherEntry {
  return {
    description: craftedToolDescription(name, description),
    execute: async () => {
      throw new Error(craftedNamespaceCorrection(name));
    },
  };
}
