/**
 * The rpc lane re-raises the SDK's file-error shape. Defends `sandbox-mount-write` on build ac73ffc5e answering
 * `FileNotFoundError` untranslated: capnweb rebuilds unknown error names as plain `Error` (node_modules/capnweb/dist/index-workers.js:1698)
 * and the DO hop drops custom props, so the `FileNotFoundError: ` message prefix is the only classification left.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { newMessagePortRpcSession } from 'capnweb';
import { createSandboxExecutor, isVfsError, sandboxFiles } from '@kinu.run/core';
import type { KinuSandbox } from '../src/kinu-sandbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import { present } from '@kinu.run/test-utils';

/** The SDK's thrown shape (sandbox-D0rNqxlr.js:15-17, :59-63); the classes are not exported from the package
 *  index, so the double carries the shape. */
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
      // FileNotFoundError is not in ERROR_TYPES, so the class is gone.
      expect(caught.name).toBe('Error');
      expect(caught.message).toBe('File not found: /workspace/x.mjs');
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

/** The live string, verbatim (kinu.run build ac73ffc5e). */
const LIVE_MISS = 'FileNotFoundError: File not found: /workspace/first-run-mount.mjs';

function liveWireError(): Error {
  return new Error(LIVE_MISS);
}

/** A container answering a missing read with the live shape above, not the SDK class. */
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
