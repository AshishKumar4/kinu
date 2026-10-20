/**
 * A screen's binary data frames (1014-t), the one codec the hub and the device daemon both speak: the daemon bundles this
 * module (packages/cli/src/daemon-build.ts), so it reads the protocol file alone.
 */
import protocol from './device-protocol.json';

const DATA = protocol.screenData;

/** The binary messages carrying `bytes` on stream `stream`: a kind byte, the stream as a big-endian u32, then at most
 *  `maxBytes` of RFB; `headerBytes` is the first two. */
export function screenDataFrames(stream: number, bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];

  for (let at = 0; at < bytes.byteLength; at += DATA.maxBytes) {
    const part = bytes.subarray(at, at + DATA.maxBytes);
    const frame = new Uint8Array(DATA.headerBytes + part.byteLength);
    const head = new DataView(frame.buffer);

    head.setUint8(0, DATA.kind);
    head.setUint32(1, stream);
    frame.set(part, DATA.headerBytes);
    frames.push(frame);
  }

  return frames;
}

/** A binary message as a screen data frame; null when it is not one. Every other frame is JSON text, whose first byte is
 *  never the data kind. */
export function readScreenData(message: ArrayBuffer | ArrayBufferView): { stream: number; bytes: Uint8Array } | null {
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);

  if (bytes.byteLength < DATA.headerBytes || bytes[0] !== DATA.kind) return null;
  const head = new DataView(bytes.buffer, bytes.byteOffset, DATA.headerBytes);

  return { stream: head.getUint32(1), bytes: bytes.subarray(DATA.headerBytes) };
}
