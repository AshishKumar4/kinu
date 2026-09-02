/**
 * The runtime's device file-consent adapters — the two reads that decide what
 * a device file operation may reach — over the production seam.
 *
 * The harness's default owner plane REFUSES every RPC a suite did not declare,
 * which is exactly a hub that cannot be reached. What that failure turns into
 * is the whole contract here: the operation fails CLOSED either way, and the
 * reason must be the truth (the hub could not be asked) rather than the
 * absent-directory refusal, which would send the owner to reconnect a machine
 * that is fine.
 */
import { describe, expect, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import { orchestratorHarness } from './helpers/actor-harness';

function deviceFiles() {
  const harness = orchestratorHarness();
  const provider = harness.agent.observeRuntime().executionRouter?.getProvider('laptop');
  if (!provider?.files) throw new Error('the runtime registered no device file view');
  return provider.files;
}

/** The result is discarded by contract: the operation is expected to fail. */
async function closedWith<Result>(work: () => Promise<Result>): Promise<KinuError> {
  try {
    await work();
  } catch (caught) {
    if (caught instanceof KinuError) return caught;
    throw new Error('the operation failed, but not with a classified error', { cause: caught });
  }
  throw new Error('the operation was expected to fail closed');
}

describe('a device file operation whose hub read fails', () => {
  test('fails closed with the hub failure as its cause, never as "no consented directory"', async () => {
    const files = deviceFiles();
    const caught = await closedWith(() => files.readFile('/home/me/proj/notes.md'));

    // The truth, with the chain intact: the hub could not answer the file-view
    // question, and the harness says so by name underneath.
    expect(caught.code).toBe('unavailable');
    expect(caught.message).toBe("reading the device's file-view scope");
    expect(caught.cause).toBeInstanceOf(Error);
    expect(caught.cause instanceof Error ? caught.cause.message : '')
      .toContain('getDeviceFileView is not reachable');
    // And NOT the lie a swallowed read used to tell.
    expect(caught.message).not.toContain('no consented directory');
  });

  test('every operation is closed the same way', async () => {
    const files = deviceFiles();
    const scopeRead = "reading the device's file-view scope";
    expect((await closedWith(() => files.writeFile('/home/me/proj/x', 'bytes'))).message).toBe(scopeRead);
    expect((await closedWith(() => files.readdir('/home/me/proj'))).message).toBe(scopeRead);
    expect((await closedWith(() => files.stat('/home/me/proj/x'))).message).toBe(scopeRead);
    expect((await closedWith(() => files.exists('/home/me/proj/x'))).message).toBe(scopeRead);
  });
});
