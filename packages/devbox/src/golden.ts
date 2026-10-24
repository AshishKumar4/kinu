// The golden snapshot (D65): the base image with the pinned tools, built by one object of the box's class.
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt } from './errors';
import { OwedSchema, SNAPSHOT_LIFE_MS, payDebt, type SnapshotDeletion } from './snapshot-registry';
import { shellPath } from './stream-archive';
import { manifestDelta, packagePaths, TOOLS_INSTALLING, TOOLS_MANIFEST, TOOLS_STAGED, TOOLS_STAMP, toolsApplyCommand, toolsFileKey, toolsInstallCommand, toolsManifestKey } from './tools';
import { containerExec } from './processes';

export const GOLDEN_BASE = 'cloudflare/debian-trixie';

export const GOLDEN_ENTRYPOINT = ['/usr/bin/tini', '--', 'sleep', 'infinity'];

export const GOLDEN_NAME = 'devbox-golden';

const DAY_MS = 24 * 60 * 60 * 1000;

export const GOLDEN_REFRESH_MS = 25 * DAY_MS;

/** A box's own lineage wakes for SNAPSHOT_LIFE_MS from its root, a delta on the golden it started from, so a golden no slot holds
 *  any more is deleted once every lineage rooted on it is past waking, with a day's margin. */
const RETIRE_MS = SNAPSHOT_LIFE_MS + DAY_MS;

const ARCHIVE = '/tmp/devbox-tools.tgz';

/** A snapshot lives 30 days from its creation or last restore. */
const Golden = v.object({ id: v.string(), tools: v.string(), base: v.string(), takenAt: v.number(), renewedAt: v.optional(v.number()) });

export const GoldenStateSchema = v.object({
  current: v.optional(Golden),
  previous: v.optional(Golden),
  /** Told once when a build verifies or fails. */
  waiting: v.array(v.string()),
  failure: v.optional(v.string()),
  /** The step a build under way is at, so a box's caller can tell a moving build from a stuck one. */
  building: v.optional(v.string()),
  /** Goldens no slot holds, each deleted from `at` on: a snapshot id, or the digest an earlier delete left. */
  retiring: v.optional(v.array(OwedSchema), []),
});

export type GoldenState = v.InferOutput<typeof GoldenStateSchema>;

/**
 * `building` is present while the golden is being built, never after a failed build: the box waits to be told, and
 * `step` is the build's own (null before it begins).
 */
export type GoldenAnswer =
  | { readonly kind: 'ready'; readonly id: string; readonly tools: string }
  | { readonly kind: 'pending'; readonly reason: string; readonly building?: { readonly step: string | null } };

export interface GoldenPorts {
  readonly tools: string;
  readonly read: () => GoldenState;
  readonly write: (state: GoldenState) => void;
  readonly start: (from: { readonly image: string } | { readonly snapshot: string }) => Promise<void>;
  readonly exec: (command: string) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  readonly pipe: (key: string, path: string) => Effect.Effect<void, DevboxError>;
  readonly snapshot: (name: string) => Promise<string>;
  readonly destroy: () => Promise<void>;
  readonly build: () => Promise<void>;
  readonly tell: (box: string, answer: GoldenAnswer) => Effect.Effect<void, DevboxError>;
  /** Deletes a snapshot from the registry, telling `owe` its manifest's digest before any tag goes; undefined without the
   *  authority to. */
  readonly delete: (ref: string, owe: (digest: string) => void) => Promise<SnapshotDeletion> | undefined;
  readonly now: () => number;
}

const toolsKey = (sha256: string): string => `devbox-tools/${sha256}.tgz`;

const TOOLS_STAMP_COMMAND = `cat ${TOOLS_STAMP} 2>/dev/null || true`;

const REBUILDING = 'the base snapshot is being rebuilt (about 30 s); the box starts when it is ready';

/** Recorded with each golden: the base it was built on. */
const BASE_COMMAND = 'echo "$(cat /etc/debian_version) $(node --version 2>/dev/null) $(sha256sum /var/lib/dpkg/status | cut -c1-16)"';

