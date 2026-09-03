/**
 * The environment terminal.
 *
 * One xterm instance, two families of driver:
 *
 *   PTY   — a real pseudo-terminal: `htop`, `vim` and anything else that
 *           paints a screen works, arrow keys and Ctrl-C reach the foreground
 *           process, and a resize reaches the shell. Two environments have
 *           one, so there are two PTY drivers built on the same xterm
 *           construction — open, fit, keep-fitted, copy chord — factored into
 *           `mountPtyTerminal` so neither repeats it:
 *
 *             sandbox — the container. `SandboxAddon` (shipped by
 *             @cloudflare/sandbox/xterm) is the client half of the container's
 *             own PTY protocol — binary frames of terminal bytes each way,
 *             `{type:'resize'}` out, `ready`/`exit`/`error` in — so the wire
 *             format is the SDK's, not ours, and reconnect/replay come with it.
 *
 *             device — the user's own machine. `SandboxAddon` is addressed by
 *             container id and cannot reach it, so this file opens its own
 *             WebSocket and speaks the same shape by hand: binary frames each
 *             way, `{type:'resize'}` out, `ready`/`exit`/`error` in.
 *
 *   LINE  — every environment with no pseudo-terminal. A command in, its
 *           output back, and the pane SAYS it is line mode. This is the honest
 *           version of what the whole pane used to be: an emulated prompt over
 *           one-shot exec that looked like a shell and could not run one.
 *
 * The lane decides PTY or line, and the route agrees with it because both read
 * the same table. Which PTY driver runs inside that family is this file's own
 * call, by executor. lib/terminal-lane.ts holds the lane table, the line-mode
 * label, and the line editor and painter this file mounts — everything that is
 * decided over strings rather than over the DOM.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SandboxAddon } from "@cloudflare/sandbox/xterm";
import "@xterm/xterm/css/xterm.css";
import { describeError } from "@/hooks/use-async-resource";
import { renderThrownChain, tolerate } from "@kinu.run/core/obs";
import * as v from "valibot";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";
import {
  BUSY, LINE_MODE_LABEL, LineTerminalState, clearBusy, feedInput, terminalLane, writeOutputRow, writePrompt,
  type TerminalPaneOutput,
} from "@/lib/terminal-lane";
import type { ExecutorCommandResult } from "@/lib/protocol";

// The row type is declared with the driver that paints it and named here
// because this pane's props are what a reader looks at to find it.
export type { TerminalPaneOutput };

export interface TerminalPaneProps {
  /** The workspace this terminal belongs to. The socket is per workspace, so
   *  the pane is told which one rather than re-deriving it from the URL. */
  workspace: string;
  /** Executor namespace: `sandbox`, `workspace`, `laptop`, `parent`. */
  executor: string;
  /** Line-mode inputs. Unused by either PTY driver, which streams live from
   *  its own transport instead of reading broadcast exec rows. */
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
  if (lane.mode !== "pty") return <LineTerminal executor={executor} outputs={outputs ?? []} onExecute={onExecute} />;
  return executor === "laptop"
    ? <DeviceTerminal workspace={workspace} executor={executor} />
    : <PtyTerminal workspace={workspace} executor={executor} />;
}

/* ── PTY ──────────────────────────────────────────────────────────────── */

type PtyState = "connecting" | "connected" | "disconnected";

interface TerminalOperation {
  promise: Promise<void> | null;
}

/**
 * What every PTY driver needs before it speaks a byte to its transport: an
 * xterm instance opened into the host, kept fitted to it as the host resizes,
 * and the copy chord that works whether or not the shell owns Ctrl-C. Each
 * driver loads its own transport on top of the returned terminal and folds its
 * own teardown around the returned `dispose`.
 */
/** One xterm, fitted and wired, and the way to take it down again. Both
 *  pty drivers mount through this so neither repeats the construction. */
interface MountedPty {
  term: Terminal;
  dispose: () => void;
}

function mountPtyTerminal(
  host: HTMLDivElement,
  mode: ThemeMode,
  copyOperation: { current: TerminalOperation | null },
  setFailure: (message: string | null) => void,
): MountedPty {
  const term = newTerminal(mode);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

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
  // opening changes the element and nothing else. Re-fitting keeps xterm's
  // internal geometry in sync; each driver turns the resulting resize event
  // into its own control frame.
  const observer = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  });
  observer.observe(host);

  return {
    term,
    dispose: () => {
      observer.disconnect();
      term.dispose();
    },
  };
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

    const { term, dispose: disposeChrome } = mountPtyTerminal(host, theme.mode, copyOperation, setFailure);
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

    return () => {
      copyOperation.current = null;
      keepaliveOperations.current.clear();
      addon.dispose();
      disposeChrome();
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
          title="Destroy this shell and open a new one. Use this after a shell exits.">
          restart shell
        </button>
        {/* What the chords actually do here. `⌃C` reaches a full-screen program
            (they read it as a keystroke), but bash job control is unavailable in
            this container: the PTY's shell is not a session leader with the
            terminal as its controlling tty, so the kernel has no foreground
            group to signal. Saying "⌃C interrupts" would be the fake. */}
        <span className="shrink-0" title="⌃C reaches a full-screen program. Suspend, fg and bg do not work here.">
          ⇧⌃C copies · no job control
        </span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}

