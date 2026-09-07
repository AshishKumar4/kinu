import { createBundledHighlighter, makeSingletonHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguagesBase, bundledLanguagesInfo } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

const getCodeHighlighter = makeSingletonHighlighter(createBundledHighlighter({
  langs: bundledLanguagesBase,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
}));

/** This module loads only for a named code fence or source preview. Shiki owns
 * the grammar names, aliases, loading and singleton cache. */
export async function highlightCode(code: string, language: string) {
  const name = language.toLowerCase();
  const grammar = bundledLanguagesInfo.find((entry) => entry.id === name || entry.aliases?.includes(name));
  if (grammar === undefined) return { code, language, html: null };
  const highlighter = await getCodeHighlighter({ langs: [grammar.id], themes: ['github-light', 'vesper'] });
  return { code, language, html: highlighter.codeToHtml(code, {
    lang: grammar.id, themes: { light: 'github-light', dark: 'vesper' },
  }) };
}
