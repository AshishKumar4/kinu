// The one place `@cloudflare/sandbox` is substituted, and the platform stand-in
// every Devbox class test runs on.
//
// WHY THE PLATFORM IS SUBSTITUTED AT ALL. The defects these tests exist for are
// about ORDER and OWNERSHIP: which of a durable row and a container process
// happens first, which of two overlapping startup attempts may write, whether a
// port may be exposed after its listener said nothing, and what a box does the
// second time one container identity fails. No pure decision can carry any of
// that — those live in `decisions.test.ts` — so the only way to pin them is to
// run the shipped methods. The class is a Durable Object and reaches its
// container by EXTENDING `Sandbox`, which the platform requires and which
// leaves no argument to inject; the module also imports `cloudflare:workers`,
// which exists in no runtime but a Worker's. So this module replaces that ONE
// SDK module and nothing else. That is the SDK boundary — the seam
// `anti-slop/no-module-mocking` exists to push tests towards rather than away
// from — and what stands behind it is a faithful container, not an expectation
// recorder: it holds processes, answers listener probes, exposes ports, and
// fails when a test says it fails.
//
// WHY IT IS SHARED. `mock.module` is process-wide, and `bun test` runs a
// package's files in one process. Two test files each registering their own
// stand-in for this module means the last one registered answers for both, and
// the other file's fake never runs its constructor. One substitution, one fake,
// imported by every file that needs the class.
import { mock } from 'bun:test';

import type { StoredValue } from '../../src/storage';
import { sessionShellRefusal } from './session-shell';

/**
 * A failure as `@cloudflare/sandbox` really presents one.
 *
 * Every error it raises is a `SandboxError` subclass carrying ONE `ErrorCode`:
 * `PROCESS_NOT_FOUND` for an id the container answered about and does not hold,
 * `NO_SPACE` for a filesystem that filled, `UNKNOWN_ERROR` for a container
 * failure it could not classify. The code is a GETTER on the class, not an own
 * property, and neither the base class nor its subclasses are exported — so a
 * stand-in that carried the code as a plain field would pass a check the
 * shipped SDK fails. This is the shape.
 */
export class SandboxFailure extends Error {
  constructor(readonly errorResponse: { readonly code: string; readonly message: string }) {
    super(errorResponse.message);
    this.name = 'SandboxError';
  }

  get code(): string {
    return this.errorResponse.code;
  }
}

/**
 * A parked call.
 *
 * `reached` is the half that makes an interleaving test deterministic: pinning
 * two overlapping attempts means acting at the exact moment one of them is
 * inside a given await, and counting microtasks to guess when that is would be
 * a race dressed up as a test. The fake resolves `reached` on entry and then
 * waits on `promise`.
 */
