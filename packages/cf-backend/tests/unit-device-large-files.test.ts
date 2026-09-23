/**
 * A device file of any size crosses the tunnel: the hub's file client (`deviceFiles`) against the
 * real daemon (`packages/pc-agent/src/index.js`), over a socket that holds the one limit the
 * platform sets. A Worker receives at most 32 MiB in one WebSocket message and closes the socket
 * with 1009 past it (Cloudflare changelog 2025-10-31, "Workers WebSocket message size limit
 * increased from 1 MiB to 32 MiB").
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { deviceFiles, JsonValueSchema, type DeviceStatus, type DeviceTransport, type JsonValue } from '@kinu.run/core';

const require_ = createRequire(import.meta.url);

const pcAgent = v.parse(
  v.object({ handle: v.function() }),
  require_(join(import.meta.dir, '../../pc-agent/src/index.js')),
);

const WORKER_WEBSOCKET_RECEIVE_BYTES = 32 * 1024 * 1024;

const ReplySchema = v.object({ id: v.string(), result: v.optional(JsonValueSchema), error: v.optional(v.string()) });

/** Every frame goes to the daemon as the hub sends it, with the owner's Sandbox switch off; every
 *  answer comes back through the platform's receive limit. */
function tunnelToDaemon(): DeviceTransport {
  const connected: DeviceStatus = { connected: true, registered: true, toolchain: null };
  let next = 0;

  return {
    status: () => connected,
    refreshStatus: async () => connected,
    rpc: (method, params) => new Promise<JsonValue | undefined>((resolve, reject) => {
      const id = `rpc-largefiles-${String(next += 1)}`;

      const socket = {
        readyState: 1,
        send(data: string) {
          const bytes = Buffer.byteLength(data);

          if (bytes > WORKER_WEBSOCKET_RECEIVE_BYTES) {
            reject(new Error(`the hub closed the device socket with 1009: a ${String(bytes)}-byte message is over the `
              + `${String(WORKER_WEBSOCKET_RECEIVE_BYTES)} bytes a Worker receives`));

            return;
          }

          const reply = v.parse(ReplySchema, JSON.parse(data));

          if (reply.error !== undefined) reject(new Error(reply.error));
          else resolve(reply.result);
        },
      };

      pcAgent.handle({ id, method, params, sandbox: { tier: 'raw', agentHome: '', roots: [] } }, socket, {});
    }),
  };
}

/** Byte i holds i mod 251, a prime, so a chunk read out of place or twice changes the bytes. */
function patterned(length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) bytes[index] = index % 251;

  return bytes;
}

const files = deviceFiles(tunnelToDaemon(), {
  consentedRoot: async () => '/',
  deviceHome: async () => '/',
  unconfined: async () => true,
});

describe('a device file of any size crosses the tunnel', () => {
  test('a 40 MiB file reads end to end, byte for byte', async () => {
    const root = scratchDir('device-large-file');
    const file = join(root, 'weights.bin');
    const written = patterned(40 * 1024 * 1024);
    writeFileSync(file, written);

    const read = await files.readFile(file);

    expect(read.length).toBe(written.length);
    expect(Buffer.compare(Buffer.from(read), Buffer.from(written))).toBe(0);
  });

  test('a range across chunk boundaries answers exactly the bytes asked for', async () => {
    const root = scratchDir('device-large-range');
    const file = join(root, 'weights.bin');
    const written = patterned(20 * 1024 * 1024);
    writeFileSync(file, written);
    const offset = 8 * 1024 * 1024 - 5;
    const length = 9 * 1024 * 1024;

    const read = await files.readRange(file, offset, length);

    expect(Buffer.compare(Buffer.from(read), Buffer.from(written.subarray(offset, offset + length)))).toBe(0);
    // Past the end, a range answers what the file holds.
    expect((await files.readRange(file, written.length - 3, 10)).length).toBe(3);
  });

  test('a directory of 25,000 entries lists completely', async () => {
    const root = scratchDir('device-wide-dir');
    const dir = join(root, 'frames');
    mkdirSync(dir);
    const names = Array.from({ length: 25_000 }, (_, index) => `frame-${String(index).padStart(5, '0')}.png`);

    for (const name of names) writeFileSync(join(dir, name), '');

    expect([...await files.readdir(dir)].sort()).toEqual(names);
  });
});
