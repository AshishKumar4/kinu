/** Resource scopes and operation ownership, shared by the box and its gateway. */
import { DEVBOX_WORKDIR, type CheckpointKind, type CheckpointOutcome } from './storage';
import { describeThrown } from './lifecycle';

/** Namespaces distinguish files, ports and processes; a subtree claims every descendant. */
export interface ResourceScope {
  readonly path: string;
  readonly subtree: boolean;
}

function atOrUnder(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** A `subtree` scope conflicts with every path at or beneath it, whichever side holds it:
 *  a recursive delete of `/a` and a write to `/a/b/c` are the same resource. */
function scopesTouch(left: ResourceScope, right: ResourceScope): boolean {
  if (left.subtree) return atOrUnder(left.path, right.path);

  if (right.subtree) return atOrUnder(right.path, left.path);

  return left.path === right.path;
}

export function scopesOverlap(
  left: readonly ResourceScope[],
  right: readonly ResourceScope[],
): boolean {
  return left.some(a => right.some(b => scopesTouch(a, b)));
}

interface ResourceLane {
  /** A streamed read keeps the lane busy until its body drains or is cancelled. */
  busy(): boolean;
  drain(): Promise<void>;
  /** Strict FIFO per resource, no shared reads; the whole scope set is claimed in one step,
   *  so a multi-resource operation cannot hold one resource while waiting for another. */
  run<T>(scopes: readonly ResourceScope[], op: () => Promise<T>): Promise<T>;
  /** Claim `scopes`, then hand back the release. The caller MUST call it on
   *  every path out, including cancellation. */
  hold(scopes: readonly ResourceScope[]): Promise<() => void>;
}

/** Lives in the container's owner object: facets are separate isolates, so a per-client queue
 *  orders only that client's calls. In-flight only, so nothing persists across eviction. */
export function createResourceLane(): ResourceLane {
  const inFlight = new Set<{ scopes: readonly ResourceScope[]; settled: Promise<void> }>();

  const hold = async (scopes: readonly ResourceScope[]): Promise<() => void> => {
    // Loop, not one pass: while waiting, a third operation can claim an overlapping resource,
    // and admitting this one anyway is the interleaving the lane exists to stop.
    for (;;) {
      const blocking = [...inFlight].filter(entry => scopesOverlap(entry.scopes, scopes));

      if (blocking.length === 0) break;
      await Promise.all(blocking.map(entry => entry.settled));
    }

    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const entry = { scopes, settled };
    inFlight.add(entry);

    return () => {
      inFlight.delete(entry);
      resolve();
    };
  };

  return {
    busy: () => inFlight.size !== 0,
    async drain() { while (inFlight.size !== 0) await Promise.all([...inFlight].map(entry => entry.settled)); },
    hold,
    async run(scopes, op) {
      const release = await hold(scopes);

      try {
        return await op();
      } finally {
        release();
      }
    },
  };
}

/** Ports have no subtree: `port:3000` and `port:30001` share no segment boundary, so never overlap. */
export function portScope(port: number): readonly ResourceScope[] {
  return [{ path: `port:${port}`, subtree: false }];
}

export function processScope(processId: string): readonly ResourceScope[] {
  return [{ path: `proc:${processId}`, subtree: false }];
}

/** A returned `ReadableStream` is unconsumed, so releasing on return lets a sibling write race
 *  the reader; release once on last chunk, error, or cancel so a half-read body frees it. */
export function heldUntilDrained<Chunk>(
  stream: ReadableStream<Chunk>,
  release: () => void,
): ReadableStream<Chunk> {
  let released = false;

  const done = (): void => {
    if (released) return;
    released = true;
    release();
  };

  return stream.pipeThrough(new TransformStream<Chunk, Chunk>({
    flush: done,
    cancel: done,
  }));
}

/** A membership-changing operation also claims its directory, so same-directory creates order;
 *  an overwrite claims it too, since it cannot be told from a create without the container. */
export function pathScopes(input: {
  readonly path: string;
  readonly membership?: boolean;
  readonly ancestors?: boolean;
  readonly recursive?: boolean;
}): readonly ResourceScope[] {
  const path = canonicalPath(input.path);
  const scopes: ResourceScope[] = [{ path: `file:${path}`, subtree: input.recursive === true }];
  const above = ancestors(path);
  // Claim only the immediate parent unless the operation creates the whole chain: every
  // ancestor would be a global lock, since unrelated creates all name `/workspace`.
  const claimed = input.ancestors === true ? above : above.slice(0, 1);

  if (input.membership === true || input.ancestors === true) {
    for (const directory of claimed) scopes.push({ path: `file:${directory}`, subtree: false });
  }

  return scopes;
}

/** Every directory above `path`, NEAREST FIRST — the order the caller slices,
 *  so taking one takes the immediate parent. */
function ancestors(path: string): readonly string[] {
  const out: string[] = [];

  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    out.push(path.slice(0, cut));
  }

  return out;
}

/** One spelling per file, so two names for one path are one resource. A spelling, not an inode:
 *  a symlink or bind mount can still name one file under two paths. */
export function canonicalPath(path: string): string {
  const absolute = path.startsWith('/') ? path : `${DEVBOX_WORKDIR}/${path}`;
  const out: string[] = [];

  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment === '..') {
      out.pop();
      continue;
    }

    out.push(segment);
  }

  return `/${out.join('/')}`;
}

interface CheckpointLane {
  busy(): boolean;
  drain(): Promise<void>;
  /** Same kind in flight joins it; a different kind queues, so a quiesce never inherits a tick's
   *  `skipped` and stops over just-landed work. */
  run(kind: CheckpointKind, op: () => Promise<CheckpointOutcome>): Promise<CheckpointOutcome>;
}

export function createCheckpointLane(): CheckpointLane {
  const inFlight: Partial<Record<CheckpointKind, Promise<CheckpointOutcome>>> = {};
  let tail: Promise<unknown> = Promise.resolve();

  return {
    busy: () => Object.values(inFlight).some(run => run !== undefined),
    drain: async () => { await tail; },
    run(kind, op) {
      const pending = inFlight[kind];

      if (pending !== undefined) return pending;
      const run = tail.then(() => op());
      inFlight[kind] = run;

      const cleaned = Promise.allSettled([run]).then(([outcome]) => {
        if (outcome?.status === 'rejected') console.error(`[devbox] ${kind} checkpoint rejected: ${describeThrown({ cause: outcome.reason })}`);

        if (inFlight[kind] === run) inFlight[kind] = undefined;
      });

      // The next lane entry observes cleanup too; no detached promise remains.
      tail = cleaned;

      return run;
    },
  };
}