export interface Gate {
  /** Resolves when the call under the gate has been entered. */
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

/** What the container holds for one process. The SDK's own status vocabulary;
 *  `isProcessLive` in the class under test reads it. */
export interface FakeProcessRow {
  readonly id: string;
  readonly pid: number;
  readonly status: string;
  readonly command: string;
}

export interface StartRecord {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly processId: string | undefined;
}

/** A `startProcess` that throws, and whether the container created the process
 *  before it did. Both happen: a refused start creates nothing, and a
 *  disconnect after the fork creates everything and returns nothing. The second
 *  is the window the durable reservation exists for. */
export interface StartFault {
  readonly error: Error;
  readonly created: boolean;
}

/** A request made through one of the SDK's distinct file relocation methods. */
export interface FileOperation {
  readonly operation: 'rename' | 'move';
  readonly from: string;
  readonly to: string;
  readonly sessionId: string | undefined;
}


export interface FakeStorage {
  readonly rows: Map<string, StoredValue>;
  readonly handle: DurableObjectStorage;
  /** Park the NEXT read of one key. Two awaits matter: the ladder row's read
   *  before a decision, and its read inside the conditional write. Parking
   *  either is how an interleaving is pinned rather than guessed — it is the
   *  half of the ownership defect the container calls cannot reach, because the
   *  fence stops a stale attempt before it ever calls one. */
  gateOn(key: string, held: Gate): void;
  /**
   * Fail the NEXT write of one key.
   *
   * The vehicle for a failure of the ATTEMPT rather than of a restoration step.
   * An ephemeral box's `attach()` cannot fail — it has nowhere to attach from —
   * so the nearest honest stand-in is the attempt's first durable write, which
   * propagates exactly as a real attach failure does: past the recovery ladder,
   * not into the incompleteness reason. Every step AFTER the attach reports
   * instead of throwing, which is why a container fault is no longer usable for
   * this.
   */
  faultOn(key: string, error: Error): void;
}

/**
 * The Durable Object's own storage, and the rows a test reads back.
 *
 * A Map behind the four operations the class uses, each with the contract the
 * runtime documents: `get` resolves undefined for a key that is not there,
 * `delete` answers whether a row existed, `list` answers the prefix range.
 */
export function fakeStorage(): FakeStorage {
  const rows = new Map<string, StoredValue>();
  const gates: Record<string, Gate | undefined> = {};
  const faults: Record<string, Error | undefined> = {};
  // SAFETY: `DurableObjectStorage` declares the platform's whole storage API,
  // of which the methods under test reach exactly these four; the rest is
  // alarms, transactions and SQL, which no line of the class can call. Each
  // operation here returns what the runtime contract says it returns.
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
      const fault = faults[key];
      if (fault !== undefined) {
        faults[key] = undefined;
        return Promise.reject(fault);
      }
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<boolean> => Promise.resolve(rows.delete(key)),
    list: (options: { prefix: string }): Promise<Map<string, StoredValue>> => Promise.resolve(
      new Map([...rows].filter(([key]) => key.startsWith(options.prefix))),
    ),
  } as DurableObjectStorage;
  return {
    rows,
    handle,
    gateOn: (key, held) => { gates[key] = held; },
    faultOn: (key, error) => { faults[key] = error; },
  };
}

/** The one command the boot-id stamp issues, and the last write a restoration
 *  makes. Faulting or gating it fails or parks an attempt at its final await. */
export const STAMP_COMMAND = 'printf %s';

/**
 * The container, as the SDK presents it.
 *
 * Every fault is a QUEUE and every gate is one-shot, because these defects only
 * exist across two calls: a fake that could not express one attempt differing
 * from the next could not express them at all.
 */
export class FakeSandbox {
  /** The instance the last `new Devbox(…)` built. The class extends this one,
   *  so the box IS its container, and this is how a test reaches it without
   *  re-describing the box as something it is not. */
  static last: FakeSandbox | undefined;

