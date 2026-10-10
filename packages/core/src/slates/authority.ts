/** Who a slate's code runs and compiles as. */
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

/**
 * A credential's file authority, by every field that changes what it may read or how what it writes is created. A
 * slate's image is compiled with one caller's: its imports resolved only where that caller may read. So a kept image
 * is that authority's, and is served to no other, as a process is held per caller.
 */
export function slateAuthority(cred: VfsCred): string {
  return JSON.stringify([cred.uid, cred.gid, cred.groups, cred.umask]);
}
