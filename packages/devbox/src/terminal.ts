import * as v from 'valibot';
import { Effect } from 'effect';
import { DevboxError, attempt, attemptSync, observe, settle } from './errors';
import { CONTAINER_ENV } from './processes';
import type { SessionRecord } from './sessions';
import { SHELL_RC } from './shown-name';

const ENV = { ...CONTAINER_ENV, TERM: 'xterm-256color' };

/**
 * tmux keeps the shell and its screen across reattaches (DEVBOX-DECISIONS, the PTY proof); none of its own chrome shows.
 * No status line, no prefix key, and the page's terminal keeps its own screen, so what scrolls by lands in its scrollback.
 * A server already running takes the settings at the next attach.
 */
const TMUX_CONF = [
  'set -g status off',
  'set -g prefix None',
  'unbind C-b',
  'set -g escape-time 0',
  'set -g history-limit 50000',
  "set -ga terminal-overrides ',xterm*:smcup@:rmcup@'",
].join('\n');

/**
 * A session's shell starts from the box's rc, the person's own first and the box's shown name in their prompt (D93),
 * then records how its last command ended on its own pane, where the sessions read finds it (D90): the exit status,
 * the time, and the command line, once per command the history numbers.
 */
const SESSION_RC = [
  SHELL_RC,
  '__kinu_entry() { HISTTIMEFORMAT= fc -l -1 2>/dev/null; }',
  '__kinu_seen=$(__kinu_entry); __kinu_seen=${__kinu_seen%%[[:space:]]*}',
  '__kinu_mark() {',
  '  local status=$? entry',
  '  entry=$(__kinu_entry) || return $status',
  '  if [ -n "$entry" ] && [ "${entry%%[[:space:]]*}" != "$__kinu_seen" ]; then',
  '    __kinu_seen=${entry%%[[:space:]]*}',
  '    entry=${entry#*[[:space:]]}',
  '    entry=${entry#"${entry%%[![:space:]]*}"}',
  '    tmux set -p -t "$TMUX_PANE" @kinu_exit "$status" \\; set -p -t "$TMUX_PANE" @kinu_at "$(date +%s)" \\; set -p -t "$TMUX_PANE" @kinu_last "$entry" 2>/dev/null',
  '  fi',
  '  return $status',
  '}',
  'PROMPT_COMMAND="__kinu_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
].join('\n');

/** `$1` the config, `$2` the session's id, `$3` its folder, `$4` the shell's rc: joins the session, or opens it there. */
const ATTACH = `printf '%s\\n' "$1" > /etc/devbox-tmux.conf
printf '%s\\n' "$4" > /etc/devbox-session.bashrc
if tmux has-session -t "=$2" 2>/dev/null; then tmux source-file /etc/devbox-tmux.conf; fi
cd "$3" 2>/dev/null || cd /workspace
exec tmux -f /etc/devbox-tmux.conf new-session -A -s "$2" -c "$PWD" /bin/bash --rcfile /etc/devbox-session.bashrc -i`;

const Size = v.object({ cols: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), rows: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)) });

const Resize = v.object({ type: v.literal('resize'), ...Size.entries });

/** One PTY process and the socket that carries it. */
interface TerminalLanes {
  readonly process: ExecProcess;
  readonly server: WebSocket;
  readonly input: WritableStreamDefaultWriter<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
  readonly abort: AbortController;
}

class TerminalConnection {
  #closed = false;
  #exited = false;

  constructor(readonly lanes: TerminalLanes) {}

  close(code: number, message: string): void {
    if (this.#closed) return;
    this.#closed = true;

    if (!this.#exited) this.lanes.abort.abort();
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
export function terminalSocket(container: Container, params: URLSearchParams, session: SessionRecord): Promise<Response> {
  return settle(Effect.gen(function* () {
    const size = yield* attemptSync('invalid-input', () => v.parse(Size, { cols: Number(params.get('cols') ?? 80), rows: Number(params.get('rows') ?? 24) }));
    const abort = new AbortController();

    const process = yield* attempt('process', () => container.exec(['/bin/sh', '-c', ATTACH, 'devbox-terminal', TMUX_CONF, session.id, session.cwd, SESSION_RC], {
      pty: size, stdin: 'pipe', env: ENV, signal: abort.signal,
    }));

    if (process.stdout === null || process.stdin === null) {
      abort.abort();

      return yield* Effect.fail(new DevboxError('process', 'native PTY did not provide its streams'));
    }

    const sockets = new WebSocketPair();
    const server = sockets[1];
    server.binaryType = 'arraybuffer';
    server.accept();
    const connection = new TerminalConnection({ process, server, input: process.stdin.getWriter(), output: process.stdout, abort });
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

/** Ends a session's shell and screen; its next attach opens a fresh one under the same name. */
export function resetTerminal(container: Container, id: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const process = yield* attempt('process', () => container.exec(['/bin/sh', '-c', 'if tmux has-session -t "=$1" 2>/dev/null; then tmux kill-session -t "=$1"; fi', 'devbox-reset', id]));
    const response = yield* attempt('process', () => process.output());

    if (response.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', new TextDecoder().decode(response.stderr)));
  }));
}
