/**
 * Publication: the writer half of the preview gate.
 *
 * The edge refuses a preview hostname it cannot prove against the exposures
 * this deployment published (`unit-preview-forgery.test.ts` drives that half
 * through the Worker entry). This file holds the other end of the same
 * contract, on the executor lane the workspace's own Durable Object runs:
 *
 *   * every preview URL the lane hands out is published FIRST, and published
 *     under the token the URL actually carries;
 *   * a deployment that cannot publish refuses to mint a URL instead of handing
 *     out a link the edge will turn away;
 *   * unexposing and removing a port withdraw it, in the fail-closed order;
 *   * listing ports re-publishes what the container still reports, which is how
 *     a long-lived exposure does not age out of the record and how one minted
 *     before the record existed gets into it.
 *
 * The round trip is asserted through the real reader, so a change to either
 * side of the token derivation fails here rather than in production.
 */
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import {
  sandboxPreviewExposed,
  sandboxPreviewExposures,
  type SandboxPreviewExposures,
} from '../src/lib/preview-exposures';
import { makeKv, type FakeKv } from './helpers/kv';
import type { KvStore } from '../src/lib/kv';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import type { KinuSandbox } from '../src/kinu-sandbox';

const SUFFIX = 'previews.example';
const SANDBOX_ID = 'kinu-hello';
const PORT = 8080;
const TOKEN = 'p8080_ab12cd34';

/** The exposure lifetime these cases pin: thirty days without observation. */
const EXPOSURE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

afterAll(() => { setSystemTime(); });

/** What a body reported while it ran. A failure that is reported rather than
 *  propagated still has to be visible, and this is where that is checked. */
async function recordDiagnostics(body: () => Promise<void>): Promise<readonly RecordedLog[]> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);
  try { await body(); } finally { restore(); }
  return logger.emitted;
}

interface PortBox {
  /** Ports the container object was asked to expose. */
  readonly exposed: number[];
  /** Ports revoked on the container object. */
  readonly revoked: number[];
  /** Ports whose durable row was removed. */
  readonly removed: number[];
  readonly box: KinuSandbox;
}

/** A container object that answers the four port methods and nothing else, the
 *  way the SDK does: `exposePort` returns the URL it minted. */
function portBox(options: { token?: string; failRevoke?: boolean } = {}): PortBox {
  const exposed: number[] = [];
  const revoked: number[] = [];
  const removed: number[] = [];
  const token = options.token ?? TOKEN;
  const box: KinuSandbox = Object.create({
    ensureReady: async () => {},
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

/** The lane as the workspace's Durable Object composes it. `writer` is the
 *  exposures writer that object built when it woke; a test that needs the
 *  writer to predate a revocation hands it in instead of minting one per call. */
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
    // The SDK reuses a port's existing token rather than the one passed in, so
    // recording the requested token would publish a record no URL matches. The
    // lane reads the token back out of the minted URL for exactly this case.
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
    // And it refuses BEFORE the container is asked, so no exposure exists that
    // the edge would then turn away.
    expect(exposed).toEqual([]);
  });

  test('a minted URL the deployment cannot parse is a failure, not a silent link', async () => {
    const kv = makeKv();
    // An SDK that changed its URL shape: the record could not name the token,
    // so the edge would refuse the link the agent is about to hand out.
    const box: KinuSandbox = Object.create({
      ensureReady: async () => {},
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

    // The container half fails; the safe direction is a live port nothing can
    // reach, never a revoked port the edge still admits.
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

    // Two thirds of the way through the record's life, the Ports panel lists.
    setSystemTime(new Date(Date.now() + (EXPOSURE_LIFETIME_MS * 2) / 3));
    await lane(kv, box).getExposedPorts(SUFFIX);
    // Two thirds again: past the first record's expiry, so a preview still in
    // use resolves only because the observation refreshed it.
    setSystemTime(new Date(Date.now() + (EXPOSURE_LIFETIME_MS * 2) / 3));

    expect(await sandboxPreviewExposed(kv, claim)).toBe(true);

    // And it is a bound, not an immortal record: with nothing observing it, the
    // same wait lapses.
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
    // The record is already correct; only the maintenance write fails. A
    // workspace whose ports are all live must not see an empty panel because
    // the store hiccupped — and the failure is reported, never dropped.
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
  // `destroyAgent` writes the watermark first and then spends several awaits
  // destroying the container object. A Ports listing, or an expose whose
  // container call was already in flight, runs in those gaps on the same
  // object, and its writer was built when the object woke — before the
  // watermark. Neither may put a record back that the edge would then prove.
  const claim = { sandboxId: SANDBOX_ID, port: PORT, token: TOKEN };

  test('a listing racing the destroy does not refresh a record the watermark withdrew', async () => {
    const kv = makeKv();
    const { box } = portBox();
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const writer = sandboxPreviewExposures(kv, SANDBOX_ID);
    await writer.publish(PORT, TOKEN);

    // Late enough in the record's life that a listing would rewrite it.
    setSystemTime(new Date(Date.now() + (EXPOSURE_LIFETIME_MS * 2) / 3));
    await writer.revokeAll();
    setSystemTime(new Date(Date.now() + 1));
    const rows = await lane(kv, box, writer).getExposedPorts(SUFFIX);

    // The listing itself stands: the container still reports the port.
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

    // A URL the edge would refuse is a failure here, never a dead link.
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
