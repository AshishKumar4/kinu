// The sole substitution of `@cloudflare/sandbox`: a faithful container stand-in for Devbox tests.
// Shared because `mock.module` is process-wide; a second registration would replace this one.
import { mock } from 'bun:test';

import { createHash } from 'node:crypto';
import * as v from 'valibot';

import { describeThrown, type StartClock } from '../../src/lifecycle';
import type { StoredValue } from '../../src/storage';
import { sessionShellRefusal } from './session-shell';

/** Models `@cloudflare/sandbox` errors: `code` is a getter on an unexported `SandboxError` class,
 *  not an own property; a plain-field stand-in would pass checks the shipped SDK fails. */
export class SandboxFailure extends Error {
  constructor(readonly errorResponse: { readonly code: string; readonly message: string }) {
    super(errorResponse.message);
    this.name = 'SandboxError';
  }

  get code(): string {
    return this.errorResponse.code;
  }
}

/** `reached` resolves on entry, before waiting on `promise`, so a test acts while the call is
 *  inside the await instead of counting microtasks, which would race. */
export interface Gate {
  readonly reached: Promise<void>;
  readonly promise: Promise<void>;
  enter(): void;
  release(): void;
}

/** Timers fire in due order, each at its own due time, only when the test moves the clock,
 *  so a budget is proven by its arithmetic, not by how fast the machine reached the step. */
export interface ManualStartClock extends StartClock {
  /** Move the clock forward, firing every timer that comes due on the way. */
  advance(ms: number): void;
  /** Move the clock to the earliest armed timer and fire it alone. */
  tick(): void;
  armed(): number;
}

export function manualStartClock(startAt = 1_000_000): ManualStartClock {
  let now = startAt;
  let sequence = 0;
  const timers = new Map<number, { readonly due: number; readonly fire: () => void }>();

  const earliest = (): [number, { readonly due: number; readonly fire: () => void }] | undefined => {
    let found: [number, { readonly due: number; readonly fire: () => void }] | undefined;

    for (const entry of timers) {
      if (found === undefined || entry[1].due < found[1].due) found = entry;
    }

    return found;
  };

  const fire = (entry: [number, { readonly due: number; readonly fire: () => void }]): void => {
    timers.delete(entry[0]);
    now = Math.max(now, entry[1].due);
    entry[1].fire();
  };

  return {
    now: () => now,
    after: (ms, callback) => {
      const id = sequence += 1;
      timers.set(id, { due: now + Math.max(0, ms), fire: callback });

      return () => { timers.delete(id); };
    },
    advance: (ms) => {
      const target = now + ms;

      for (let next = earliest(); next !== undefined && next[1].due <= target; next = earliest()) fire(next);
      now = target;
    },
    tick: () => {
      const next = earliest();

      if (next !== undefined) fire(next);
    },
    armed: () => timers.size,
  };
}

export function gate(): Gate {
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();

  return {
    reached: entered.promise,
    promise: held.promise,
    enter: () => { entered.resolve(); },
    release: () => { held.resolve(); },
  };
}

/** Uses the SDK's own status vocabulary: `isProcessLive` reads `status`, and
 *  `waitForRunnerExit` reads the exit code a settled row carries. */
export interface FakeProcessRow {
  readonly id: string;
  readonly pid: number;
  readonly status: string;
  readonly command: string;
  readonly exitCode?: number;
}

export type LiveProcess = FakeProcessRow & {
  getLogs(): Promise<{ stdout: string; stderr: string }>;
};

/** The box's argv split back into words, plus the control snapshot written to `--control`.
 *  Only `action` and `resultPath` are read by the fake; runners read the rest via `runnerOption`. */
export interface RunnerInvocation {
  readonly action: string;
  readonly resultPath: string | undefined;
  readonly control: string | undefined;
  readonly argv: readonly string[];
}

export function runnerOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);

  return index === -1 ? undefined : argv[index + 1];
}

/** Parses only `'word'` with `'\''` for a literal quote: the sole quoting `runnerCommand`
 *  and the journal daemon's argv produce. */
function quotedWords(command: string): string[] {
  const words: string[] = [];

  for (const match of command.matchAll(/'((?:[^']|'\\'')*)'/g)) {
    words.push((match[1] ?? '').replaceAll("'\\''", "'"));
  }

  return words;
}

/** The chain's builders quote every path with `shellPath`, so single-quoted segments name
 *  the mount points, sources and targets without re-parsing shell syntax. */
