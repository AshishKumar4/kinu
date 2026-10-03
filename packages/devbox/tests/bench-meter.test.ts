// The 104-cycle soak (sbs10031343nsoak1, D68): a kill mid-save cancelled a store request while it
// pushed the bench's operation tally. The push never settled, every later store request in that
// isolate awaited it, and from then on every box's `/backups` mount failed until teardown.
import { expect, test } from 'bun:test';
import { DevboxStoreGateway } from '../bench/worker';
import { storeRouteHost, storeSource, type StoreGatewayProps } from '../src/store-gateway';

const props: StoreGatewayProps = {
  protocolVersion: 1, mode: 'active', routeId: 'route-1', source: storeSource('BACKUP_BUCKET'),
  keyPrefix: 'boxes/box-1/', access: 'read-write',
};

test('a store request does not wait on a tally push that another request left unsettled', async () => {
  let pushes = 0;
  // The first push belongs to the cancelled request: the runtime never settles it.
  const counter = { bump: async () => { pushes += 1; await (pushes === 1 ? new Promise<void>(() => undefined) : Promise.resolve()); } };

  // SAFETY: the gateway reaches `props` on its context, and `BACKUP_BUCKET` and `BenchOpCounter`
  // on its env; a HEAD reaches only `head` on the bucket and only `bump` on the counter.
  const env = Object.create({
    BACKUP_BUCKET: Object.create({ head: async () => await Promise.resolve(null) }),
    BenchOpCounter: { idFromName: (name: string) => name, get: () => counter },
  });

  const head = async (): Promise<number> => {
    const gateway = new DevboxStoreGateway(Object.create({ props }), env);
    const answer = await gateway.fetch(new Request(`http://${storeRouteHost('route-1')}/BACKUP_BUCKET/a`, { method: 'HEAD' }));

    return answer.status;
  };

  const cancelled = head();

  // On the previous code the second request never answers, and the ladder kills the hung run.
  expect(await head()).toBe(404);
  expect(Bun.peek.status(cancelled)).toBe('pending');
});
