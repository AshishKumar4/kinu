import { Files, SandboxFileError } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { TERM_GRACE_MS } from './lifecycle';

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.system.crt';

// Native exec does not inherit start() env; the upstream coding-agents example passes this per process.
export const CONTAINER_TRUST_ENV = { NODE_EXTRA_CA_CERTS: CA_PATH, REQUESTS_CA_BUNDLE: BUNDLE };

/** The SDK docs' trust step; it keeps no earlier container's CA. */
export const TRUST = ['/bin/sh', '-c', `[ -e ${SYSTEM_BUNDLE} ] || { cp ${BUNDLE} ${SYSTEM_BUNDLE}.tmp && mv ${SYSTEM_BUNDLE}.tmp ${SYSTEM_BUNDLE}; }
timeout 10 sh -c 'until [ -s ${CA_PATH} ]; do sleep 0.1; done' && cat ${SYSTEM_BUNDLE} ${CA_PATH} >${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE}`, 'devbox-trust'] as const;

const ROOT = '/var/tmp/devbox/processes';

const KERNEL_READ = ['/bin/sh', '-c', 'cat /proc/sys/kernel/random/boot_id', 'devbox-incarnation-read'] as const;

// A command queued before stop may be delivered to a replacement kernel. Bind the actual argv, not
// merely its post-call result, so private file mutations, RUN, UNLAUNCH and KILL all share this fence.
const IN_KERNEL = `expected=$1; shift
[ "$(cat /proc/sys/kernel/random/boot_id)" = "$expected" ] || exit 125
exec "$@"`;

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

export function isProcessLive(status: string): boolean {
  return status === 'starting' || status === 'running';
}

/** The claim remains held while native I/O settles, but expiry revokes permission to issue a later mutation. */
function whileCurrent<A>(current: (() => boolean) | undefined, mutate: () => Effect.Effect<A, DevboxError>): Effect.Effect<A, DevboxError> {
  return current === undefined || current() ? mutate()
    : Effect.fail(new DevboxError('cancelled', 'process launch reservation was superseded'));
}

// File-backed identities survive a DO eviction; a process group carries signals. A launch whose exec
// answer was lost is decided by one symlink: `launched` before anything runs, or `unlaunched` set by
// a caller finding no pid and no exit (D48). A missing cwd is the launch's own recorded failure.
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

/** `end_tree PID`: its tree and the groups they lead, gone (D69). Status 3: none was alive. */
export const END_TREE = `end_tree() {
  tree() { for c in $(cat /proc/$1/task/$1/children 2>/dev/null); do tree "$c"; done; [ -d /proc/$1 ] && echo "$1"; }
  first=$(tree "$1")
  groups=$(ps -o pid=,pgid= -p "$(echo $first | tr ' ' ,)" 2>/dev/null | awk '$1 == $2 { print $1 }')
  standing() {
    ps -eo pid=,pgid=,stat= | awk -v pids=" $(echo $first $(tree "$1")) " -v groups=" $(echo $groups) " \\
      '$3 !~ /^Z/ && (index(pids, " " $1 " ") || index(groups, " " $2 " ")) { print $1 }'
  }
  left=$(standing "$1")
  [ -n "$left" ] || return 3
  kill -s TERM $left 2>/dev/null
  waited=0
  while left=$(standing "$1"); [ -n "$left" ]; do
    [ "$waited" -ge ${TERM_GRACE_MS / 100} ] && kill -s KILL $left 2>/dev/null
    sleep 0.1; waited=$((waited + 1))
  done
}`;

const directory = (id: string) => attemptSync('invalid-input', () => `${ROOT}/${v.parse(IdSchema, id)}`);

export class Processes {
  readonly #files: Files;
  constructor(readonly container: Pick<Container, 'exec' | 'running'>, readonly kernel?: string) {
    this.#files = new Files(container);
  }

  incarnation(): Promise<string> {
    return settle(Effect.gen({ self: this }, function* () {
      const read = yield* attempt('process', () => this.container.exec([...KERNEL_READ]));
      const output = yield* attempt('process', () => read.output());
      const kernel = new TextDecoder().decode(output.stdout).trim();

      if (output.exitCode !== 0 || kernel === '') return yield* Effect.fail(new DevboxError('process', 'native kernel identity could not be read'));

      return kernel;
    }));
  }