function quotedSegments(command: string): string[] {
  return [...command.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

export interface StartRecord {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly processId: string | undefined;
}

/** A throwing `startProcess`: a refused start creates nothing; a disconnect after the fork
 *  creates the process and returns nothing, the window the durable reservation exists for. */
export interface StartFault {
  readonly error: Error;
  readonly created: boolean;
}

export interface FileOperation {
  readonly operation: 'rename' | 'move';
  readonly from: string;
  readonly to: string;
  readonly sessionId: string | undefined;
}


/** The SDK's schedule table, shared by SDK `schedule()`/`listSchedules()` and the sweep via
 *  `ctx.storage.sql`; one copy keyed by storage so no two fakes can disagree about a row. */
const scheduleTables = new WeakMap<DurableObjectStorage, { callback: string; time: number }[]>();

export function scheduleTableOf(
  storage: DurableObjectStorage,
): { callback: string; time: number }[] {
  const held = scheduleTables.get(storage);

  if (held !== undefined) return held;
  // The fake registers its table when it builds the handle, so an absent table is fresh, not
  // missing: a box on storage this module did not make holds no rows.
  const fresh: { callback: string; time: number }[] = [];
  scheduleTables.set(storage, fresh);

  return fresh;
}

/** Unmodelled platform members throw by name: a stand-in that answered would answer wrongly,
 *  and an absent one would surface elsewhere as a missing property. */
function unreached(member: string): never {
  throw new Error(`the devbox platform stand-in does not implement ${member}`);
}

export interface FakeStorage {
  readonly rows: Map<string, StoredValue>;
  readonly handle: DurableObjectStorage;
  /** Park the NEXT read of one key: the ladder row's read before a decision, or its read
   *  inside the conditional write, to pin an interleaving the container calls cannot reach. */
  gateOn(key: string, held: Gate): void;
  /** Stands in for an attach failure: an ephemeral box's `attach()` cannot fail, and every later
   *  step reports instead of throwing, so a container fault cannot propagate past the ladder. */
  faultOn(key: string, error: Error): void;
}

/** Durable Object storage double: a Map honouring the runtime contract for the four ops used.
 *  `get` resolves undefined when absent, `delete` reports whether a row existed, `list` by prefix. */
export function fakeStorage(): FakeStorage {
  const rows = new Map<string, StoredValue>();
  const schedules: { callback: string; time: number }[] = [];
  const gates: Record<string, Gate | undefined> = {};
  const faults: Record<string, Error | undefined> = {};
  /** A transaction refuses to commit a key another writer moved meanwhile: the runtime
   *  isolates concurrent transactions, so the second committer fails instead of overwriting. */
  const keyVersions = new Map<string, number>();

  const takeWriteFault = (key: string): Error | undefined => {
    const fault = faults[key];
    faults[key] = undefined;

    return fault;
  };

  // SAFETY: `DurableObjectStorage` declares the platform's whole storage API,
  // of which the methods under test reach exactly these five; the rest is
  // alarms and SQL beyond the one statement modelled below, which no line of
  // the class can call. Each operation here returns what the runtime contract
  // says it returns.
  const handle = {
    get: async (key: string): Promise<StoredValue> => {
      const held = gates[key];

      if (held !== undefined) {
        gates[key] = undefined;
        held.enter();
        await held.promise;
      }

      return rows.get(key);
    },
    put: (key: string, value: StoredValue): Promise<void> => {
      const fault = takeWriteFault(key);

      if (fault !== undefined) {
        return Promise.reject(fault);
      }

      rows.set(key, value);
      keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1);

      return Promise.resolve();
    },
    delete: (key: string): Promise<boolean> => {
      const existed = rows.delete(key);

      if (existed) keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1);

      return Promise.resolve(existed);
    },
    // Writes are buffered and land only when the closure settles, none if it throws: a
    // write-through fake could not hold the atomicity the head CAS rests on.
    transaction: async <T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> => {
      const staged = new Map<string, StoredValue>();
      const removed = new Set<string>();
      const seen = new Map<string, number>();

      const observe = (key: string): void => {
        if (!seen.has(key)) seen.set(key, keyVersions.get(key) ?? -1);
      };

      const transaction: DurableObjectTransaction = Object.create({
        get: async (key: string): Promise<StoredValue> => {
          observe(key);

          return removed.has(key) ? undefined : staged.get(key) ?? rows.get(key);
        },
        put: async (key: string, value: StoredValue): Promise<void> => {
          const fault = takeWriteFault(key);

          if (fault !== undefined) throw fault;
          observe(key);
          removed.delete(key);
          staged.set(key, value);
        },
        delete: async (key: string): Promise<boolean> => {
          observe(key);
          staged.delete(key);
          removed.add(key);

          return rows.has(key);
        },
      });

      const result = await closure(transaction);

      for (const key of staged.keys()) {
        if ((keyVersions.get(key) ?? -1) !== (seen.get(key) ?? -1)) {
          throw new Error(`transaction conflict: ${key} changed during the transaction`);
        }
      }

      for (const key of removed) {
        if ((keyVersions.get(key) ?? -1) !== (seen.get(key) ?? -1)) {
          throw new Error(`transaction conflict: ${key} changed during the transaction`);
        }
      }

      for (const key of removed) {
        rows.delete(key);
        keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1);
      }

      for (const [key, value] of staged) {
        rows.set(key, value);
        keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1);
      }

      return result;
    },
    // Models only the one SQLite statement the class issues; anything else refuses by name,
    // since a fake answering an unmodelled statement would answer it wrongly (`session-shell.ts`).
    sql: {
      exec: (query: string) => {
        if (!query.includes('FROM container_schedules')) {
          throw new Error(`the fake Durable Object SQLite was asked an unmodelled statement: ${query}`);
        }

        const distinct = [...new Set(schedules.map((row) => row.callback))];

        return { toArray: () => distinct.map((callback) => ({ callback })) };
      },
    },
    list: (options: { prefix: string }): Promise<Map<string, StoredValue>> => Promise.resolve(
      new Map([...rows].filter(([key]) => key.startsWith(options.prefix))),
    ),
  } as DurableObjectStorage;

  scheduleTables.set(handle, schedules);

  return {
    rows,
    handle,
    gateOn: (key, held) => { gates[key] = held; },
    faultOn: (key, error) => { faults[key] = error; },
  };
}

/** The boot-id stamp's command, a restoration's last write; matched by path, not verb, since
 *  the listener proof also writes with `printf %s` and must not hit the stamp gate or fault. */
export const STAMP_COMMAND = '> /tmp/devbox-boot-id';

const IMAGE_DIRECTORIES = ['/', '/workspace', '/tmp', '/var/tmp'] as const;

/** Faults are queues and gates are one-shot: the modelled defects exist only across two calls,
 *  so the fake must let one attempt differ from the next. */
export class FakeSandbox {
  /** The instance the last `new Devbox(…)` built; `Devbox` extends this class, so the box IS
   *  its container and a test reaches the container through it. */
  static last: FakeSandbox | undefined;

