/**
 * A device's credential (device protocol 5): an Ed25519 keypair `kinu connect` makes on the machine. The private half
 * stays there, in `~/.kinu/device.key` (PKCS#8 PEM, mode 0600); the hub keeps the public half, and of the connect secret
 * beside it in `device.json` only a hash. What each signature covers, and whether one holds.
 * Dependency-free: the hub, the CLI and the device daemon's CommonJS read this one module.
 */
import protocol from './device-protocol.json';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';

/** Beside `device.json` in the daemon's home. */
export const DEVICE_KEY_FILE = 'device.key';

/** A public key as the 43 base64url characters of its 32 raw bytes, as the hub stores it. */
const PUBLIC_KEY_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;

/** A signature as the 86 base64url characters of its 64 bytes. */
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{86}$/u;

export function isDevicePublicKey(text: string): boolean {
  return PUBLIC_KEY_BASE64URL.test(text);
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(text.replaceAll('-', '+').replaceAll('_', '/'));
}

/**
 * The bytes a daemon signs to buy a connect ticket. `origin` is the hub it dials, so a signature for staging buys
 * nothing on production; `secret` is the connect secret its device.json holds, random and handed anew at each connect
 * the hub accepted ('' before the first), which tells the hub whether a second machine holds this key; `nonce` is the
 * hub's single-use challenge.
 */
export function deviceConnectMessage(origin: string, device: string, secret: string, nonce: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`kinu-device-connect:${String(protocol.version)}:${origin}:${device}:${secret}:${nonce}`);
}

/** A connect secret as the hub hands one: 32 random bytes as base64url; '' is the one a device holds before its first. */
export const DEVICE_CONNECT_SECRET = /^[A-Za-z0-9_-]{43}$/u;

/** The bytes a daemon signs to say why it refused an update, over a challenge of its own. */
export function deviceRefusalMessage(origin: string, device: string, nonce: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`kinu-device-update-refused:${String(protocol.version)}:${origin}:${device}:${nonce}`);
}

/** The bytes a machine's old key signs when `kinu connect` links it again: that registration, replaced by the one
 *  `publicKey` makes. The new public key is fresh per connect, so the signature names one replacement only. */
export function deviceReplaceMessage(origin: string, device: string, publicKey: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`kinu-device-replace:${String(protocol.version)}:${origin}:${device}:${publicKey}`);
}

/** Signs `message` with a PKCS#8 PEM Ed25519 private key; the signature as base64url. The PEM's armour lines are
 *  dropped and its body read as base64, which WebCrypto refuses unless it is such a key. */
export async function signDeviceMessage(privateKeyPem: string, message: Uint8Array<ArrayBuffer>): Promise<string> {
  const body = privateKeyPem.replace(/-----[^-]*-----/gu, '').replace(/\s+/gu, '');
  const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(body), { name: 'Ed25519' }, false, ['sign']);

  return toBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, message)));
}

/** Whether `signature` over `message` was made by `publicKey`'s private half. A key or a signature that is not well
 *  formed is false, never a throw. */
export async function verifyDeviceSignature(publicKey: string, signature: string, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (!PUBLIC_KEY_BASE64URL.test(publicKey) || !SIGNATURE_BASE64URL.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), { name: 'Ed25519' }, false, ['verify']);

  return await crypto.subtle.verify('Ed25519', key, fromBase64Url(signature), message);
}
