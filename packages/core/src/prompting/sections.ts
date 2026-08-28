/**
 * How to recognise the parts of an already-assembled request.
 *
 * A leaf on purpose, importing nothing. Two very different consumers need the
 * same boundaries — the builder's renderers, and the meter that reports what
 * share of a request each part is — and neither should have to import the
 * other to agree on where one part ends. Putting the definitions here is what
 * keeps the measurement plane out of the assembly plane (and the layer gate
 * enforces exactly that).
 */

/** One `## ` block of an assembled system prompt. */
export interface PromptSection {
  readonly title: string;
  readonly chars: number;
}

/** The soul opens the prompt with no heading of its own. */
export const SOUL_SECTION_TITLE = 'Soul';

/** The opening literal of every rendered live-state block. The renderer writes
 *  it and the meter matches it, so it is defined once, here. */
export const DYNAMIC_CONTEXT_OPEN_TAG = '<dynamic_context';

/** The block carrying workspace instruction files the owner has not approved
 *  (KINU-N028). Same reason it lives here: two layers write and read it. */
export const WORKSPACE_INSTRUCTIONS_TAG = 'workspace_instructions';

/** Each block's own delimiter, wherever it appears inside that block's body. */
export const DYNAMIC_CONTEXT_DELIMITER = /<(\/?)dynamic_context/g;
export const WORKSPACE_INSTRUCTIONS_DELIMITER = /<(\/?)workspace_instructions/g;

/**
 * Neutralize a block's own delimiter inside its body.
 *
 * Every free-text plane in these blocks is authored by the model or by content
 * the model read: task titles, background-job labels sliced off a tool input,
 * search rationales, the gated command an approval is waiting on, the recovery
 * ledger's verbatim echo of a previous call's ARGUMENTS — and, for the
 * workspace-instructions block, whole files the agent's own tools can write.
 * None of it is escaped, deliberately: the model has to read markdown, paths and
 * code exactly as written, and an escaped body would be a worse lie than an
 * unescaped one.
 *
 * So the one thing that must not survive into a body is that body's own
 * delimiter. A task titled `</dynamic_context>` would otherwise close the
 * live-state ledger and let whatever followed open a forged one — and that block
 * is precisely where the model reads which searches are running and which
 * approvals are the human's, so a forgeable boundary there is a forgeable claim
 * about the state of the system. For workspace instructions the stake is the
 * trust tier itself: an unapproved file that could close its own block would
 * escape the label that demotes it.
 *
 * Applied at the single point that wraps each body, so a plane added later
 * cannot forget it. Here, in the leaf, because the two blocks are written by
 * two different layers and neither should import the other to agree on this.
 */
export function sealDelimiters(body: string, delimiter: RegExp, tag: string): string {
  return body.replace(delimiter, `&lt;$1${tag}`);
}

/**
 * Recover the sections of an assembled prompt.
 *
 * The builder joins already-rendered markdown, so a `## ` heading at the start
 * of a line IS the section boundary — there is no section registry to consult.
 * Single-sourced because two consumers depend on these exact boundaries: the
 * per-section char-budget test that pins their sizes, and the context meter
 * that reports each section's share of a request.
 */
export function splitPromptSections(prompt: string): PromptSection[] {
  if (prompt === '') return [];
  return prompt.split(/\n(?=## )/).map((block) => {
    const first = block.split('\n', 1)[0] ?? '';
    return {
      title: first.startsWith('## ') ? first.slice(3) : SOUL_SECTION_TITLE,
      chars: block.length,
    };
  });
}
