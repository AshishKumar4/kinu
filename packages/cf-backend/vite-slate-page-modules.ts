import type { Plugin } from 'vite';
import { SLATE_PAGE_MODULES_PATH } from '../core/src/web/slate-page';
import { slatePageFiles } from './slate-vendor';

/**
 * The modules a page the chat draws itself imports by name (`SLATE_PAGE_MODULES`), as files of the app named for their
 * content under `SLATE_PAGE_MODULES_PATH`: served by the dev server, emitted with the client's assets, and named to the
 * app as `__KINU_SLATE_PAGE_MODULES__`, a constant the build writes in (a module the landing's prerender would have to
 * resolve too).
 */
export function slatePageModules(): Plugin {
  return {
    name: 'kinu:slate-page-modules',
    config: () => ({
      define: { __KINU_SLATE_PAGE_MODULES__: JSON.stringify(Object.fromEntries(Object.entries(slatePageFiles()).map(([file, { name }]) => [file, name]))) },
    }),
    configureServer(server) {
      server.middlewares.use(SLATE_PAGE_MODULES_PATH, (request, response, next) => {
        const found = Object.values(slatePageFiles()).find(({ name }) => `/${name}` === request.url);

        if (found === undefined) {
          next();

          return;
        }

        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.setHeader('access-control-allow-origin', '*');
        response.end(found.body);
      });
    },
    generateBundle() {
      // The Worker's bundle has no assets of its own.
      if (this.environment.name !== 'client') return;

      for (const { name, body } of Object.values(slatePageFiles())) {
        this.emitFile({ type: 'asset', fileName: `${SLATE_PAGE_MODULES_PATH.slice(1)}${name}`, source: body });
      }
    },
  };
}
