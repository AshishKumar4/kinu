import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { WorkMode } from '../types/turn';
import { slateAuthority } from './authority';

/** A registered actor name: every actor shares one root object, so the name, not a class, is the identity. */
export interface SlateCallerHop {
  readonly name: string;
}

/** The actor a slate acts for; stamped only by actor code, never by a browser, client, or the binding holder. */
export interface SlateCaller {
  readonly path: readonly SlateCallerHop[];
  readonly cred: VfsCred;
  readonly workMode: WorkMode;
}

export const ROOT_SLATE_CALLER: SlateCaller = { path: [], cred: CRED_SESSION_USER, workMode: 'build' };

export function slateCallerKey(caller: SlateCaller): string {
  return JSON.stringify([slateAuthority(caller.cred), caller.path, caller.workMode]);
}
