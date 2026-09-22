/**
 * Writer half of the preview gate (`unit-preview-forgery.test.ts` holds the edge half): every URL is published first
 * under the token it carries, unpublishable deployments refuse to mint, withdrawal is fail-closed, and listing re-publishes.
 */
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import {
  sandboxPreviewExposed,
  sandboxPreviewExposures,
  type SandboxPreviewExposures,
} from '@kinu.run/core';
import { makeKv, type FakeKv } from './helpers/kv';
import type { KvStore } from '@kinu.run/agent-utils';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import type { KinuSandbox } from '../src/kinu-sandbox';

const SUFFIX = 'previews.example';

const SANDBOX_ID = 'kinu-hello';

const PORT = 8080;

const TOKEN = 'p8080_ab12cd34';

const EXPOSURE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

afterAll(() => { setSystemTime(); });

/** A failure reported rather than propagated must still be visible. */
async function recordDiagnostics(body: () => Promise<void>): Promise<readonly RecordedLog[]> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);

  try { await body(); } finally { restore(); }

  return logger.emitted;
}

interface PortBox {
  readonly exposed: number[];
  readonly revoked: number[];
  readonly removed: number[];
  readonly box: KinuSandbox;
}

/** Answers the four port methods only; `exposePort` returns the minted URL, like the SDK. */
function portBox(options: { token?: string; failRevoke?: boolean } = {}): PortBox {
  const exposed: number[] = [];
  const revoked: number[] = [];
  const removed: number[] = [];
  const token = options.token ?? TOKEN;

  const box: KinuSandbox = Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    exposePort: async (port: number, opts: { hostname: string }) => {
      exposed.push(port);

      return {
        url: `https://${String(port)}-${SANDBOX_ID}-${token}.${opts.hostname}/`,
        port,
      };
    },
    unexposePort: async (port: number) => {
      if (options.failRevoke === true) throw new Error('container unreachable');
      revoked.push(port);

      return undefined;
    },
    notePortRemoved: async (port: number) => { removed.push(port); },
    getExposedPorts: async (hostname: string) => [{
      url: `https://${String(PORT)}-${SANDBOX_ID}-${token}.${hostname}/`,
      port: PORT,
      status: 'active',
    }],
  });

  return { exposed, revoked, removed, box };
}

/** `writer` is built when the object woke; pass one in when it must predate a revocation. */
function lane(kv: FakeKv | null, box: KinuSandbox, writer?: SandboxPreviewExposures) {
  return adaptCloudflareSandbox(
    box,
    async () => {},
    writer ?? (kv === null ? null : sandboxPreviewExposures(kv, SANDBOX_ID)),
  );
}

describe('exposing a port publishes the preview the edge will be asked about', () => {
  test('the URL handed back is provable, under the token it carries', async () => {
    const kv = makeKv();
    const { box, exposed } = portBox();

    const result = await lane(kv, box).exposePort(PORT, { hostname: SUFFIX });

    expect(exposed).toEqual([PORT]);
    expect(result.url).toBe(`https://${String(PORT)}-${SANDBOX_ID}-${TOKEN}.${SUFFIX}/`);
    expect(await sandboxPreviewExposed(kv, {
      sandboxId: SANDBOX_ID, port: PORT, token: TOKEN,
    })).toBe(true);
  });

  test('the token PUBLISHED is the one the URL carries, not the one asked for', async () => {
    // The SDK reuses a port's existing token, so the lane reads the token back out of the minted URL.
    const kv = makeKv();
    const { box } = portBox({ token: 'p8080_reused99' });

    await lane(kv, box).exposePort(PORT, { hostname: SUFFIX, token: 'p8080_asked00' });

    expect(await sandboxPreviewExposed(kv, {
      sandboxId: SANDBOX_ID, port: PORT, token: 'p8080_reused99',
    })).toBe(true);
    expect(await sandboxPreviewExposed(kv, {
      sandboxId: SANDBOX_ID, port: PORT, token: 'p8080_asked00',
    })).toBe(false);
  });

  test('a deployment that cannot publish refuses to mint a URL', async () => {
    const { box, exposed } = portBox();

    await expect(lane(null, box).exposePort(PORT, { hostname: SUFFIX }))
      .rejects.toThrow('AUTH_KV');
    // Refused before the container is asked.
    expect(exposed).toEqual([]);
  });

  test('a minted URL the deployment cannot parse is a failure, not a silent link', async () => {
    const kv = makeKv();

    const box: KinuSandbox = Object.create({
      resolveReadiness: async () => ({ kind: 'restored' as const }),
      exposePort: async () => ({ url: 'https://preview.elsewhere.example/8080', port: PORT }),
    });

    await expect(lane(kv, box).exposePort(PORT, { hostname: SUFFIX })).rejects.toThrow('cannot publish');
    expect(kv.keys()).toEqual([]);
  });
});

describe('revoking a port withdraws its published preview', () => {
  test('unexposing withdraws it, and withdraws it BEFORE the container is asked', async () => {
    const kv = makeKv();
    const { box } = portBox({ failRevoke: true });
    await sandboxPreviewExposures(kv, SANDBOX_ID).publish(PORT, TOKEN);

    // Fail-safe direction: a live unreachable port, never a revoked port the edge still admits.
    await expect(lane(kv, box).unexposePort(PORT)).rejects.toThrow('container unreachable');

    expect(await sandboxPreviewExposed(kv, {
      sandboxId: SANDBOX_ID, port: PORT, token: TOKEN,
    })).toBe(false);
  });

  test('removing the port row withdraws it too', async () => {
    const kv = makeKv();
    const { box, removed } = portBox();
    await sandboxPreviewExposures(kv, SANDBOX_ID).publish(PORT, TOKEN);

    await lane(kv, box).notePortRemoved(PORT);

    expect(removed).toEqual([PORT]);
    expect(await sandboxPreviewExposed(kv, {
      sandboxId: SANDBOX_ID, port: PORT, token: TOKEN,
    })).toBe(false);
  });
});