const VERIFY_COMMAND = 'set -e; for t in bun git tmux tini s3fs fuse-overlayfs mksquashfs unsquashfs zstd curl python3 flock devbox-squashfuse '
  + 'devbox-block-lower sandbox-shim; do command -v $t >/dev/null || { echo "missing $t"; exit 1; }; done; '
  + 'd=/var/tmp/devbox-verify; rm -rf $d && mkdir -p $d/s $d/m $d/u $d/w $d/o && echo ok > $d/s/f && mksquashfs $d/s $d/l.sqsh -noappend -quiet >/dev/null '
  + '&& devbox-squashfuse $d/l.sqsh $d/m && fuse-overlayfs -o lowerdir=$d/m,upperdir=$d/u,workdir=$d/w $d/o && cat $d/o/f '
  + '&& fusermount3 -u $d/o && fusermount3 -u $d/m && rm -rf $d';

const usable = (golden: v.InferOutput<typeof Golden> | undefined, now: number) => golden !== undefined && now - Math.max(golden.takenAt, golden.renewedAt ?? 0) < SNAPSHOT_LIFE_MS;

/** A golden of other tools still serves, refreshed in the box's gate, while the pinned one builds. */
export function goldenFor(ports: GoldenPorts, box: string, lost?: string): Effect.Effect<GoldenAnswer, DevboxError> {
  return Effect.gen(function* () {
    const held = ports.read();
    const now = ports.now();
    const state = lost === undefined ? held : retire({ ...held, current: held.current?.id === lost ? undefined : held.current, previous: held.previous?.id === lost ? undefined : held.previous }, held, now);

    if (state !== held) ports.write(state);
    const serving = [state.current, state.previous].find(golden => usable(golden, now));

    if (serving !== undefined && serving === state.current && serving.tools === ports.tools) return { kind: 'ready', id: serving.id, tools: serving.tools };
    yield* attempt('io', () => ports.build());

    if (serving !== undefined) return { kind: 'ready', id: serving.id, tools: serving.tools };
    ports.write({ ...state, waiting: [...new Set([...state.waiting, box])] });

    return state.failure === undefined
      ? { kind: 'pending', reason: REBUILDING, building: { step: state.building ?? null } }
      : { kind: 'pending', reason: state.failure };
  });
}

/** `keepAlive` restores the previous golden too, renewing its life. */
export function buildGolden(ports: GoldenPorts, keepAlive: boolean): Effect.Effect<GoldenState, DevboxError> {
  return Effect.gen(function* () {
    const before = ports.read();
    const built = yield* Effect.result(build(ports, before));
    const after = ports.read();

    const state: GoldenState = Result.isSuccess(built)
      ? retire({ ...after, ...built.success, waiting: [], failure: undefined, building: undefined }, after, ports.now())
      : { ...after, waiting: [], failure: `the base snapshot could not be built: ${built.failure.message}`, building: undefined };

    ports.write(state);

    const answer: GoldenAnswer = state.current !== undefined && Result.isSuccess(built)
      ? { kind: 'ready', id: state.current.id, tools: state.current.tools }
      : { kind: 'pending', reason: state.failure ?? REBUILDING };

    for (const box of after.waiting) yield* Effect.result(ports.tell(box, answer));

    if (keepAlive && state.previous !== undefined && Result.isSuccess(built)) {
      const previous = state.previous;
      const renewed = yield* Effect.result(attempt('io', async () => { await ports.start({ snapshot: previous.id }); await ports.destroy(); }));

      if (Result.isSuccess(renewed)) ports.write({ ...state, previous: { ...previous, renewedAt: ports.now() } });
    }

    yield* deleteRetired(ports);

    return Result.isSuccess(built) ? ports.read() : yield* Effect.fail(built.failure);
  });
}

/** `next` with every golden `before` held and `next` no longer does put to retire. */
function retire(next: GoldenState, before: GoldenState, now: number): GoldenState {
  const held = new Set([next.current?.id, next.previous?.id]);
  const dropped = [before.current, before.previous].flatMap(golden => golden === undefined || held.has(golden.id) ? [] : [{ ref: golden.id, at: now + RETIRE_MS }]);

  return dropped.length === 0 ? next : { ...next, retiring: [...next.retiring, ...dropped] };
}

/** The retired goldens whose time has come, each deleted or kept owed: a refusal, or no authority, waits for the next. */
function deleteRetired(ports: GoldenPorts): Effect.Effect<void> {
  return Effect.promise(() => payDebt({
    read: () => ports.read().retiring, write: (retiring) => { ports.write({ ...ports.read(), retiring: [...retiring] }); },
    delete: ports.delete, now: ports.now, called: 'the retired golden',
  }));
}

