const SESSION_RE = /^p[a-f0-9]{24}$/;
const CAPABILITY_RE = /^[a-f0-9]{24}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const LABEL_RE = /^([0-9a-z]{1,4})-([a-z2-7]{20})-([a-z2-7]{20})-([a-z2-7]{15})$/;

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += BASE32[(buffer << (5 - bits)) & 31];
  return encoded;
}

function encodeHex(value: string): string {
  if (!/^[a-f0-9]+$/.test(value) || value.length % 2 !== 0) throw new Error('Invalid hex value');
  return encodeBase32(Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)));
}

function decodeBase32Hex(value: string, expectedBytes: number): string | null {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of value) {
    const digit = BASE32.indexOf(character);
    if (digit < 0) return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bytes.length !== expectedBytes || buffer !== 0) return null;
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface NimbusPreviewHost {
  port: number;
  sessionId: string;
  token: string;
  capability: string;
}

export function parseNimbusPreviewLabel(label: string): NimbusPreviewHost | null {
  const match = LABEL_RE.exec(label.toLowerCase());
  if (!match) return null;
  const port = Number.parseInt(match[1], 36);
  const sessionHex = decodeBase32Hex(match[2], 12);
  const capability = decodeBase32Hex(match[3], 12);
  if (!sessionHex || !capability) return null;
  const sessionId = `p${sessionHex}`;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !SESSION_RE.test(sessionId)) return null;
  return { port, sessionId, token: match[4], capability };
}

export function buildNimbusPreviewHost(
  port: number,
  sessionId: string,
  token: string,
  capability: string,
  suffix: string,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid preview port: ${port}`);
  if (!SESSION_RE.test(sessionId)) throw new Error(`Invalid Nimbus session id: ${sessionId}`);
  if (!/^[a-z2-7]{15}$/.test(token)) throw new Error('Invalid Nimbus preview token');
  if (!CAPABILITY_RE.test(capability)) throw new Error('Invalid Nimbus preview capability');
  return `${port.toString(36)}-${encodeHex(sessionId.slice(1))}-${encodeHex(capability)}-${token}.${suffix}`;
}
