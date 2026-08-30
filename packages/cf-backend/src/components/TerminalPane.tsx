/**
 * The environment terminal.
 *
 * One xterm instance, two drivers:
 *
 *   PTY   — the sandbox container. A real pseudo-terminal: `htop`, `vim` and
 *           anything else that paints a screen works, arrow keys and Ctrl-C
 *           reach the foreground process, and a resize reaches the shell.
 *           `SandboxAddon` (shipped by @cloudflare/sandbox/xterm) is the client
 *           half of the container's own PTY protocol — binary frames of
 *           terminal bytes each way, `{type:'resize'}` out, `ready`/`exit`/
 *           `error` in — so the wire format is the SDK's, not ours, and
 *           reconnect/replay come with it.
 *
 *   LINE  — every environment with no pseudo-terminal (see lib/terminal-lane.ts
 *           for what each one is missing). A command in, its output back, and
 *           the pane SAYS it is line mode. This is the honest version of what
 *           the whole pane used to be: an emulated prompt over one-shot exec
 *           that looked like a shell and could not run one.
 *
 * The lane decides which driver runs, and the route agrees with it because both
 * read the same table.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SandboxAddon } from "@cloudflare/sandbox/xterm";
import "@xterm/xterm/css/xterm.css";
import { describeError } from "@/hooks/use-async-resource";
import { renderThrownChain } from "@kinu.run/core/obs";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";
import { LineTerminalState, terminalLane } from "@/lib/terminal-lane";
import type { ExecutorCommandResult } from "@/lib/protocol";

export interface TerminalPaneOutput {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  /** Stored lengths of the two streams. The server clips what it sends, and a
   *  pane that showed the prefix alone would present part of an output as the
   *  whole of it — so the clip is drawn, never implied. */
  stdout_len: number;
  stderr_len: number;
  exit_code: number;
  created_at: number;
}

export interface TerminalPaneProps {
  /** The workspace this terminal belongs to. The socket is per workspace, so
   *  the pane is told which one rather than re-deriving it from the URL. */
  workspace: string;
  /** Executor namespace: `sandbox`, `workspace`, `laptop`, `parent`. */
  executor: string;
  /** Line-mode inputs. Unused by the PTY driver, which streams from the
   *  container instead of reading broadcast exec rows. */
  outputs?: readonly TerminalPaneOutput[];
  onExecute?: (cmd: string) => Promise<ExecutorCommandResult>;
}

/** How often an attached terminal tells the server a human is still here.
 *
 *  The container proxy renews the SDK's activity clock on every frame it
 *  forwards, but the DURABLE lease that decides whether the container may take
 *  its final checkpoint and stop is only moved by an operation on the object —
 *  which a proxied frame is not. Without this beat a container can quiesce
 *  under someone who is typing. A minute is far inside the idle gate, and the
 *  server throttles the durable write itself. */
const KEEPALIVE_MS = 60_000;

/** xterm's own default is 1000 lines, which a build log overruns in seconds. */
const SCROLLBACK_LINES = 5_000;

export function TerminalPane({ workspace, executor, outputs, onExecute }: TerminalPaneProps) {
  const lane = terminalLane(executor);
  return lane.mode === "pty"
    ? <PtyTerminal workspace={workspace} executor={executor} />
    : <LineTerminal executor={executor} missing={lane.missing} outputs={outputs ?? []} onExecute={onExecute} />;
}

/* ── PTY ──────────────────────────────────────────────────────────────── */

type PtyState = "connecting" | "connected" | "disconnected";

interface TerminalOperation {
  promise: Promise<void> | null;
}

