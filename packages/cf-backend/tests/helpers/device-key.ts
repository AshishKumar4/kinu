/**
 * A machine's device credential (protocol 5) as `kinu connect` makes it, and its connect as the daemon makes it, against
 * the real UserDO: the challenge, the key's signature over it, the ticket, the upgrade and the AUTH frame. The signed
 * messages are spelled here from the protocol's words and signed by node's own Ed25519, apart from the code under test.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import * as v from 'valibot';
import { DEVICE_CONNECT_PATH, DEVICE_FRAMES, type DeviceConnectProof, type DeviceTicketIssue, type UserCaller } from '@kinu.run/core';
import { testOwner, type AcceptedSocket, type TestUserDO } from './user-do';

/** The origin the UserDO harness answers as (its `CLI_PUBLIC_ORIGIN`), which a signature names. */
export const TEST_HUB_ORIGIN = 'https://kinu.example.com';

export interface TestDeviceKey {
  /** The raw public key as base64url: what the hub stores. */
  readonly publicKey: string;
  /** The private key as PKCS#8 PEM: what device.key holds. */
  readonly privateKeyPem: string;
}

/** `key`'s Ed25519 signature over `message`'s UTF-8 bytes, as base64url. */
function signed(key: TestDeviceKey, message: string): string {
  return Buffer.from(sign(null, Buffer.from(message), createPrivateKey(key.privateKeyPem))).toString('base64url');
}

/** What a connect signs: the protocol, the hub, the device, the generation it holds and the hub's challenge. */
export function signConnect(key: TestDeviceKey, at: { device: string; generation: number; nonce: string; origin?: string }): string {
  return signed(key, `kinu-device-connect:5:${at.origin ?? TEST_HUB_ORIGIN}:${at.device}:${String(at.generation)}:${at.nonce}`);
}

/** What an update refusal signs: the protocol, the hub, the device and the hub's challenge. */
export function signRefusal(key: TestDeviceKey, at: { origin: string; device: string; nonce: string }): string {
  return signed(key, `kinu-device-update-refused:5:${at.origin}:${at.device}:${at.nonce}`);
}

/** What linking a machine again signs with its old key: the registration it replaces, and the new public key. */
export function signReplace(key: TestDeviceKey, at: { device: string; publicKey: string }): string {
  return signed(key, `kinu-device-replace:5:${TEST_HUB_ORIGIN}:${at.device}:${at.publicKey}`);
}

export function testDeviceKey(): TestDeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;

  if (raw === undefined) throw new Error('the Ed25519 public key exported no raw bytes');

  return { publicKey: raw, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

interface Registering {
  registerDevice: TestUserDO['userDO']['registerDevice'];
}

/** A signed-in machine's registration, with a key of its own. */
export async function registerTestDevice(userDO: Registering, label?: string, caller?: UserCaller): Promise<{ deviceId: string; key: TestDeviceKey }> {
  const key = testDeviceKey();
  const { deviceId } = await userDO.registerDevice(caller ?? await testOwner(), { publicKey: key.publicKey, origin: TEST_HUB_ORIGIN, label });

  return { deviceId, key };
}

const IssuedSchema = v.object({ ok: v.literal(true), nonce: v.string() });

/** A fresh challenge for `deviceId`, signed by `key` over `generation`: the proof the daemon posts for a ticket. */
export async function connectProof(harness: TestUserDO, deviceId: string, key: TestDeviceKey, generation: number): Promise<DeviceConnectProof> {
  const issued = v.parse(IssuedSchema, await harness.userDO.issueDeviceConnectChallenge(await testOwner(), deviceId));
  const signature = signConnect(key, { device: deviceId, generation, nonce: issued.nonce });

  return { origin: TEST_HUB_ORIGIN, device: deviceId, generation, nonce: issued.nonce, signature };
}

/** A ticket for `deviceId` bought with `key`, or the hub's refusal. */
export async function buyTicket(harness: TestUserDO, deviceId: string, key: TestDeviceKey, generation: number): Promise<DeviceTicketIssue> {
  return harness.userDO.issueDeviceConnectTicket(await testOwner(), await connectProof(harness, deviceId, key, generation));
}

/** The socket the UserDO accepted for an upgrade with no ticket in it, before any frame. */
export async function openDeviceSocket(harness: TestUserDO): Promise<AcceptedSocket> {
  const response = await harness.userDO.fetch(new Request(`${TEST_HUB_ORIGIN}${DEVICE_CONNECT_PATH}`, { headers: { Upgrade: 'websocket' } }));

  if (response.status !== 101) throw new Error(`the device upgrade answered ${String(response.status)}`);
  const accepted = harness.acceptedSockets.at(-1);

  if (accepted === undefined) throw new Error('the UserDO upgraded without accepting a socket');

  return accepted;
}

const GenerationSchema = v.object({ type: v.literal(DEVICE_FRAMES.generation), generation: v.number() });

/** The generation the hub handed `socket` on its AUTH, or null for none. */
export function handedGeneration(socket: AcceptedSocket): number | null {
  for (const raw of socket.sent) {
    const frame = v.safeParse(GenerationSchema, JSON.parse(raw));

    if (frame.success) return frame.output.generation;
  }

  return null;
}

/**
 * A daemon's whole connect: a ticket bought with `key` over `generation`, the upgrade, then AUTH as its first frame.
 * `acknowledge` answers the generation the hub hands it, as a daemon that stored it does.
 */
export async function connectTestDevice(
  harness: TestUserDO, deviceId: string, key: TestDeviceKey, opts: { readonly generation: number; readonly acknowledge: boolean },
): Promise<AcceptedSocket> {
  const issued = await buyTicket(harness, deviceId, key, opts.generation);

  if (!issued.ok) throw new Error(`the hub refused the ticket: ${issued.refusal}`);
  const socket = await openDeviceSocket(harness);

  await harness.userDO.webSocketMessage(socket.ws, JSON.stringify({ type: DEVICE_FRAMES.auth, user: harness.userDO.name, ticket: issued.ticket }));
  const generation = handedGeneration(socket);

  if (opts.acknowledge && generation !== null) {
    await harness.userDO.webSocketMessage(socket.ws, JSON.stringify({ type: DEVICE_FRAMES.generationAck, generation }));
  }

  return socket;
}
