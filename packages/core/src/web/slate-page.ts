/**
 * The head the slate runner opens every page it answers with (an HTML page, a React client, its class's own `fetch`):
 * where its bare specifiers resolve, the app's palette and the chat's type, and the host's scheme set before first paint.
 */
import { SLATE_PAGE_STYLE, SLATE_SCHEME_SCRIPT } from '../slates/page-head';
import { fontsCss, SLATE_FONTS_PATH } from './fonts';
import { THEME_CSS } from './theme';

/** Where a page's bare specifiers resolve: every module the runner serves under `/__kinu/`. */
const SLATE_IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: {
  'react': '/__kinu/react.js',
  'react-dom/client': '/__kinu/react.js',
  'react/jsx-runtime': '/__kinu/react.js',
  'capnweb': '/__kinu/capnweb.js',
  'kinu:slate': '/__kinu/slate.js',
} })}</script>`;

/** Any page reads as part of the answer it sits in until its own styles say otherwise: the faces are its own host's. */
const SLATE_PAGE_HEAD = `<style>${THEME_CSS}\n${fontsCss(SLATE_FONTS_PATH)}\n${SLATE_PAGE_STYLE}</style><script>${SLATE_SCHEME_SCRIPT}</script>`;

/** What every page is opened with: kinu:slate's `fit` takes the host's theme and tells it the page's height. */
export const SLATE_PAGE_PREAMBLE = `${SLATE_IMPORT_MAP}${SLATE_PAGE_HEAD}<script type="module">import { fit } from "kinu:slate"; fit();</script>`;