function build(ports: GoldenPorts, before: GoldenState): Effect.Effect<Pick<GoldenState, 'current' | 'previous'>, DevboxError> {
  // Each step is recorded as it begins: a waiting box's caller holds while the step moves on (D79). A build under way
  // replaces the last one's failure, so a box asking meanwhile waits on the rebuild instead of reading that failure.
  const at = (step: string) => Effect.sync(() => { ports.write({ ...ports.read(), building: step, failure: undefined }); });

  const run = (doing: string, command: string) => Effect.gen(function* () {
    yield* at(doing);
    const ran = yield* attempt('io', () => ports.exec(command), doing);

    return ran.exitCode === 0 ? ran.stdout.trim() : yield* Effect.fail(new DevboxError('io', `${doing} exited ${String(ran.exitCode)}: ${(ran.stderr || ran.stdout).trim().slice(-600)}`));
  });

  return Effect.gen(function* () {
    const current = before.current;

    // A base roll needs no rebuild: a snapshot keeps its base (D65).
    if (current !== undefined && current.tools === ports.tools && ports.now() - current.takenAt < GOLDEN_REFRESH_MS) {
      return { current, previous: before.previous };
    }

    yield* at('starting the base image');
    yield* attempt('io', () => ports.start({ image: GOLDEN_BASE }), 'starting the base image');
    const base = yield* run('reading the base', BASE_COMMAND);

    yield* at('fetching the tools');
    yield* ports.pipe(toolsKey(ports.tools), ARCHIVE);
    yield* run('installing the tools', toolsInstallCommand(ARCHIVE, ports.tools));
    yield* run('checking the tools', VERIFY_COMMAND);
    yield* at('snapshotting the base');
    const id = yield* attempt('io', () => ports.snapshot(`${toolsKey(ports.tools).slice(13, 21)}-${String(ports.now())}`), 'snapshotting the base');
    // The snapshot is made: a container that will not stop is no failed build, or its id would be lost unrecorded.
    const stopped = yield* Effect.result(attempt('io', () => ports.destroy()));

    if (Result.isFailure(stopped)) console.error(`[devbox] the golden ${id} is built, but its container did not stop: ${stopped.failure.message}`);

    return { current: { id, tools: ports.tools, base, takenAt: ports.now() }, previous: current ?? before.previous };
  });
}


export function pipeParts(
  ports: { readonly get: (key: string) => Promise<R2ObjectBody | null>; readonly container: Container },
  key: string,
  path: string,
): Effect.Effect<void, DevboxError> {
  return Effect.gen(function* () {
    for (let part = 0; ; part += 1) {
      const object = yield* attempt('io', () => ports.get(`${key}.${String(part)}`));

      if (object === null && part === 0) {
        return yield* Effect.fail(new DevboxError('configuration', `the store holds no ${key}.0: bun scripts/devbox-tools.ts publish <bucket>`));
      }

      if (object === null) return;
      const writer = yield* attempt('io', () => containerExec(ports.container, ['/bin/sh', '-c', `cat ${part === 0 ? '>' : '>>'} ${shellPath(path)}`], { stdin: 'pipe' }));
      const stdin = writer.stdin;

      if (stdin === null) return yield* Effect.fail(new DevboxError('io', 'the exec took no stdin'));
      yield* attempt('io', () => object.body.pipeTo(stdin), `writing ${path}`);
      const written = yield* attempt('io', () => writer.output());

      if (written.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `writing ${path} exited ${String(written.exitCode)}`));
    }
  });
}

/**
 * What a start's tools refresh did (ledger 1024-h), the box's own record of it: `current`, the box already at the pin;
 * `incremental`, the files the pin's manifest names anew fetched by sha256 and placed; `full`, the whole tarball
 * installed, `reason` saying why the delta could not be. Each count and time is the install's own (`toolsApplyCommand`,
 * `toolsInstallCommand`).
 */
export interface ToolsRefresh {
  readonly mode: 'current' | 'incremental' | 'full';
  readonly ms: number;
  readonly reason?: string;
  readonly files?: number;
  readonly removed?: number;
  readonly bytes?: number;
  readonly filesMs?: number;
  readonly extractMs?: number;
  readonly installMs?: number;
  /** Packages apt set up. */
  readonly changed?: number;
}

