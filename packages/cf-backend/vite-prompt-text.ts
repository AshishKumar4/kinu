import type { Plugin } from 'vite';

/** Bun and esbuild honour `with { type: 'text' }`; Vite needs the same
 *  text-module transform for production and its workerd test runner. */
export function promptText(): Plugin {
  return {
    name: 'kinu:prompt-text',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/core/src/prompts/') || !id.endsWith('.md')) return null;

      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}
