import type { Plugin } from 'vite';

/**
 * Phosphor defines each icon in six weights, and an icon's import carries all six (~4 KB). The app draws four, so the
 * client build cuts the other two from every icon's definitions: 2026-10-08, the icons were 365 KB of the workspace's
 * first load. A source that asks for a cut weight fails the build, since that icon would draw nothing.
 */
const CUT_WEIGHTS = ['thin', 'duotone'] as const;

const DRAWN_WEIGHTS = ['bold', 'fill', 'light', 'regular'] as const;

/** Each weight is one `[ "<weight>", <element> ]` entry of the definition's Map, at this indentation (2.1.10). */
const CUT_ENTRY = new RegExp(`^  \\[\\n    "(?:${CUT_WEIGHTS.join('|')})",\\n[\\s\\S]*?\\n  \\],?\\n`, 'gm');

const ASKS_CUT_WEIGHT = new RegExp(`weight(?:=\\{?|:\\s*)["'](?:${CUT_WEIGHTS.join('|')})["']`);

export function iconWeights(): Plugin {
  return {
    name: 'kinu:icon-weights',
    applyToEnvironment: (environment) => environment.name === 'client',
    transform(code, id) {
      if (id.includes('/src/') && !id.includes('/node_modules/') && ASKS_CUT_WEIGHT.test(code)) {
        this.error(`${id} draws an icon in a weight the build cuts (${CUT_WEIGHTS.join(', ')}): add it to DRAWN_WEIGHTS`);
      }

      if (!/\/@phosphor-icons\/react\/dist\/defs\/[^/]+\.es\.js$/.test(id)) return null;
      const cut = code.replace(CUT_ENTRY, '');

      if (DRAWN_WEIGHTS.some((weight) => !cut.includes(`    "${weight}",\n`)) || CUT_WEIGHTS.some((weight) => cut.includes(`    "${weight}",\n`))) {
        this.error(`${id}: the icon definition's layout changed, so its weights cannot be cut`);
      }

      return { code: cut, map: null };
    },
  };
}
