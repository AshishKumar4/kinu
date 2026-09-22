// The door is public; a run key gates it. Only its digest is stored, and the key never
// appears in storage, logs, ledger rows or URLs; the run id identifies a run there.
import { sha256Hex } from '../safety/argument-digest';
import { base64Url, timingSafeEqual } from '../utils/crypto';

// Multiple of three so base64url has no padding.
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

/** Backend-only: reaches `node:crypto`. */
export function runKeyDigest(runKey: string): string {
  return sha256Hex(runKey);
}

export function runKeyAdmits(presented: string, storedDigest: string): boolean {
  if (presented === '' || storedDigest === '') return false;

  return timingSafeEqual(runKeyDigest(presented), storedDigest);
}

/** Browsers cannot set upgrade headers, so the key rides as the second subprotocol token; only this name is echoed. */
export const DEPLOY_SOCKET_PROTOCOL = 'kinu.deploy.run-key';

export const DEPLOY_RUN_ID = /^[A-Za-z0-9_-]{16}$/u;
