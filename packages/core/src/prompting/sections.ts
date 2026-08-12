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
