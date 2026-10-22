import * as v from 'valibot';
import { Effect } from 'effect';
import { DevboxError, attempt, attemptSync, observe, settle } from './errors';
import { boxEnv, containerExec, endProcess, resizePty, type TerminalSize } from './processes';
import { INSTALL_SESSION_FILES, SAVED_SESSIONS, SESSIONS_FORGET, SESSION_FILES, SESSION_RC_FILE, SESSION_RESUME_FILE, TMUX_CONF_FILE, type SessionRecord } from './sessions';
import { DEVBOX_WORKDIR } from './storage';
import { holdReadiness, type ReadinessHold } from './readiness-hold';

const ENV = boxEnv({ ...SESSION_FILES, TERM: 'xterm-256color' });

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
  /** The box's end of the pane's socket: the PTY's bytes go out on it, and it is closed with the terminal. */
  readonly server: Pick<WebSocket, 'send' | 'close'>;
  readonly input: WritableStreamDefaultWriter<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
  /** Ends the PTY's tmux client, which leaves its session running (`endProcess`). */
  readonly end: () => void;
  readonly resize: (size: TerminalSize) => Effect.Effect<'resized' | 'ended', DevboxError>;
  /** The size the PTY opened at. */
  readonly size: TerminalSize;
}

class TerminalConnection {
  #closed = false;
  #exited = false;
  /** The size the pane asked for last, while a resize runs: a pane being dragged asks many times, and only its last counts. */
  #wanted: TerminalSize | null = null;
  #resizing = false;
  /** The PTY's size now: a pane that asks for it again is answered without an exec. */
  #size: TerminalSize;

  constructor(readonly lanes: TerminalLanes) {
    this.#size = lanes.size;
  }

