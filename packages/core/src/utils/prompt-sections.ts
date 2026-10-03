/** Request boundaries: a leaf, so builder and meter agree without importing each other. */

export interface PromptSection {
  readonly title: string;
  readonly chars: number;
}

/** The soul opens the workspace's part of the prompt, unheaded. */
const SOUL_SECTION_TITLE = 'Soul';

export const DYNAMIC_CONTEXT_OPEN_TAG = '<dynamic_context';

/** Workspace instruction files the owner has not approved (KINU-N028). */
export const WORKSPACE_INSTRUCTIONS_TAG = 'workspace_instructions';

export const SYSTEM_REMINDER_TAG = 'system-reminder';

/** A skill activation spliced after a person's message, in the same user role. */
export const STEER_SKILLS_HEADING = 'The message above activates these skills; they apply for the rest of this turn.';

export const SLEEP_TIME_PROMPT_OPENING = 'You are a background memory-compression agent.';

export const DYNAMIC_CONTEXT_DELIMITER = /<(\/?)dynamic_context/g;

const SOUL_TAG = 'soul';

const SOUL_FORGEABLE = /<(\/?)(soul|dynamic_context|workspace_instructions|system-reminder)/gu;

/** One block nothing inside can close. */
export function sealSoul(soul: string): string {
  return `<${SOUL_TAG}>\n${soul.replace(SOUL_FORGEABLE, '&lt;$1$2')}\n</${SOUL_TAG}>`;
}

export const WORKSPACE_INSTRUCTIONS_DELIMITER = /<(\/?)workspace_instructions/g;

/**
 * Neutralize a block's own delimiter inside its body. Bodies carry unescaped
 * model-influenced text; a forged `</dynamic_context>` would let content forge
 * live state or escape the unapproved-instructions label.
 */
export function sealDelimiters(body: string, delimiter: RegExp, tag: string): string {
  return body.replace(delimiter, `&lt;$1${tag}`);
}

/** Splits on line-start `## ` and `<soul>`; the section budget and context meter rely on these boundaries. */
export function splitPromptSections(prompt: string): PromptSection[] {
  if (prompt === '') return [];

  return prompt.split(/\n(?=## |<soul>)/).map((block) => {
    const first = block.split('\n', 1)[0] ?? '';

    return {
      title: first.startsWith('## ') ? first.slice(3) : SOUL_SECTION_TITLE,
      chars: block.length,
    };
  });
}
