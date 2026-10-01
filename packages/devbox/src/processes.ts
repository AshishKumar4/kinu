import { Files, SandboxFileError } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { TERM_GRACE_MS } from './lifecycle';

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// Native exec does not inherit start() env; the upstream coding-agents example passes this per process.
export const CONTAINER_TRUST_ENV = { NODE_EXTRA_CA_CERTS: CA_PATH, GIT_SSL_CAINFO: CA_PATH, CURL_CA_BUNDLE: CA_PATH, SSL_CERT_FILE: CA_PATH };

const ROOT = '/var/tmp/devbox/processes';

const IdSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/));

const RecordSchema = v.object({ id: IdSchema, command: v.string(), cwd: v.string() });

export interface ProcessRecord {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly pid: number | undefined;
  readonly status: 'starting' | 'running' | 'completed' | 'failed';
  readonly exitCode: number | undefined;
}

// Cloudflare sandbox-sdk rc.1's process-workspace example: file-backed identities survive a DO
// eviction, native exec starts the wrapper, and a process group carries signals to its children.
// An exec whose answer is lost may or may not have spawned the wrapper, so one symlink decides the
// launch: the wrapper makes `launch -> launched` before anything runs, and a caller that finds no pid
// and no exit makes `launch -> unlaunched`, after which nothing runs (D48). The wrapper enters the cwd
// itself, so a missing one is the launch's own recorded failure.
const RUN = `dir=$1; cwd=$2; shift 2
ln -s launched "$dir/launch" 2>/dev/null || exit 0
if ! cd -- "$cwd" 2>/dev/null; then
  printf "Failed to change directory to '%s'\\n" "$cwd" >"$dir/stderr.log"
  echo 1 >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
  exit 0
fi
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"`;

/** `$1/pid`'s pid if alive and from this boot (an old record: if written since boot). */
const LIVE = `live() {
  [ -f "$1/pid" ] || return 1
  read -r p b < "$1/pid"
  if [ -n "$b" ]; then [ "$b" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 1
  else [ "$(stat -c %Y "$1/pid")" -ge "$(awk '/^btime/ {print $2}' /proc/stat)" ] || return 1
  fi
  kill -0 "$p" 2>/dev/null && echo "$p"
}`;

/** Exits 0 when the launch in `$1` never ran, claiming it for nobody. */
const UNLAUNCH = `[ -f "$1/pid" ] || [ -f "$1/exit" ] || ln -s unlaunched "$1/launch" 2>/dev/null
[ "$(readlink "$1/launch")" = unlaunched ]`;

const STATUS = `${LIVE}
for dir in "$@"; do
  [ -f "$dir/process.json" ] || continue
  if [ -f "$dir/exit" ]; then state="exit $(cat "$dir/exit")"
  elif [ "$(readlink "$dir/launch")" = unlaunched ]; then state=unlaunched
  elif [ ! -f "$dir/pid" ]; then state=starting
  elif p=$(live "$dir"); then state="running $p"
  else state=lost
  fi
  printf '%s\\n' "$state"
  cat "$dir/process.json"; printf '\\n'
done`;

const directory = (id: string) => attemptSync('invalid-input', () => `${ROOT}/${v.parse(IdSchema, id)}`);

export class Processes {
  readonly #files: Files;
  constructor(readonly container: Container) {
    this.#files = new Files(container);
  }

