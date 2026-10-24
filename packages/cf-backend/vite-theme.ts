import type { Plugin } from 'vite';
import { APP_FONTS_PATH, fontsCss } from '../core/src/web/fonts';
import { MODE_BOOT } from '../core/src/utils/color-mode';
import { THEME_CSS } from '../core/src/web/theme';

const ID = 'virtual:kinu-theme.css';

/** Core's palette, radii and faces as a stylesheet; and every page it builds painted in its mode from the first frame,
 *  by core's one rule (`MODE_BOOT`), so no page carries a copy of its own. */
export function kinuTheme(): Plugin {
  return {
    name: 'kinu:theme',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load: (id) => (id === `\0${ID}` ? `${THEME_CSS}\n${fontsCss(APP_FONTS_PATH)}` : null),
    transformIndexHtml: () => [{ tag: 'script', children: MODE_BOOT, injectTo: 'head' }],
  };
}
