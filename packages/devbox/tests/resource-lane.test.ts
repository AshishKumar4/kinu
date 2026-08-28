// KINU-034. Every agent in a workspace shares ONE container and each is a
// separate Durable Object, so a queue built beside a client orders only that
// client's calls. Two facets writing one path interleaved, an exposure raced its
// own un-exposure, and a port token was minted beside the removal of the row it
// belonged to. The claim therefore lives in the object all of them reach.
//
// These tests drive the OWNER'S lane from independent callers — the shape two
// facets have — and they pin the two things a lane like this gets wrong: what
// counts as the same resource (topology, not just an equal path string), and
// when a claim is released (for a stream, not until the bytes are done).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalPath,
  createResourceLane,
  heldUntilDrained,
  pathScopes,
  portScope,
  processScope,
  scopesOverlap,
} from '../src/lifecycle';

/** Drain the microtask queue, with no clock involved: an operation that has not
 *  entered after this is one the lane is holding back, not one that was merely
 *  not scheduled yet. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

/**
 * Two independent callers of one container, which is what two facets are.
 *
 * Each `client` is its own closure with its own operations and no knowledge of
 * the other; both hold the SAME lane, because the lane belongs to the object
 * they both address. A per-client lane would let every assertion below pass
 * while the bug survived, so the lane is constructed once here on purpose.
 */
function sharedOwner() {
  const lane = createResourceLane();
  const order: string[] = [];
  const client = (name: string) => ({
    /** Run a named operation over `scopes`, recording entry and exit. */
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
    // The pair exact-path keys miss entirely: `listFiles('/workspace/src')` and
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

    // A different directory and a different port, both while the first is held.
    const other = owner.b.op('write', [...pathScopes({ path: '/workspace/two/b.txt', membership: true })]);
    const port = owner.b.op('expose', [...portScope(3000)]);
    await Promise.all([other.entered, port.entered]);
    other.release();
    port.release();
    await Promise.all([other.done, port.done]);

    held.release();
    await held.done;
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

    // The next caller of the same resource runs, and runs promptly.
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

    // The same path on a DIFFERENT box must not wait: the claim is per
    // container, and a lane that were shared across instances would serialize
    // every workspace in the deployment against every other.
    const elsewhere = second.a.op('write', scopes);
    await elsewhere.entered;
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

    // A sibling write must wait while the reader is still pulling.
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

// The read overrides are the one place the owner has to speak the SDK's own
// result types, and the SDK exports none of them. Deriving them structurally from
// the pinned declaration keeps ONE authority; copying their bodies would put a
// silently drifting second copy in this tree. `tsc` proves the derivation
// resolves — the override would not compile otherwise — and these two pin the
// decision so nobody "simplifies" it back into a restatement.
describe('the read overrides derive their types instead of restating them', () => {
  const module = readFileSync(join(import.meta.dir, '../src/devbox.ts'), 'utf8');

  test('the base declaration is the source of both arms', () => {
    expect(module).toContain("ReadFileArms<Sandbox<unknown>['readFile']>");
    expect(module).toContain("override readFile(...args: ReadArms['stream']['args'])");
    expect(module).toContain("override readFile(...args: ReadArms['value']['args'])");
  });

  test('no SDK result interface is copied into this package', () => {
    // The fields those unexported interfaces carry. Any of them appearing as a
    // declaration here means someone restated a third-party contract.
    for (const copied of ['bytesWritten', 'interface ReadFileResult', 'interface ReadFileStreamResult']) {
      expect(module).not.toContain(copied);
    }
  });

  test('the SDK still declares the two arms the match depends on', () => {
    // `tsc` is the real proof that the derivation resolves: the override could
    // not compile if either arm inferred `never`. This pins WHY it resolves, so a
    // release that collapses the two overloads into one is read here rather than
    // discovered by a stream that silently stopped being held.
    const declaration = readFileSync(
      join(import.meta.dir, '../../../node_modules/@cloudflare/sandbox/dist/sandbox-BtaWcmmG.d.ts'),
      'utf8',
    );
    expect(declaration).toContain("encoding: 'none';");
    expect(declaration).toContain("encoding?: Exclude<FileEncoding, 'none'>;");
  });
});
