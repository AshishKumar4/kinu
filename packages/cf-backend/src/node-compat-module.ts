/**
 * Nimbus's node-compat (`@nimbus-sh/core/node-compat`, ask 67) as an eval program imports it beside `kinu-node.js`: the
 * `fs`, `fs/promises` and `child_process` its `require` hands out. Vendored by `slate-vendor.ts`.
 */
import { slateVendorModule } from './slates/vendor';

export const NODE_COMPAT_MODULE = 'kinu-node-compat.js';

/** The 48 KB bundle, read when a program with `require` is launched. */
export async function nodeCompatSource(): Promise<string> {
  return (await slateVendorModule()).default.nodeCompat;
}
