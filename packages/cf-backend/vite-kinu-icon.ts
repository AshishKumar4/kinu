import type { Plugin } from 'vite';
import { markDocument } from '../core/src/http/public-shell';

const PATH = '/assets/kinu-icon.svg';

/** The favicon from core's mark, for the dev server and the built assets; the Worker serves the same document. */
export function kinuIcon(): Plugin {
  return {
    name: 'kinu:icon',
    configureServer(server) {
      server.middlewares.use(PATH, (_request, response) => {
        response.setHeader('content-type', 'image/svg+xml');
        response.end(markDocument());
      });
    },
    generateBundle() {
      // The Worker's bundle has no assets of its own.
      if (this.environment.name !== 'client') return;
      this.emitFile({ type: 'asset', fileName: PATH.slice(1), source: markDocument() });
    },
  };
}