  /** The platform's container handle, and the object the Durable Object state
   *  hands the class as `ctx.container`. One object, so a test that stops the
   *  container and the class that reads `running` cannot disagree. */
  readonly running = { running: true };
  defaultPort = 3000;
  readonly processes = new Map<string, FakeProcessRow>();
  readonly starts: StartRecord[] = [];
  readonly kills: string[] = [];
  readonly execs: string[] = [];
  readonly exposures: { port: number; token: string | undefined; name: string | undefined }[] = [];
  readonly schedules: string[] = [];
  readonly scheduleRows: { readonly callback: string; readonly time: number }[] = [];
  /** Ports a probe finds a listener on. A port absent from here answers the way
   *  a refused connection does, which is what the shipped probe reads. */
  readonly listening = new Set<number>();
  readonly fileOperations: FileOperation[] = [];
  /** Every bucket mount/unmount the box asked the SDK for, as
   * `mount:<path>` / `unmount:<path>` rows. A quiesce's stop order is a
   * property of THIS sequence, so the fake records it the way `execs` records
   * commands. */
  readonly mountCalls: string[] = [];
  /** Every mount operation and every exec, in ONE chronological sequence, as
   *  `mount:<path>`, `unmount:<path>` and `exec:<first word>`. The stop order
   *  is a property of the order ACROSS these two channels, so it is recorded
   *  here rather than reconstructed from two separate lists. */
  readonly sequence: string[] = [];
  /** Paths the box's own `mountBucket` holds mounted, which is what
   *  `/proc/mounts` reports for them. */
  readonly s3fsMounts = new Set<string>();
  /** While a holder is present an unmount answers with the EBUSY refusal a
   *  real fusermount gives for a mount with open files. Cleared by the
   *  holder-release command the way the real stop clears it by killing the
   *  holder — unless the holder is marked `survives`, which is the shape a
   *  still-busy unmount has to name rather than hide, or `session`, which is
   *  the container's own exec channel: the scan NAMES that one and declines to
   *  signal it, because killing an ancestor of the shell running the scan ends
   *  the session the stop is speaking through. */
  workdirHolder: {
    readonly pid: number;
    readonly comm: string;
    readonly survives?: boolean;
    readonly session?: boolean;
  } | undefined;
  readonly fileOperationFailures = {
    rename: Array<Error>(),
    move: Array<Error>(),
  } satisfies Record<FileOperation['operation'], Error[]>;
  readonly startFaults: StartFault[] = [];
  startFaultBeforeRunning: Error | undefined;
  startFaultAfterRunning: Error | undefined;
  providerStatus: 'running' | 'healthy' | 'stopped' | 'stopping' = 'healthy';
  readonly getFaults: Error[] = [];
  readonly killFaults: Error[] = [];
  readonly stampFaults: (Error | undefined)[] = [];
  startGate: Gate | undefined;
  /** Parks the container's own admission probe — `start()`, which every attempt
   *  awaits before it captures a generation. `startGate` is the process start;
   *  these are two different calls and two different windows. */
  containerStartGate: Gate | undefined;
  execGate: Gate | undefined;
  stampGate: Gate | undefined;
  exposeGate: Gate | undefined;
  destroyFault: Error | undefined;
  destroys = 0;
  bootId: string | undefined;
  containerStarts = 0;
  readonly startWaitOptions: unknown[] = [];

  constructor(readonly ctx: DurableObjectState) {
    FakeSandbox.last = this;
  }