  /** Same object the Durable Object state hands the class as `ctx.container`, so a test that
   *  stops the container and the class reading `running` cannot disagree. */
  readonly running = { running: true };
  defaultPort = 3000;
  readonly processes = new Map<string, FakeProcessRow>();
  readonly starts: StartRecord[] = [];
  readonly kills: string[] = [];
  readonly execs: string[] = [];
  readonly exposures: { port: number; token: string | undefined; name: string | undefined }[] = [];
  readonly schedules: string[] = [];
  /** The SDK's schedule table, shared with the Durable Object's SQLite: see {@link scheduleTableOf}. */
  readonly scheduleRows: { callback: string; time: number }[];
  /** Configured probe answers for services on a started container, retained
   *  with the other fault controls; this is not a live process registry. */
  readonly listening = new Set<number>();
  readonly fileOperations: FileOperation[] = [];
  readonly mountCalls: string[] = [];
  /** Mounts and execs share one chronological list: stop order is a property of the order
   *  across both channels and cannot be reconstructed from two separate lists. */
  readonly sequence: string[] = [];
  /** Stands in for what `/proc/mounts` reports for paths the box's `mountBucket` holds mounted. */
  readonly s3fsMounts = new Set<string>();
  /** s3fs runs under exactly these options; an option absent here is s3fs's own default. */
  readonly s3fsOptionsByMount = new Map<string, readonly string[]>();
  /** While a holder is present, unmount answers EBUSY as real fusermount does for open files;
   *  the stop's holder-kill clears it unless `survives`, `session` (never signalled) or `cwdOnly`. */
  workdirHolder: {
    readonly pid: number;
    readonly comm: string;
    readonly survives?: boolean;
    readonly session?: boolean;
    /** Holds the mount by cwd, invisible to an fd-only scan. Named, never signalled (container
     *  server's own children): ordinary unmount stays refused; only a lazy detach releases it. */
    readonly cwdOnly?: boolean;
  } | undefined;
  /** The SDK default session starts with `cwd: "/workspace"` (the mount point) and `unmountBucket`
   *  runs in it without its own cwd; a shell standing on the mount holds it, so unmount can EBUSY. */
  sessionCwd = '/workspace';
  /** A fresh container holds only the image's dirs; `/var/tmp/devbox` is made by whatever runs
   *  first. Commands earn dirs by `mkdir -p`; a cwd absent here refuses chdir, as the container does. */
  readonly directories = new Set<string>(IMAGE_DIRECTORIES);
  readonly fileOperationFailures = {
    rename: Array<Error>(),
    move: Array<Error>(),
  } satisfies Record<FileOperation['operation'], Error[]>;
  readonly startFaults: StartFault[] = [];
  startFaultBeforeRunning: Error | undefined;
  startFaultAfterRunning: Error | undefined;
  /** A standing platform refusal: every `start` is refused while set; never consumed.
   *  Models capacity exhaustion, which persists across retries, unlike the one-shot faults. */
  containerUnavailable: Error | undefined;
  providerStatus: 'running' | 'healthy' | 'stopped' | 'stopping' = 'healthy';
  readonly getFaults: Error[] = [];
  readonly killFaults: Error[] = [];
  /** A kill failure for one id, consulted before the order-based queue: a stop kills several,
   *  so a queued fault lands on whichever kill runs first. */
  readonly killFaultsById = new Map<string, Error>();
  readonly stampFaults: (Error | undefined)[] = [];
  startGate: Gate | undefined;
  /** Parks the container's own admission probe, `start()`, awaited before a generation is captured.
   *  Distinct from `startGate` (the process start): two different calls and windows. */
  containerStartGate: Gate | undefined;
  /** Container is running, but the SDK has not invoked the port-proven hook. */
  containerHookGate: Gate | undefined;
  execGate: Gate | undefined;
  /** Delay inside the container per command, modelling a counted loop (`awaitLayer`, `awaitListenerCommand`).
   *  A real wait: the test checks whether one command's duration can extend a caller's window. */
  execDelayMs = 0;
  stampGate: Gate | undefined;
  exposeGate: Gate | undefined;
  destroyFault: Error | undefined;
  stopFault: Error | undefined;
  destroys = 0;
  bootId: string | undefined;
  containerStarts = 0;
  readonly startWaitOptions: unknown[] = [];
  /** False models a journal daemon that starts but whose mount never lands,
   *  the case the readiness probe exists to catch. */
  journalMounts = true;
  /** False: socket lost while daemon and mount stand; process table and `/proc/mounts` read
   *  healthy, only the socket probe sees it. A daemon start resets this (fresh socket). */
  journalSocketUp = true;
  /** Answers `startProcess` for `--action` commands: reply goes to {@link files}, a throw fails
   *  the row with exit 1 and stderr. Unset, the runner stays `running` like an unanswered one. */
  runner: ((invocation: RunnerInvocation) => Promise<string> | string) | undefined;
  readonly files = new Map<string, string>();
  /** Lets a fixture hand accepted workload bytes to the runner's journal model;
   *  unset, the write is still kept in {@link files}. */
  fileWritten: ((path: string, content: string) => Promise<void> | void) | undefined;
  /** Recorded by the box's own `fuse-overlayfs` command and reported via `cat /proc/mounts`,
   *  which `isOverlayMounted` reads; termination clears them with the local filesystem (P1). */
  readonly overlayMounts = new Set<string>();
  /** Recorded when the box's own `squashfuse` command runs and read back via `/proc/mounts`;
   *  a stop clears them with the local filesystem, like `overlayMounts`. */
  readonly layerMounts = new Set<string>();
  /** Must be the bucket `objectFacts` reads and `chainStoreRoot` derives, so a `dd` through the
   *  store mount lands where the next attach looks. Unset, no chain command reaches the store. */
  chainStore: { readonly objects: Map<string, Uint8Array>; readonly root: string;
    /** Every object-store write attempt a publication makes, in order. s3fs `dd` costs three
     *  (marker, empty placeholder, payload); the egress PUT costs one. */
    attempts?: { operation: 'put' | 'uploadPart' | 'complete'; key: string; bytes: number }[] } | undefined;
  /** Local files keyed by container path: what the box's `mksquashfs` produced, which a later
   *  `dd` of that path publishes. Not the remote objects in chainStore. */
  readonly stagedArchives = new Map<string, Uint8Array>();
  /** Bumped by every SDK file write, which is what the real watcher observes; a version a
   *  caller holds still matches `checkChanges` until such a write. */
  changeVersion = 0;

  /** The fake's process table is the container's, so this reads the same fact the daemon's
   *  supervisor reads, not a flag a test sets beside it. */
  journalRunning(): boolean {
    return [...this.processes.values()].some(
      (row) => row.command.includes('kinu-journal-daemon') && row.status === 'running',
    );
  }
  /** An explicit platform input block. The patched SDK's container hook does
   *  not hold one; delivered operations join Devbox readiness themselves. */
  initGate: Promise<void> | undefined;

  constructor(readonly ctx: DurableObjectState) {
    FakeSandbox.last = this;
    this.scheduleRows = scheduleTableOf(ctx.storage);
  }

  /** Mirrors the SDK's delete-by-callback (`container.js:1492-1494`); the class's sweep
   *  of unreachable rows goes through it. */
  deleteSchedules(callback: string): void {
    for (let index = this.scheduleRows.length - 1; index >= 0; index -= 1) {
      if (this.scheduleRows[index]?.callback === callback) this.scheduleRows.splice(index, 1);
    }
  }

  onStart(): Promise<void> {
    return Promise.resolve();
  }
  /** A missing `cwd` is refused: the session shell chdirs first, so the command never runs.
   *  An accepted `cwd` stays: one persistent session shell serves every command. */
  #chdir(cwd: string | undefined): { stdout: string; stderr: string; exitCode: number } | null {
    if (cwd === undefined) return null;

    if (!this.directories.has(cwd)) {
      this.sequence.push(`chdirRefused:${cwd}`);

      return { stdout: '', stderr: `Failed to change directory to '${cwd}'`, exitCode: 1 };
    }

    this.sessionCwd = cwd;

