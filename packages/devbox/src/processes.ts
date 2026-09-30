import { Files, SandboxFileError } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { DevboxError, attempt, attemptSync, settle } from './errors';

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
const RUN = `dir=$1; shift
setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"`;

const STATUS = `for dir in "$@"; do
  [ -f "$dir/process.json" ] || continue
  if [ -f "$dir/exit" ]; then state="exit $(cat "$dir/exit")"
  elif [ ! -f "$dir/pid" ]; then state=starting
  elif kill -0 "$(cat "$dir/pid")" 2>/dev/null; then state="running $(cat "$dir/pid")"
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

        if (held.status === 'running' || held.status === 'starting') return held;
        yield* attempt('file', () => this.#files.remove(dir, { recursive: true }));
        yield* attempt('file', () => this.#files.mkdir(dir));
      }

      const record = { id: options.processId, command, cwd: options.cwd ?? '/workspace' };
      yield* attempt('file', () => this.#files.writeFile(`${dir}/process.json`, JSON.stringify(record)));
      yield* attempt('process', () => this.container.exec(['/bin/sh', '-c', RUN, 'devbox-process', dir, '/bin/bash', '-c', command], {
        cwd: record.cwd, env: CONTAINER_TRUST_ENV, stdout: 'ignore', stderr: 'ignore',
      }));

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

      const ended = yield* attempt('process', () => this.container.exec(['/bin/sh', '-c', `dir=$1
[ -f "$dir/process.json" ] || exit 0
while [ ! -f "$dir/pid" ] && [ ! -f "$dir/exit" ]; do sleep 0.1; done
[ -f "$dir/exit" ] && exit 0
pid=$(cat "$dir/pid")
kill -0 "$pid" 2>/dev/null || exit 0
kill -s TERM -- "-$pid" || exit $?
while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done`, 'devbox-kill', dir]));

      const result = yield* attempt('process', () => ended.output());

      if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `process ${id} was not stopped: ${new TextDecoder().decode(result.stderr)}`));
    }));
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
