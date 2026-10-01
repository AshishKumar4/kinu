// Native platform boundary. Real Files/S3Mount clients execute against the shim model.
import { NativeShim } from './native-shim';
import { processResult } from './native-process';
import { Devbox } from '../../src/devbox';

export { Devbox };

import { createHash } from 'node:crypto';

import { snapshotChainStorage } from '../../src/snapshot-chain';
import { DEVBOX_RUNTIME_DIR, type StoredValue } from '../../src/storage';
import {
  DEVBOX_SYNC_HOST, containerChainPorts, decodeSyncConfig, parseCheckpointKind, syncCaller,
  syncWorker, type SyncAnswer,
} from '../../src/sync';
import { shellSyntaxError } from "./container-shell";
import * as v from 'valibot';
import type { ExecResult } from '../../src/contracts';

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

export const HARNESS_IMAGE = 'registry.cloudflare.com/test/kinu-devbox@sha256:0000';

/** The process manager's scripts, named by their `$0` (`src/processes.ts`). */
const PROCESS_SCRIPTS = new Set(['devbox-process', 'devbox-unlaunch', 'devbox-status', 'devbox-kill']);

/** Uses the SDK's own status vocabulary: `isProcessLive` reads `status`. */
export interface FakeProcessRow {
  readonly id: string;
  readonly pid: number;
  readonly status: string;
  readonly command: string;
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


const alarmTimes = new WeakMap<DurableObjectStorage, { at: number | null; scheduled: string[] }>();


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
  /** Every `list` under `prefix` rejects with `error` until cleared with `undefined`. */
  failListOn(prefix: string, error: Error | undefined): void;
}

/** The object's one alarm and the schedule rows that armed it. */
interface AlarmModel {
  at: number | null;
  readonly scheduled: string[];
}

/** Durable Object storage double: a Map honouring the runtime contract for the four ops used.
 *  `get` resolves undefined when absent, `delete` reports whether a row existed, `list` by prefix. */