    return null;
  }

  /** `mkdir -p` creates what it names: how a container earns the directories
   *  later commands are allowed to stand in. */
  #recordDirectories(command: string): void {
    for (const made of command.matchAll(/mkdir -p ((?:'[^']+'\s*)+)/g)) {
      for (const quoted of made[1].matchAll(/'([^']+)'/g)) this.directories.add(quoted[1]);
    }
  }

  /** Removes each quoted path's subtree so a retired reply cannot be read by the next attempt
   *  on the same fixed result path; `rm -rf` of an absent path still succeeds. */
  #execRemoval(command: string): { stdout: string; stderr: string; exitCode: number } | null {
    const removed = /^rm -r?f '([^']+)'$/.exec(command);

    if (removed === null && !command.startsWith('rm -rf ')) return null;

    const targets = removed === null ? quotedSegments(command) : [removed[1] ?? ''];

    for (const target of targets) {
      for (const path of this.files.keys()) {
        if (path === target || path.startsWith(`${target}/`)) this.files.delete(path);
      }
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  /** Models the real holder release: stdout names who still holds after signalling, not before.
   *  Matched on the `/proc/$pid/fd` scan, not the command prefix, which an ancestor walk changes. */
  #execHolderRelease(command: string): { stdout: string; stderr: string; exitCode: number } | null {
    if (!command.includes('/proc/$pid/fd')) return null;
    const holder = this.workdirHolder;

    if (holder === undefined) return { stdout: 'none', stderr: '', exitCode: 0 };
    const named = `${String(holder.pid)}:${holder.comm}`;

    if (holder.session === true) {
      return { stdout: named, stderr: `not signalled, this session's own: ${named}`, exitCode: 0 };
    }

    if (holder.cwdOnly === true) {
      return { stdout: named, stderr: `not signalled, cwd-only holders: ${named}`, exitCode: 0 };
    }

    if (holder.survives) return { stdout: named, stderr: `signalling: ${named}`, exitCode: 0 };
    // Signalled, and it died: the re-scan at the end of the real command finds
    // nothing, so this answers `none` rather than the name it started with.
    this.workdirHolder = undefined;

    return { stdout: 'none', stderr: `signalling: ${named}`, exitCode: 0 };
  }

  /** Answers snapshot-chain commands as the container does; matched on the binary each runs,
   *  the one part of the template the strategy's builders own. Null for any other command. */
  #execChainCommand(command: string): { stdout: string; stderr: string; exitCode: number } | null {
    const unmount = /\/usr\/bin\/fusermount3 -u '([^']+)'/.exec(command)?.[1];

    if (unmount !== undefined) {
      const mounted = this.overlayMounts.has(unmount) || this.layerMounts.has(unmount) || this.s3fsMounts.has(unmount);

      if (mounted && this.#mountIsBusy(unmount)) return { stdout: '', stderr: `fusermount3: failed to unmount ${unmount}: Device or resource busy`, exitCode: 1 };
      this.overlayMounts.delete(unmount);
      this.layerMounts.delete(unmount);
      this.s3fsMounts.delete(unmount);

      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command.includes('/usr/bin/fuse-overlayfs')) {
      const quoted = quotedSegments(command);
      const target = quoted.at(-1);

      if (target !== undefined) this.overlayMounts.add(target);

      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command.includes('/usr/local/bin/devbox-squashfuse')) {
      const quoted = quotedSegments(command.slice(command.indexOf('/usr/local/bin/devbox-squashfuse')));
      const mountPoint = quoted[1];

      if (mountPoint !== undefined) this.layerMounts.add(mountPoint);

      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command.includes('/usr/bin/mksquashfs')) {
      const tail = command.slice(command.indexOf('/usr/bin/mksquashfs'));
      const quoted = quotedSegments(tail);
      const sourceDir = quoted[0];
      const archivePath = quoted[1];

      if (sourceDir === undefined || archivePath === undefined) {
        throw new Error(`the archiver command names no source and target: ${command}`);
      }

      const bytes = this.synthesizeArchive(sourceDir);
      this.stagedArchives.set(archivePath, bytes);

      return { stdout: `0 ${String(bytes.byteLength)}`, stderr: '', exitCode: 0 };
    }

    if (command.includes('devbox-publish.mjs')) return this.#execPublishEgress(command);

    if (command.includes('conv=fsync')) return this.#execPublish(command);

    // Content-hashed, not metadata-hashed: this stand-in keeps no inodes or times, and a
    // fingerprint moving without a byte change would commit where the box skips.
    if (command.startsWith('bash -o pipefail -c ') && command.includes('/var/tmp/devbox/upper')) {
      // The shipped caller fingerprints only the overlay upper, inside nested quoting,
      // so the path is matched rather than parsed out of the quoting.
      return {
        stdout: createHash('sha256').update(this.synthesizeArchive('/var/tmp/devbox/upper')).digest('hex'),
        stderr: '',
        exitCode: 0,
      };
    }

    if (command.includes('then seen=1; break; fi')) {
      // The layer-visibility probe: `ready` exactly when the store holds the
      // object, which is what a re-list through the mount would find.
      const seen = /test -e '([^']+)'/.exec(command)?.[1];
      const store = this.chainStore;
      const relative = seen?.startsWith('/backups/') === true ? seen.slice('/backups/'.length) : undefined;
      const held = relative !== undefined && store?.objects.has(`${store.root}/${relative}`) === true;

      if (held) return { stdout: 'ready', stderr: '', exitCode: 0 };

      const holds = store === undefined
        ? ''
        : [...store.objects.keys()].filter((key) => key.startsWith(`${store.root}/`)).join(' ');

      return { stdout: `missing ${holds}`.trimEnd(), stderr: '', exitCode: 0 };
    }

    return null;
  }

  /** Models an s3fs publish as three object attempts: `mkdir -p` PUTs the marker, `create` PUTs
   *  an empty object, then the flush PUTs the payload (measured shape of `b20260914045438`). */
  #execPublish(command: string) {
    const archivePath = /if='([^']+)'/.exec(command)?.[1];
    const mountedPath = /of='([^']+)'/.exec(command)?.[1];
    const store = this.chainStore;

    if (archivePath === undefined || mountedPath === undefined || store === undefined) {
      throw new Error(`the publish command names no archive, target or store: ${command}`);
    }

    const bytes = this.stagedArchives.get(archivePath);

    if (bytes === undefined) throw new Error(`the publish reads an archive nothing staged: ${archivePath}`);

    // The store mount exposes the chain root: shipped `mountedLayerPath` joins `/backups` and
    // the root-relative key, so this same join fails loudly below if the two drift.
    const relative = mountedPath.startsWith('/backups/')
      ? mountedPath.slice('/backups/'.length)
      : undefined;

    if (relative === undefined) throw new Error(`the publish target is outside the store mount: ${mountedPath}`);

    const key = `${store.root}/${relative}`;
    const parent = key.slice(0, key.lastIndexOf('/') + 1);

    store.attempts?.push({ operation: 'put', key: parent, bytes: 0 });
    store.attempts?.push({ operation: 'put', key, bytes: 0 });
    store.attempts?.push({ operation: 'put', key, bytes: bytes.byteLength });
    store.objects.set(key, bytes.slice());

    return { stdout: `0 ${String(bytes.byteLength)}`, stderr: '', exitCode: 0 };
  }

  /** Models D15: the egress publish writes the staged archive in ONE object attempt (s3fs `dd`
   *  cannot); the store lands it under the mount's prefix plus the URL's key. */
  #execPublishEgress(command: string) {
    const archivePath = /devbox-publish\.mjs' '([^']+)'/.exec(command)?.[1];
    const objectUrl = /devbox-publish\.mjs' '[^']+' '([^']+)'/.exec(command)?.[1];
    const store = this.chainStore;

    if (archivePath === undefined || objectUrl === undefined || store === undefined) {
      throw new Error(`the egress publish command names no archive, URL or store: ${command}`);
    }

    if (this.s3fsMounts.size === 0) {
      return { stdout: '1 ', stderr: 'Access to R2 bucket is not permitted. Call mountBucket() with this bucket before accessing it.', exitCode: 0 };
    }

    const relative = /^https?:\/\/[^/]+\/[^/]+\/(.+)$/.exec(objectUrl)?.[1];

    if (relative === undefined) {
      return { stdout: '1 ', stderr: `PUT answered 403 for ${objectUrl}`, exitCode: 0 };
    }

    const bytes = this.stagedArchives.get(archivePath);

    if (bytes === undefined) return { stdout: '2 ', stderr: `no archive at ${archivePath}`, exitCode: 0 };

    const key = `${store.root}/${relative}`;
    store.attempts?.push({ operation: 'put', key, bytes: bytes.byteLength });
    store.objects.set(key, bytes.slice());

    return { stdout: `0 ${String(bytes.byteLength)} "etag"`, stderr: '', exitCode: 0 };
  }

  async exec(
    command: string,
    options?: { readonly cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const refused = sessionShellRefusal(command);

    if (refused !== undefined) {
      this.sequence.push(`sessionKilled:${command.split(' ')[0]}`);
      throw refused;
    }

    const refusedChdir = this.#chdir(options?.cwd);

    if (refusedChdir !== null) return refusedChdir;
    this.#recordDirectories(command);
    this.execs.push(command);
    // The scan gets a fixed name, not its first word: ordering assertions read this row
    // and must not silently stop matching when the template's first word changes.
    this.sequence.push(command.includes('/proc/$pid/fd')
      ? 'exec:release-workdir-holders'
      : `exec:${command.split(' ')[0]}`);
    const held = this.execGate;

    if (held !== undefined) {
      this.execGate = undefined;
      held.enter();
      await held.promise;
    }

    if (this.execDelayMs > 0) await scheduler.wait(this.execDelayMs);

    if (command === 'cat /tmp/devbox-boot-id 2>/dev/null || true') {
      return { stdout: this.bootId ?? '', stderr: '', exitCode: 0 };
    }

    if (command === 'cat /proc/mounts') {
      // Lists every path the box's `mountBucket` holds, as `/proc/mounts` does in a container,
      // so a strategy's read-back observes the fake's changes, not test-staged state.
      const lines = [
        'proc /proc proc rw,relatime 0 0',
        ...[...this.s3fsMounts].map(
          (path) => `s3fs ${path} fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0`,
        ),
        ...(this.journalRunning() && this.journalMounts
          ? ['kinu-journal /workspace fuse.kinu-journal rw,nosuid,nodev,relatime 0 0']
          : []),
        // Present until a stop takes the FUSE daemons down; the fstype must match the container's
        // because `isOverlayMounted` reads it while `findMount` reads the mount point.
        ...[...this.overlayMounts].map(
          (path) => `fuse-overlayfs ${path} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
        ),
        ...[...this.layerMounts].map(
          (path) => `squashfuse ${path} fuse.squashfuse ro,nosuid,nodev,relatime 0 0`,
        ),
      ];

      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
    }

    if (command.startsWith('sync')) {
      // `sync -f <dir> && sync; echo $?`: the fake holds no pages to flush, so it answers
      // with the success the real command reports.
      return { stdout: '0', stderr: '', exitCode: 0 };
    }

    if (command.startsWith('test -e')) {
      // The fake holds no filesystem, so `test -e` answers yes for any path a strategy asks about.
      return { stdout: 'yes', stderr: '', exitCode: 0 };
    }

    // Answers the journal socket probe as the container does: exit is 0 either way (`|| echo no`),
    // so readers must take the stdout words; an exit-code read cannot see a lost socket.
    if (command.startsWith('test -S ')) {
      const serving = this.journalRunning() && this.journalMounts && this.journalSocketUp;

      return { stdout: serving ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 };
    }

    const removal = this.#execRemoval(command);

    if (removal !== null) return removal;
    const probed = /127\.0\.0\.1:(\d+)/.exec(command);

    if (probed !== null) {
      // '200|0' is an answer; '000|7' is curl's connection-refused exit.
      const port = Number(probed[1]);

      return { stdout: this.listening.has(port) ? '200|0' : '000|7', stderr: '', exitCode: 0 };
    }

    if (command.includes(STAMP_COMMAND)) {
      const stamp = this.stampGate;

      if (stamp !== undefined) {
        this.stampGate = undefined;
        stamp.enter();
        await stamp.promise;
      }

      const fault = this.stampFaults.shift();

      if (fault !== undefined) throw fault;
      const bootId = /^printf %s ([^ ]+) > \/tmp\/devbox-boot-id$/.exec(command);

      if (bootId !== null) this.bootId = bootId[1];
    }

    // Lazy detach (`MNT_DETACH`) removes the mount even while a holder lives, so it clears
    // both the mount and the holder row; the holder process survives without a mount.
    if (command.includes('fusermount -uz')) {
      this.sequence.push('exec:lazy-unmount');
      this.s3fsMounts.delete('/workspace');
      this.workdirHolder = undefined;

      return { stdout: '', stderr: '', exitCode: 0 };
    }

    const release = this.#execHolderRelease(command);

    if (release !== null) return release;

    // The readiness probe waits inside the container, so one exec answers it; never answer per attempt.
    // Matched on the line it prints: a fake keyed on anything else answers '' to a reshaped command.
    if (command.includes('echo "socket=$socket mount=$mount"')) {
      const serving = this.journalRunning() && this.journalMounts;

      return {
        stdout: `socket=${serving ? 'yes' : 'no'} mount=${serving ? 'yes' : 'no'}\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    const chain = this.#execChainCommand(command);

    if (chain !== null) return chain;

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async mountBucket(
    _binding: string, mountPath: string, options?: { readonly s3fsOptions?: readonly string[] },
  ): Promise<void> {
    this.mountCalls.push(`mount:${mountPath}`);
    this.sequence.push(`mount:${mountPath}`);
    this.s3fsMounts.add(mountPath);
    this.s3fsOptionsByMount.set(mountPath, options?.s3fsOptions ?? []);
  }

  async unmountBucket(mountPath: string): Promise<void> {
    this.mountCalls.push(`unmount:${mountPath}`);
    this.sequence.push(`unmount:${mountPath}`);

    // Models the SDK: `fusermount -u` runs in the default session (cwd `/workspace`), and a
    // shell standing on a mount holds it, so unmount is refused even with no live holder.
    if (this.#mountIsBusy(mountPath)) {
      throw new Error(
        `fusermount -u failed (exit 1): fusermount: failed to unmount ${mountPath}: `
        + 'Device or resource busy',
      );
    }

    this.s3fsMounts.delete(mountPath);
  }

  #mountIsBusy(path: string): boolean {
    return this.sessionCwd === path || this.sessionCwd.startsWith(`${path}/`)
      || (path === '/workspace' && this.workdirHolder !== undefined);
  }

  async renameFile(oldPath: string, newPath: string, sessionId?: string): Promise<FileOperation> {
    return this.#recordFileOperation('rename', oldPath, newPath, sessionId);
  }

  async moveFile(sourcePath: string, destinationPath: string, sessionId?: string): Promise<FileOperation> {
    return this.#recordFileOperation('move', sourcePath, destinationPath, sessionId);
  }

  #recordFileOperation(
    operation: FileOperation['operation'],
    from: string,
    to: string,
    sessionId: string | undefined,
  ): FileOperation {
    const request = { operation, from, to, sessionId };
    this.fileOperations.push(request);
    const failure = this.fileOperationFailures[operation].shift();

    if (failure !== undefined) throw failure;

    return request;
  }

  async getState() {
    return { status: this.providerStatus, lastChange: 0 };
  }

  /** A process as the SDK hands it back: the row plus its own `getLogs`, which
   *  the box reads when a runner exits non-zero. */
  #live(row: FakeProcessRow): LiveProcess {
    return { ...row, getLogs: async () => await this.getProcessLogs(row.id) };
  }

  async startProcess(
    command: string,
    options: { cwd?: string; processId?: string },
  ): Promise<LiveProcess> {
    this.starts.push({ command, cwd: options.cwd, processId: options.processId });
    const held = this.startGate;

    if (held !== undefined) {
      this.startGate = undefined;
      held.enter();
      await held.promise;
    }

    const fault = this.startFaults.shift();

    if (fault?.created === false) throw fault.error;
    const id = options.processId ?? `sdk-generated-${this.processes.size + 1}`;

    const row: FakeProcessRow = {
      id, pid: 1_000 + this.processes.size, status: 'running', command,
    };

    this.processes.set(id, row);

    // A fresh journal daemon brings a fresh control socket, the way the mount
    // line and the readiness probe already treat a fresh daemon as serving.
    if (command.includes('kinu-journal-daemon')) this.journalSocketUp = true;

    if (fault !== undefined) throw fault.error;
    const argv = quotedWords(command);
    const action = runnerOption(argv, 'action');

    if (action === undefined || this.runner === undefined) return this.#live(row);
    // The runner settles before start replies: a real shape and the only deterministic one, so
    // the first exit poll finds a settled row with the reply at its path.
    const resultPath = runnerOption(argv, 'result');
    const controlPath = runnerOption(argv, 'control');

    try {
      const control = controlPath === undefined ? undefined : this.files.get(controlPath);
      const reply = await this.runner({ action, resultPath, control, argv });

      if (resultPath !== undefined) this.files.set(resultPath, reply);
      this.processes.set(id, { ...row, status: 'completed', exitCode: 0 });
    } catch (cause) {
      this.processLogs.set(id, { stdout: '', stderr: describeThrown({ cause }) });
      this.processes.set(id, { ...row, status: 'failed', exitCode: 1 });
    }

    return this.#live(row);
  }

  async readFile(path: string): Promise<{ content: string }> {
    const content = this.files.get(path);

    if (content === undefined) throw new Error(`File not found: ${path}`);

    return { content };
  }

  /** A write under the work directory also lands in the overlay upper, where an overlayfs
   *  write really goes and what the chain's delta archiver walks. */
  async writeFile(path: string, content: string): Promise<{ success: true; path: string; timestamp: string }> {
    this.files.set(path, content);
    this.changeVersion += 1;

    if (path.startsWith('/workspace/')) {
      this.files.set(`/var/tmp/devbox/upper/${path.slice('/workspace/'.length)}`, content);
    }

    await this.fileWritten?.(path, content);

    return { success: true, path, timestamp: new Date().toISOString() };
  }

  /** Models the SDK's retained change state: a held version matches until a write moves it;
   *  a first call with no `since` establishes the baseline and reports unchanged. */
  async checkChanges(
    _path: string,
    options?: { readonly since?: string },
  ): Promise<{ success: true; status: 'unchanged' | 'changed'; version: string; timestamp: string }> {
    const version = `v${String(this.changeVersion)}`;
    const status = options?.since === undefined || options.since === version ? 'unchanged' : 'changed';

    return { success: true, status, version, timestamp: new Date().toISOString() };
  }

  /** The files this container holds under one directory, as the SDK lists
   *  them. The chain's emptiness gates read only the count. */
  async listFiles(
    path: string,
    _options?: { readonly recursive?: boolean },
  ): Promise<{
    readonly success: true;
    readonly path: string;
    readonly files: readonly {
      readonly name: string;
      readonly absolutePath: string;
      readonly relativePath: string;
      readonly type: 'file';
      readonly size: number;
      readonly modifiedAt: string;
      readonly mode: string;
      readonly permissions: { readonly readable: true; readonly writable: true; readonly executable: false };
    }[];
    readonly count: number;
    readonly timestamp: string;
  }> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const now = new Date().toISOString();

    const files = [...this.files.entries()]
      .filter(([entry]) => entry.startsWith(prefix))
      .map(([absolutePath, content]) => ({
        name: absolutePath.slice(prefix.length).split('/').at(-1) ?? absolutePath,
        absolutePath,
        relativePath: absolutePath.slice(prefix.length),
        type: 'file' as const,
        size: content.length,
        modifiedAt: now,
        mode: '644',
        permissions: { readable: true as const, writable: true as const, executable: false as const },
      }));

    return { success: true, path, files, count: files.length, timestamp: now };
  }

  /** Deterministic stand-in for squashfs bytes: unchanged files measure identically, any write
   *  changes the measure. Workload files match no `CHAIN_EXCLUDES`, so exclusion is skipped. */
  synthesizeArchive(sourceDir: string): Uint8Array {
    const prefix = sourceDir.endsWith('/') ? sourceDir : `${sourceDir}/`;

    const entries = [...this.files.entries()]
      .filter(([entry]) => entry.startsWith(prefix))
      .sort(([left], [right]) => {
        if (left < right) return -1;

        return left > right ? 1 : 0;
      });

    const encoded = new TextEncoder();
    const parts: Uint8Array[] = [];

    for (const [entry, content] of entries) {
      parts.push(encoded.encode(`${entry} ${String(content.length)} `), encoded.encode(content));
    }

    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;

    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }

    return out;
  }

  /** Models the platform reclaiming an instance mid-poll: the process record still answers
   *  `running` after its reporter is gone, so the poll must observe the container stop. */
  readonly stopsContainerOnPoll = new Set<string>();

  getProcess(id: string): Promise<LiveProcess | null> {
    const fault = this.getFaults.shift();

    if (fault !== undefined) return Promise.reject(fault);

    if (this.stopsContainerOnPoll.has(id)) this.running.running = false;
    const row = this.processes.get(id);

    return Promise.resolve(row === undefined ? null : this.#live(row));
  }

  listProcesses(): Promise<readonly FakeProcessRow[]> {
    return Promise.resolve([...this.processes.values()]);
  }

  /** Tests stage a daemon's own output here to assert failures report its words,
   *  not a guessed "the mount did not land". */
  readonly processLogs = new Map<string, { stdout: string; stderr: string }>();

  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    return Promise.resolve(this.processLogs.get(id) ?? { stdout: '', stderr: '' });
  }

  killProcess(id: string): Promise<void> {
    this.kills.push(id);
    const targeted = this.killFaultsById.get(id);

    if (targeted !== undefined) return Promise.reject(targeted);
    const fault = this.killFaults.shift();

    if (fault !== undefined) return Promise.reject(fault);
    this.processes.delete(id);

    return Promise.resolve();
  }

  async exposePort(port: number, options: { token?: string; name?: string }): Promise<void> {
    const held = this.exposeGate;

    if (held !== undefined) {
      this.exposeGate = undefined;
      held.enter();
      await held.promise;
    }

    this.exposures.push({ port, token: options.token, name: options.name });
  }

  destroy(): Promise<void> {
    this.destroys += 1;
    const fault = this.destroyFault;

    if (fault !== undefined) return Promise.reject(fault);
    this.running.running = false;
    this.#loseContainerLocalState();

    return Promise.resolve();
  }

  #loseContainerLocalState(): void {
    this.files.clear();
    this.directories.clear();

    for (const path of IMAGE_DIRECTORIES) this.directories.add(path);
    this.bootId = undefined;
    this.stagedArchives.clear();
    this.processes.clear();
    this.processLogs.clear();
    this.overlayMounts.clear();
    this.layerMounts.clear();
    this.s3fsMounts.clear();
    this.workdirHolder = undefined;
    this.sessionCwd = '/workspace';
    this.changeVersion = 0;
    this.journalSocketUp = false;
  }

  async containerFetch(): Promise<Response> {
    return new Response();
  }

  /** Starting a running container is a health probe, not a new instance: it adds no start,
   *  but the ask is still recorded and an injected fault still fires. */
  async start(...args: unknown[]): Promise<void> {
    this.startWaitOptions.push(args[1]);
    // Admission park: nothing before this point is durable, so it is the only seam that pins
    // what a superseded admission may do.
    const admitting = this.containerStartGate;

    if (admitting !== undefined) {
      this.containerStartGate = undefined;
      admitting.enter();
      await admitting.promise;
    }

    // The standing refusal, checked after the park so a test can hold an
    // attempt inside a refusal that is not going to clear.
    if (this.containerUnavailable !== undefined) throw this.containerUnavailable;
    const beforeRunning = this.startFaultBeforeRunning;
    this.startFaultBeforeRunning = undefined;

    if (beforeRunning !== undefined) throw beforeRunning;
    const wasRunning = this.running.running;
    this.running.running = true;

    if (!wasRunning) this.containerStarts += 1;
    const fault = this.startFaultAfterRunning;
    this.startFaultAfterRunning = undefined;

    if (fault !== undefined) throw fault;
    const beforeHook = this.containerHookGate;

    if (beforeHook !== undefined) {
      this.containerHookGate = undefined;
      beforeHook.enter();
      await beforeHook.promise;
    }

    // Models the platform: an adoption RPC inside the SDK hook block never gets its reply,
    // measured 2026-09-13. The storage block is released first; readiness singleflight gates callers.
    await this.onStart();

  }

  /** Proves the control listener or a requested app port before opening onStart (D1);
   *  only app listeners depend on restored workloads. */
  async startAndWaitForPorts(...args: unknown[]): Promise<void> {
    // The rest parameter is the one `unknown` this file allows; decode SDK port shapes here.
    const single = v.safeParse(v.number(), args[0]);
    const list = v.safeParse(v.array(v.number()), args[0]);

    const options = v.safeParse(v.object({
      ports: v.union([v.number(), v.array(v.number())]),
      cancellationOptions: v.optional(v.object({
        instanceGetTimeoutMS: v.optional(v.number()),
        waitInterval: v.optional(v.number()),
        abort: v.optional(v.instance(AbortSignal)),
      })),
    }), args[0]);

    const askedPorts = (): readonly number[] => {
      if (single.success) return [single.output];

      if (list.success) return list.output;

      if (!options.success) return [];
      const { ports } = options.output;

      return Array.isArray(ports) ? ports : [ports];
    };

    const wanted = askedPorts();

    // Port 3000 is the Sandbox control listener, not a restored application.
    const dark = wanted.filter((port) => port !== this.defaultPort && !this.listening.has(port));

    if (dark.length > 0) {
      const wasRunning = this.running.running;
      this.running.running = true;

      if (!wasRunning) this.containerStarts += 1;
      throw new Error(
        `port ${dark.join(', ')} never answered: admission waits for the instance, and per-port proofs live inside the restore`,
      );
    }

    const cancellation = options.success ? options.output.cancellationOptions : undefined;
    const interval = cancellation?.waitInterval ?? 100;
    await FakeSandbox.prototype.start.call(this, undefined, {
      portToCheck: this.defaultPort,
      retries: Math.ceil((cancellation?.instanceGetTimeoutMS ?? 30_000) / interval),
      waitInterval: interval,
      signal: cancellation?.abort,
    });
  }

  stops = 0;

  /** Successful physical termination discards local state, not DO storage,
   * remote objects, recorded call history or configured fault responses. */
  stop(): Promise<void> {
    this.stops += 1;
    const fault = this.stopFault;

    if (fault !== undefined) return Promise.reject(fault);
    this.running.running = false;
    this.#loseContainerLocalState();

    return Promise.resolve();
  }

  renewActivityTimeout(): void {
    // The activity clock is the platform's; nothing here reads it.
  }

  listSchedules(callback?: string): Promise<readonly { time: number }[]> {
    return Promise.resolve(
      this.scheduleRows
        .filter(row => callback === undefined || row.callback === callback)
        .map(({ time }) => ({ time })),
    );
  }

  schedule(delaySeconds: number, callback: string): Promise<void> {
    this.schedules.push(callback);
    this.scheduleRows.push({ callback, time: Date.now() / 1000 + delaySeconds });

    return Promise.resolve();
  }
}

