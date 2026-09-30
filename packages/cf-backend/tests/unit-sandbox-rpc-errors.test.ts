// The native file boundary carries POSIX errno in Error.cause, which survives JSRPC.
import { expect, test } from 'bun:test';
import { createSandboxExecutor, sandboxFiles } from '@kinu.run/core';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import type { KinuSandbox } from '../src/kinu-sandbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';

function filesRefusing(cause: Error) {
  const box: KinuSandbox = Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    readFile: async () => { throw cause; },
  });

  return sandboxFiles(adaptCloudflareSandbox(box, async () => {}, null));
}

test('a native missing-file error is ENOENT without the SDK error class', async () => {
  const path = '/workspace/first-run-mount.mjs';

  const delivered = new Error('no such file', {
    cause: { kind: 'devbox.file', code: 'ENOENT', path, operation: 'readFile' },
  });

  try {
    await filesRefusing(delivered).readFile(path);
    throw new Error('the missing file was accepted');
  } catch (cause) {
    if (!isVfsError(cause)) throw cause;
    expect(cause.code).toBe('ENOENT');
    expect(cause.path).toBe(path);
  }
});

test('an unknown native file errno is an I/O failure, not a false missing file', async () => {
  const delivered = new Error('new filesystem error', {
    cause: { kind: 'devbox.file', code: 'ENATIVE_UNKNOWN' },
  });

  await expect(filesRefusing(delivered).readFile('/workspace/x')).rejects.toMatchObject({ code: 'EIO' });
});

test('a non-file failure is not classified from its message', async () => {
  const refusal = new Error('FileNotFoundError: an upstream service is unavailable');
  await expect(filesRefusing(refusal).readFile('/workspace/x')).rejects.toMatchObject({ code: 'io' });
});

// Before the native adapter a transport failure reached `withSandboxRetry` as itself; classifying it
// `unavailable` made it a verdict the retry never re-enters.
test('a transient failure on the way to the box is retried by the executor', async () => {
  let calls = 0;

  const box: KinuSandbox = Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    readFile: async () => {
      calls += 1;

      if (calls === 1) throw new Error('Network connection lost.');

      return { content: 'kept', encoding: 'utf-8' as const };
    },
  });

  const executor = createSandboxExecutor(adaptCloudflareSandbox(box, async () => {}, null));

  expect({ read: await executor.tools.readFile?.execute('/workspace/kept.txt'), calls }).toEqual({ read: 'kept', calls: 2 });
});

// Review 3f6, 2026-09-30: the file view read with no encoding, which the native box answers as
// `Response.text()`, so a download or a copy of a binary file came back with its bytes replaced.
test('the sandbox file view reads exact bytes through the adapter', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0xfe]);
  const asked: unknown[] = [];

  const box: KinuSandbox = Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    // As `Devbox.readFile` answers: the bytes only when asked for base64.
    readFile: async (_path: string, opts?: { encoding?: 'utf-8' | 'base64' }) => {
      asked.push(opts);

      return opts?.encoding === 'base64'
        ? { content: Buffer.from(png).toString('base64'), encoding: 'base64' as const }
        : { content: new TextDecoder().decode(png), encoding: 'utf-8' as const };
    },
  });

  const read = await sandboxFiles(adaptCloudflareSandbox(box, async () => {}, null)).readFile('/workspace/logo.png');

  expect({ read, asked }).toEqual({ read: png, asked: [{ encoding: 'base64' }] });
});
