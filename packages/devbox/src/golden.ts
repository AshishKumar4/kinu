// The golden snapshot (D65): the base image with the pinned tools, built by one object of the box's class.
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt } from './errors';
import { shellPath } from './stream-archive';
import { TOOLS_STAMP, toolsInstallCommand } from './tools';

export const GOLDEN_BASE = 'cloudflare/debian-trixie';

export const GOLDEN_ENTRYPOINT = ['/usr/bin/tini', '--', 'sleep', 'infinity'];

export const GOLDEN_NAME = 'devbox-golden';

const DAY_MS = 24 * 60 * 60 * 1000;

const LIFE_MS = 29 * DAY_MS;

export const GOLDEN_REFRESH_MS = 25 * DAY_MS;

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
  readonly tell: (box: string, answer: GoldenAnswer) => Promise<void>;
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

const usable = (golden: v.InferOutput<typeof Golden> | undefined, now: number) => golden !== undefined && now - Math.max(golden.takenAt, golden.renewedAt ?? 0) < LIFE_MS;

/** A golden of other tools still serves, refreshed in the box's gate, while the pinned one builds. */
export function goldenFor(ports: GoldenPorts, box: string, lost?: string): Effect.Effect<GoldenAnswer, DevboxError> {
  return Effect.gen(function* () {
    const held = ports.read();
    const state = lost === undefined ? held : { ...held, current: held.current?.id === lost ? undefined : held.current, previous: held.previous?.id === lost ? undefined : held.previous };

    if (state !== held) ports.write(state);
    const now = ports.now();
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
      ? { ...after, ...built.success, waiting: [], failure: undefined, building: undefined }
      : { ...after, waiting: [], failure: `the base snapshot could not be built: ${built.failure.message}`, building: undefined };

    ports.write(state);

    const answer: GoldenAnswer = state.current !== undefined && Result.isSuccess(built)
      ? { kind: 'ready', id: state.current.id, tools: state.current.tools }
      : { kind: 'pending', reason: state.failure ?? REBUILDING };

    for (const box of after.waiting) yield* Effect.result(attempt('io', () => ports.tell(box, answer)));

    if (keepAlive && state.previous !== undefined && Result.isSuccess(built)) {
      const previous = state.previous;
      const renewed = yield* Effect.result(attempt('io', async () => { await ports.start({ snapshot: previous.id }); await ports.destroy(); }));

      if (Result.isSuccess(renewed)) ports.write({ ...state, previous: { ...previous, renewedAt: ports.now() } });
    }

    return Result.isSuccess(built) ? ports.read() : yield* Effect.fail(built.failure);
  });
}

function build(ports: GoldenPorts, before: GoldenState): Effect.Effect<Pick<GoldenState, 'current' | 'previous'>, DevboxError> {
  // Each step is recorded as it begins: a waiting box's caller holds while the step moves on (D79).
  const at = (step: string) => Effect.sync(() => { ports.write({ ...ports.read(), building: step }); });

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
    yield* attempt('io', () => ports.destroy());

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
      const writer = yield* attempt('io', () => ports.container.exec(['/bin/sh', '-c', `cat ${part === 0 ? '>' : '>>'} ${shellPath(path)}`], { stdin: 'pipe' }));
      const stdin = writer.stdin;

      if (stdin === null) return yield* Effect.fail(new DevboxError('io', 'the exec took no stdin'));
      yield* attempt('io', () => object.body.pipeTo(stdin), `writing ${path}`);
      const written = yield* attempt('io', () => writer.output());

      if (written.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `writing ${path} exited ${String(written.exitCode)}`));
    }
  });
}

export function refreshTools(ports: {
  readonly pin: string;
  readonly exec: (command: string) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
  readonly pipe: (key: string, path: string) => Effect.Effect<void, DevboxError>;
}): Effect.Effect<void, DevboxError> {
  return Effect.gen(function* () {
    const held = yield* attempt('io', () => ports.exec(TOOLS_STAMP_COMMAND));

    if (held.stdout.trim() === ports.pin) return;
    yield* ports.pipe(toolsKey(ports.pin), ARCHIVE);
    const installed = yield* attempt('io', () => ports.exec(toolsInstallCommand(ARCHIVE, ports.pin)));

    if (installed.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `installing the pinned tools exited ${String(installed.exitCode)}: ${installed.stdout.slice(-600)}`));
  });
}
