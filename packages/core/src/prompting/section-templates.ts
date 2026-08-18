/**
 * Prompt prose, as data.
 *
 * Every template here is an addressable artifact: an id an optimiser or an owner
 * can name, and a source string that can be read, scored and replaced without
 * recompiling the builder around it. Branching and iteration stay in the builder
 * (`prompt.ts`) where the unions are exhaustive — see `template.ts` for why.
 */

import { definePromptSection } from './template';

/**
 * One built-in tool's index entry: its name, what it is for, and one real call.
 *
 * The builder maps this over the turn's tool list, so the iteration is typed
 * TypeScript and only the line's wording lives here.
 */
export const BUILTIN_TOOL_LINE = definePromptSection(
  'tools/builtin-line',
  '- **{{name}}** — {{summary}}\n  `{{example}}`',
);