  inIncarnation(kernel: string): Processes {
    const native = this.container;

    return new Processes({
      get running() { return native.running; },
      exec: (argv, options) => native.exec([
        '/bin/sh', '-c', IN_KERNEL, 'devbox-incarnation', kernel, ...argv,
      ], options),
    }, kernel);
  }

  start(command: string, options: { readonly cwd?: string; readonly processId: string; readonly current?: () => boolean }): Promise<ProcessRecord> {
    if (this.kernel === undefined) return settle(attempt('process', async () => {
      const kernel = await this.incarnation();

      return this.inIncarnation(kernel).start(command, options);
    }));

    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(options.processId);
      yield* whileCurrent(options.current, () => attempt('file', () => this.#files.mkdir(ROOT, { recursive: true })));
      const made = yield* Effect.result(whileCurrent(options.current, () => attempt('file', () => this.#files.mkdir(dir))));

      if (Result.isFailure(made)) {
        const cause = made.failure.cause;

        if (!SandboxFileError.is(cause) || cause.code !== 'EEXIST') return yield* Effect.fail(made.failure);
        const held = (yield* this.#status([dir]))[0];

        if (held === undefined) return yield* Effect.fail(made.failure);

        // A launch with no pid yet is live only if its wrapper claimed it.
        if (held.status === 'running' || (held.status === 'starting' && !(yield* this.#unlaunched(dir, options.current)))) return held;
        yield* whileCurrent(options.current, () => attempt('file', () => this.#files.remove(dir, { recursive: true })));
        yield* whileCurrent(options.current, () => attempt('file', () => this.#files.mkdir(dir)));
      }

      const record = { id: options.processId, command, cwd: options.cwd ?? '/workspace' };
      yield* whileCurrent(options.current, () => attempt('file', () => this.#files.writeFile(`${dir}/process.json`, JSON.stringify(record))));

      const launched = yield* Effect.result(whileCurrent(options.current, () => attempt('process', () => this.container.exec(['/bin/sh', '-c', RUN, 'devbox-process', dir, record.cwd, '/bin/bash', '-c', command], {
        env: CONTAINER_TRUST_ENV, stdout: 'ignore', stderr: 'ignore',
      }))));

      if (Result.isFailure(launched)) {
        // The claim records a launch that never ran, so neither a retry nor a kill adopts it.
        const decided = yield* Effect.result(this.#unlaunched(dir, options.current));

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

  kill(id: string, options: { readonly current?: () => boolean } = {}): Promise<void> {
    if (this.kernel === undefined) return settle(attempt('process', async () => {
      const kernel = await this.incarnation();

      return this.inIncarnation(kernel).kill(id, options);
    }));

    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(id);

      const token = yield* Effect.result(attempt('file', async () => (await this.#files.readFile(`${dir}/pid`)).text()));
      const expected = Result.isSuccess(token) ? token.success.trim() : '';

      if (Result.isFailure(token) && !(SandboxFileError.is(token.failure.cause) && token.failure.cause.code === 'ENOENT')) return yield* Effect.fail(token.failure);

      const ended = yield* whileCurrent(options.current, () => attempt('process', () => this.container.exec(['/bin/sh', '-c', `dir=$1; expected=$2
[ -f "$dir/process.json" ] || exit 0
if [ -n "$expected" ]; then [ "$(cat "$dir/pid" 2>/dev/null)" = "$expected" ] || exit 0; fi
set -- "$dir"
${UNLAUNCH} && exit 0
while [ ! -f "$dir/pid" ] && [ ! -f "$dir/exit" ]; do sleep 0.1; done
[ -f "$dir/exit" ] && exit 0
${LIVE}
pid=$(live "$dir") || exit 0
${END_TREE}
end_tree "$pid" || [ $? -eq 3 ]`, 'devbox-kill', dir, expected])));

      const result = yield* attempt('process', () => ended.output());

      if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `process ${id} was not stopped: ${new TextDecoder().decode(result.stderr)}`));
    }));
  }

  /** `true`: the launch in `dir` never ran, and never will. */
  #unlaunched(dir: string, current?: () => boolean): Effect.Effect<boolean, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const claim = yield* whileCurrent(current, () => attempt('process', () => this.container.exec(['/bin/sh', '-c', UNLAUNCH, 'devbox-unlaunch', dir])));
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
