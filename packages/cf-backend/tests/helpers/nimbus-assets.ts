import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The tree the build stages under `/_assets` (vite.config.ts), from the pinned package. */
const PUBLIC = join(dirname(createRequire(import.meta.url).resolve('@nimbus-sh/worker/package.json')), 'public');

/** `env.ASSETS` as Nimbus reads it: its runtime artifacts, the git bundle a network facet imports among them. */
export function nimbusAssets(request: Request): Response {
  const file = join(PUBLIC, new URL(request.url).pathname);

  return file.startsWith(join(PUBLIC, '_assets/')) && existsSync(file)
    ? new Response(readFileSync(file))
    : new Response('not found', { status: 404 });
}