export function fakeStorage(): FakeStorage {
  const rows = new Map<string, StoredValue>();
  const gates: Record<string, Gate | undefined> = {};
  const alarm: AlarmModel = { at: null, scheduled: [] };
  const faults: Record<string, Error | undefined> = {};
  const listFaults = new Map<string, Error>();
  let kvCursor = 0;
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
    get: async (key: string | string[]): Promise<StoredValue | Map<string, StoredValue>> => {
      if (Array.isArray(key)) return new Map(key.filter(item => rows.has(item)).map(item => [item, rows.get(item)]));
      const held = gates[key];

      if (held !== undefined) {
        gates[key] = undefined;
        held.enter();
        await held.promise;
      }

      return rows.get(key);
    },
    put: async (key: string | Record<string, StoredValue>, value?: StoredValue): Promise<void> => {
      for (const [name, stored] of v.is(v.string(), key) ? [[key, value] as const] : Object.entries(key)) {
        const fault = takeWriteFault(name);

        if (fault !== undefined) throw fault;
        rows.set(name, stored);
        keyVersions.set(name, (keyVersions.get(name) ?? -1) + 1);
      }
    },
    delete: async (keys: string | string[]): Promise<boolean | number> => {
      let removed = 0;

      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (rows.delete(key)) { removed++; keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1); }
      }

      return Array.isArray(keys) ? removed : removed !== 0;
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
    kv: {
      get: (key: string) => rows.get(key),
      put: (key: string, value: StoredValue) => {
        const fault = takeWriteFault(key);

        if (fault !== undefined) throw fault;
        rows.set(key, value);
        keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1);

        if (key.startsWith('devbox:schedule:')) alarm.scheduled.push(key.slice('devbox:schedule:'.length));
      },
      delete: (key: string) => {
        const deleted = rows.delete(key);

        if (deleted) keyVersions.set(key, (keyVersions.get(key) ?? -1) + 1);

        return deleted;
      },
      list: ({ prefix = "" } = {}): IterableIterator<[string, StoredValue]> => {
        const cursor = ++kvCursor;
        const entries = [...rows].filter(([key]) => key.startsWith(prefix)).values();

        return {
          [Symbol.iterator]() { return this; },
          next() {
            if (cursor !== kvCursor) throw new Error("kv.list() iterator was invalidated by another list");

            return entries.next();
          },
        };
      },
    },
    setAlarm: async (at: number | Date) => { alarm.at = Number(at); },
    getAlarm: async () => alarm.at,
    deleteAlarm: async () => { alarm.at = null; },
    sql: {
      exec: (query: string) => unreached("sql: " + query),
      get databaseSize() { return unreached("sql.databaseSize"); },
      get Cursor() { return unreached("sql.Cursor"); },
      get Statement() { return unreached("sql.Statement"); },
    },
    list: (options: { prefix: string }): Promise<Map<string, StoredValue>> => {
      const failure = listFaults.get(options.prefix);

      if (failure !== undefined) return Promise.reject(failure);

      return Promise.resolve(new Map([...rows].filter(([key]) => key.startsWith(options.prefix))));
    },
    deleteAll: () => unreached('storage.deleteAll'),
    sync: () => unreached('storage.sync'),
    transactionSync: <T>(run: () => T): T => {
      const before = new Map(rows);
      const versions = new Map(keyVersions);

      try { return run(); }
      catch (cause) {
        rows.clear(); keyVersions.clear();

        for (const [key, value] of before) rows.set(key, value);

        for (const [key, value] of versions) keyVersions.set(key, value);
        throw cause;
      }
    },
    getCurrentBookmark: () => unreached('storage.getCurrentBookmark'),
    getBookmarkForTime: () => unreached('storage.getBookmarkForTime'),
    onNextSessionRestoreBookmark: () => unreached('storage.onNextSessionRestoreBookmark'),
  } as DurableObjectStorage;

  alarmTimes.set(handle, alarm);

  return {
    rows,
    handle,
    gateOn: (key, held) => { gates[key] = held; },
    failListOn: (prefix, error) => { if (error === undefined) listFaults.delete(prefix); else listFaults.set(prefix, error); },
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

  /** Same object the Durable Object state hands the class as `ctx.container`, so a test that
   *  stops the container and the class reading `running` cannot disagree. */
  readonly running = { running: true };
  defaultPort = 3000;
  readonly processes = new Map<string, FakeProcessRow>();
  readonly starts: StartRecord[] = [];
  readonly kills: string[] = [];
  readonly execs: string[] = [];
  readonly exposures: { port: number; token: string | undefined; name: string | undefined }[] = [];
  get schedules(): string[] { return alarmTimes.get(this.ctx.storage)?.scheduled ?? []; }
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
  /** Hosts the box bound to a named outbound handler (`setOutboundByHost`). */
  readonly outboundHosts = new Map<string, string>();
  /** The image's sync program, as `# devbox-sync-start-v1` leaves it; the heartbeat reads it. */
  syncRunning = false;
  /** The box's sync host, which `harness` wires to the box it built; the flush reaches it. */
  syncHost: ((body: string) => Promise<SyncAnswer>) | undefined = undefined;
  /** s3fs runs under exactly these options; an option absent here is s3fs's own default. */
  readonly s3fsOptionsByMount = new Map<string, readonly string[]>();
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
  readonly getFaults: Error[] = [];
  readonly killFaults: Error[] = [];
  readonly stampFaults: (Error | undefined)[] = [];
  startGate: Gate | undefined;
  /** Parks the container's own admission probe, `start()`, awaited before a generation is captured.
   *  Distinct from `startGate` (the process start): two different calls and windows. */
  containerStartGate: Gate | undefined;
  /** Container is running, but the SDK has not invoked the port-proven hook. */
  containerHookGate: Gate | undefined;
  execGate: Gate | undefined;
  /** Parks a session exec where the SDK reads its object's state (`containerFetch`,
   *  `startContainerForRPC`): issued, but not yet at the container. */
  stateReadGate: Gate | undefined;
  /** Delay inside the container per command, modelling a counted loop (`awaitLayer`, `awaitListenerCommand`).
   *  A real wait: the test checks whether one command's duration can extend a caller's window. */
  execDelayMs = 0;
  stampGate: Gate | undefined;
  exposeGate: Gate | undefined;
  /** Parks a file write inside the container, while its caller still holds the path. */
  writeGate: Gate | undefined;
  destroyFault: Error | undefined;
  stopFault: Error | undefined;
  destroys = 0;
  bootId: string | undefined;
  containerStarts = 0;
  readonly startWaitOptions: unknown[] = [];
  /** Each platform start's options (D50). */
  readonly startOptions: (ContainerStartupOptions | undefined)[] = [];
  readonly files = new Map<string, string>();
  /** Files whose bytes are not UTF-8 text, which `files` cannot hold; the SDK's file reads serve them as bytes. */
  readonly binaryFiles = new Map<string, Uint8Array>();
  readonly fileFaults = new Map<string, { readonly errno: number; readonly message: string }>();
  /** Recorded by the box's own `fuse-overlayfs` command and reported via `cat /proc/mounts`,
   *  which `isOverlayMounted` reads; termination clears them with the local filesystem (P1). */
  readonly overlayMounts = new Set<string>();
  /** Recorded when the box's own `squashfuse` command runs and read back via `/proc/mounts`;
   *  a stop clears them with the local filesystem, like `overlayMounts`. */
  readonly layerMounts = new Set<string>();
  /** Each layer mount's `fsname`: the archive it serves, which `/proc/mounts` reports as its source. */
  readonly #layerSources = new Map<string, string>();
  /** Must be the bucket `objectFacts` reads and `chainStoreRoot` derives, so a `dd` through the
   *  store mount lands where the next attach looks. Unset, no chain command reaches the store. */
  chainStore: { readonly objects: Map<string, Uint8Array>; readonly root: string;
    /** Every object-store write attempt a publication makes, in order. s3fs `dd` costs three
     *  (marker, empty placeholder, payload); the egress PUT costs one. */
    attempts?: { operation: 'put' | 'uploadPart' | 'complete'; key: string; bytes: number }[] } | undefined;
  /** Local files keyed by container path: what the box's `mksquashfs` produced, which a later
   *  `dd` of that path publishes. Not the remote objects in chainStore. */
  readonly stagedArchives = new Map<string, Uint8Array>();
  /** The SDK's start block (D26): set while the start hook runs, so `deliver` holds every
   *  operation that arrives during the restore until the hook settles. */
  initGate: Promise<void> | undefined;

  constructor(readonly ctx: DurableObjectState) {}

  /** A missing `cwd` is refused: the session shell chdirs first, so the command never runs. */
  #chdir(cwd: string | undefined): ExecResult | null {
    if (cwd === undefined || this.directories.has(cwd)) return null;
    this.sequence.push(`chdirRefused:${cwd}`);

    return { stdout: '', stderr: `Failed to change directory to '${cwd}'`, exitCode: 1 };
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
  #execRemoval(command: string): ExecResult | null {
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

  /** The holder release as a container with no process on the mount answers it. Matched on the
   *  `/proc/$pid/fd` scan, not the command prefix, which an ancestor walk changes. */
  #execHolderRelease(command: string): ExecResult | null {
    return command.includes('/proc/$pid/fd') ? { stdout: 'none', stderr: '', exitCode: 0 } : null;
  }
  #hydrateLayer(source: string, mountPoint: string): void {
    const relative = source.startsWith('/backups/') ? source.slice('/backups/'.length) : undefined;

    const bytes = relative === undefined ? this.stagedArchives.get(source)
      : this.chainStore?.objects.get(this.chainStore.root + '/' + relative);

    if (bytes === undefined) return;
    const archive = new TextDecoder().decode(bytes);
    const rootEnd = archive.indexOf('\0');

    if (rootEnd < 0) return;
    const root = archive.slice(0, rootEnd) + '/';
    let at = rootEnd + 1;

    while (at < archive.length) {
      const nameEnd = archive.indexOf('\0', at);
      const sizeEnd = archive.indexOf('\0', nameEnd + 1);

      if (nameEnd < 0 || sizeEnd < 0) throw new Error('the modeled archive has an incomplete file header');
      const name = archive.slice(at, nameEnd);
      const size = Number(archive.slice(nameEnd + 1, sizeEnd));

      if (!Number.isInteger(size) || size < 0 || !name.startsWith(root)) throw new Error('the modeled archive has an invalid file header');
      at = sizeEnd + 1;
      this.files.set(mountPoint + '/' + name.slice(root.length), archive.slice(at, at + size));
      at += size;
    }
  }

  #unmountWorkdir(path: string): ExecResult {
    for (const process of this.processes.values()) {
      if (process.status !== 'running' && process.status !== 'starting') continue;

      for (let at = this.starts.length - 1; at >= 0; at--) {
        const start = this.starts[at];

        if (start?.processId !== process.id) continue;

        if (start.cwd === path || start.cwd?.startsWith(path + '/') === true) {
          return { stdout: '', stderr: 'fusermount3: failed to unmount ' + path + ': Device or resource busy', exitCode: 1 };
        }

        break;
      }
    }

    for (const file of this.files.keys()) if (file.startsWith(path + '/')) this.files.delete(file);
    this.overlayMounts.delete(path);
    this.layerMounts.delete(path);
    this.#layerSources.delete(path);
    this.s3fsMounts.delete(path);

    return { stdout: '', stderr: '', exitCode: 0 };
  }
  #mountOverlay(command: string): ExecResult {
    const target = quotedSegments(command).at(-1);

    if (target !== undefined) {
      this.overlayMounts.add(target);
      const lowers = /lowerdir='([^']+)'/.exec(command)?.[1]?.split(':').reverse() ?? [];
      const upper = /upperdir='([^']+)'/.exec(command)?.[1];

      if (upper !== undefined) lowers.push(upper);

      for (const layer of lowers) {
        for (const [path, content] of Array.from(this.files)) if (path.startsWith(layer + '/')) this.files.set(target + path.slice(layer.length), content);
      }
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  /** Answers snapshot-chain commands as the container does; matched on the binary each runs,
   *  the one part of the template the strategy's builders own. Null for any other command. */
  #execChainCommand(command: string): ExecResult | null {
    const unmount = /\/usr\/bin\/fusermount3 -u '([^']+)'/.exec(command)?.[1];

    if (unmount !== undefined) return this.#unmountWorkdir(unmount);

    if (command.includes('/usr/bin/fuse-overlayfs')) return this.#mountOverlay(command);

    if (command.includes('/usr/local/bin/devbox-squashfuse')) {
      const quoted = quotedSegments(command.slice(command.indexOf('/usr/local/bin/devbox-squashfuse')));
      const [source, mountPoint] = quoted;

      if (mountPoint !== undefined) this.layerMounts.add(mountPoint);

      if (mountPoint !== undefined && source !== undefined) {
        this.#layerSources.set(mountPoint, source);
        this.#hydrateLayer(source, mountPoint);
      }

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

    if (command.startsWith('bash -o pipefail -c ') && command.includes('/var/tmp/devbox/upper')) {
      return { stdout: this.#upperMark(), stderr: '', exitCode: 0 };
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

    const key = `${store.root}/${decodeURIComponent(relative)}`;
    store.attempts?.push({ operation: 'put', key, bytes: bytes.byteLength });
    store.objects.set(key, bytes.slice());

    return { stdout: `0 ${String(bytes.byteLength)} "etag"`, stderr: '', exitCode: 0 };
  }

  /** Lists every path the box's `mountBucket` holds, as `/proc/mounts` does in a container,
   *  so a strategy's read-back observes the fake's changes, not test-staged state. */
  #procMounts(): string {
    const lines = [
      'proc /proc proc rw,relatime 0 0',
      ...[...this.s3fsMounts].map(
        (path) => `s3fs ${path} fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0`,
      ),
      // Present until a stop takes the FUSE daemons down; the fstype must match the container's
      // because `isOverlayMounted` reads it while `findMount` reads the mount point.
      ...[...this.overlayMounts].map(
        (path) => `fuse-overlayfs ${path} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
      ),
      ...[...this.layerMounts].map(
        (path) => `${this.#layerSources.get(path) ?? 'squashfuse'} ${path} fuse.squashfuse ro,nosuid,nodev,relatime 0 0`,
      ),
    ];

    return `${lines.join('\n')}\n`;
  }

  /** Content-hashed, not metadata-hashed: this stand-in keeps no inodes or times, and a
   *  fingerprint moving without a byte change would commit where the box skips. The shipped
   *  caller fingerprints only the overlay upper. */
  #upperMark(): string {
    return createHash('sha256').update(this.synthesizeArchive('/var/tmp/devbox/upper')).digest('hex');
  }

  async exec(
    command: string,
    options?: { readonly cwd?: string },
  ): Promise<ExecResult> {
    return await this.#execIn(command, options);
  }

  /** A command in no session shell, as the image's program runs its own. */
  async #execIn(
    command: string,
    options?: { readonly cwd?: string },
  ): Promise<ExecResult> {
    const refused = shellSyntaxError(command);

    if (refused !== undefined) {
      this.sequence.push(`sessionKilled:${command.split(' ')[0]}`);
      throw refused;
    }

    const refusedChdir = this.#chdir(options?.cwd);

    if (refusedChdir !== null) return refusedChdir;
    this.#recordDirectories(command);
    this.execs.push(command);
    const marker = /^# (devbox-[\w-]+)\n/.exec(command)?.[1];
    // The scan and the marked programs get fixed names, not their first word: ordering assertions
    // read these rows and must not silently stop matching when a template's first word changes.
    this.sequence.push(command.includes('/proc/$pid/fd')
      ? 'exec:release-workdir-holders'
      : `exec:${marker ?? command.split(' ')[0]}`);
    const held = this.execGate;

    if (held !== undefined) {
      this.execGate = undefined;
      held.enter();
      await held.promise;
    }

    if (this.execDelayMs > 0) await scheduler.wait(this.execDelayMs);

    const answered = await this.#execBoxProgram(command);

    if (answered !== null) return answered;

    if (command.startsWith('sync')) {
      // `sync -f <dir> && sync; echo $?`: the fake holds no pages to flush, so it answers
      // with the success the real command reports.
      return { stdout: '0', stderr: '', exitCode: 0 };
    }

    if (command.startsWith('test -e')) {
      // The fake holds no filesystem, so `test -e` answers yes for any path a strategy asks about.
      return { stdout: 'yes', stderr: '', exitCode: 0 };
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

    // Lazy detach (`MNT_DETACH`) removes the mount even while something holds it.
    if (command.includes('fusermount -uz')) {
      this.sequence.push('exec:lazy-unmount');
      this.s3fsMounts.delete('/workspace');

      return { stdout: '', stderr: '', exitCode: 0 };
    }

    const release = this.#execHolderRelease(command);

    if (release !== null) return release;

    const chain = this.#execChainCommand(command);

    if (chain !== null) return chain;

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  /** The box's own programs and probes, answered from this container's state with the bytes bash
   *  writes; the session path hands them back as the container server does. Null for any other. */
  async #execBoxProgram(command: string): Promise<ExecResult | null> {
    if (command === 'cat /tmp/devbox-boot-id 2>/dev/null || true') return { stdout: this.bootId ?? '', stderr: '', exitCode: 0 };

    if (command.startsWith('# devbox-beat-v1\n')) {
      return { stdout: `${this.bootId ?? ''}\n${this.syncRunning ? 'alive' : ''}`, stderr: '', exitCode: 0 };
    }

    if (command === 'cat /proc/mounts') return { stdout: this.#procMounts(), stderr: '', exitCode: 0 };

    if (command.startsWith('# devbox-tick-probe-v2\n')) {
      return { stdout: `${this.#upperMark()}\n${this.#procMounts()}`, stderr: '', exitCode: 0 };
    }

    if (command.startsWith('# devbox-sync-flush-v1\n')) return await this.#flushSync(command);

    if (command.startsWith('# devbox-sync-start-v1\n') || command.startsWith('# devbox-sync-stop-v1\n')) {
      this.syncRunning = command.startsWith('# devbox-sync-start-v1\n');

      return { stdout: '', stderr: '', exitCode: 0 };
    }

    const counted = /^find '([^']*)' -mindepth 1 -maxdepth 1 \| wc -l$/.exec(command);

    if (counted === null) return null;
    // The fake's own listing: `this` is the box, whose `listFiles` is a caller's route and stamps the lease.
    const { count } = await FakeSandbox.prototype.listFiles.call(this, counted[1] ?? '');

    return { stdout: `${String(count)}\n`, stderr: '', exitCode: 0 };
  }

  /** The flush as the image's program takes it: the same chain checkpoint, run on this container's
   *  own shell, asking the box through `devboxSync` for what the container cannot reach (D30). */
  async #flushSync(command: string): Promise<ExecResult> {
    const flush = /DEVBOX_SYNC_CONFIG=(\S+) bun \S+ flush (\w+)/.exec(command);

    if (flush === null) return { stdout: '', stderr: `unparsed flush: ${command}`, exitCode: 2 };
    const host = this.syncHost;

    if (host === undefined) return { stdout: '', stderr: 'no box serves this container\'s sync', exitCode: 2 };
    const generation = async (): Promise<string | undefined> => await Promise.resolve(this.bootId);

    const transport = async (body: string): Promise<{ status: number; text: string }> => {
      // `.internal` resolves nowhere: without the box's binding the request never leaves the container.
      if (!this.outboundHosts.has(DEVBOX_SYNC_HOST)) throw new Error('Unable to connect. Is the computer able to access the url?');
      const answer = await host(body);

      return { status: answer.status, text: answer.body };
    };

    const worker = syncWorker(snapshotChainStorage(containerChainPorts(decodeSyncConfig(flush[1]), {
      exec: async (inner) => await this.#execIn(inner, { cwd: DEVBOX_RUNTIME_DIR }),
      call: syncCaller(transport, generation),
      generation,
      log: () => undefined,
    })));

    return { stdout: JSON.stringify(await worker.run(parseCheckpointKind(flush[2]))), stderr: '', exitCode: 0 };
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


    this.s3fsMounts.delete(mountPath);
  }


  async startProcess(
    command: string,
    options: { cwd?: string; processId?: string },
  ): Promise<FakeProcessRow> {
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

    if (fault !== undefined) throw fault.error;

    return row;
  }

  /** A write under the work directory also lands in the overlay upper, where an overlayfs
   *  write really goes and what the chain's delta archiver walks. */
  async writeFile(path: string, content: string): Promise<{ success: true; path: string; timestamp: string }> {
    const held = this.writeGate;

    if (held !== undefined) {
      this.writeGate = undefined;
      held.enter();
      await held.promise;
    }

    this.files.set(path, content);

    if (path.startsWith('/workspace/')) {
      this.files.set(`/var/tmp/devbox/upper/${path.slice('/workspace/'.length)}`, content);
    }

    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async deleteFile(path: string): Promise<void> {
    for (const key of this.files.keys()) if (key === path || key.startsWith(path + '/')) this.files.delete(key);

    for (const key of this.binaryFiles.keys()) if (key === path || key.startsWith(path + '/')) this.binaryFiles.delete(key);

    for (const key of this.directories) if (key === path || key.startsWith(path + '/')) this.directories.delete(key);
    this.stagedArchives.delete(path);
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
    const parts: Uint8Array[] = [encoded.encode(sourceDir.replace(/\/$/, '') + '\0')];

    for (const [entry, content] of entries) {
      parts.push(encoded.encode(`${entry}\0${String(content.length)}\0`), encoded.encode(content));
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

  getProcess(id: string): Promise<FakeProcessRow | null> {
    const fault = this.getFaults.shift();

    if (fault !== undefined) return Promise.reject(fault);

    const row = this.processes.get(id);

    return Promise.resolve(row ?? null);
  }

  killProcess(id: string): Promise<void> {
    this.kills.push(id);
    const fault = this.killFaults.shift();

    if (fault !== undefined) return Promise.reject(fault);
    this.processes.delete(id);

    return Promise.resolve();
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
    this.binaryFiles.clear();
    this.directories.clear();

    for (const path of IMAGE_DIRECTORIES) this.directories.add(path);
    this.bootId = undefined;
    this.stagedArchives.clear();
    this.processes.clear();
    this.overlayMounts.clear();
    this.layerMounts.clear();
    this.#layerSources.clear();
    this.s3fsMounts.clear();
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

    return;
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

  activityRenewals = 0;
  readonly shim = new NativeShim(this);
  /** Each `sandbox-shim` invocation's operation, as `s3-mount unmount`. */
  readonly shimCalls: string[] = [];
  owner: { alarm(): Promise<void>; onStop(): Promise<void> } | undefined;
  nativeExec: Container['exec'] | undefined;
  /** The model's start behind the platform's synchronous `start`; a failure surfaces at the next exec. */
  #opening: Promise<PromiseSettledResult<void>[]> | undefined;
  #pid = 10;
  #ended = Promise.withResolvers<void>();

  get scheduleRows(): { callback: string; time: number }[] {
    return [...this.ctx.storage.kv.list<number>({ prefix: 'devbox:schedule:' })]
      .map(([key, at]) => ({ callback: key.slice('devbox:schedule:'.length), time: at / 1000 }));
  }
  async seedSchedule(callback: string, time: number): Promise<void> {
    this.ctx.storage.kv.put("devbox:schedule:" + callback, time * 1000);
    await this.ctx.storage.setAlarm(Math.min(this.alarmAt ?? Infinity, time * 1000));
  }
  get alarmAt(): number | null { return alarmTimes.get(this.ctx.storage)?.at ?? null; }
  async alarm(): Promise<void> { await this.owner?.alarm(); }
  clearSchedules(callback?: string): void {
    for (const [key] of this.ctx.storage.kv.list({ prefix: "devbox:schedule:" })) {
      if (callback === undefined || key === "devbox:schedule:" + callback) this.ctx.storage.kv.delete(key);
    }
  }
  handle(): Container {
    const running = () => this.running.running;

    return {
      get running() { return running(); },
      get images() { return { devbox: HARNESS_IMAGE }; },
      start: options => {
        this.startOptions.push(options);

        // As the platform does without an image.
        if (options?.image === '') throw new TypeError('ctx.container.start(): image must not be empty');
        this.#ended = Promise.withResolvers<void>();
        this.#opening = Promise.allSettled([this.start(options)]);
      },
      monitor: () => this.#ended.promise,
      destroy: async () => { await this.destroy(); this.#ended.resolve(); },
      signal: () => { void this.stop().then(this.#ended.resolve, this.#ended.reject); },
      getTcpPort: port => ({
        fetch: async () => new Response('', { status: this.listening.has(port) ? 200 : 503 }),
        connect: () => unreached('port.connect'),
      }),
      setInactivityTimeout: async () => { this.activityRenewals++; },
      interceptOutboundHttp: async (host) => { this.outboundHosts.set(host, host); },
      interceptAllOutboundHttp: async () => { this.outboundHosts.set(DEVBOX_SYNC_HOST, DEVBOX_SYNC_HOST); },
      interceptOutboundHttps: async () => undefined,
      snapshotContainer: () => unreached('container.snapshotContainer'),
      inspect: () => unreached('container.inspect'),
      exec: (args, options) => this.#native(args, options),
    };
  }

  /** What the platform does before a native exec runs: the start it is behind, then the running check. */
  async #admitNative(options: ContainerExecOptions): Promise<void> {
    const [opened] = await this.#opening ?? [];

    this.#opening = undefined;

    if (opened?.status === 'rejected') throw opened.reason;
    const held = this.stateReadGate;

    if (held !== undefined) { this.stateReadGate = undefined; held.enter(); await held.promise; }

    if (!this.running.running) throw new Error('native exec cannot run in a stopped container');

    if (options.signal?.aborted) throw options.signal.reason;
  }

  async #native(args: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
    await this.#admitNative(options);

    if (this.nativeExec !== undefined && (args[0] === "bash" || args[3] === "kill-tree" || args[3] === "port-listeners")) return this.nativeExec(args, options);

    if (args[0] === '/usr/local/bin/sandbox-shim') {
      this.shimCalls.push(args.slice(1, 3).join(' '));

      return this.shim.exec(args);
    }

    const pid = this.#pid++;

    // The restore deadline's process ends only when it is killed: a test that needs the deadline to
    // fall hands the box a hand clock rather than waiting out a duration.
    if (args[0] === '/bin/sleep') {
      let release: () => void = () => undefined;
      const done = new Promise<ExecResult>(resolve => { release = () => resolve({ stdout: '', stderr: '', exitCode: 0 }); });

      return processResult(done, pid, () => { release(); });
    }

    if (args[0] === '/bin/true') {
      const hookGate = this.containerHookGate;

      if (hookGate !== undefined) { this.containerHookGate = undefined; hookGate.enter(); await hookGate.promise; }

      return processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }), pid);
    }

    if (PROCESS_SCRIPTS.has(args[3] ?? '')) return await this.#processScript(args, pid);

    const command = args[2] ?? '';

    return processResult(this.#execIn(command, { cwd: options.cwd }), pid);
  }

  /** The process scripts' file protocol: `launch` stands for the claim symlink and holds its target. */
  async #processScript(args: string[], pid: number): Promise<ExecProcess> {
    if (args[3] === 'devbox-process') {
      const dir = args[4] ?? '';
      const cwd = args[5] ?? '';
      const id = dir.split('/').at(-1) ?? '';
      const ran = processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }), pid);

      if (this.files.has(`${dir}/launch`)) return ran;

      if (!this.directories.has(cwd)) {
        this.files.set(`${dir}/launch`, 'launched');
        this.files.set(`${dir}/stderr.log`, `Failed to change directory to '${cwd}'\n`);
        this.files.set(`${dir}/exit`, '1');

        return ran;
      }

      let row: FakeProcessRow;

      try {
        row = await this.startProcess(args.at(-1) ?? '', { cwd, processId: id });
      } catch (error) {
        // An answer lost after the fork: the wrapper ran, so it holds the claim and wrote its pid.
        const created = this.processes.get(id);

        if (created !== undefined) this.#launched(dir, created.pid);
        throw error;
      }

      this.#launched(dir, row.pid);

      return processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }), row.pid);
    }

    if (args[3] === 'devbox-unlaunch') {
      const dir = args[4] ?? '';

      return processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: this.#unlaunched(dir) ? 0 : 1 }), pid);
    }

    if (args[3] === 'devbox-kill') {
      const dir = args[4] ?? '';
      const id = dir.split('/').at(-1) ?? '';
      const row = this.processes.get(id);

      if (this.files.has(`${dir}/process.json`) && !this.#unlaunched(dir) && !this.files.has(`${dir}/exit`)
        && (row?.status === 'running' || row?.status === 'starting')) await this.killProcess(id);

      return processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }), pid);
    }

    return this.#nativeProcessStatus(args.slice(4), pid);
  }

  #launched(dir: string, pid: number): void {
    this.files.set(`${dir}/launch`, 'launched');
    this.files.set(`${dir}/pid`, String(pid));
  }

  /** The claim `UNLAUNCH` makes: a launch with no pid, no exit and no claim is claimed for nobody. */
  #unlaunched(dir: string): boolean {
    if (!this.files.has(`${dir}/pid`) && !this.files.has(`${dir}/exit`) && !this.files.has(`${dir}/launch`)) {
      this.files.set(`${dir}/launch`, 'unlaunched');
    }

    return this.files.get(`${dir}/launch`) === 'unlaunched';
  }

  async #nativeProcessStatus(dirs: string[], pid: number): Promise<ExecProcess> {
    const lines: string[] = [];

    for (const dir of dirs) {
      const id = dir.split('/').at(-1) ?? '';
      const row = await this.getProcess(id);
      const record = this.files.get(`${dir}/process.json`);

      if (record === undefined) continue;
      const exited = this.files.get(`${dir}/exit`);
      let state = `exit ${row?.status === 'completed' ? 0 : 1}`;

      if (exited !== undefined) state = `exit ${exited}`;
      else if (this.files.get(`${dir}/launch`) === 'unlaunched') state = 'unlaunched';
      else if (!this.files.has(`${dir}/pid`)) state = 'starting';
      else if (row === null) state = 'lost';
      else if (row.status === 'running') state = `running ${row.pid}`;
      else if (row.status === 'starting') state = 'starting';
      lines.push(state, record);
    }

    return processResult(Promise.resolve({ stdout: lines.length ? lines.join('\n') + '\n' : '', stderr: '', exitCode: 0 }), pid);
  }

}

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


