// Native platform boundary. Real Files/S3Mount clients execute against the shim model.
import { NativeShim } from './native-shim';
import { processResult } from './native-process';
import { Devbox } from '../../src/devbox';

export { Devbox };

import { createHash } from 'node:crypto';

import type { StoredValue } from '../../src/storage';
import { TOOLS_STAMP } from '../../src/tools';
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
  /** Answers a port's fetch in place of the probe status, e.g. with an upgrade. */
  portAnswer: ((port: number, request: Request) => Response) | undefined;
  readonly fileOperations: FileOperation[] = [];
  readonly mountCalls: string[] = [];
  /** Mounts and execs share one chronological list: stop order is a property of the order
   *  across both channels and cannot be reconstructed from two separate lists. */
  readonly sequence: string[] = [];
  /** Stands in for what `/proc/mounts` reports for paths the box's `mountBucket` holds mounted. */
  readonly s3fsMounts = new Set<string>();
  /** Hosts the box bound to a named outbound handler (`setOutboundByHost`). */
  readonly outboundHosts = new Map<string, string>();
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
  /** Each snapshot the platform holds, and how a start from it behaves: `hang` never admits a command. */
  readonly snapshots = new Map<string, 'ok' | 'hang'>();
  /** Every signal a native exec was given: the platform may act on one long after the exec settled. */
  readonly execSignals: AbortSignal[] = [];
  /** Ids never repeat, as the platform's do not: a deleted snapshot's id is not handed out again. */
  #snapshotsTaken = 0;
  /** What each snapshot holds: the container's disk as it was when it was taken. */
  readonly #snapshotDisks = new Map<string, { readonly files: Map<string, string>; readonly binaryFiles: Map<string, Uint8Array>; readonly directories: Set<string> }>();
  /** A snapshot taken elsewhere (the golden), holding `files`. */
  addSnapshot(id: string, files: ReadonlyMap<string, string>): void {
    this.snapshots.set(id, 'ok');
    this.#snapshotDisks.set(id, { files: new Map(files), binaryFiles: new Map(), directories: new Set() });
  }

  /** Thrown by the next `snapshotContainer`, as a refused snapshot is. */
  snapshotFault: Error | undefined;
  readonly files = new Map<string, string>();
  /** Files whose bytes are not UTF-8 text, which `files` cannot hold; the SDK's file reads serve them as bytes. */
  readonly binaryFiles = new Map<string, Uint8Array>();
  readonly fileFaults = new Map<string, { readonly errno: number; readonly message: string }>();
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

  /** Lists every path the box's `mountBucket` holds, as `/proc/mounts` does in a container,
   *  so a strategy's read-back observes the fake's changes, not test-staged state. */
  #procMounts(): string {
    const lines = [
      'proc /proc proc rw,relatime 0 0',
      ...[...this.s3fsMounts].map(
        (path) => `s3fs ${path} fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0`,
      ),
    ];

    return `${lines.join('\n')}\n`;
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
    this.sequence.push(`exec:${marker ?? command.split(' ')[0]}`);
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

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  /** The box's own programs and probes, answered from this container's state with the bytes bash
   *  writes; the session path hands them back as the container server does. Null for any other. */
  async #execBoxProgram(command: string): Promise<ExecResult | null> {
    if (command === 'cat /tmp/devbox-boot-id 2>/dev/null || true') return { stdout: this.bootId ?? '', stderr: '', exitCode: 0 };

    if (command === 'cat /proc/mounts') return { stdout: this.#procMounts(), stderr: '', exitCode: 0 };

    if (command.startsWith(`cat ${TOOLS_STAMP}`)) return { stdout: this.files.get(TOOLS_STAMP) ?? '', stderr: '', exitCode: 0 };

    // The tools install: the archive must have arrived, and the stamp names what it installed.
    if (command.includes(`> ${TOOLS_STAMP}`)) {
      this.sequence.push('exec:tools-install');
      const archive = /tar -C \/ -xzf '([^']+)'/.exec(command)?.[1] ?? '';

      if (!this.binaryFiles.has(archive)) return { stdout: 'no archive', stderr: '', exitCode: 2 };
      this.files.set(TOOLS_STAMP, /printf %s '([^']+)' > /.exec(command)?.[1] ?? '');

      return { stdout: 'installMs=1 changed=1', stderr: '', exitCode: 0 };
    }

    const probed = /^mountpoint -q (\S+)$/.exec(command)?.[1];

    if (probed !== undefined) return { stdout: '', stderr: '', exitCode: this.s3fsMounts.has(probed) ? 0 : 1 };

    const counted = /^find '([^']*)' -mindepth 1 -maxdepth 1 \| wc -l$/.exec(command);

    if (counted === null) return null;
    // The fake's own listing: `this` is the box, whose `listFiles` is a caller's route and stamps the lease.
    const { count } = await FakeSandbox.prototype.listFiles.call(this, counted[1] ?? '');

    return { stdout: `${String(count)}\n`, stderr: '', exitCode: 0 };
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
    this.processes.clear();
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
        this.#opening = Promise.allSettled([this.#open(options)]);
      },
      monitor: () => this.#ended.promise,
      destroy: async () => { await this.destroy(); this.#ended.resolve(); },
      signal: () => { void this.stop().then(this.#ended.resolve, this.#ended.reject); },
      getTcpPort: port => ({
        fetch: async (request: Request) => this.portAnswer?.(port, request) ?? new Response('', { status: this.listening.has(port) ? 200 : 503 }),
        connect: () => unreached('port.connect'),
      }),
      setInactivityTimeout: async () => { this.activityRenewals++; },
      interceptOutboundHttp: async (host) => { this.outboundHosts.set(host, host); },
      interceptAllOutboundHttp: async () => undefined,
      interceptOutboundHttps: async () => { this.sequence.push('intercept:https'); },
      snapshotContainer: async (options) => {
        const fault = this.snapshotFault;
        this.snapshotFault = undefined;

        if (fault !== undefined) throw fault;
        this.#snapshotsTaken += 1;
        const id = `snapshot-${String(this.#snapshotsTaken)}`;
        this.snapshots.set(id, 'ok');
        this.#snapshotDisks.set(id, { files: new Map(this.files), binaryFiles: new Map(this.binaryFiles), directories: new Set(this.directories) });

        return { id, size: 1, name: options?.name };
      },
      inspect: () => unreached('container.inspect'),
      exec: (args, options) => this.#native(args, options),
    };
  }

  /** A start from a snapshot the platform no longer holds fails; one marked `hang` never comes up. */
  #open(options: ContainerStartupOptions | undefined): Promise<void> {
    const snapshot = options?.containerSnapshot?.id;

    if (snapshot === undefined) return this.start(options);
    const behaviour = this.snapshots.get(snapshot);

    if (behaviour === 'hang') return new Promise<void>(() => undefined);

    if (behaviour === undefined) return Promise.reject(new Error(`snapshot ${snapshot} not found`));

    return this.start(options).then(() => {
      const disk = this.#snapshotDisks.get(snapshot);

      for (const [path, content] of disk?.files ?? []) this.files.set(path, content);

      for (const [path, bytes] of disk?.binaryFiles ?? []) this.binaryFiles.set(path, bytes);

      for (const path of disk?.directories ?? []) this.directories.add(path);
    });
  }

  /** What the platform does before a native exec runs: the start it is behind, then the running check. */
  async #admitNative(options: ContainerExecOptions): Promise<void> {
    const signal = options.signal;
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true }));
    const [opened] = await Promise.race([this.#opening ?? Promise.resolve([]), aborted]);

    this.#opening = undefined;

    if (opened?.status === 'rejected') throw opened.reason;
    const held = this.stateReadGate;

    if (held !== undefined) { this.stateReadGate = undefined; held.enter(); await held.promise; }

    if (!this.running.running) throw new Error('native exec cannot run in a stopped container');

    if (options.signal?.aborted) throw options.signal.reason;
  }

  async #native(args: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
    if (options.signal !== undefined) this.execSignals.push(options.signal);
    await this.#admitNative(options);

    if (this.nativeExec !== undefined && (args[0] === "bash" || args[3] === "kill-tree" || args[3] === "port-listeners")) return this.nativeExec(args, options);

    // `cat > <path>` fed on stdin: the bytes land in the file once the writer closes.
    if (options.stdin === 'pipe' && args[0] === '/bin/sh') {
      const target = /^cat > '([^']+)'$/.exec(args[2] ?? '')?.[1] ?? '';
      const chunks: Uint8Array[] = [];
      const closed = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();

      const stdin = new WritableStream<Uint8Array>({
        write: (chunk) => { chunks.push(chunk); },
        close: () => { this.binaryFiles.set(target, Buffer.concat(chunks)); closed.resolve({ stdout: '', stderr: '', exitCode: 0 }); },
      });

      this.sequence.push(`exec:stdin ${target}`);

      return { ...processResult(closed.promise, this.#pid++), stdin };
    }

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

    if (args[3] === 'devbox-trust') {
      this.sequence.push('trust');

      return processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }), pid);
    }

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
/** What the fake platform calls on the object it built. */
interface PlatformServed {
  alarm(): Promise<void>;
  onStop(): Promise<void>;
}

export function harness<Box extends PlatformServed>(
  Box: new (state: BoxState, env: TestEnv) => Box,
  id: string = TEST_BOX_ID,
  exec?: Container['exec'],
): Harness<Box> {
  const storage = fakeStorage();

  const state = boxState({
    storage: storage.handle, id,
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