/** A real empty async iterator keeps the mocked SDK `streamFile` contract faithful; stream
 *  decoding is left to the SDK boundary tests that own it. */
function emptyFileChunks() {
  const metadata = {
    mimeType: 'application/octet-stream',
    size: 0,
    isBinary: true,
    encoding: 'base64' as const,
  };

  return {
    next: async () => ({ done: true as const, value: metadata }),
    return: async () => ({ done: true as const, value: metadata }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

await mock.module('@cloudflare/sandbox', () => ({
  Sandbox: FakeSandbox,
  streamFile: emptyFileChunks,
}));

// A real timer on purpose: the probe loop and the stop-transition wait are under test,
// so faking the clock would replace the property. Assertions never read elapsed time.
Object.defineProperty(globalThis, 'scheduler', {
  configurable: true,
  value: {
    wait: (ms: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);

      return promise;
    },
  },
});

// Dynamic import: the substitution above must register before the class's module graph
// resolves `@cloudflare/sandbox`, and a static import would be hoisted above it.
export const { Devbox } = await import('../../src/devbox');

/** Derived from the class's constructor signature: the Workers types parameterise it,
 *  and a second spelling here would be a second opinion on the platform. */
type BoxState = ConstructorParameters<typeof Devbox>[0];

export interface BoxStateParts {
  readonly storage: DurableObjectStorage;
  readonly id: string;
  readonly container?: { running: boolean };
  readonly blockConcurrencyWhile: <T>(closure: () => Promise<T>) => Promise<T>;
}

/** The whole `DurableObjectState`: the SDK `Sandbox` constructor takes the full handle.
 *  Only the members the class reads are supplied; every other one refuses by name. */
export function boxState(parts: BoxStateParts): BoxState {
  return {
    id: { toString: () => parts.id, equals: () => unreached('state.id.equals') },
    storage: parts.storage,
    container: parts.container === undefined ? undefined : containerHandle(parts.container),
    blockConcurrencyWhile: parts.blockConcurrencyWhile,
    props: {},
    waitUntil: () => unreached('state.waitUntil'),
    get facets(): DurableObjectFacets { return unreached('state.facets'); },
    acceptWebSocket: () => unreached('state.acceptWebSocket'),
    getWebSockets: () => unreached('state.getWebSockets'),
    setWebSocketAutoResponse: () => unreached('state.setWebSocketAutoResponse'),
    getWebSocketAutoResponse: () => unreached('state.getWebSocketAutoResponse'),
    getWebSocketAutoResponseTimestamp: () => unreached('state.getWebSocketAutoResponseTimestamp'),
    setHibernatableWebSocketEventTimeout: () => unreached('state.setHibernatableWebSocketEventTimeout'),
    getHibernatableWebSocketEventTimeout: () => unreached('state.getHibernatableWebSocketEventTimeout'),
    getTags: () => unreached('state.getTags'),
    abort: () => unreached('state.abort'),
  };
}

/** Only `running` is live; the rest refuse because the class reaches the control plane
 *  through the SDK, never through `ctx.container`. */
export function containerHandle(flag: { running: boolean }): Container {
  return {
    get running(): boolean { return flag.running; },
    start: () => unreached('container.start'),
    monitor: () => unreached('container.monitor'),
    destroy: () => unreached('container.destroy'),
    signal: () => unreached('container.signal'),
    getTcpPort: () => unreached('container.getTcpPort'),
    setInactivityTimeout: () => unreached('container.setInactivityTimeout'),
    interceptOutboundHttp: () => unreached('container.interceptOutboundHttp'),
    interceptAllOutboundHttp: () => unreached('container.interceptAllOutboundHttp'),
    interceptOutboundHttps: () => unreached('container.interceptOutboundHttps'),
    snapshotDirectory: () => unreached('container.snapshotDirectory'),
    snapshotContainer: () => unreached('container.snapshotContainer'),
    exec: () => unreached('container.exec'),
  };
}

/** An ephemeral test box has no store and nothing durable, so its env has no bindings.
 *  Named rather than `unknown`: a boundary that admits anything admits an unparsed value too. */
export type TestEnv = Record<string, never>;

/** Also the box prefix the strategy scopes the store to (`boxes/<id>`). */
export const TEST_BOX_ID = 'devbox-under-test';

/** Hashes the same input production passes to `binding.idFromName(`${strategy}:${name}`)`;
 *  equal inputs share one box and its storage, any difference gives another box. */
export function deriveBoxId(strategy: string, name: string): string {
  return createHash('sha256').update(`${strategy}:${name}`).digest('hex');
}

export interface Harness<Box> {
  readonly box: Box;
  readonly container: FakeSandbox;
  readonly rows: Map<string, StoredValue>;
  readonly storage: FakeStorage;
}

/** `id` defaults to `TEST_BOX_ID`; pass `deriveBoxId` output to model production identity.
 *  Starts stopped; a running-but-unsettled fixture is refused by readiness until the hook runs. */
export function harness<Box>(
  Box: new (state: BoxState, env: TestEnv) => Box,
  id: string = TEST_BOX_ID,
): Harness<Box> {
  const storage = fakeStorage();

  const state = boxState({
    storage: storage.handle,
    id,
    // Deliberately grants no exclusion: the closure just runs, so a test can park inside it
    // and prove the conditional write refuses when the row changed under it.
    blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => await closure(),
  });

  const box = new Box(state, {});
  const container = FakeSandbox.last;

  if (container === undefined) {
    throw new Error('the substituted Sandbox base class did not run its constructor');
  }

  // Set after construction because the class reads `ctx.container` only at call
  // time, and the fake owns the flag it flips on stop and destroy.
  state.container = containerHandle(container.running);

  container.running.running = false;

  return { box, container, rows: storage.rows, storage };
}

/** Holds the operation until the init gate opens: no event reaches a Durable Object inside
 *  `blockConcurrencyWhile`, so an earlier call tests an interleaving that cannot happen. */
export async function deliver<T>(container: FakeSandbox, work: () => Promise<T>): Promise<T> {
  await container.initGate;

  return await work();
}
