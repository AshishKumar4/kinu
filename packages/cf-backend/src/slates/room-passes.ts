/**
 * A slate room's addresses and keys. A room is named by its workspace and a handle derived from its slate, so the app's
 * routes (which carry the slate) and the slate's own host (which carries the handle) reach the same object. The link's
 * key signs the room's link generation: stopping the link and starting it again mints a new key, and an old one opens
 * nothing (`Revocation.lean`: `a_stopped_links_sessions_stay_ended`).
 */
import { labelSigner, roomPagePath, sha256Hex, type LabelSignerEnv } from '@kinu.run/core';

/** 26 base32 characters: 130 bits, for a key that admits anyone who holds it. */
const roomSigner = labelSigner('kinu.slate-room.salt', 'kinu.slate-room.v1', 26);

/** Ten hex characters, as the slate host's label carries a handle. */
export function roomHandle(workspace: string, slate: string): string {
  return sha256Hex(`kinu:slate-room:v1:${workspace}/${slate}`, 10);
}

export function roomObjectName(workspace: string, handle: string): string {
  return `${workspace}/${handle}`;
}

function linkMessage(workspace: string, slate: string, linkGen: number): string {
  return `kinu:slate-room-link:v1:${workspace}:${slate}:${linkGen}`;
}

export async function linkKey(env: LabelSignerEnv, workspace: string, slate: string, linkGen: number): Promise<string | null> {
  const secret = roomSigner.secret(env);

  return secret === undefined ? null : await roomSigner.token(secret, linkMessage(workspace, slate, linkGen));
}

export async function linkKeyHolds(env: LabelSignerEnv, room: { workspace: string; slate: string; linkGen: number }, key: string): Promise<boolean> {
  return await roomSigner.verify(env, linkMessage(room.workspace, room.slate, room.linkGen), key);
}

/** The live page's address while the link is on: the app's origin, the slate, and the key. */
export async function linkUrl(
  env: LabelSignerEnv & { readonly CLI_PUBLIC_ORIGIN?: string }, room: { workspace: string; slate: string; linkGen: number },
): Promise<string | null> {
  const origin = env.CLI_PUBLIC_ORIGIN;
  const key = await linkKey(env, room.workspace, room.slate, room.linkGen);

  if (origin === undefined || !URL.canParse(origin) || key === null) return null;

  return new URL(roomPagePath(room.workspace, room.slate, key), origin).toString();
}
