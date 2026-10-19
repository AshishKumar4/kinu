import * as v from 'valibot';
import { Effect } from 'effect';
import { DevboxError, attempt, attemptSync, observe, settle } from './errors';
import { CONTAINER_ENV, endProcess } from './processes';
import { INSTALL_SESSION_FILES, SAVED_SESSIONS, SESSIONS_FORGET, SESSION_FILES, SESSION_RC_FILE, SESSION_RESUME_FILE, TMUX_CONF_FILE, type SessionRecord } from './sessions';
import { DEVBOX_WORKDIR } from './storage';

const ENV = { ...CONTAINER_ENV, ...SESSION_FILES, TERM: 'xterm-256color' };

/**
 * `$1` the session's id, `$2` its folder: joins the session, or opens it there, first showing what it had before a
 * restart when the box saved it (D97).
 */
const ATTACH = `${INSTALL_SESSION_FILES}
if tmux has-session -t "=$1" 2>/dev/null; then tmux source-file ${TMUX_CONF_FILE}; fi
cd "$2" 2>/dev/null || cd ${DEVBOX_WORKDIR}
if ! tmux has-session -t "=$1" 2>/dev/null && [ -f "${SAVED_SESSIONS}/$1/screen" ]; then
  tmux -f ${TMUX_CONF_FILE} new-session -d -s "$1" -c "$PWD" "sh ${SESSION_RESUME_FILE} $1; exec /bin/bash --rcfile ${SESSION_RC_FILE} -i"
fi
exec tmux -f ${TMUX_CONF_FILE} new-session -A -s "$1" -c "$PWD" /bin/bash --rcfile ${SESSION_RC_FILE} -i`;

const Size = v.object({ cols: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), rows: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)) });

const Resize = v.object({ type: v.literal('resize'), ...Size.entries });

/** One PTY process and the socket that carries it. */
interface TerminalLanes {
  readonly process: ExecProcess;
  readonly server: WebSocket;
  readonly input: WritableStreamDefaultWriter<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
  /** Ends the PTY's tmux client, which leaves its session running (`endProcess`). */
  readonly end: () => void;
}

class TerminalConnection {
  #closed = false;
  #exited = false;

  constructor(readonly lanes: TerminalLanes) {}

  close(code: number, message: string): void {
    if (this.#closed) return;
    this.#closed = true;

    if (!this.#exited) this.lanes.end();
    this.lanes.server.close(code, message);
  }

  #failed(lane: 'input' | 'output', cause: DevboxError): void {
    if (this.#closed && cause.code === 'cancelled') return;
    console.error(`[devbox] native terminal ${lane} failed: ${cause.message}`);
    this.close(1011, `terminal ${lane} failed`);
  }

  accept(event: MessageEvent): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (this.#closed) return;

      if (event.data instanceof ArrayBuffer) {
        yield* attempt('io', () => this.lanes.input.write(new Uint8Array(event.data)));
      } else {
        const resize = yield* attemptSync('invalid-input', () => v.parse(Resize, JSON.parse(event.data)));
        yield* attemptSync('process', () => this.lanes.process.resize(resize.cols, resize.rows));
      }
    }).pipe(Effect.catch(cause => Effect.sync(() => this.#failed('input', cause)))));
  }

  read(): () => void {
    const reader = this.lanes.output.getReader();

    const pump = Effect.gen({ self: this }, function* () {
      for (;;) {
        const chunk = yield* attempt('io', () => reader.read());

        if (chunk.done) break;

        if (!this.#closed) yield* attemptSync('io', () => this.lanes.server.send(chunk.value));
      }

      yield* attempt('process', () => this.lanes.process.exitCode);
      this.#exited = true;
    }).pipe(Effect.onExit(() => attempt('io', async () => {
      await reader.cancel();
      reader.releaseLock();
    })));

    return observe(pump, {
      success: () => this.close(1000, 'terminal exited'),
      failure: cause => this.#failed('output', cause),
    });
  }
}

/** The PTY owns a tmux client, not the workspace shell; detaching must keep the session. */
export function terminalSocket(container: Pick<Container, 'exec'>, params: URLSearchParams, session: SessionRecord): Promise<Response> {
  return settle(Effect.gen(function* () {
    const size = yield* attemptSync('invalid-input', () => v.parse(Size, { cols: Number(params.get('cols') ?? 80), rows: Number(params.get('rows') ?? 24) }));

    const process = yield* attempt('process', () => container.exec(['/bin/sh', '-c', ATTACH, 'devbox-terminal', session.id, session.cwd], {
      pty: size, stdin: 'pipe', env: ENV,
    }));

    const end = (): void => { endProcess(container, process.pid, "ending a terminal's client"); };

    if (process.stdout === null || process.stdin === null) {
      end();

      return yield* Effect.fail(new DevboxError('process', 'native PTY did not provide its streams'));
    }

    const sockets = new WebSocketPair();
    const server = sockets[1];
    server.binaryType = 'arraybuffer';
    server.accept();
    const connection = new TerminalConnection({ process, server, input: process.stdin.getWriter(), output: process.stdout, end });
    const cancelRead = connection.read();
    server.addEventListener('message', event => observe(Effect.promise(() => connection.accept(event)), {
      success: () => undefined,
      failure: () => { connection.close(1011, 'terminal input failed'); cancelRead(); },
    }));
    server.addEventListener('close', () => { connection.close(1000, 'terminal detached'); cancelRead(); });
    server.addEventListener('error', () => { connection.close(1011, 'terminal transport failed'); cancelRead(); });

    return new Response(null, { status: 101, webSocket: sockets[0] });
  }));
}

/** Ends a session's shell and screen, and what a restart saved of it (D97); its next attach opens a fresh one. */
export function resetTerminal(container: Container, id: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const process = yield* attempt('process', () => container.exec(['/bin/sh', '-c', `if tmux has-session -t "=$1" 2>/dev/null; then tmux kill-session -t "=$1"; fi\n${SESSIONS_FORGET}`, 'devbox-reset', id]));
    const response = yield* attempt('process', () => process.output());

    if (response.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', new TextDecoder().decode(response.stderr)));
  }));
}