function PtyTerminal({ workspace, executor }: { workspace: string; executor: string }) {
  const theme = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const addonRef = useRef<SandboxAddon | null>(null);
  const copyOperation = useRef<TerminalOperation | null>(null);
  const keepaliveOperations = useRef(new Map<string, TerminalOperation>());
  const [state, setState] = useState<PtyState>("connecting");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = newTerminal(theme.mode);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    const addon = new SandboxAddon({
      // The terminal's socket, on the app's own origin under the workspace's
      // authenticated path — the cookie and `Origin` the handshake carries are
      // what authorize it. Geometry rides the query so the container's first
      // paint is already the right size instead of an 80x24 frame that reflows.
      getWebSocketUrl: ({ sandboxId, origin }) =>
        `${origin}/api/workspaces/${encodeURIComponent(sandboxId)}/terminal`
        + `?executor=${encodeURIComponent(executor)}&cols=${term.cols}&rows=${term.rows}`,
      onStateChange: (next, error) => {
        setState(next);
        // A reconnecting socket is not a failure to report; a stated error is.
        setFailure(error ? error.message : null);
      },
    });
    term.loadAddon(addon);
    addonRef.current = addon;
    addon.connect({ sandboxId: workspace });

    // Copy needs a chord that is not Ctrl-C, because Ctrl-C is a byte the
    // foreground program must receive (a full-screen app reads it as a
    // keystroke). Ctrl/Cmd-Shift-C copies the selection; paste is left to
    // xterm's own handling of the browser paste event, which Ctrl-V and Cmd-V
    // already produce.
    term.attachCustomKeyEventHandler((event) => {
      const copyChord = (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyC";
      if (!copyChord || event.type !== "keydown") return true;
      const selection = term.getSelection();
      if (!selection) return true;
      if (copyOperation.current !== null) return false;
      const owner: TerminalOperation = { promise: null };
      // The key handler must return its boolean synchronously, so install the
      // owner before the browser action starts and cleanup can fence its result.
      copyOperation.current = owner;
      owner.promise = (async () => {
        try {
          await navigator.clipboard.writeText(selection);
        } catch (cause) {
          if (copyOperation.current === owner) {
            // The pane's failure line is the reader: the header advertises the
            // chord, so a refused clipboard write must not vanish.
            setFailure(`clipboard refused the copy: ${renderThrownChain({ cause })}`);
          }
        } finally {
          if (copyOperation.current === owner) copyOperation.current = null;
        }
      })();
      return false;
    });

    // The pane resizes with the layout, not only with the window: a sidebar
    // opening changes the element and nothing else. xterm's own resize event
    // is what the addon turns into a control frame, so fitting is enough.
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);

    return () => {
      copyOperation.current = null;
      keepaliveOperations.current.clear();
      observer.disconnect();
      addon.dispose();
      term.dispose();
      termRef.current = null;
      addonRef.current = null;
    };
  }, [workspace, executor]);

  // xterm cannot read CSS custom properties, so the palette is applied
  // imperatively on every theme change — both axes, since either can move.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme.mode);
  }, [theme]);

  useEffect(() => {
    if (state !== "connected") return;
    const beat = setInterval(() => {
      const keepaliveKey = crypto.randomUUID();
      const owner: TerminalOperation = { promise: null };
      // Install the owner before the fetch starts; several keepalives may be
      // outstanding at once, so each owns its own map entry.
      keepaliveOperations.current.set(keepaliveKey, owner);
      owner.promise = (async () => {
        try {
          const response = await fetch(
            `/api/workspaces/${encodeURIComponent(workspace)}/terminal/keepalive`
            + `?executor=${encodeURIComponent(executor)}`,
            { method: "POST", credentials: "same-origin" },
          );
          // A missed beat costs at most one idle cycle of lease, so it is not
          // fatal — but it is shown rather than discarded, because the reason
          // (container gone, attach failed) arrives here before the socket says so.
          if (keepaliveOperations.current.get(keepaliveKey) === owner && !response.ok) {
            setFailure(`the container refused the terminal's keepalive (${response.status})`);
          }
        } catch (cause) {
          if (keepaliveOperations.current.get(keepaliveKey) === owner) {
            setFailure(describeError(cause));
          }
        } finally {
          if (keepaliveOperations.current.get(keepaliveKey) === owner) {
            keepaliveOperations.current.delete(keepaliveKey);
          }
        }
      })();
    }, KEEPALIVE_MS);
    return () => {
      clearInterval(beat);
      keepaliveOperations.current.clear();
    };
  }, [state, workspace, executor]);

  // A shell that exits leaves the container holding a dead PTY that every later
  // attach is handed, so the way back has to be reachable from the pane itself.
  const restart = async () => {
    setFailure(null);
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspace)}/terminal/reset`
      + `?executor=${encodeURIComponent(executor)}`,
      { method: "POST", credentials: "same-origin" },
    );
    if (!response.ok) {
      setFailure(describeError(await response.text()));
      return;
    }
    termRef.current?.reset();
    addonRef.current?.disconnect();
    addonRef.current?.connect({ sandboxId: workspace });
  };

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 text-[10px] p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>{state === "connected" ? "interactive shell" : state}</span>
        {failure !== null && <span className="p-danger truncate" title={failure}>{failure}</span>}
        <button type="button" onClick={async () => {
          try {
            await restart();
          } catch (cause) {
            setFailure(renderThrownChain({ cause }));
          }
        }}
          className="ml-auto shrink-0 underline decoration-dotted hover:p-text-2 cursor-pointer"
          title="Destroy this shell and open a new one. The only way back from a shell that exited.">
          restart shell
        </button>
        {/* What the chords actually do here. `⌃C` reaches a full-screen program
            (they read it as a keystroke), but bash job control is unavailable in
            this container: the PTY's shell is not a session leader with the
            terminal as its controlling tty, so the kernel has no foreground
            group to signal. Saying "⌃C interrupts" would be the fake. */}
        <span className="shrink-0" title="The container's shell has no controlling terminal, so bash job control (interrupt, suspend, fg/bg) is unavailable. A full-screen program still receives ⌃C as a keystroke.">
          ⇧⌃C copies · no job control
        </span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}

/* ── line mode ────────────────────────────────────────────────────────── */

/** The in-flight marker, on its own line so it can be erased whole. */
const BUSY = "\x1b[2m⋯ running\x1b[0m";

function LineTerminal(
  { executor, missing, outputs, onExecute }: {
    executor: string;
    missing: string;
    outputs: readonly TerminalPaneOutput[];
    onExecute?: (cmd: string) => Promise<ExecutorCommandResult>;
  },
) {
  const theme = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const lineStateRef = useRef<LineTerminalState | null>(null);
  if (lineStateRef.current === null) lineStateRef.current = new LineTerminalState();
  const lineState = lineStateRef.current;
  const commandOperation = useRef<TerminalOperation | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The parent hands a fresh closure every render. Held in a ref so the effect
  // below stays keyed on the executor alone: rebuilding the terminal per render
  // would wipe the scrollback under whoever was reading it.
  const execute = useRef(onExecute);
  execute.current = onExecute;

  useEffect(() => {
    const generation = lineState.reset();
    const host = hostRef.current;
    if (!host) return;
    const term = newTerminal(theme.mode);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    promptLine(term);

    const typing = term.onData((data) => {
      const run = execute.current;
      if (lineState.running || !run) return;
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 0x0d) {
          const cmd = lineState.takeLine();
          term.write("\r\n");
          if (!cmd.trim()) {
            promptLine(term);
            continue;
          }
          // Keystrokes are dropped while a command runs, so say so; the marker
          // is cleared by whichever of the two paths below lands.
          lineState.beginCommand();
          term.write(BUSY);
          setFailure(null);
          // xterm owns a synchronous data callback, so retain the background
          // promise until it settles even though the executor generation fences it.
          const owner: TerminalOperation = { promise: null };
          commandOperation.current = owner;
          owner.promise = (async () => {
            try {
              // A command that FAILS is an outcome, not a lost failure: its error
              // belongs on the terminal row. The rejection is therefore held as a
              // value, and the two fences — a reset generation, a rebuilt terminal
              // — are decided once below, on the same footing for a command that
              // failed and one that did not, instead of as a return out of the
              // handler that reads identically for a stale row and a failed one.
              let thrown: { readonly cause: unknown } | undefined;
              try {
                await run(cmd);
              } catch (cause) {
                thrown = { cause };
              }
              if (!lineState.finishCommand(generation)) return;
              if (termRef.current !== term) return;
              if (thrown !== undefined) {
                // A rejected exec produces no output row, so nothing else would
                // ever clear the marker or reprint the prompt.
                clearBusy(term, lineState);
                term.write(`\x1b[31m${describeError(thrown.cause)}\x1b[0m\r\n`);
                promptLine(term);
              }
            } catch (cause) {
              if (lineState.finishCommand(generation) && termRef.current === term) {
                clearBusy(term, lineState);
                setFailure(describeError(cause));
              }
            } finally {
              if (commandOperation.current === owner) commandOperation.current = null;
            }
          })();
          return;
        } else if (code === 0x7f || code === 0x08) {
          if (lineState.backspace()) term.write("\b \b");
        } else if (code === 0x03) {
          lineState.clearLine();
          term.write("^C\r\n");
          promptLine(term);
        } else if (code >= 0x20) {
          lineState.append(ch);
          term.write(ch);
        }
      }
    });

    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);

    return () => {
      commandOperation.current = null;
      lineState.reset();
      typing.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [executor]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme.mode);
  }, [theme]);

  // New outputs as ANSI rows, deduped so a re-render never reprints a row.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let wrote = false;
    for (const out of outputs) {
      if (!lineState.recordOutput(out.id)) continue;
      clearBusy(term, lineState);
      if (out.stdout) {
        term.write(out.stdout);
        if (!out.stdout.endsWith("\n")) term.write("\r\n");
      }
      writeClipNote(term, "stdout", out.stdout.length, out.stdout_len);
      if (out.stderr && out.exit_code !== 0) {
        term.write(`\x1b[31m${out.stderr}\x1b[0m`);
        if (!out.stderr.endsWith("\n")) term.write("\r\n");
      }
      if (out.exit_code !== 0) writeClipNote(term, "stderr", out.stderr.length, out.stderr_len);
      wrote = true;
    }
    if (wrote) promptLine(term);
  }, [outputs]);

  return (
    <div className="w-full h-full flex flex-col">
      {/* What this pane is, and why it is not a shell. A user who types `htop`
          here deserves the reason on screen rather than a hung command. */}
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 text-[10px] p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>line mode — one command at a time, no interactive programs</span>
        {failure !== null && <span className="p-danger truncate" title={failure}>{failure}</span>}
        <span className="ml-auto truncate" title={missing}>{missing}</span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}

/* ── shared ───────────────────────────────────────────────────────────── */

function newTerminal(mode: ThemeMode): Terminal {
  return new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: SCROLLBACK_LINES,
    theme: terminalTheme(mode),
  });
}

function promptLine(term: Terminal) {
  term.write("\x1b[32m$\x1b[0m ");
}

function clearBusy(term: Terminal, state: LineTerminalState) {
  if (!state.clearBusy()) return;
  term.write("\r\x1b[2K"); // carriage return + erase line
}

/** Say what the row is not showing. Silence here would turn a clipped prefix
 *  into a claim about the whole output. */
function writeClipNote(term: Terminal, stream: string, shown: number, stored: number) {
  const withheld = stored - shown;
  if (withheld <= 0) return;
  term.write(`\x1b[2m… ${withheld.toLocaleString()} more ${stream} characters are stored and not shown here\x1b[0m\r\n`);
}

/**
 * xterm needs concrete colours, not custom properties, so the palette is read
 * off the document at theme time. Hardcoding it is what let the previous
 * terminal drift a whole palette behind.
 *
 * ANSI is a protocol: a program that emits `\x1b[31m` means "error", so the
 * four slots with a status role take that role's token. Magenta and cyan have
 * no status meaning and no token; they stay distinguishable (a shell that
 * colours by type needs them to be) but are pulled into the warm family rather
 * than shipping the only violet and cyan in the product.
 */
const ANSI_UNTOKENED = {
  dark: { magenta: "#c9a0c6", cyan: "#8fbdb8" },
  light: { magenta: "#7a3f74", cyan: "#2f6660" },
} as const;

function terminalTheme(mode: ThemeMode): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  const cs = getComputedStyle(document.documentElement);
  const tok = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: tok("--c-bg"),
    foreground: tok("--c-text"),
    cursor: tok("--c-accent"),
    black: tok("--c-recessed"),
    white: tok("--c-text"),
    red: tok("--c-danger"),
    green: tok("--c-success"),
    yellow: tok("--c-warning"),
    blue: tok("--c-info"),
    ...ANSI_UNTOKENED[mode],
  };
}
