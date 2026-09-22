/**
 * The rpc lane re-raises the SDK's file-error shape — the transport the
 * product actually uses (`SANDBOX_TRANSPORT = "rpc"`, one capnweb session).
 *
 * THE FAILURE THIS LOCKS DOWN SHIPPED TWICE. First as an untranslated miss
 * (a create through the mount refused `io`); then, with the core taxonomy in
 * place, the deployed first-run case `sandbox-mount-write` (build ac73ffc5e,
 * which contains that fix) STILL answered `write
 * /sandbox/workspace/first-run-mount.mjs failed: FileNotFoundError: File not
 * found: /workspace/first-run-mount.mjs`. The core translation keys on the
 * SDK's `name`/`errorResponse`, and over rpc neither crosses:
 *
 *   - capnweb sends `["error", name, message]`
 *     (node_modules/capnweb/dist/index-workers.js:1526) and re-materializes
 *     with `ERROR_TYPES[name] || Error` (:1698), while `ERROR_TYPES` (:1309)
 *     holds only the platform's seven plus AggregateError — so a
 *     `FileNotFoundError` arrives client-side as a plain `Error`. Own
 *     enumerable props DO cross (:1505-1519 → :1702-1712, measured below),
 *     but the SDK's client wrapper only re-raises `instanceof SandboxError`
 *     (`translateRPCError`, sandbox-CPj2jsbz.js:3671) and the DO hop drops
 *     the custom props with the class — the same loss `sandbox-exec-lane.ts`
 *     already routes around by carrying readiness as data.
 *   - Neither dist concatenates name+message anywhere (verified by grep), the
 *     SDK wrapper preserves the message verbatim, and structuredClone
 *     preserves it verbatim (measured below) — so the `FileNotFoundError: `
 *     token leading the live string is baked in server-side, and it is the
 *     only classification the lane ever sees.
 *
 * The first section measures the wire with a REAL capnweb session against a
 * fake container server, so the shape the lane restores from is observed, not
 * assumed. The second drives the lane with that exact shape — the live string
 * verbatim — and proves core's one translation serves both transports.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { newMessagePortRpcSession } from 'capnweb';
import { createSandboxExecutor, isVfsError, sandboxFiles } from '@kinu.run/core';
import type { KinuSandbox } from '../src/kinu-sandbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import { present } from '@kinu.run/test-utils';

/** The SDK's thrown shape, structurally: `name` set in the constructor and
 *  `errorResponse` as an own enumerable prop (sandbox-CPj2jsbz.js:15-17 and
 *  the FileNotFoundError ctor at :59-63). The classes themselves are not
 *  exported from the package index, so the double carries the shape. */
function sdkThrown(name: string, code: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  Object.defineProperty(error, 'errorResponse', {
    value: { code, message, context: {} },
    enumerable: true,
  });

  return error;
}

const WireErrorProps = v.looseObject({
  errorResponse: v.optional(v.looseObject({ code: v.optional(v.string()) })),
});

describe('the rpc wire flattens SDK file errors to name plus message', () => {
  test('a thrown FileNotFoundError arrives as a plain Error, message verbatim, props intact', async () => {
    const { port1, port2 } = new MessageChannel();

    try {
      const server = {
        files: {
          readFile: async (path: string) => {
            throw sdkThrown('FileNotFoundError', 'FILE_NOT_FOUND', `File not found: ${path}`);
          },
        },
      };

      newMessagePortRpcSession(port2, server);

      const remote = newMessagePortRpcSession<{
        files: { readFile(path: string): Promise<{ content: string }> };
      }>(port1);

      let caught: unknown;

      try {
        await remote.files.readFile('/workspace/x.mjs');
      } catch (cause) {
        caught = cause;
      }

      if (!(caught instanceof Error)) throw new Error('the wire must reject with an Error');
      // The collapse: FileNotFoundError is not in ERROR_TYPES, so the class is gone.
      expect(caught.name).toBe('Error');
      // No concatenation anywhere on the path: the message is byte-identical.
      expect(caught.message).toBe('File not found: /workspace/x.mjs');
      // ...while the response object rides along as ordinary props.
      expect(v.parse(WireErrorProps, caught).errorResponse?.code).toBe('FILE_NOT_FOUND');
    } finally {
      port1.close();
      port2.close();
    }
  });

  test('the DO hop keeps the message and drops the rest', () => {
    const wire = sdkThrown('FileNotFoundError', 'FILE_NOT_FOUND', 'File not found: /workspace/x.mjs');
    const delivered = structuredClone(wire);

    expect(delivered.name).toBe('Error');
    expect(delivered.message).toBe('File not found: /workspace/x.mjs');
    expect(v.parse(WireErrorProps, delivered).errorResponse).toBeUndefined();
  });
});

