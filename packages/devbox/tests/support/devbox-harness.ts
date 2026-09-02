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

import { describeThrown } from '../../src/lifecycle';
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
 *  `isProcessLive` in the class under test reads it, and `waitForRunnerExit`
 *  reads the exit code a settled row carries. */
export interface FakeProcessRow {
  readonly id: string;
  readonly pid: number;
  readonly status: string;
  readonly command: string;
  readonly exitCode?: number;
}

/** The row as the SDK hands it back from a start or a lookup: with its own
 *  `getLogs`, which the box reads when a runner exits non-zero. */
export type LiveProcess = FakeProcessRow & {
  getLogs(): Promise<{ stdout: string; stderr: string }>;
};

/**
 * One candidate runner start, as the container sees it: the argv the box
 * composed, split back into words. `action` and `resultPath` are the two the
 * fake itself has to read; a runner reads the rest with {@link runnerOption}.
 */
export interface RunnerInvocation {
  readonly action: string;
  readonly resultPath: string | undefined;
  readonly argv: readonly string[];
}

/** The value after `--<name>` in a runner argv, or undefined when absent. */
export function runnerOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

/** The words of a command the box composed from single-quoted parts: `'word'`
 *  with `'\''` for a literal quote, which is the only quoting `runnerCommand`
 *  and the journal daemon's argv produce. */
function quotedWords(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/'((?:[^']|'\\'')*)'/g)) {
    words.push((match[1] ?? '').replaceAll("'\\''", "'"));
  }
  return words;
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


/**
 * The container SDK's own schedule table, which lives in the Durable Object's
 * SQLite (`@cloudflare/containers`, `container.js:389-399`).
 *
 * ONE TABLE, TWO READERS, and that is why it is not a field on either fake: the
 * SDK writes it through `schedule()` and reads it through `listSchedules()`,
 * while the class under test sweeps it through `ctx.storage.sql` and deletes
 * through the SDK's `deleteSchedules`. Two copies could disagree about a row,
 * which is precisely the defect the sweep exists for.
 */
const scheduleTables = new WeakMap<DurableObjectStorage, { callback: string; time: number }[]>();

