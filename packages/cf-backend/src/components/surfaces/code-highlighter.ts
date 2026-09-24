import { createBundledHighlighter, makeSingletonHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguagesBase, bundledLanguagesInfo } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

const THEMES = { light: "github-light", dark: "vesper" } as const;

const getCodeHighlighter = makeSingletonHighlighter(createBundledHighlighter({
  langs: bundledLanguagesBase,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
}));

function grammarOf(language: string): string | null {
  const name = language.toLowerCase();

  return bundledLanguagesInfo.find((entry) => entry.id === name || entry.aliases?.includes(name))?.id ?? null;
}

/** Loads only for a named code fence or source preview. */
export async function highlightCode(code: string, language: string) {
  const grammar = grammarOf(language);

  if (grammar === null) return { code, language, html: null };
  const highlighter = await getCodeHighlighter({ langs: [grammar], themes: Object.values(THEMES) });

  return { code, language, html: highlighter.codeToHtml(code, { lang: grammar, themes: THEMES }) };
}

export interface CodeToken {
  readonly text: string;
  readonly light: string;
  readonly dark: string;
}

export async function codeTokens(code: string, language: string): Promise<CodeToken[][] | null> {
  const grammar = grammarOf(language);

  if (grammar === null) return null;
  const highlighter = await getCodeHighlighter({ langs: [grammar], themes: Object.values(THEMES) });

  return highlighter.codeToTokens(code, { lang: grammar, themes: THEMES }).tokens.map((line) => line.map((token) => ({
    text: token.content, light: token.htmlStyle?.color ?? "", dark: token.htmlStyle?.["--shiki-dark"] ?? "",
  })));
}