/** Derived from the class's constructor signature: the Workers types parameterise it,
 *  and a second spelling here would be a second opinion on the platform. */
type BoxState = ConstructorParameters<typeof Devbox>[0];

export interface BoxStateParts {
  readonly storage: DurableObjectStorage;
  readonly id: string;
  readonly container?: { running: boolean };
  readonly blockConcurrencyWhile: <T>(closure: () => Promise<T>) => Promise<T>;
  readonly sync?: (body: string) => Promise<SyncAnswer>;
}

/** The whole `DurableObjectState`: the SDK `Sandbox` constructor takes the full handle.
 *  Only the members the class reads are supplied; every other one refuses by name. */
export function boxState(parts: BoxStateParts): BoxState {
  return {
    id: { toString: () => parts.id, equals: () => unreached('state.id.equals') },
    storage: parts.storage,
    container: parts.container === undefined ? undefined : containerHandle(parts.container),
    blockConcurrencyWhile: parts.blockConcurrencyWhile,
    exports: {
      DevboxStoreGateway: () => ({ fetch: async () => unreached('store gateway network'), connect: () => unreached('store gateway TCP') }),
      DevboxOutbound: () => ({ fetch: async () => unreached('outbound network'), connect: () => unreached('outbound TCP') }),
      DevboxSyncGateway: () => ({
        fetch: async (input: RequestInfo | URL) => {
          if (parts.sync === undefined) return unreached('unbound sync host');
          const request = input instanceof Request ? input : new Request(input.toString());
          const reply = await parts.sync(await request.text());

          return new Response(reply.body, { status: reply.status });
        },
        connect: () => unreached('sync host TCP'),
      }),
    },
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

/** Only `running` and, when a test supplies it, `exec` are live; the rest refuse because the class reaches the
 *  control plane through the SDK, never through `ctx.container`. */
export function containerHandle(flag: { running: boolean }, exec?: Container['exec']): Container {
  return {
    get running(): boolean { return flag.running; },
    get images() { return {}; },
    start: () => unreached('container.start'),
    monitor: () => unreached('container.monitor'),
    destroy: () => unreached('container.destroy'),
    signal: () => unreached('container.signal'),
    getTcpPort: () => unreached('container.getTcpPort'),
    setInactivityTimeout: () => unreached('container.setInactivityTimeout'),
    interceptOutboundHttp: () => unreached('container.interceptOutboundHttp'),
    interceptAllOutboundHttp: () => unreached('container.interceptAllOutboundHttp'),
    interceptOutboundHttps: () => unreached('container.interceptOutboundHttps'),
    inspect: () => unreached('container.inspect'),
    snapshotContainer: () => unreached('container.snapshotContainer'),
    exec: exec ?? (() => unreached('container.exec')),
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
  /** What the platform hands a new instance of the object after an eviction: same storage, same container. */
  readonly state: BoxState;
}

/** `id` defaults to `TEST_BOX_ID`; pass `deriveBoxId` output to model production identity.
 *  Starts stopped; a running-but-unsettled fixture is refused by readiness until the hook runs. */
/** The box side of the container's sync: its outbound handler's target (D30). */
interface SyncServing {
  devboxSync(body: string): Promise<SyncAnswer>;
  alarm(): Promise<void>;
  onStop(): Promise<void>;
}

export function harness<Box extends SyncServing>(
  Box: new (state: BoxState, env: TestEnv) => Box,
  id: string = TEST_BOX_ID,
  exec?: Container['exec'],
): Harness<Box> {
  const storage = fakeStorage();

  const state = boxState({
    storage: storage.handle, id,
    sync: body => container.syncHost === undefined ? Promise.reject(new Error('unbound sync')) : container.syncHost(body),
    blockConcurrencyWhile: <T>(closure: () => Promise<T>): Promise<T> => {
      const previous = container.initGate;
      const completed = Promise.withResolvers<void>();
      const held = previous === undefined ? completed.promise : Promise.all([previous, completed.promise]).then(() => undefined);
      container.initGate = held;
      const clear = () => { if (container.initGate === held) container.initGate = undefined; };

      void held.then(clear, clear);

      return closure().finally(completed.resolve);
    },
  });

  const container = new FakeSandbox(state);
  container.running.running = false;
  state.container = container.handle();
  container.nativeExec = exec;
  const box = new Box(state, {});
  container.owner = box;
  container.syncHost = body => box.devboxSync(body);

  return { box, container, rows: storage.rows, storage, state };
}

/** Holds the operation until the init gate opens: no event reaches a Durable Object inside
 *  `blockConcurrencyWhile`, so an earlier call tests an interleaving that cannot happen. */
export async function deliver<T>(container: FakeSandbox, work: () => Promise<T>): Promise<T> {
  await container.initGate;

  return await work();
}

/** The platform's side of the alarm: it fires the object's one alarm once due, until the SDK deletes
 *  it or `passes` passes ran. `advance` moves the test's clock to the alarm; returns the passes run. */
export async function wakeWhileArmed(container: FakeSandbox, advance: (to: number) => void, passes: number): Promise<number> {
  let ran = 0;

  while (ran < passes && container.alarmAt !== null) {
    advance(container.alarmAt);
    await container.alarm();
    ran += 1;
  }

  return ran;
}
