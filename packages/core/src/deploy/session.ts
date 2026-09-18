/**
 * A guided run's identity: the id that names it and the key that authorizes it.
 *
 * The door is public — a person deploying their own Kinu has no Kinu account
 * yet, so there is no session to gate on. What gates it is the key: 192 random
 * bits handed to the browser (or to the CLI) once, presented in the
 * `authorization` header of every call and as the socket upgrade's second
 * subprotocol token, compared against a stored DIGEST rather than against
 * itself. A run's storage therefore never holds the key, and neither does a
 * log line, a ledger row, a diagnostics field or a URL — the run id is what
 * identifies a run in every one of those places.
 */
import { sha256Hex } from '../safety/argument-digest';
import { base64Url, timingSafeEqual } from '../utils/crypto';

/** 192 bits. Above the 128-bit floor, and a multiple of three so the base64url
 *  form carries no padding to trim. */
const KEY_BYTES = 24;

const ID_BYTES = 12;

export interface DeployRunTicket {
  readonly runId: string;
  readonly runKey: string;
}

export function mintDeployRun(): DeployRunTicket {
  const id = new Uint8Array(ID_BYTES);
  const key = new Uint8Array(KEY_BYTES);

  crypto.getRandomValues(id);
  crypto.getRandomValues(key);

  return { runId: base64Url(id), runKey: base64Url(key) };
}

/** What the run stores instead of the key. One digest spelling in this tree,
 *  `safety/argument-digest.ts`; it reaches `node:crypto`, which is why it is
 *  called on a backend and never in the page that holds the key. */
export function runKeyDigest(runKey: string): string {
  return sha256Hex(runKey);
}

export function runKeyAdmits(presented: string, storedDigest: string): boolean {
  if (presented === '' || storedDigest === '') return false;

  return timingSafeEqual(runKeyDigest(presented), storedDigest);
}

/**
 * The subprotocol that names the run key on a socket upgrade.
 *
 * A browser cannot set a header on a WebSocket upgrade, and the key must not be
 * in the URL, so the upgrade offers two tokens: this name, and the key. The
 * route reads the second and answers with the first — the key is never echoed.
 */
export const DEPLOY_SOCKET_PROTOCOL = 'kinu.deploy.run-key';

export const DEPLOY_RUN_ID = /^[A-Za-z0-9_-]{16}$/u;