/** Why a refresh installs the tarball whole, or undefined when the files the pin changed are enough. */
function wholeReason(at: { readonly pin: string; readonly published: boolean; readonly unfinished: boolean; readonly held: boolean; readonly packages: number }): string | undefined {
  if (!at.published) return `the store holds no ${toolsManifestKey(at.pin)}.0`;

  if (at.unfinished) return 'the box\'s last full install did not finish';

  if (!at.held) return 'the box holds no tools manifest';

  return at.packages === 0 ? undefined : `the pin changes ${String(at.packages)} package files`;
}

/** The `name=number` pairs an install prints on its last line. */
function installCounts(stdout: string): Record<string, number> {
  return Object.fromEntries([...stdout.matchAll(/\b(\w+)=(\d+)\b/gu)].map((match) => [match[1] ?? '', Number(match[2])]));
}

/**
 * Brings a starting box's tools to `pin`, inside its start (D66): a box at the pin reads its stamp and is done. Every
 * re-pin from 2026-10-21 to 10-23 changed one binary of 0.7 to 3.8 MB in a 358 MB tarball, and the box fetched and
 * installed all of it, 12 to 24 s of its 25 s (production, ledger 1024-h): a box that holds its manifest and finds the
 * pin's in the store fetches only the files the two differ on. One with no manifest (the image, never installed), a
 * store with none for the pin, or a pin that changes a package (`packagePaths`) installs the tarball whole, and says why.
 */
export function refreshTools(ports: {
  readonly pin: string;
  readonly exec: (command: string) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
  readonly pipe: (key: string, path: string) => Effect.Effect<void, DevboxError>;
  /** A one-part store object's text, null when the store holds none. */
  readonly read: (key: string) => Promise<string | null>;
  readonly now: () => number;
}): Effect.Effect<ToolsRefresh, DevboxError> {
  return Effect.gen(function* () {
    const since = ports.now();
    const held = yield* attempt('io', () => ports.exec(TOOLS_STAMP_COMMAND));

    if (held.stdout.trim() === ports.pin) return { mode: 'current', ms: ports.now() - since } satisfies ToolsRefresh;
    const next = yield* attempt('io', () => ports.read(toolsManifestKey(ports.pin)));
    const box = next === null ? undefined : yield* attempt('io', () => ports.exec(`[ -e ${TOOLS_INSTALLING} ] && exit 3; cat ${TOOLS_MANIFEST} 2>/dev/null || true`));
    const installed = box?.exitCode === 0 ? box.stdout : '';
    const delta = manifestDelta(installed, next ?? '');
    const reason = wholeReason({ pin: ports.pin, published: next !== null, unfinished: box?.exitCode === 3, held: installed.trim() !== '', packages: packagePaths(delta).length });

    if (reason !== undefined) {
      yield* ports.pipe(toolsKey(ports.pin), ARCHIVE);
      const whole = yield* attempt('io', () => ports.exec(toolsInstallCommand(ARCHIVE, ports.pin)));

      if (whole.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `installing the pinned tools exited ${String(whole.exitCode)}: ${whole.stdout.slice(-600)}`));
      const counts = installCounts(whole.stdout);

      return { mode: 'full', reason, extractMs: counts['extractMs'], installMs: counts['installMs'], changed: counts['changed'], ms: ports.now() - since } satisfies ToolsRefresh;
    }

    yield* attempt('io', () => ports.exec(`mkdir -p ${TOOLS_STAGED}`));

    for (const sha256 of new Set(delta.changed.map((file) => file.sha256))) yield* ports.pipe(toolsFileKey(sha256), `${TOOLS_STAGED}/${sha256}`);
    yield* ports.pipe(toolsManifestKey(ports.pin), `${TOOLS_STAGED}/manifest`);
    const applied = yield* attempt('io', () => ports.exec(toolsApplyCommand(delta, ports.pin)));

    if (applied.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `moving the tools to ${ports.pin} exited ${String(applied.exitCode)}: ${applied.stdout.slice(-600)}`));
    const counts = installCounts(applied.stdout);

    return { mode: 'incremental', files: counts['files'], removed: counts['removed'], bytes: counts['bytes'], filesMs: counts['filesMs'], ms: ports.now() - since } satisfies ToolsRefresh;
  });
}