export function scheduleTableOf(
  storage: DurableObjectStorage,
): { callback: string; time: number }[] {
  const held = scheduleTables.get(storage);
  if (held !== undefined) return held;
  // A box built on a storage this module did not make holds no rows: the fake
  // registers its table when it builds the handle, so an absent one is a fresh
  // table rather than a missing one.
  const fresh: { callback: string; time: number }[] = [];
  scheduleTables.set(storage, fresh);
  return fresh;
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
  const schedules: { callback: string; time: number }[] = [];
  const gates: Record<string, Gate | undefined> = {};
  const faults: Record<string, Error | undefined> = {};
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
      const fault = faults[key];
      if (fault !== undefined) {
        faults[key] = undefined;
        return Promise.reject(fault);
      }
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<boolean> => Promise.resolve(rows.delete(key)),
    // THE CANDIDATE CONTROL ROW'S READ-MODIFY-WRITE. The runtime runs the
    // closure against a transaction whose writes land together when it
    // settles and not at all when it throws; a closure that refused (the head
    // CAS naming a stale parent) must leave the row it read untouched. Buffered
    // for that reason rather than written through: a fake that committed each
    // put as it happened could not hold the atomicity the CAS rests on.
    transaction: async <T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> => {
      const staged = new Map<string, StoredValue>();
      const removed = new Set<string>();
      const transaction: DurableObjectTransaction = Object.create({
        get: async (key: string): Promise<StoredValue> =>
          removed.has(key) ? undefined : staged.get(key) ?? rows.get(key),
        put: async (key: string, value: StoredValue): Promise<void> => {
          removed.delete(key);
          staged.set(key, value);
        },
        delete: async (key: string): Promise<boolean> => {
          staged.delete(key);
          removed.add(key);
          return rows.has(key);
        },
      });
      const result = await closure(transaction);
      for (const key of removed) rows.delete(key);
      for (const [key, value] of staged) rows.set(key, value);
      return result;
    },
    // The DO's own SQLite, as the ONE statement the class issues sees it. A fake
    // that answered a statement it does not model would answer it wrongly, so
    // anything else refuses by name — see `session-shell.ts` for why.
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

/**
 * The one command the boot-id stamp issues, and the last write a restoration
 * makes. Faulting or gating it fails or parks an attempt at its final await.
 *
 * THE PATH, NOT THE VERB. This used to be `printf %s`, and a prefix like that
 * identifies a command by the least specific thing about it: the listener proof
 * writes its answer with `printf %s` too, so the fake would have parked that
 * probe on the stamp gate, fired a stamp fault at it, and counted it as a
 * stamp — a silent, wrong answer to a real command, which is exactly the class
 * of fake defect `session-shell.ts` exists to stop. The boot-id path is what
 * makes this command the stamp.
 */
export const STAMP_COMMAND = '> /tmp/devbox-boot-id';

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
  /** THE SDK'S TABLE, shared with the Durable Object's SQLite: see
   *  {@link scheduleTableOf}. */
  readonly scheduleRows: { callback: string; time: number }[];
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
   *  the session the stop is speaking through, or `cwdOnly`, which holds the
   *  mount by its working directory and is invisible to any scan that matches
   *  only `/proc/<pid>/fd`. */
  workdirHolder: {
    readonly pid: number;
    readonly comm: string;
    readonly survives?: boolean;
    readonly session?: boolean;
    /** Holds the mount by cwd, not by an fd. Measured in deployed probe
     *  `hp0901170218`: six of these, all invisible to an fd-only scan. Named,
     *  never signalled — they are the container server's own children — so an
     *  ordinary unmount stays refused and only a lazy detach releases it. */
    readonly cwdOnly?: boolean;
  } | undefined;
  /**
   * WHERE THE SHARED SESSION SHELL IS STANDING.
   *
   * The SDK creates its default session with `cwd: "/workspace"` — the mount
   * point — and `unmountBucket` goes through that session with no cwd of its
   * own. A shell standing on a mount is a reference to it, so this field is
   * what decides whether an unmount can succeed. Modelling it is the repair to
   * this fake: without it, every deployed r2fs stop could refuse EBUSY while
   * this suite stayed green, because the one reference that actually held the
   * mount was not represented at all.
   */
  sessionCwd = '/workspace';
  readonly fileOperationFailures = {
    rename: Array<Error>(),
    move: Array<Error>(),
  } satisfies Record<FileOperation['operation'], Error[]>;
  readonly startFaults: StartFault[] = [];
  startFaultBeforeRunning: Error | undefined;
  startFaultAfterRunning: Error | undefined;
  /**
   * A STANDING refusal from the platform: every `start` is refused while this is
   * set, and it is never consumed.
   *
   * The two fields above are one-shot, which models a transient blip. Capacity
   * exhaustion is not a blip — measured live, a contended account refused the
   * same box 21 times in 15 s — and the properties that matter under it (an
   * operation is refused rather than admitted onto a box with no work
   * directory; the box stays re-armable) are invisible to a fault that clears
   * itself after the first ask.
   */
  containerUnavailable: Error | undefined;
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
  /** How long every command waits INSIDE the container before answering — the
   *  shape of a counted loop (`awaitLayer`, `awaitListenerCommand`), whose whole
   *  duration belongs to one command. A real wait, because what is under test is
   *  whether that duration can extend a caller's own window. */
  execDelayMs = 0;
  stampGate: Gate | undefined;
  exposeGate: Gate | undefined;
  destroyFault: Error | undefined;
  destroys = 0;
  bootId: string | undefined;
  containerStarts = 0;
  readonly startWaitOptions: unknown[] = [];
  /** Does the journal daemon's mount land once it is started? False is the
   *  daemon that starts and never serves, which is the only reason the
   *  readiness probe exists. */
  journalMounts = true;
  /**
   * THE CANDIDATE RUNNER, as the container runs it. The box starts `bun
   * <runner> --action … --result <path>` as a supervised process, waits for
   * the row to settle, and reads the reply from the result path; a test that
   * sets this answers that process. Invoked from `startProcess` for every
   * command carrying `--action`: the reply is written to {@link files} at the
   * result path and the row settles `completed` with exit code 0; a throw
   * settles it `failed` with exit code 1 and the message on stderr, which is
   * what the box reads when a real runner dies. Unset, a runner start stays
   * `running` for ever, which is the deployed shape of a runner nobody answers.
   */
  runner: ((invocation: RunnerInvocation) => Promise<string> | string) | undefined;
  /** The container's files, as far as the box reads them: runner result paths
   *  and workload files accepted through the SDK boundary. */
  readonly files = new Map<string, string>();
  /** A workload write the fake accepted. Candidate fixtures use this to hand
   *  the same bytes to the runner's journal model; unset, the file write is
   *  still kept in {@link files}. */
  fileWritten: ((path: string, content: string) => Promise<void> | void) | undefined;

  /** Is a journal daemon process live? The fake's process table IS the
   *  container's, so this is the same fact the daemon's own supervisor reads
   *  rather than a flag a test sets beside it. */
  journalRunning(): boolean {
    return [...this.processes.values()].some(
      (row) => row.command.includes('kinu-journal-daemon') && row.status === 'running',
    );
  }
  /**
   * Set while the container-start hook holds the platform's init gate.
   *
   * The one platform fact this fake models that is NOT a container behaviour:
   * while `onStart` is awaited inside `blockConcurrencyWhile` the runtime
   * delivers no event to the Durable Object. A test that called `box.exec()`
   * directly during that window would be asserting against an interleaving the
   * platform cannot produce, so {@link deliver} awaits this first.
   */
  initGate: Promise<void> | undefined;

  constructor(readonly ctx: DurableObjectState) {
    FakeSandbox.last = this;
    this.scheduleRows = scheduleTableOf(ctx.storage);
  }

  /** The SDK's own delete-by-callback (`container.js:1492-1494`), which is what
   *  the class's sweep of unreachable rows goes through. */
  deleteSchedules(callback: string): void {
    for (let index = this.scheduleRows.length - 1; index >= 0; index -= 1) {
      if (this.scheduleRows[index]?.callback === callback) this.scheduleRows.splice(index, 1);
    }
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
  async exec(
    command: string,
    options?: { readonly cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const refused = sessionShellRefusal(command);
    if (refused !== undefined) {
      this.sequence.push(`sessionKilled:${command.split(' ')[0]}`);
      throw refused;
    }
    // AN EXEC'S CWD MOVES THE SHARED SESSION, AND IT STAYS MOVED. The container
    // server runs every command in one persistent session shell, so a cwd
    // option is a `cd` that outlives the command — which is exactly why the
    // SDK's own `unmountBucket`, which passes no cwd at all, inherits wherever
    // the last caller left the shell. A fake that dropped this argument (this
    // one did) cannot express the reference that refuses an unmount.
    if (options?.cwd !== undefined) this.sessionCwd = options.cwd;
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
    if (this.execDelayMs > 0) await scheduler.wait(this.execDelayMs);
    if (command === 'cat /tmp/devbox-boot-id 2>/dev/null || true') {
      return { stdout: this.bootId ?? '', stderr: '', exitCode: 0 };
    }
    if (command === 'cat /proc/mounts') {
      // EVERY path the box's own `mountBucket` holds, not just the work
      // directory — the same fact `/proc/mounts` reports in a real container,
      // so a strategy's read-back observes the world the fake changed rather
      // than a world the test staged. The candidate arms mount their object
      // store somewhere else entirely and read it back the same way.
      const lines = [
        'proc /proc proc rw,relatime 0 0',
        ...[...this.s3fsMounts].map(
          (path) => `s3fs ${path} fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0`,
        ),
        // The journal daemon's own mount, present exactly while it is serving.
        ...(this.journalRunning() && this.journalMounts
          ? ['kinu-journal /workspace fuse.kinu-journal rw,nosuid,nodev,relatime 0 0']
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
    // THE RUNNER RESULT'S RETIREMENT: `rm -f '<reply>'` after one attempt and
    // `rm -rf '<dir>'` when the candidate is discarded. Answered against the
    // file table the runner writes into, so a reply the box retired cannot be
    // read again by the next attempt on the same fixed result path.
    const removed = /^rm -r?f '([^']+)'$/.exec(command);
    if (removed !== null) {
      const target = removed[1] ?? '';
      for (const path of this.files.keys()) {
        if (path === target || path.startsWith(`${target}/`)) this.files.delete(path);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
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
    // THE LAZY DETACH, which is the strategy's last resort for a reference it
    // may not revoke. `MNT_DETACH` removes the mount from the namespace even
    // while a holder lives, so it clears BOTH the mount and the fake's holder
    // row — the holder survives as a process, it just no longer holds a mount.
    if (command.includes('fusermount -uz')) {
      this.sequence.push('exec:lazy-unmount');
      this.s3fsMounts.delete('/workspace');
      this.workdirHolder = undefined;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    // THE HOLDER-RELEASE COMMAND, answered the way the real container answers
    // it: the signal work happens inside the same command, and STDOUT IS WHO IS
    // STILL HOLDING WHEN IT ENDS. That last part is the repair — the command
    // used to echo the list it captured BEFORE signalling, so a writer it had
    // just killed successfully was still named as a holder, which is how
    // deployed runs `probe09011530` and `hp0901170218` both blamed a `bun` pid
    // that the `/proc` report taken afterwards shows was already gone.
    //
    // The fake's `workdirHolder` IS its process table, so clearing it is what
    // the real command's SIGTERM achieves; a holder marked `survives` is one the
    // TERM and the KILL both failed on, one marked `session` is an ancestor of
    // the scan's own shell, and one marked `cwdOnly` holds by working directory
    // and is invisible to an fd match. None of the last three is signalled, so
    // all three are still holding when the scan ends and all three are named.
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
      if (holder.cwdOnly === true) {
        return { stdout: named, stderr: `not signalled, cwd-only holders: ${named}`, exitCode: 0 };
      }
      if (holder.survives) return { stdout: named, stderr: `signalling: ${named}`, exitCode: 0 };
      // Signalled, and it died: the re-scan at the end of the real command finds
      // nothing, so this answers `none` rather than the name it started with.
      this.workdirHolder = undefined;
      return { stdout: 'none', stderr: `signalling: ${named}`, exitCode: 0 };
    }
    // THE JOURNAL READINESS PROBE, answered as the container answers it: the
    // daemon serves once it has been started, unless a test says the mount
    // never lands. The command WAITS inside the container, so one exec is the
    // whole question — a fake that answered it per attempt would let the
    // forty-round-trip loop this replaced pass again.
    //
    // Matched on the answer it prints rather than on a path or a first word:
    // the command's shape is what the caller reads back, and a fake keyed on
    // anything else answers the empty string to a command it stopped
    // recognising.
    if (command.includes('echo "socket=$socket mount=$mount"')) {
      const serving = this.journalRunning() && this.journalMounts;
      return {
        stdout: `socket=${serving ? 'yes' : 'no'} mount=${serving ? 'yes' : 'no'}\n`,
        stderr: '',
        exitCode: 0,
      };
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
    // TWO REFERENCES REFUSE THIS, and the second one is the whole defect.
    //
    // A live holder is the obvious one. The other is THIS CALL'S OWN SESSION:
    // the SDK issues `fusermount -u` through its default session, created with
    // `cwd: "/workspace"` and given no cwd of its own here, and a shell standing
    // on a mount holds that mount. So an unmount asked for while the session
    // still stands inside the work directory is refused no matter how many
    // holders were killed first — which is the deterministic reason every
    // deployed r2fs stop refused, measured in probe `hp0901170218`, where the
    // identical `fusermount -u` returned 0 the moment the session was parked.
    if (mountPath === '/workspace'
      && (this.sessionCwd === mountPath || this.sessionCwd.startsWith(`${mountPath}/`))) {
      throw new Error(
        `fusermount -u failed (exit 1): fusermount: failed to unmount ${mountPath}: `
        + 'Device or resource busy',
      );
    }
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
    if (fault !== undefined) throw fault.error;
    const argv = quotedWords(command);
    const action = runnerOption(argv, 'action');
    if (action === undefined || this.runner === undefined) return this.#live(row);
    // THE RUNNER ANSWERS BEFORE START REPLIES, which is one shape the real one
    // has (candidate-runner.test.ts: "reads the result when the runner
    // completed before start replied") and the only deterministic one: the
    // first exit poll finds a settled row, and the reply is at its path.
    const resultPath = runnerOption(argv, 'result');
    try {
      const reply = await this.runner({ action, resultPath, argv });
      if (resultPath !== undefined) this.files.set(resultPath, reply);
      this.processes.set(id, { ...row, status: 'completed', exitCode: 0 });
    } catch (cause) {
      this.processLogs.set(id, { stdout: '', stderr: describeThrown({ cause }) });
      this.processes.set(id, { ...row, status: 'failed', exitCode: 1 });
    }
    return this.#live(row);
  }

  /** One file, as the SDK's `readFile` answers it: the content, or the SDK's
   *  refusal for a path the container does not hold. */
  async readFile(path: string): Promise<{ content: string }> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return { content };
  }

  /** One file write through the SDK boundary. The tests drive text because
   *  the candidate journal model's byte semantics live in its own suite; this
   *  stand-in keeps the bytes at the path and tells an installed candidate
   *  runner that a workload mutation occurred. */
  async writeFile(path: string, content: string): Promise<{ success: true; path: string; timestamp: string }> {
    this.files.set(path, content);
    await this.fileWritten?.(path, content);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  /**
   * Process ids whose next poll STOPS the container.
   *
   * The platform reclaims an instance whenever it likes, and the process table
   * a caller polls lives on this side of that: the record keeps answering
   * `running` for a process whose reporter is gone. "The sandbox container
   * stopped while the operation was pending" is that event named from the
   * outside, and it is what every arm that lost an operation to a ceiling in
   * `e2ecal0901002202` and `e2e20260901140445` was told.
   */
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

  /** What a process printed. A failure that reports the daemon's own words is
   *  the difference between "the mount did not land" and a reader guessing, so
   *  a test can stage those words and assert they travel. */
  readonly processLogs = new Map<string, { stdout: string; stderr: string }>();

  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    return Promise.resolve(this.processLogs.get(id) ?? { stdout: '', stderr: '' });
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
    // The standing refusal, checked after the park so a test can hold an
    // attempt inside a refusal that is not going to clear.
    if (this.containerUnavailable !== undefined) throw this.containerUnavailable;
    const beforeRunning = this.startFaultBeforeRunning;
    this.startFaultBeforeRunning = undefined;
    if (beforeRunning !== undefined) throw beforeRunning;
    const wasRunning = this.running.running;
    this.running.running = true;
    if (!wasRunning) this.containerStarts += 1;
      // THE INIT GATE, modelled where the SDK really opens it. `container.js`
      // runs this hook inside `ctx.blockConcurrencyWhile`, so for as long as it
      // is held the runtime delivers NO event to the object — which is the
      // admission control the restore now relies on. The promise is published so
      // a test can deliver a request the way the platform does (see
      // {@link deliver}) instead of calling straight into a method the platform
      // would still be holding back.
      // OPENED WHEN THE HOOK SETTLES, however it settled — a rejection there is
      // the platform resetting the object, and a request the runtime held back
      // is released either way. So the marker is resolved in the `finally`
      // rather than derived from the hook's promise: a rejection handler here
      // would turn a failed activation into the same value a successful one
      // produces, and the fake would be answering for something it did not see.
      //
      // RUN ON EVERY `start()`, NOT ONLY ON A REAL ONE, because that is what the
      // SDK does: `container.js:583` opens the block and calls the hook whether
      // or not `startContainerIfNotRunning` started anything, and
      // `startAndWaitForPorts` does the same after `setHealthy()`. Measured on
      // deployed probe `gp0902011918`, where the hook was re-entered 37 ms into
      // a restore's first exec. A fake that skipped it could not hold the
      // property that a re-entered hook fences nothing.
    const opened = Promise.withResolvers<void>();
    this.initGate = opened.promise;
    try {
      await this.onStart();
    } finally {
      this.initGate = undefined;
      opened.resolve();
    }
    const fault = this.startFaultAfterRunning;
    this.startFaultAfterRunning = undefined;
    if (fault !== undefined) throw fault;
  }

  async startAndWaitForPorts(): Promise<void> {
    await this.start();
  }

  stops = 0;

  /**
   * A stop ends every process in the container and the process table with
   * them: the SDK answers `getProcess` from the container's own server
   * (`client.processes.getProcess`), which a stop takes down, so a wake finds
   * no row for any runner or daemon the previous life started. What a stop
   * does NOT take is the instance disk: the boot marker under `/tmp` and the
   * runner's result files stay, which is the same-instance wake the platform
   * can produce (`src/snapshot-chain.ts`, "the same-instance path") and the
   * one the candidate repair is judged on.
   */
  stop(): Promise<void> {
    this.stops += 1;
    this.running.running = false;
    this.processes.clear();
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
export type TestEnv = Record<string, never>;

/** The Durable Object id every test box carries, and therefore the box prefix
 *  its strategy scopes the store to (`boxes/<id>`). */
export const TEST_BOX_ID = 'devbox-under-test';

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
    id: { toString: () => TEST_BOX_ID },
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

/**
 * Run one operation the way the PLATFORM would deliver it: not before the init
 * gate opens.
 *
 * The difference matters for exactly one class of assertion, and it is the one
 * the container-start restore rests on. A test that calls `box.exec()` while
 * `onStart` is still held is asserting against an interleaving the runtime
 * cannot produce — no event is delivered to a Durable Object inside
 * `blockConcurrencyWhile` — so it would either prove nothing or prove a hazard
 * that does not exist. Going through here says "this request arrived DURING the
 * restore" honestly: it is issued then, and delivered when the platform would
 * deliver it.
 */
export async function deliver<T>(container: FakeSandbox, work: () => Promise<T>): Promise<T> {
  await container.initGate;
  return await work();
}
