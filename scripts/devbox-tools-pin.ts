/**
 * The pinned devbox tools tarball (D65, D78) and the parts a box reads it in: shared by `devbox-tools.ts`, which
 * builds, publishes and checks them, and the release manifest, which names them for a self-deployment to copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

const BLOCK_LOWER = join(import.meta.dir, '..', 'packages/devbox/block-lower');

export const ToolsRecord = v.object({ sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), bytes: v.number() });

export type Tools = v.InferOutput<typeof ToolsRecord>;

/** The pinned tarball's record, from upstream.json. */
export function pinnedTools(): Tools {
  return v.parse(v.object({ tools: ToolsRecord }), JSON.parse(readFileSync(join(BLOCK_LOWER, 'upstream.json'), 'utf8'))).tools;
}

/** The object key a box reads the tarball's parts from, `.0` first: packages/devbox/src/golden.ts reads the same. */
export const toolsKey = (sha256: string): string => `devbox-tools/${sha256}.tgz`;

/** Under the 300 MiB that `wrangler r2 object put` and the R2 REST upload take (developers.cloudflare.com/api, Upload Object). */
export const TOOLS_PART_BYTES = 256 * 1024 * 1024;

/** Each part's key and size, in the order a box reads them. */
export function partsOf(tools: Tools): readonly { readonly key: string; readonly bytes: number }[] {
  return Array.from({ length: Math.ceil(tools.bytes / TOOLS_PART_BYTES) }, (_, part) => ({
    key: `${toolsKey(tools.sha256)}.${String(part)}`, bytes: Math.min(TOOLS_PART_BYTES, tools.bytes - part * TOOLS_PART_BYTES),
  }));
}
