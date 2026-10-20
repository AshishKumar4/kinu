/**
 * What a program's sandbox needs of its egress: the props it is minted with and the mint itself. Apart from the egress
 * (`codemode-egress.ts`), so a program's bundle holds neither the forwarding policy nor what it reaches: the egress is
 * one of this Worker's own entrypoints, reached through `enable_ctx_exports`.
 */
import { exports } from 'cloudflare:workers';
import type { EgressPrincipal } from '@kinu.run/core';

export interface CodemodeEgressProps {
  /**
   * Whom the program runs for. Its `actorId` is whose browser sessions it reaches; null for slate code, which reaches only
   * a new Kitesurf browser. A preview's slate runs as the owner, unbounded by a share's grant; a shared one, as a viewer.
   */
  readonly principal: EgressPrincipal;
}

/** The host `connectBrowser` dials; the path's last segment is a session id or `kitesurf`. */
export const BROWSER_GATE_HOST = 'browser.kinu.invalid';

/** Null outside workerd (test harnesses). */
export function codemodeEgress(props: CodemodeEgressProps): Fetcher | null {
  return exports.CodemodeEgress?.({ props }) ?? null;
}
