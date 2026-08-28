import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';



describe("Cap'n Web transferred writable stream ownership", () => {
  it('delivers close after the RPC that returned the writable stream settles', async () => {
    const remote = env.STREAM_LIFECYCLE.get(env.STREAM_LIFECYCLE.idFromName('close'));
    const writable = await remote.openWritable();

    const writer = writable.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.close();

    await expect(remote.streamEffects()).resolves.toEqual({
      writeClosed: true,
      writeAborted: false,
    });
  });

  it('delivers abort after a caller-owned remote writable stream fails', async () => {
    const remote = env.STREAM_LIFECYCLE.get(env.STREAM_LIFECYCLE.idFromName('abort'));
    const writable = await remote.openWritable();
    await writable.abort(new Error('candidate finalization failed'));

    await expect(remote.streamEffects()).resolves.toEqual({
      writeClosed: false,
      writeAborted: true,
    });
  });
});
