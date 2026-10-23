/**
 * The head the slate runner opens every page it answers with (an HTML page, a React client, its class's own `fetch`):
 * where its bare specifiers resolve, the app's palette and the chat's type, and the host's scheme set before first paint.
 */
import { SLATE_PAGE_STYLE, SLATE_SCHEME_SCRIPT } from '../slates/page-head';
import { SLATE_LEGACY_TOKEN_CSS } from '../slates/host-context';
import { fontsCss, SLATE_FONTS_PATH } from './fonts';
import { THEME_CSS } from './theme';

/**
 * Every module a slate page may import by name, and the file it is served as: by a slate's runner under `/__kinu/`, and
 * by the app to a page the chat draws itself (`drawnPageDocument`). Beside React and `kinu:slate`, a chart library and a
 * small one for markup that changes, so a page draws them without reaching outside.
 */
export const SLATE_PAGE_MODULES = {
  'react': 'react.js',
  'react-dom/client': 'react.js',
  'react/jsx-runtime': 'react.js',
  'capnweb': 'capnweb.js',
  'kinu:slate': 'slate.js',
  'uplot': 'uplot.js',
  'preact': 'preact.js',
  'preact/hooks': 'preact-hooks.js',
  'htm/preact': 'htm-preact.js',
} as const;

/** Where the app serves those files, each under a name its content picks, to a page the chat draws itself. */
export const SLATE_PAGE_MODULES_PATH = '/assets/slate/';

/** The import map that names each of them where `at` says its file is: a runner's `/__kinu/`, or the app's own path. */
export function slateImportMap(at: (file: string) => string): string {
  return `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(Object.entries(SLATE_PAGE_MODULES).map(([name, file]) => [name, at(file)])) })}</script>`;
}

const SLATE_IMPORT_MAP = slateImportMap((file) => `/__kinu/${file}`);

/** Any page reads as part of the answer it sits in until its own styles say otherwise: the faces are its own host's. */
const SLATE_PAGE_HEAD = `<style>${THEME_CSS}\n${SLATE_LEGACY_TOKEN_CSS}\n${fontsCss(SLATE_FONTS_PATH)}\n${SLATE_PAGE_STYLE}</style><script>${SLATE_SCHEME_SCRIPT}</script>`;

/** What every page is opened with: kinu:slate's `fit` takes the host's theme and tells it the page's height. */
export const SLATE_PAGE_PREAMBLE = `${SLATE_IMPORT_MAP}${SLATE_PAGE_HEAD}<script type="module">import { fit } from "kinu:slate"; fit();</script>`;
