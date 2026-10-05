import * as v from 'valibot';
import { Effect } from 'effect';
import { DevboxError, attempt, attemptSync, observe, settle } from './errors';
import { CONTAINER_TRUST_ENV } from './processes';

const ENV = { ...CONTAINER_TRUST_ENV, TERM: 'xterm-256color' };

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
export function terminalSocket(container: Container, params: URLSearchParams): Promise<Response> {
  return settle(Effect.gen(function* () {
    const size = yield* attemptSync('invalid-input', () => v.parse(Size, { cols: Number(params.get('cols') ?? 80), rows: Number(params.get('rows') ?? 24) }));
    const abort = new AbortController();

    const process = yield* attempt('process', () => container.exec(['tmux', 'new-session', '-A', '-s', 'devbox', '-c', '/workspace', '/bin/bash'], {
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

export function resetTerminal(container: Container): Promise<void> {
  return settle(Effect.gen(function* () {
    const process = yield* attempt('process', () => container.exec(['/bin/sh', '-c', 'if tmux has-session -t devbox 2>/dev/null; then tmux kill-session -t devbox; fi']));
    const response = yield* attempt('process', () => process.output());

    if (response.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', new TextDecoder().decode(response.stderr)));
  }));
}
