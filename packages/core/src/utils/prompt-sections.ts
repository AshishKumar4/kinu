/** Boundaries of an assembled request. A leaf importing nothing, so builder and meter agree without importing each other (layer gate). */

export interface PromptSection {
  readonly title: string;
  readonly chars: number;
}

/** The soul opens the prompt with no heading of its own. */
const SOUL_SECTION_TITLE = 'Soul';

export const DYNAMIC_CONTEXT_OPEN_TAG = '<dynamic_context';

/** Workspace instruction files the owner has not approved (KINU-N028). */
export const WORKSPACE_INSTRUCTIONS_TAG = 'workspace_instructions';

/** A note the harness adds in the user's role at a turn's stop, such as the open-task reminder. */
export const SYSTEM_REMINDER_TAG = 'system-reminder';

export const DYNAMIC_CONTEXT_DELIMITER = /<(\/?)dynamic_context/g;

export const WORKSPACE_INSTRUCTIONS_DELIMITER = /<(\/?)workspace_instructions/g;

/**
 * Neutralize a block's own delimiter inside its body. Bodies carry unescaped
 * model-influenced text; a forged `</dynamic_context>` would let content forge
 * live state or escape the unapproved-instructions label.
 */
export function sealDelimiters(body: string, delimiter: RegExp, tag: string): string {
  return body.replace(delimiter, `&lt;$1${tag}`);
}

/** Split an assembled prompt on line-start `## ` headings; the per-section budget test and the context meter depend on these boundaries. */
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
