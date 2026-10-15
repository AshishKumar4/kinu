/**
 * A slate room's addresses and keys. A room is named by its workspace and a handle derived from its slate, so the app's
 * routes (which carry the slate) and the slate's own host (which carries the handle) reach the same object. The link's
 * key signs the room's link generation: stopping the link and starting it again mints a new key, and an old one opens
 * nothing (`Revocation.lean`: `a_stopped_links_sessions_stay_ended`).
 */
import * as v from 'valibot';
import { labelSigner, type LabelSignerEnv } from '../../utils/label-signer';
import { sha256Hex } from '../../safety/argument-digest';
import { roomPagePath } from '../room-api';

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

async function linkKey(env: LabelSignerEnv, workspace: string, slate: string, linkGen: number): Promise<string | null> {
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

// ── The slate's own host ────────────────────────────────────────────────────────────────────────────────────────────

/** A session's pass on the slate's host: who, and how they hold the slate, signed by the room that admitted them. */
const frameSigner = labelSigner('kinu.slate-room-frame.salt', 'kinu.slate-room-frame.v1', 26);

/** Host-only, so the slate's host alone carries it; the room re-checks the session it names on every request. */
const ROOM_FRAME_COOKIE = '__Host-kinu_room';

/** The host's entry: a ticket becomes the cookie, then the slate's page. */
export const ROOM_ENTER_PATH = '/__kinu/enter';

const TICKET_LIFETIME_MS = 5 * 60 * 1000;

const COOKIE_LIFETIME_MS = 12 * 60 * 60 * 1000;

const FrameClaimSchema = v.object({
  email: v.nullable(v.string()),
  access: v.variant('kind', [
    v.object({ kind: v.literal('owner') }),
    v.object({ kind: v.literal('member'), gen: v.number() }),
    v.object({ kind: v.literal('link'), gen: v.number() }),
  ]),
  /** Distinguishes a ticket from a cookie, so one never verifies as the other. */
  use: v.picklist(['ticket', 'cookie'] as const),
  expiresAt: v.number(),
});

export type FrameClaim = v.InferOutput<typeof FrameClaimSchema>;

function frameMessage(workspace: string, handle: string, payload: string): string {
  return `kinu:slate-room-frame:v1:${workspace}:${handle}:${payload}`;
}

async function signedPass(env: LabelSignerEnv, room: { workspace: string; handle: string }, claim: FrameClaim): Promise<string | null> {
  const secret = frameSigner.secret(env);

  if (secret === undefined) return null;
  const payload = btoa(JSON.stringify(claim)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

  return `${payload}.${await frameSigner.token(secret, frameMessage(room.workspace, room.handle, payload))}`;
}

/** A five-minute ticket for one session, which the host's entry exchanges for its cookie. */
export async function frameTicket(
  env: LabelSignerEnv, room: { workspace: string; handle: string }, session: Pick<FrameClaim, 'email' | 'access'>,
): Promise<string | null> {
  return await signedPass(env, room, { ...session, use: 'ticket', expiresAt: Date.now() + TICKET_LIFETIME_MS });
}

/** The cookie's value for a ticket that holds, or null. */
export async function cookieForTicket(env: LabelSignerEnv, room: { workspace: string; handle: string }, ticket: string): Promise<string | null> {
  const claim = await readPass(env, room, ticket, 'ticket');

  return claim === null ? null : await signedPass(env, room, { ...claim, use: 'cookie', expiresAt: Date.now() + COOKIE_LIFETIME_MS });
}

export async function readPass(env: LabelSignerEnv, room: { workspace: string; handle: string }, pass: string, use: FrameClaim['use']): Promise<FrameClaim | null> {
  const [payload, sig] = pass.split('.');

  if (payload === undefined || sig === undefined || !await frameSigner.verify(env, frameMessage(room.workspace, room.handle, payload), sig)) return null;
  const claim = v.safeParse(FrameClaimSchema, JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))));

  return claim.success && claim.output.use === use && claim.output.expiresAt > Date.now() ? claim.output : null;
}

export function frameCookieHeader(value: string): string {
  return `${ROOM_FRAME_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(COOKIE_LIFETIME_MS / 1000)}`;
}

export function frameCookieOf(cookieHeader: string | null): string | null {
  return cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${ROOM_FRAME_COOKIE}=`))
    ?.slice(ROOM_FRAME_COOKIE.length + 1) ?? null;
}
