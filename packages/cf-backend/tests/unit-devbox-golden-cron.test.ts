// The 15-minute cron keeps the devbox golden snapshot built (devbox D66): it asks the golden object,
// which builds only when the pinned tools moved or the golden nears its end, and a failure is reported.
import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GOLDEN_NAME, type Devbox } from '@kinu.run/devbox';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { keepDevboxGolden } from '../src/devbox-golden';
import { KinuDevbox } from '../src/kinu-devbox';
import { harness, type TestEnv } from '../../devbox/tests/support/devbox-harness';

test('snapshot deletion uses the deployment account even when its image is the managed base', async () => {
  const requests: Request[] = [];
  const snapshot = 'snapshot-owned-by-this-box';
  const tag = `rootfs-snapshot-${createHash('sha256').update(snapshot).digest('hex')}`;

  const original = globalThis.fetch;

  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;

    if (path.endsWith('/credentials')) return Response.json({ success: true, result: { username: 'registry-user', password: ['registry', 'password'].join('-') } });

    if (path === '/v2/_catalog') return Response.json({ repositories: { owned: [tag] } });

    if (request.method === 'DELETE') return new Response(null, { status: 202 });

    return Response.json({ annotations: { 'io.cloudflare.cloudchamber.snapshot_set_id': 'owned-set' } });
  }, { preconnect: original.preconnect }));

  class ManagedBox extends KinuDevbox {
    constructor(ctx: ConstructorParameters<typeof Devbox>[0], _env: TestEnv) {
      super(Object.create(ctx),
        Object.assign(Object.create(null), {
          CLOUDFLARE_ACCOUNT_ID: 'account-for-this-deployment', DEVBOX_REGISTRY_TOKEN: ['registry', 'token'].join('-'),
          BACKUP_BUCKET: Object.create({ list: async () => ({ objects: [], truncated: false }) }),
        }));
    }
    protected override get containerImage(): string { return 'cloudflare/debian-trixie'; }
  }

  try {
    const made = harness(ManagedBox);
    made.rows.set('devbox:snapshot', { id: snapshot, image: 'cloudflare/debian-trixie', chainRev: 0, takenAt: Date.now(), lineage: [] });
    await made.box.discardState();
    expect(requests.some(request => new URL(request.url).pathname.includes('/accounts/account-for-this-deployment/'))).toBe(true);
    expect(requests.filter(request => request.method === 'DELETE').length).toBe(2);
  } finally { network.mockRestore(); }
});

test('the cron asks the golden object, and a failed build is reported by name', async () => {
  const asked: string[] = [];

  const boxes = (answer: () => Promise<string>) => ({
    getByName: (name: string) => ({
      ensureGolden: async () => {
        asked.push(name);

        return await answer();
      },
    }),
  });

  const recorder = createRecordingLogger();
  const restore = setDiagnosticsSink(recorder);

  try {
    await keepDevboxGolden(boxes(async () => 'golden-1'));
    await keepDevboxGolden(boxes(async () => await Promise.reject(new Error('installing the tools exited 100'))));
  } finally {
    restore();
  }

  expect({ asked, failed: recorder.emitted.filter(line => line.event === 'devbox.golden_failed').map(line => line.cause ?? '') })
    .toEqual({ asked: [GOLDEN_NAME, GOLDEN_NAME], failed: [expect.stringContaining('installing the tools exited 100')] });
});