/** The live string, verbatim (kinu.run build ac73ffc5e): name already
 *  flattened to Error, kind baked into the message, props gone. */
const LIVE_MISS = 'FileNotFoundError: File not found: /workspace/first-run-mount.mjs';

function liveWireError(): Error {
  return new Error(LIVE_MISS);
}

/** A container that serves files but answers a missing read the way the
 *  deployed one does — the live shape above, not the SDK class. */
function rpcBox(store: Map<string, string>): KinuSandbox {
  const readFile = async (path: string) => {
    const bytes = store.get(path);

    if (bytes === undefined) throw liveWireError();

    return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64', exitCode: 0 };
  };

  const writeFile = async (path: string, content: string, opts?: { encoding?: string }) => {
    store.set(
      path,
      opts?.encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content,
    );
  };

  const listFiles = async (path: string) => ({
    files: [...store.entries()]
      .filter(([key]) => key.startsWith(`${path}/`))
      .map(([key, content]) => ({ name: key.slice(path.length + 1), type: 'file', size: content.length })),
  });

  return Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    readFile,
    writeFile,
    listFiles,
    deleteFile: async (path: string) => {
      store.delete(path);
    },
  });
}

describe('the rpc lane restores the shape core translates', () => {
  test('a wire-flattened miss comes back a FileNotFoundError carrying its code', async () => {
    const lane = adaptCloudflareSandbox(rpcBox(new Map()), async () => {}, null);

    let caught: unknown;

    try {
      await lane.readFile('/workspace/first-run-mount.mjs');
    } catch (cause) {
      caught = cause;
    }

    if (!(caught instanceof Error)) throw new Error('a miss must reject with an Error');
    expect(caught.name).toBe('FileNotFoundError');
    expect(caught.message).toBe(LIVE_MISS);
    expect(v.parse(WireErrorProps, caught).errorResponse?.code).toBe('FILE_NOT_FOUND');
  });

  test('through the restored shape, a miss reads as ENOENT — one translation, both transports', async () => {
    const lane = adaptCloudflareSandbox(rpcBox(new Map()), async () => {}, null);
    const files = sandboxFiles(lane);

    let caught: unknown;

    try {
      await files.readFile('/workspace/first-run-mount.mjs');
    } catch (cause) {
      caught = cause;
    }

    if (!isVfsError(caught)) throw new Error(`expected a classified refusal, got ${String(caught)}`);
    expect(caught.code).toBe('ENOENT');
  });

  test('a restored ValidationFailedError is EIO, never a raw SDK refusal', async () => {
    const box: KinuSandbox = Object.create({
      resolveReadiness: async () => ({ kind: 'restored' as const }),
      readFile: async () => {
        throw new Error("ValidationFailedError: Invalid path format for '': Path must be a non-empty string");
      },
    });

    const files = sandboxFiles(adaptCloudflareSandbox(box, async () => {}, null));

    let caught: unknown;

    try {
      await files.readFile('/workspace/x');
    } catch (cause) {
      caught = cause;
    }

    if (!isVfsError(caught)) throw new Error(`expected a classified refusal, got ${String(caught)}`);
    expect(caught.code).toBe('EIO');
  });

  test('what is not a flattened SDK file error passes through untouched', async () => {
    const seen: unknown[] = [];

    const box: KinuSandbox = Object.create({
      resolveReadiness: async () => ({ kind: 'restored' as const }),
      readFile: async () => {
        throw seen[0];
      },
    });

    const lane = adaptCloudflareSandbox(box, async () => {}, null);

    const plain = new Error('boom');
    seen[0] = plain;

    let caught: unknown;

    try {
      await lane.readFile('/workspace/x');
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(plain);

    const typed = sdkThrown('FileNotFoundError', 'FILE_NOT_FOUND', 'File not found: /workspace/x');
    seen[0] = typed;

    try {
      await lane.readFile('/workspace/x');
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(typed);
  });

  test('the executor over the lane writes a new file and reads it back', async () => {
    const lane = adaptCloudflareSandbox(rpcBox(new Map()), async () => {}, null);
    const executor = createSandboxExecutor(lane);

    const files = present(executor.files, "the sandbox executor's file plane");

    await files.writeFile('/workspace/first-run-mount.mjs', 'export const ok = 1;\n');
    expect(await files.readFile('/workspace/first-run-mount.mjs', { encoding: 'utf8' }))
      .toBe('export const ok = 1;\n');
  });
});
