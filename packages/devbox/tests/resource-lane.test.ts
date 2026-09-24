// Tests the container owner's resource lane, shared by every agent's Durable Object, from
// independent callers: resource identity is topology, and a stream's claim ends at drain.
import { describe, expect, test } from 'bun:test';

import {
  canonicalPath,
  createResourceLane,
  heldUntilDrained,
  pathScopes,
  portScope,
  processScope,
  scopesOverlap,
} from '../src/lifecycle';

/** Drains microtasks without a clock: an operation not entered after this is held by the lane,
 *  not merely unscheduled. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

/** Two independent clients model two facets of one container; both must share ONE lane,
 *  since a per-client lane would pass every assertion below while the bug survived. */
function sharedOwner() {
  const lane = createResourceLane();
  const order: string[] = [];

  const client = (name: string) => ({
    op: (label: string, scopes: readonly Parameters<typeof scopesOverlap>[0][number][]) => {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();

      const done = lane.run(scopes, async () => {
        order.push(`${name}/${label}:enter`);
        entered.resolve();
        await gate.promise;
        order.push(`${name}/${label}:exit`);
      });

      return { done, entered: entered.promise, release: gate.resolve };
    },
  });

  return { lane, order, a: client('a'), b: client('b') };
}

describe('what counts as the same resource', () => {
  test('one path spelled two ways is one resource', () => {
    expect(canonicalPath('/workspace/./src/../a.txt')).toBe('/workspace/a.txt');
    expect(canonicalPath('a.txt')).toBe('/workspace/a.txt');
    expect(canonicalPath('/workspace//src///a.txt')).toBe('/workspace/src/a.txt');
    expect(canonicalPath('/workspace/src/')).toBe('/workspace/src');
  });

  test('a subtree claim reaches everything beneath it, from either end', () => {
    const subtree = pathScopes({ path: '/workspace/src', recursive: true });
    expect(scopesOverlap(subtree, pathScopes({ path: '/workspace/src/a/b.ts' }))).toBe(true);
    expect(scopesOverlap(pathScopes({ path: '/workspace/src/a/b.ts' }), subtree)).toBe(true);
  });

  test('a subtree claim stops at a segment boundary, so a sibling is not swallowed', () => {
    // `/workspace/srcx` is not inside `/workspace/src`, and a plain string
    // prefix would say it is.
    const subtree = pathScopes({ path: '/workspace/src', recursive: true });
    expect(scopesOverlap(subtree, pathScopes({ path: '/workspace/srcx/a.ts' }))).toBe(false);
  });

  test('membership makes a listing conflict with a create inside it', () => {
    // Exact-path keys miss this pair: `listFiles('/workspace/src')` and
    // `writeFile('/workspace/src/a.ts')` name different paths and the same fact.
    const listing = pathScopes({ path: '/workspace/src' });
    const create = pathScopes({ path: '/workspace/src/a.ts', membership: true });
    expect(scopesOverlap(listing, create)).toBe(true);
  });

  test('membership does not reach a directory that cannot change', () => {
    const create = pathScopes({ path: '/workspace/src/a.ts', membership: true });
    expect(scopesOverlap(pathScopes({ path: '/workspace/lib' }), create)).toBe(false);
  });

  test('a create claims its own directory and no higher, so unrelated writes stay parallel', () => {
    // Claiming every ancestor is a global lock: two creates in unrelated
    // directories would both name `/workspace`.
    const create = pathScopes({ path: '/workspace/a/b/c.ts', membership: true });
    expect(scopesOverlap(pathScopes({ path: '/workspace/a/b' }), create)).toBe(true);
    expect(scopesOverlap(pathScopes({ path: '/workspace/a' }), create)).toBe(false);
    expect(scopesOverlap(pathScopes({ path: '/workspace' }), create)).toBe(false);
  });

  test('a recursive mkdir is the one operation that claims the whole chain', () => {
    const recursive = pathScopes({ path: '/workspace/a/b/c', membership: true, ancestors: true });

    for (const above of ['/workspace', '/workspace/a', '/workspace/a/b']) {
      expect(scopesOverlap(pathScopes({ path: above }), recursive)).toBe(true);
    }
  });

  test('ports and processes are their own namespaces, and adjacent numbers do not touch', () => {
    expect(scopesOverlap(portScope(3000), portScope(3000))).toBe(true);
    expect(scopesOverlap(portScope(3000), portScope(30001))).toBe(false);
    expect(scopesOverlap(portScope(3000), processScope('3000'))).toBe(false);
    expect(scopesOverlap(portScope(3000), pathScopes({ path: '/workspace' }))).toBe(false);
  });
});

