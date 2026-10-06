import type { Plugin } from 'vite';
import { THEME_CSS } from '../core/src/web/theme';

const ID = 'virtual:kinu-theme.css';

/** Core's palette and radii as a stylesheet. */
export function kinuTheme(): Plugin {
  return {
    name: 'kinu:theme',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load: (id) => (id === `\0${ID}` ? THEME_CSS : null),
  };
}