describe('listing ports re-observes what the container still reports', () => {
  test('an exposure minted before this record existed is carried into it', async () => {
    const kv = makeKv();
    const { box } = portBox();
    expect(kv.keys()).toEqual([]);

    const rows = await lane(kv, box).getExposedPorts(SUFFIX);

    expect(rows.map((row) => row.port)).toEqual([PORT]);
    expect(await sandboxPreviewExposed(kv, {
      sandboxId: SANDBOX_ID, port: PORT, token: TOKEN,
    })).toBe(true);
  });

  test('a re-observed exposure outlives the record it was first published in', async () => {
    const kv = makeKv();
    const { box } = portBox();
    const claim = { sandboxId: SANDBOX_ID, port: PORT, token: TOKEN };
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    await sandboxPreviewExposures(kv, SANDBOX_ID).publish(PORT, TOKEN);

    setSystemTime(new Date(Date.now() + (EXPOSURE_LIFETIME_MS * 2) / 3));
    await lane(kv, box).getExposedPorts(SUFFIX);
    // Past the first expiry: the preview resolves only because the listing refreshed it.
    setSystemTime(new Date(Date.now() + (EXPOSURE_LIFETIME_MS * 2) / 3));

    expect(await sandboxPreviewExposed(kv, claim)).toBe(true);

    setSystemTime(new Date(Date.now() + EXPOSURE_LIFETIME_MS));
    expect(await sandboxPreviewExposed(kv, claim)).toBe(false);
    setSystemTime();
  });

  test('a fresh record is not rewritten, so a polling Ports panel writes nothing', async () => {
    const kv = makeKv();
    const { box } = portBox();
    await sandboxPreviewExposures(kv, SANDBOX_ID).publish(PORT, TOKEN);
    const key = `sandbox-preview:${SANDBOX_ID}:${String(PORT)}`;
    const published = await kv.get(key);

    await lane(kv, box).getExposedPorts(SUFFIX);
    await lane(kv, box).getExposedPorts(SUFFIX);

    expect(await kv.get(key)).toBe(published);
  });

  test('a store that refuses the refresh does not empty the Ports panel', async () => {
    const kv = makeKv();
    const { box } = portBox();

    // A failed maintenance write must not empty the panel, and is reported.
    const refusing: KvStore = {
      get: (key) => kv.get(key),
      put: async () => { throw new Error('KV PUT failed: 429'); },
      delete: (key) => kv.delete(key),
    };

    const emitted = await recordDiagnostics(async () => {
      const rows = await adaptCloudflareSandbox(
        box, async () => {}, sandboxPreviewExposures(refusing, SANDBOX_ID),
      ).getExposedPorts(SUFFIX);

      expect(rows.map((row) => row.port)).toEqual([PORT]);
    });

    expect(emitted.map((line) => line.event)).toContain('preview.refresh_failed');
  });
});

describe('a revoked exposure is never resurrected by the lane that published it', () => {
  // `destroyAgent` writes the watermark then awaits container teardown; writers built before it must not re-publish.
  const claim = { sandboxId: SANDBOX_ID, port: PORT, token: TOKEN };

  test('a listing racing the destroy does not refresh a record the watermark withdrew', async () => {
    const kv = makeKv();
    const { box } = portBox();
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const writer = sandboxPreviewExposures(kv, SANDBOX_ID);
    await writer.publish(PORT, TOKEN);

    setSystemTime(new Date(Date.now() + (EXPOSURE_LIFETIME_MS * 2) / 3));
    await writer.revokeAll();
    setSystemTime(new Date(Date.now() + 1));
    const rows = await lane(kv, box, writer).getExposedPorts(SUFFIX);

    expect(rows.map((row) => row.port)).toEqual([PORT]);
    expect(await sandboxPreviewExposed(kv, claim)).toBe(false);
    setSystemTime();
  });

  test('a listing under a watermark does not create a record for an exposure it cannot vouch for', async () => {
    const kv = makeKv();
    const { box } = portBox();
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const writer = sandboxPreviewExposures(kv, SANDBOX_ID);
    await writer.revokeAll();
    setSystemTime(new Date(Date.now() + 1));

    await lane(kv, box, writer).getExposedPorts(SUFFIX);

    expect(await sandboxPreviewExposed(kv, claim)).toBe(false);
    setSystemTime();
  });

  test('an expose in flight when the workspace is destroyed publishes nothing', async () => {
    const kv = makeKv();
    const { box } = portBox();
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const writer = sandboxPreviewExposures(kv, SANDBOX_ID);
    await writer.revokeAll();
    setSystemTime(new Date(Date.now() + 1));

    await expect(lane(kv, box, writer).exposePort(PORT, { hostname: SUFFIX }))
      .rejects.toThrow('revoked');

    expect(await sandboxPreviewExposed(kv, claim)).toBe(false);
    setSystemTime();
  });

  test('the recreated workspace, whose object woke after the destroy, publishes again', async () => {
    const kv = makeKv();
    const { box } = portBox();
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    await sandboxPreviewExposures(kv, SANDBOX_ID).revokeAll();
    setSystemTime(new Date(Date.now() + 1));

    await lane(kv, box).exposePort(PORT, { hostname: SUFFIX });

    expect(await sandboxPreviewExposed(kv, claim)).toBe(true);
    setSystemTime();
  });
});