describe('two independent callers of one container', () => {
  test('the same resource is never held by both at once', async () => {
    const owner = sharedOwner();
    const first = owner.a.op('write', [...pathScopes({ path: '/workspace/a.txt' })]);
    await first.entered;
    const second = owner.b.op('write', [...pathScopes({ path: '/workspace/a.txt' })]);

    await drain();
    expect(owner.order).toEqual(['a/write:enter']);

    first.release();
    await first.done;
    await second.entered;
    second.release();
    await second.done;
    expect(owner.order).toEqual([
      'a/write:enter', 'a/write:exit', 'b/write:enter', 'b/write:exit',
    ]);
  });

  test('a read waits behind the write it would otherwise tear', async () => {
    const owner = sharedOwner();
    const write = owner.a.op('write', [...pathScopes({ path: '/workspace/a.txt', membership: true })]);
    await write.entered;
    const read = owner.b.op('read', [...pathScopes({ path: '/workspace/a.txt' })]);

    await drain();
    expect(owner.order).not.toContain('b/read:enter');

    write.release();
    await write.done;
    await read.entered;
    read.release();
    await read.done;
    expect(owner.order.indexOf('a/write:exit'))
      .toBeLessThan(owner.order.indexOf('b/read:enter'));
  });

  test('independent resources run at the same time', async () => {
    const owner = sharedOwner();
    const held = owner.a.op('write', [...pathScopes({ path: '/workspace/one/a.txt', membership: true })]);
    await held.entered;

    const other = owner.b.op('write', [...pathScopes({ path: '/workspace/two/b.txt', membership: true })]);
    const port = owner.b.op('expose', [...portScope(3000)]);

    // Drained and asserted, not awaited: awaiting entry under a container-keyed lane times out
    // naming no expectation; after a drain, an unentered operation is one the lane holds back.
    await drain();
    expect(owner.order).toEqual(['a/write:enter', 'b/write:enter', 'b/expose:enter']);

    other.release();
    port.release();
    await Promise.all([other.done, port.done]);

    held.release();
    await held.done;
    expect(owner.order).toEqual([
      'a/write:enter', 'b/write:enter', 'b/expose:enter',
      'b/write:exit', 'b/expose:exit', 'a/write:exit',
    ]);
  });

  test('a directory claim orders the creates inside it and nothing outside', async () => {
    const owner = sharedOwner();
    const listing = owner.a.op('list', [...pathScopes({ path: '/workspace/src' })]);
    await listing.entered;

    const inside = owner.b.op('create', [...pathScopes({ path: '/workspace/src/a.ts', membership: true })]);
    const outside = owner.b.op('elsewhere', [...pathScopes({ path: '/workspace/lib/b.ts', membership: true })]);
    await outside.entered;
    outside.release();
    await outside.done;

    await drain();
    expect(owner.order).not.toContain('b/create:enter');
    listing.release();
    await listing.done;
    await inside.entered;
    inside.release();
    await inside.done;
  });

  test('a move claims both ends as ONE step, so it can never hold one and wait for the other', async () => {
    const owner = sharedOwner();

    const moved = [
      ...pathScopes({ path: '/workspace/from.txt', membership: true, recursive: true }),
      ...pathScopes({ path: '/workspace/to.txt', membership: true, recursive: true }),
    ];

    // Both ends are already claimed, by DIFFERENT callers, in the order that
    // would deadlock an implementation acquiring one key at a time.
    const from = owner.a.op('holds-from', [...pathScopes({ path: '/workspace/from.txt' })]);
    const to = owner.b.op('holds-to', [...pathScopes({ path: '/workspace/to.txt' })]);
    await Promise.all([from.entered, to.entered]);

    const move = owner.a.op('move', moved);
    await drain();
    expect(owner.order).not.toContain('a/move:enter');

    from.release();
    to.release();
    await Promise.all([from.done, to.done]);
    await move.entered;
    move.release();
    await move.done;
  });

  test('a failure releases its resource', async () => {
    const owner = sharedOwner();
    const scopes = [...pathScopes({ path: '/workspace/a.txt' })];
    await expect(owner.lane.run(scopes, () => Promise.reject(new Error('container refused'))))
      .rejects.toThrow('container refused');

    const next = owner.b.op('write', scopes);
    await next.entered;
    next.release();
    await next.done;
  });

  test('a second owner is a second container: no lane is global', async () => {
    const first = sharedOwner();
    const second = sharedOwner();
    const scopes = [...pathScopes({ path: '/workspace/a.txt' })];

    const held = first.a.op('write', scopes);
    await held.entered;

    // The claim is per container: a lane shared across instances would serialize every
    // workspace in the deployment against every other.
    const elsewhere = second.a.op('write', scopes);
    await drain();

    // Asserts `second.order` instead of awaiting entry, so a module-level lane fails here
    // rather than hanging on an entry that never comes.
    expect(second.order).toEqual(['a/write:enter']);
    // The first claim is still held, so the second entry is a real overlap and
    // not a release that had already run.
    expect(first.order).toEqual(['a/write:enter']);

    elsewhere.release();
    await elsewhere.done;

    held.release();
    await held.done;
  });
});

describe('a claim that outlives its call', () => {
  function source(chunks: readonly string[]): ReadableStream<string> {
    return new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  test('a streamed read holds its file until the bytes are done', async () => {
    const owner = sharedOwner();
    const scopes = [...pathScopes({ path: '/workspace/big.bin' })];
    const release = await owner.lane.hold(scopes);
    const stream = heldUntilDrained(source(['one', 'two']), release);

    const write = owner.b.op('write', scopes);
    await drain();
    expect(owner.order).not.toContain('b/write:enter');

    const reader = stream.getReader();
    expect((await reader.read()).value).toBe('one');
    await drain();
    expect(owner.order).not.toContain('b/write:enter');

    expect((await reader.read()).value).toBe('two');
    await reader.read();

    await write.entered;
    write.release();
    await write.done;
  });

  test('a cancelled stream clears the lane busy state', async () => {
    const owner = sharedOwner();
    const scopes = [...pathScopes({ path: '/workspace/big.bin' })];
    const release = await owner.lane.hold(scopes);
    const stream = heldUntilDrained(source(['one', 'two']), release);

    expect(owner.lane.busy()).toBe(true);
    const reader = stream.getReader();
    await reader.cancel('the consumer went away');
    expect(owner.lane.busy()).toBe(false);
  });
});