  start(command: string, options: { readonly cwd?: string; readonly processId: string }): Promise<ProcessRecord> {
    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(options.processId);
      yield* attempt('file', () => this.#files.mkdir(ROOT, { recursive: true }));
      const made = yield* Effect.result(attempt('file', () => this.#files.mkdir(dir)));

      if (Result.isFailure(made)) {
        const cause = made.failure.cause;

        if (!SandboxFileError.is(cause) || cause.code !== 'EEXIST') return yield* Effect.fail(made.failure);
        const held = (yield* this.#status([dir]))[0];

        if (held === undefined) return yield* Effect.fail(made.failure);

        // A launch with no pid yet is live only if its wrapper claimed it.
        if (held.status === 'running' || (held.status === 'starting' && !(yield* this.#unlaunched(dir)))) return held;
        yield* attempt('file', () => this.#files.remove(dir, { recursive: true }));
        yield* attempt('file', () => this.#files.mkdir(dir));
      }

      const record = { id: options.processId, command, cwd: options.cwd ?? '/workspace' };
      yield* attempt('file', () => this.#files.writeFile(`${dir}/process.json`, JSON.stringify(record)));

      const launched = yield* Effect.result(attempt('process', () => this.container.exec(['/bin/sh', '-c', RUN, 'devbox-process', dir, record.cwd, '/bin/bash', '-c', command], {
        env: CONTAINER_TRUST_ENV, stdout: 'ignore', stderr: 'ignore',
      })));

      if (Result.isFailure(launched)) {
        // Refused, or lost after the spawn: the claim says which, and records a launch that never
        // ran, so neither a retry nor a kill adopts it as live. Unreadable, the next one decides.
        const decided = yield* Effect.result(this.#unlaunched(dir));

        return yield* Effect.fail(Result.isSuccess(decided) ? launched.failure : new DevboxError(launched.failure.code,
          `${launched.failure.message}; whether it ran is left to the next start or kill: ${decided.failure.message}`, { cause: launched.failure }));
      }

      return { ...record, pid: undefined, status: 'starting' as const, exitCode: undefined };
    }));
  }

  get(id: string): Promise<ProcessRecord | null> {
    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(id);

      return (yield* this.#status([dir]))[0] ?? null;
    }));
  }

  list(): Promise<ProcessRecord[]> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.container.running) return [];
      const listed = yield* Effect.result(attempt('file', () => this.#files.readDirectory(ROOT)));

      if (Result.isFailure(listed)) {
        const cause = listed.failure.cause;

        if (SandboxFileError.is(cause) && cause.code === 'ENOENT') return [];

        return yield* Effect.fail(listed.failure);
      }

      const dirs = yield* Effect.forEach(listed.success, entry => directory(entry.name));

      return yield* this.#status(dirs);
    }));
  }

  kill(id: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(id);

      // TERM, then KILL whatever of the group outlives the grace; it returns when
      // the group has exited, not at a deadline. `kill -0 -- -N` is a usage error in dash.
      const ended = yield* attempt('process', () => this.container.exec(['/bin/sh', '-c', `dir=$1
[ -f "$dir/process.json" ] || exit 0
set -- "$dir"
${UNLAUNCH} && exit 0
while [ ! -f "$dir/pid" ] && [ ! -f "$dir/exit" ]; do sleep 0.1; done
[ -f "$dir/exit" ] && exit 0
${LIVE}
pid=$(live "$dir") || exit 0
kill -s TERM -- "-$pid" || exit $?
waited=0
while kill -s 0 -- "-$pid" 2>/dev/null; do
  [ "$waited" -eq ${TERM_GRACE_MS / 100} ] && kill -s KILL -- "-$pid" 2>/dev/null
  sleep 0.1; waited=$((waited + 1))
done`, 'devbox-kill', dir]));

      const result = yield* attempt('process', () => ended.output());

      if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `process ${id} was not stopped: ${new TextDecoder().decode(result.stderr)}`));
    }));
  }

  /** `true`: the launch in `dir` never ran, and never will. */
  #unlaunched(dir: string): Effect.Effect<boolean, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const claim = yield* attempt('process', () => this.container.exec(['/bin/sh', '-c', UNLAUNCH, 'devbox-unlaunch', dir]));
      const result = yield* attempt('process', () => claim.output());

      if (result.exitCode > 1) return yield* Effect.fail(new DevboxError('process', `the launch claim failed: ${new TextDecoder().decode(result.stderr)}`));

      return result.exitCode === 0;
    });
  }

  #status(dirs: string[]): Effect.Effect<ProcessRecord[], DevboxError> {
    return Effect.gen({ self: this }, function* () {
      if (dirs.length === 0 || !this.container.running) return [];
      const process = yield* attempt('process', () => this.container.exec(['/bin/sh', '-c', STATUS, 'devbox-status', ...dirs]));
      const result = yield* attempt('process', () => process.output());

      if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `process status failed: ${new TextDecoder().decode(result.stderr)}`));

      return yield* attemptSync('process', () => readProcessRows(new TextDecoder().decode(result.stdout)));
    });
  }
}

function readProcessRows(output: string): ProcessRecord[] {
  const lines = output.trimEnd().split('\n');
  const found: ProcessRecord[] = [];

  for (let at = 0; at + 1 < lines.length; at += 2) {
    const record = v.parse(RecordSchema, JSON.parse(lines[at + 1] ?? ''));
    const [state, value] = (lines[at] ?? '').split(' ');
    const exitCode = state === 'exit' ? Number(value) : undefined;
    let status: ProcessRecord['status'] = exitCode === 0 ? 'completed' : 'failed';

    if (state === 'running' || state === 'starting') status = state;
    found.push({ ...record, pid: state === 'running' ? Number(value) : undefined, status, exitCode });
  }

  return found;
}