/**
 * The wire this driver speaks, verbatim: binary frames of terminal bytes each
 * way, `{type:'resize'}` out, and these three control frames in. Not the
 * SDK's own shape (`code`/`signal`/`message` — see PtyTerminal above): this
 * environment has no vendored client to match, so the shape is the one the
 * route promises instead.
 */
/** The three control frames the route sends, and nothing else. A frame that
 *  is none of them is dropped: the pane and the route ship together. */
const DeviceTerminalMessageSchema = v.variant("type", [
  v.object({ type: v.literal("ready") }),
  v.object({ type: v.literal("exit"), exitCode: v.number() }),
  v.object({ type: v.literal("error"), error: v.string() }),
]);

function DeviceTerminal({ workspace, executor }: { workspace: string; executor: string }) {
  const theme = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const copyOperation = useRef<TerminalOperation | null>(null);
  const [state, setState] = useState<PtyState>("connecting");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setState("connecting");
    setFailure(null);

    const { term, dispose: disposeChrome } = mountPtyTerminal(host, theme.mode, copyOperation, setFailure);
    termRef.current = term;

    // The terminal's own socket, on the app's own origin under the same
    // authenticated workspace path the sandbox driver uses — the cookie and
    // `Origin` the handshake carries are what authorize it. Geometry rides the
    // query so the device's first paint is already the right size instead of
    // an 80x24 frame that reflows. The scheme has to be spelled out: a
    // relative URL would resolve against `http(s):` and the constructor
    // rejects that.
    const origin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
    const socket = new WebSocket(
      `${origin}/api/workspaces/${encodeURIComponent(workspace)}/terminal`
      + `?executor=${encodeURIComponent(executor)}&cols=${term.cols}&rows=${term.rows}`,
    );
    // Output arrives as bytes rather than the default Blob, so it can go
    // straight into xterm with no read step in between.
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    let dataSubscription: IDisposable | null = null;
    let resizeSubscription: IDisposable | null = null;

    socket.onopen = () => {
      dataSubscription = term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });
      resizeSubscription = term.onResize(({ cols, rows }) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
      });
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
        return;
      }
      if (event.data instanceof Blob) return;
      // A frame that is not JSON is the one failure tolerated here by name;
      // the socket carries what the server wrote. Anything else propagates.
      const parsed = v.safeParse(DeviceTerminalMessageSchema, tolerate(() => JSON.parse(String(event.data)), "malformed-input"));
      if (!parsed.success) return;
      const message = parsed.output;
      switch (message.type) {
        case "ready":
          setState("connected");
          term.focus();
          break;
        case "exit":
          setState("disconnected");
          setFailure(`the shell exited (code ${message.exitCode})`);
          break;
        case "error":
          setState("disconnected");
          setFailure(message.error);
          break;
      }
    };
    socket.onclose = () => setState("disconnected");
    socket.onerror = () => {
      setState("disconnected");
      setFailure("the connection dropped");
    };

    return () => {
      copyOperation.current = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      dataSubscription?.dispose();
      resizeSubscription?.dispose();
      socket.close();
      disposeChrome();
      termRef.current = null;
    };
  }, [workspace, executor]);

  // xterm cannot read CSS custom properties, so the palette is applied
  // imperatively on every theme change — both axes, since either can move.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme.mode);
  }, [theme]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 text-[10px] p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>{state === "connected" ? "interactive shell" : state}</span>
        {failure !== null && <span className="p-danger truncate" title={failure}>{failure}</span>}
        {/* Copy needs the same chord here, and for the same reason: Ctrl-C is
            a byte the foreground program must receive. On this driver that
            program is a real shell, so Ctrl-C keeps its ordinary meaning
            instead of merely reaching a full-screen program's raw input. */}
        <span className="ml-auto shrink-0" title="⌃C interrupts the foreground program.">
          ⇧⌃C copies
        </span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}

/* ── line mode ────────────────────────────────────────────────────────── */

function LineTerminal(
  { executor, outputs, onExecute }: {
    executor: string;
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
    writePrompt(term);

    const typing = term.onData((data) => {
      const run = execute.current;
      if (lineState.running || !run) return;
      // The editor owns the echo and decides when a command is finished; a
      // heredoc and a pasted script both reach here as ordinary chunks.
      const cmd = feedInput(term, lineState, data);
      if (cmd === null) return;
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
            writePrompt(term);
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
      writeOutputRow(term, out);
      wrote = true;
    }
    if (wrote) writePrompt(term);
  }, [outputs]);

  return (
    <div className="w-full h-full flex flex-col">
      {/* The mode this pane is in. It never explains what an environment
          cannot do: a device PTY is being built, and a label about a missing
          primitive would be wrong the day it lands. */}
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 text-[10px] p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>{LINE_MODE_LABEL}</span>
        {failure !== null && <span className="ml-auto p-danger truncate" title={failure}>{failure}</span>}
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
