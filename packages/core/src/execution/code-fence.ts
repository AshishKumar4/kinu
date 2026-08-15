import { markdownFencedBlocks } from '../prompts/structured.js';

const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['node', 'javascript'],
  ['ts', 'typescript'],
  ['py', 'python'],
  ['python3', 'python'],
]);

export function canonicalLanguage(tag: string | null | undefined): string | null {
  const normalized = tag?.trim().toLowerCase();
  if (!normalized) return null;
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
}

export interface FencedBlock {
  readonly language: string | null;
  readonly code: string;
}

/** Parse every non-empty Markdown fence in source order. */
export function fencedBlocks(text: string): FencedBlock[] {
  return markdownFencedBlocks(text)
    .map(({ tag, code }) => ({ language: canonicalLanguage(tag), code }))
    .filter(({ code }) => code.length > 0);
}

export type ProposalCode =
  | { readonly kind: 'runnable'; readonly language: string; readonly code: string }
  | { readonly kind: 'unrunnable'; readonly language: string }
  | null;

/** Select the last runnable implementation; otherwise preserve the unsupported language. */
export function readProposalCode(
  text: string,
  languages: readonly [string, ...string[]],
): ProposalCode {
  const blocks = fencedBlocks(text);
  let unrunnable: string | null = null;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    const language = block.language ?? languages[0];
    if (languages.includes(language)) {
      return { kind: 'runnable', language, code: block.code };
    }
    unrunnable ??= language;
  }
  return unrunnable === null ? null : { kind: 'unrunnable', language: unrunnable };
}
