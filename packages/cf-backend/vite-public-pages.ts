import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The public pages' build (landing, legal), apart from the app's `client` build, into the same directory the Worker
 * serves. In one build a page's first load also took the app's code: a chunk group learns a module's importers, never
 * which of a barrel's exports a page uses, so the landing's grew from 266 to 553 KB gzip (rolldown 1.2.14, 2026-10-25).
 */
export const PUBLIC_PAGES = 'public';

/** The builds a browser loads; every other environment is a Worker's. */
export function isBrowserEnvironment(name: string): boolean {
  return name === 'client' || name === PUBLIC_PAGES;
}

export function publicPages(): Plugin {
  return {
    name: 'kinu:public-pages',
    apply: 'build',
    // Where the Cloudflare plugin puts the client's files, `<outDir>/client`, after the client build emptied it.
    config: (config) => ({ environments: { [PUBLIC_PAGES]: { build: { outDir: join(config.build?.outDir ?? 'dist', 'client') } } } }),
    buildApp: {
      order: 'post',
      handler: async (builder) => {
        const pages = builder.environments[PUBLIC_PAGES];

        if (pages !== undefined) await builder.build(pages);
      },
    },
  };
}