  onStart(): Promise<void> {
    return Promise.resolve();
  }
  /**
   * One command, answered as the container's PERSISTENT session shell answers
   * it.
   *
   * THE PARSE COMES FIRST, and it is a real one — see `session-shell.ts`. This
   * fake used to accept any string and answer it by prefix, so a command
   * template that no shell would run was green here and dead on the
   * deployment: `releaseWorkdirHoldersCommand` reached run
   * `e2e20260901140445` with no separator before its `done`, and every arm's
   * stop came back as `Session 'sandbox-default' shell exited (exit code: 2)`.
   * A fake that answers what a shell refuses cannot hold that class of defect.
   */
  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const refused = sessionShellRefusal(command);
    if (refused !== undefined) {
      this.sequence.push(`sessionKilled:${command.split(' ')[0]}`);
      throw refused;
    }
    this.execs.push(command);
    // The scan gets a NAME rather than its first word, because the ordering
    // assertions read this row and a template whose first word changes must not
    // silently stop matching them.
    this.sequence.push(command.includes('/proc/$pid/fd')
      ? 'exec:release-workdir-holders'
      : `exec:${command.split(' ')[0]}`);
    const held = this.execGate;
    if (held !== undefined) {
      this.execGate = undefined;
      held.enter();
      await held.promise;
    }
    if (command === 'cat /tmp/devbox-boot-id 2>/dev/null || true') {
      return { stdout: this.bootId ?? '', stderr: '', exitCode: 0 };
    }
    if (command === 'cat /proc/mounts') {
      // The work directory reads as an s3fs mount exactly while the box's own
      // mountBucket has it mounted — the same fact `/proc/mounts` reports in
      // a real container, so a strategy's read-back observes the world the
      // fake changed rather than a world the test staged.
      const lines = [
        'proc /proc proc rw,relatime 0 0',
        ...(this.s3fsMounts.has('/workspace')
          ? [`s3fs /workspace fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0`]
          : []),
      ];
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    if (command.startsWith('sync')) {
      // `sync -f <dir> && sync; echo $?`: the flush this fake has no pages for,
      // answered with the success the real command reports.
      return { stdout: '0', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('test -e')) {
      // `#pathExists` asks `test -e '<path>' && echo yes || echo no`; the fake
      // holds no filesystem, so the answer is yes for any path a strategy
      // asked about — the cache directory the r2fs attach read-back wants is
      // the one `mountBucket` created beside its mount.
      return { stdout: 'yes', stderr: '', exitCode: 0 };
    }
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
    // THE HOLDER-RELEASE COMMAND, answered the way the real container answers
    // it: the holders are named on stdout, and the signal work happens inside
    // the same command. The fake's `workdirHolder` IS its process table, so
    // clearing it is what the real command's SIGTERM achieves; a holder marked
    // `survives` is one the TERM and the KILL both failed on, and one marked
    // `session` is an ancestor of the scan's own shell, which the command
    // reports and never signals. Both leave the mount busy, which is the shape
    // a still-busy unmount has to name rather than hide.
    //
    // MATCHED ON THE SCAN ITSELF, not on the command's first word: the first
    // word changed the moment the command grew its ancestor walk, and a fake
    // keyed on it answered the empty string to a command it no longer
    // recognised — a silent, wrong answer to a real command.
    if (command.includes('/proc/$pid/fd')) {
      const holder = this.workdirHolder;
      if (holder === undefined) return { stdout: 'none', stderr: '', exitCode: 0 };
      const named = `${String(holder.pid)}:${holder.comm}`;
      if (holder.session === true) {
        return { stdout: named, stderr: `not signalled, this session's own: ${named}`, exitCode: 0 };
      }
      if (!holder.survives) this.workdirHolder = undefined;
      return { stdout: named, stderr: named, exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async mountBucket(_binding: string, mountPath: string): Promise<void> {
    this.mountCalls.push(`mount:${mountPath}`);
    this.sequence.push(`mount:${mountPath}`);
    this.s3fsMounts.add(mountPath);
  }

  async unmountBucket(mountPath: string): Promise<void> {
    this.mountCalls.push(`unmount:${mountPath}`);
    this.sequence.push(`unmount:${mountPath}`);
    if (this.workdirHolder !== undefined && mountPath === '/workspace') {
      // The holder is still alive, so the mount is still busy: the refusal a
      // real fusermount gives, before any state changes hands.
      throw new Error(`fusermount: failed to unmount ${mountPath}: Device or resource busy`);
    }
    this.s3fsMounts.delete(mountPath);
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

  getProcess(id: string): Promise<FakeProcessRow | null> {
    const fault = this.getFaults.shift();
    if (fault !== undefined) return Promise.reject(fault);
    return Promise.resolve(this.processes.get(id) ?? null);
  }

  listProcesses(): Promise<readonly FakeProcessRow[]> {
    return Promise.resolve([...this.processes.values()]);
  }

  killProcess(id: string): Promise<void> {
    this.kills.push(id);
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
    return Promise.resolve();
  }
  async containerFetch(): Promise<Response> {
    return new Response();
  }

  /** The SDK runs the class's own start hook as part of starting a container.
   *
   *  ASKING A RUNNING CONTAINER TO START IS A HEALTH PROBE, not a second
   *  instance: the SDK returns once the container is up and its port answers, so
   *  a caller that always asks — which is how a restoration proves the instance
   *  it is about to run commands on — must not read as a container start. The
   *  ask is still recorded in `startWaitOptions`, and an injected fault still
   *  fires, because "the probe was made" and "the probe failed" are both facts a
   *  test needs. */
  async start(...args: unknown[]): Promise<void> {
    this.startWaitOptions.push(args[1]);
    // The ADMISSION await, which a startup attempt sits inside before it owns
    // anything. Parking here is the only way to pin what a superseded admission
    // is allowed to do: nothing above it is durable yet, so the interleave
    // cannot be reached from any other seam.
    const admitting = this.containerStartGate;
    if (admitting !== undefined) {
      this.containerStartGate = undefined;
      admitting.enter();
      await admitting.promise;
    }
    const beforeRunning = this.startFaultBeforeRunning;
    this.startFaultBeforeRunning = undefined;
    if (beforeRunning !== undefined) throw beforeRunning;
    const wasRunning = this.running.running;
    this.running.running = true;
    if (!wasRunning) {
      this.containerStarts += 1;
      await this.onStart();
    }
    const fault = this.startFaultAfterRunning;
    this.startFaultAfterRunning = undefined;
    if (fault !== undefined) throw fault;
  }

  async startAndWaitForPorts(): Promise<void> {
    await this.start();
  }

  stops = 0;

  stop(): Promise<void> {
    this.stops += 1;
    this.running.running = false;
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

/** A real empty async iterator, not a generator with a dummy yield. The lifecycle
 *  harness never opens a staged archive, but Devbox imports the SDK decoder now;
 *  this keeps the mocked SDK's contract faithful while leaving stream decoding to
 *  the SDK boundary tests that own it. */
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

// `scheduler.wait` is a Workers global, and two shipped loops await it: the gap
// between listener probes and the wait for the provider's own stop transition.
// A REAL timer on purpose, and the only one in these tests: both loops are the
// behaviour under test — that the probe keeps asking, and that a stop is proved
// rather than assumed — so replacing the clock would replace the property. The
// waits are single-digit milliseconds under a test policy, and every assertion
// is on a loop's outcome, never on elapsed time.
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

// Dynamic on purpose, and the only way this module can work: the substitution
// above has to be registered BEFORE the class's own module graph resolves
// `@cloudflare/sandbox`, and a static import is hoisted above it.
export const { Devbox } = await import('../../src/devbox');

/** The platform handle the class is constructed with. Named from the class's
 *  own signature rather than restated: the Workers types parameterise it, and a
 *  second spelling here would be a second opinion on the platform. */
type BoxState = ConstructorParameters<typeof Devbox>[0];

/** The env a test box is constructed with: no bindings at all, which is what an
 *  ephemeral box — no store, nothing durable — really has. Named rather than
 *  `unknown`, because a boundary that admits anything admits an unparsed value
 *  too. */
type TestEnv = Record<string, never>;

/** One box, its container and its durable rows. */
export interface Harness<Box> {
  readonly box: Box;
  readonly container: FakeSandbox;
  readonly rows: Map<string, StoredValue>;
  readonly storage: FakeStorage;
}

/**
 * One box on a fresh container and fresh durable rows.
 *
 * `container.running` starts true, so the readiness gate drives the restoration
 * rather than starting a container: an ephemeral box — no store — attaches
 * nothing, which is a real state and the one that keeps these tests about the
 * lifecycle rather than about a strategy.
 */
export function harness<Box>(
  Box: new (state: BoxState, env: TestEnv) => Box,
): Harness<Box> {
  const storage = fakeStorage();
  // SAFETY: `DurableObjectState` declares the platform handle a Durable Object
  // is constructed with. The class under test reads `storage`, `container` and
  // `id` from it and nothing else — the remaining members are WebSocket
  // hibernation, facets and `blockConcurrencyWhile`, which no method under test
  // reaches — and all three are provided here.
  const state = {
    storage: storage.handle,
    id: { toString: () => 'devbox-under-test' },
    // The platform's critical section, as a stand-in that deliberately does NOT
    // provide the exclusion the real one does: the closure simply runs. That is
    // what lets a test park inside the section and prove the conditional write
    // refuses when the row changed under it. A stand-in that granted exclusion
    // would make the interleaving untestable and the assertion vacuous.
    blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => await closure(),
  } as BoxState;
  const box = new Box(state, {});
  const container = FakeSandbox.last;
  if (container === undefined) {
    throw new Error('the substituted Sandbox base class did not run its constructor');
  }
  // Defined after construction because the class reads `ctx.container` only at
  // call time, and the fake owns the handle it flips on stop and destroy.
  Object.defineProperty(state, 'container', { value: container.running, configurable: true });
  return { box, container, rows: storage.rows, storage };
}