  close(code: number, message: string): void {
    if (this.#closed) return;
    this.#closed = true;

    if (!this.#exited) this.lanes.end();
    this.lanes.server.close(code, message);
  }

  /** A lane that failed while the terminal is open closes it; one failing after it closed or its client exited is no news. */
  failed(lane: 'input' | 'output', cause: DevboxError): void {
    if (this.#closed || this.#exited) return;
    console.error(`[devbox] native terminal ${lane} failed: ${cause.message}`);
    this.close(1011, `terminal ${lane} failed`);
  }

  accept(data: string | ArrayBuffer): Effect.Effect<void, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      if (this.#closed) return;

      if (data instanceof ArrayBuffer) {
        yield* attempt('io', () => this.lanes.input.write(new Uint8Array(data)));
      } else {
        const resize = yield* attemptSync('invalid-input', () => v.parse(Resize, JSON.parse(data)));

        yield* this.#resizes({ cols: resize.cols, rows: resize.rows });
      }
    });
  }

  /** Runs the resize the pane asked for, then each it asked for meanwhile, last first; one asked while one runs waits. */
  #resizes(size: TerminalSize): Effect.Effect<void, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      this.#wanted = size;

      if (this.#resizing) return;
      this.#resizing = true;

      yield* Effect.gen({ self: this }, function* () {
        for (let next = this.#wanted; next !== null && !this.#closed; next = this.#wanted) {
          this.#wanted = null;

          if (next.cols === this.#size.cols && next.rows === this.#size.rows) continue;

          // A client gone mid-resize ended its terminal: its output's end closes the socket, and no size is owed it.
          if ((yield* this.lanes.resize(next)) === 'ended') return;
          this.#size = next;
        }
      }).pipe(Effect.ensuring(Effect.sync(() => { this.#resizing = false; })));
    });
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
      failure: cause => this.failed('output', cause),
    });
  }
}

/** What a terminal's end of its socket says, as the runtime hands a held socket's events to its object. */
export interface TerminalSocketEvents {
  message(data: string | ArrayBuffer): void;
  close(): void;
  error(): void;
}

/** A frame the box tells a pane while its terminal is not yet attached, or as it attaches (D109): JSON text, the PTY's
 *  own bytes being binary. */
export type TerminalControl = { readonly type: 'status'; readonly text: string } | { readonly type: 'ready' } | { readonly type: 'error'; readonly error: string };

/**
 * The session's PTY on `server`, the box's end of the pane's socket, which the box already gave the runtime
 * (`acceptWebSocket`): an end the object accepts itself is its request until it closes, and the visitor's close, even a
 * clean one, then ends that request as the uncaught "Network connection lost." (D109). The answer is where the socket's
 * events go. The PTY owns a tmux client, not the workspace shell: detaching keeps the session.
 */
export function attachTerminal(container: Pick<Container, 'exec'>, params: URLSearchParams, session: SessionRecord, server: Pick<WebSocket, 'send' | 'close'>): Promise<TerminalSocketEvents> {
  return settle(Effect.gen(function* () {
    const size = yield* attemptSync('invalid-input', () => v.parse(Size, { cols: Number(params.get('cols') ?? 80), rows: Number(params.get('rows') ?? 24) }));

    const process = yield* attempt('process', () => containerExec(container, ['/bin/sh', '-c', ATTACH, 'devbox-terminal', session.id, session.cwd], {
      pty: size, stdin: 'pipe', env: ENV,
    }));

    const end = (): void => { endProcess(container, process.pid, "ending a terminal's client"); };

    if (process.stdout === null || process.stdin === null) {
      end();

      return yield* Effect.fail(new DevboxError('process', 'native PTY did not provide its streams'));
    }

    const resize = (wanted: TerminalSize) => resizePty(container, process.pid, wanted);
    const connection = new TerminalConnection({ process, server, input: process.stdin.getWriter(), output: process.stdout, end, resize, size });
    const cancelRead = connection.read();

    return {
      message: (data) => observe(connection.accept(data), {
        success: () => undefined,
        failure: (cause) => { connection.failed('input', cause); cancelRead(); },
      }),
      close: () => { connection.close(1000, 'terminal detached'); cancelRead(); },
      error: () => { connection.close(1011, 'terminal transport failed'); cancelRead(); },
    };
  }));
}

/** What `attachWhenReady` needs of the box: its readiness, held as the workspace holds it, and the attach itself. */
export interface TerminalAttach extends Pick<ReadinessHold, 'ask' | 'wait' | 'now'> {
  /** The box's end of the pane's socket, which the runtime holds. */
  readonly socket: Pick<WebSocket, 'send' | 'close'>;
  /** True while the box still holds the socket: false once the pane left. */
  readonly held: () => boolean;
  /** The PTY, once the box is ready. */
  readonly attach: () => Promise<TerminalSocketEvents>;
}

/**
 * The pane's PTY once the box is ready (D109), the pane told each new reason it waits in a `status` frame meanwhile.
 * Null when the pane left first, or when the box could not attach it: an `error` frame then says why in the box's words,
 * and the socket closes 1011.
 */
export async function attachWhenReady(box: TerminalAttach): Promise<TerminalSocketEvents | null> {
  const tell = (frame: TerminalControl): void => { if (box.held()) box.socket.send(JSON.stringify(frame)); };

  let told = '';

  const sayWhy = ({ reason }: { readonly reason: string }): void => {
    if (reason === told) return;
    told = reason;
    tell({ type: 'status', text: reason });
  };

  const attached = Effect.flatMap(attempt('io', () => holdReadiness({ ...box, gone: () => !box.held(), pending: sayWhy })), (readiness) => {
    if (!box.held()) return Effect.succeed(null);

    if (readiness.kind === 'pending') return Effect.fail(new DevboxError('io', readiness.reason));

    return attempt('io', () => box.attach());
  });

  return await settle(Effect.catchTag(attached, 'DevboxError', (failure) => Effect.sync(() => {
    tell({ type: 'error', error: failure.message });
    box.socket.close(1011, 'the terminal could not attach');

    return null;
  })));
}

/** Ends a session's shell and screen, and what a restart saved of it (D97); its next attach opens a fresh one. */
export function resetTerminal(container: Container, id: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const process = yield* attempt('process', () => containerExec(container, ['/bin/sh', '-c', `if tmux has-session -t "=$1" 2>/dev/null; then tmux kill-session -t "=$1"; fi\n${SESSIONS_FORGET}`, 'devbox-reset', id]));
    const response = yield* attempt('process', () => process.output());

    if (response.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', new TextDecoder().decode(response.stderr)));
  }));
}
