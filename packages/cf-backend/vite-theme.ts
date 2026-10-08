import type { Plugin } from 'vite';
import { APP_FONTS_PATH, fontsCss } from '../core/src/web/fonts';
import { THEME_CSS } from '../core/src/web/theme';

const ID = 'virtual:kinu-theme.css';

/** Core's palette, radii and faces as a stylesheet. */
export function kinuTheme(): Plugin {
  return {
    name: 'kinu:theme',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load: (id) => (id === `\0${ID}` ? `${THEME_CSS}\n${fontsCss(APP_FONTS_PATH)}` : null),
  };
}
