/**
 * What kind of terminal each environment can actually give a user.
 *
 * One module because the answer has two readers that must agree: the route
 * that attaches the socket (terminal-route.ts) and the pane that renders it
 * (components/TerminalPane.tsx). A pane that offered a PTY the route refuses
 * would be a terminal that fails on connect, and a pane that fell back to line
 * mode where a PTY exists would be the fake shell this replaces.
 *
 * Client-safe by construction: no imports, so the browser bundle can hold it.
 */

/**
 * A `line` lane names the primitive the environment is missing, because a
 * refusal that only says "unsupported" is what leaves a user typing `htop`
 * into something that cannot run it. Line mode is a real mode — a command in,
 * its output back — and it is labelled as one.
 */
export type TerminalLane =
  | { mode: 'pty' }
  | { mode: 'line'; missing: string };

/**
 * Mutable state owned by one line terminal. Changing executor starts a new
 * generation so work started for the previous terminal cannot complete into
 * this one.
 */
export class LineTerminalState {
  #generation = 0;
  #writtenOutputIds = new Set<string>();
  #line = '';
  #running = false;
  #busy = false;

  reset(): number {
    this.#generation += 1;
    this.#writtenOutputIds.clear();
    this.#line = '';
    this.#running = false;
    this.#busy = false;
    return this.#generation;
  }

  get running(): boolean {
    return this.#running;
  }

  recordOutput(id: string): boolean {
    if (this.#writtenOutputIds.has(id)) return false;
    this.#writtenOutputIds.add(id);
    return true;
  }

  takeLine(): string {
    const line = this.#line;
    this.#line = '';
    return line;
  }

  append(data: string) {
    this.#line += data;
  }

  backspace(): boolean {
    if (this.#line.length === 0) return false;
    this.#line = this.#line.slice(0, -1);
    return true;
  }

  clearLine() {
    this.#line = '';
  }

  beginCommand() {
    this.#running = true;
    this.#busy = true;
  }

  finishCommand(generation: number): boolean {
    if (generation !== this.#generation) return false;
    this.#running = false;
    return true;
  }

  clearBusy(): boolean {
    if (!this.#busy) return false;
    this.#busy = false;
    return true;
  }
}

/**
 * Per-environment terminal capability, established from each environment's own
 * source rather than from what would be convenient.
 *
 * `sandbox` — @cloudflare/sandbox 0.12.8 runs a real pseudo-terminal:
 *   `sandbox-container/src/pty.ts` spawns the shell against a `Bun.Terminal`
 *   (`name: 'xterm-256color'`, `TERM=xterm-256color` in the child's env),
 *   `resize(cols, rows)` reaches that terminal, and a 256 KiB ring buffer
 *   replays to a reattaching client.
 *
 * `workspace` — Nimbus. Its session handle (core/src/execution/nimbus.ts,
 *   `NimbusSandboxHandle`) offers `exec` with a one-shot `stdin?: string`,
 *   `startProcess` with `processes.logs(pid)` polling, and nothing more: no
 *   bidirectional byte stream, no resize, no raw-mode input. Nimbus is a
 *   JS/WASM substrate and its own tty shim states there is no real TTY
 *   (`@nimbus-sh/core` substrate/lifo/node-compat/tty.d.ts), so its processes
 *   have no controlling terminal to attach to.
 *
 * `laptop` — the pc-agent daemon. Its JSON-RPC surface is exec, readFile,
 *   writeFile, listFiles, exists, listPorts, which and the checkpoint calls
 *   (packages/pc-agent/src/index.js); every one is a correlated
 *   request/response, and the daemon holds no pseudo-terminal binding.
 *
 * `parent` — a fork reaching its origin's exec plane, one call per command,
 *   with no session of its own to attach to.
 */
export function terminalLane(executor: string): TerminalLane {
  switch (executor) {
    case 'sandbox':
      return { mode: 'pty' };
    case 'workspace':
      return {
        mode: 'line',
        missing:
          'the Nimbus session exposes exec and startProcess only — no pseudo-terminal, ' +
          'no streaming stdin, no resize',
      };
    case 'laptop':
      return {
        mode: 'line',
        missing:
          "the device daemon's JSON-RPC surface has no pty method — it would need a " +
          'pseudo-terminal binding and a streaming frame type on the device socket',
      };
    case 'parent':
      return {
        mode: 'line',
        missing: "a fork runs commands on its origin's exec plane and holds no session of its own",
      };
    default:
      return { mode: 'line', missing: `no terminal capability is declared for "${executor}"` };
  }
}
