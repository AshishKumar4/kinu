// Drivers: PTY (sandbox via SandboxAddon; device via own socket, same frames),
// workspace shell (runtime JSON frames), line mode. Lanes: core execution/terminal-lane.ts.

import { useEffect, useRef, useState, type RefObject } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SandboxAddon } from "@cloudflare/sandbox/xterm";
import "@xterm/xterm/css/xterm.css";
import { describeError } from "@/hooks/use-async-resource";
import { renderThrownChain, tolerate } from "@kinu.run/core/obs";
import * as v from "valibot";
import { useTheme, type Theme, type ThemeMode } from "@/hooks/use-theme";
import {
  BUSY, LINE_MODE_LABEL, LineTerminalState, clearBusy, feedInput, terminalLane, writeOutputRow, writePrompt,
  type TerminalPaneOutput,
} from "@kinu.run/core";
import type { ExecutorCommandResult } from "@kinu.run/core";
import { WorkspaceTerminalOutputSchema } from "@kinu.run/core";

export type { TerminalPaneOutput };

export interface TerminalPaneProps {
  workspace: string;
  executor: string;
  outputs?: readonly TerminalPaneOutput[];
  onExecute?: (cmd: string) => Promise<ExecutorCommandResult>;
}

/** The durable container lease moves only on object operations, not proxied frames;
 *  this beat keeps a container from quiescing under a typing user. */
const KEEPALIVE_MS = 60_000;

/** xterm's default is 1000 lines, which a build log overruns in seconds. */
const SCROLLBACK_LINES = 5_000;

export function TerminalPane({ workspace, executor, outputs, onExecute }: TerminalPaneProps) {
  const lane = terminalLane(executor);

  if (lane.mode === "line") return <LineTerminal executor={executor} outputs={outputs ?? []} onExecute={onExecute} />;

  if (lane.mode === "shell") return <WorkspaceTerminal workspace={workspace} executor={executor} />;

  return executor === "device"
    ? <DeviceTerminal workspace={workspace} executor={executor} />
    : <PtyTerminal workspace={workspace} executor={executor} />;
}


type PtyState = "connecting" | "connected" | "disconnected";

interface TerminalOperation {
  promise: Promise<void> | null;
}

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

  // Copy is Ctrl/Cmd-Shift-C: Ctrl-C is a byte the foreground program must receive.
  term.attachCustomKeyEventHandler((event) => {
    const copyChord = (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyC";

    if (!copyChord || event.type !== "keydown") return true;
    const selection = term.getSelection();

    if (!selection) return true;

    if (copyOperation.current !== null) return false;
    const owner: TerminalOperation = { promise: null };
    // The key handler must return synchronously; install the owner before the browser action starts.
    copyOperation.current = owner;
    owner.promise = (async () => {
      try {
        await navigator.clipboard.writeText(selection);
      } catch (cause) {
        if (copyOperation.current === owner) {
          // The header advertises the chord, so a refused clipboard write must be shown.
          setFailure(`clipboard refused the copy: ${renderThrownChain({ cause })}`);
        }
      } finally {
        if (copyOperation.current === owner) copyOperation.current = null;
      }
    })();

    return false;
  });

  // Re-fit on element resize, not only window resize: a sidebar opening changes only the element.
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

/** xterm cannot read CSS custom properties, so the palette is applied imperatively. */
function useTerminalPalette(termRef: RefObject<Terminal | null>, theme: Theme): void {
  useEffect(() => {
    const term = termRef.current;

    if (term) term.options.theme = terminalTheme(theme.mode);
  }, [termRef, theme]);
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
      // Cookie and Origin on the handshake authorize the socket; geometry in the query avoids an 80x24 first paint.
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

  useTerminalPalette(termRef, theme);

  useEffect(() => {
    if (state !== "connected") return;

    const beat = setInterval(() => {
      const keepaliveKey = crypto.randomUUID();
      const owner: TerminalOperation = { promise: null };
      // Several keepalives may be outstanding at once; each owns its own map entry.
      keepaliveOperations.current.set(keepaliveKey, owner);
      owner.promise = (async () => {
        try {
          const response = await fetch(
            `/api/workspaces/${encodeURIComponent(workspace)}/terminal/keepalive`
            + `?executor=${encodeURIComponent(executor)}`,
            { method: "POST", credentials: "same-origin" },
          );

          // Shown, not fatal: the reason (container gone, attach failed) arrives here before the socket reports it.
          if (keepaliveOperations.current.get(keepaliveKey) === owner && !response.ok) {
            setFailure(`the container refused the terminal's keepalive (${response.status})`);
          }
        } catch (cause) {
          if (keepaliveOperations.current.get(keepaliveKey) === owner) {
            setFailure(describeError({ cause }));
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

  // An exited shell leaves a dead PTY handed to every later attach, so restart must be reachable from the pane.
  const restart = async () => {
    setFailure(null);

    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspace)}/terminal/reset`
      + `?executor=${encodeURIComponent(executor)}`,
      { method: "POST", credentials: "same-origin" },
    );

    if (!response.ok) {
      setFailure(describeError({ cause: await response.text() }));

      return;
    }

    termRef.current?.reset();
    addonRef.current?.disconnect();
    addonRef.current?.connect({ sandboxId: workspace });
  };

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 p-meta p-text-3">
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
        {/* Job control is unavailable: the PTY shell is not a session leader, so ⌃C only reaches full-screen programs. */}
        <span className="shrink-0" title="⌃C reaches a full-screen program. Suspend, fg and bg do not work here.">
          ⇧⌃C copies · no job control
        </span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}

function resizeFrames(term: Terminal, socket: WebSocket): IDisposable {
  return term.onResize(({ cols, rows }) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
  });
}

function releaseSocketPane(pane: {
  socket: WebSocket;
  subscriptions: readonly (IDisposable | null)[];
  disposeChrome: () => void;
  copyOperation: RefObject<TerminalOperation | null>;
  termRef: RefObject<Terminal | null>;
}): () => void {
  return () => {
    const { socket } = pane;

    pane.copyOperation.current = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;

    for (const subscription of pane.subscriptions) subscription?.dispose();
    socket.close();
    pane.disposeChrome();
    pane.termRef.current = null;
  };
}

/** Device wire: terminal bytes each way, `{type:'resize'}` out, these control frames in. */
/** Other frames are dropped: the pane and the route ship together. */
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

    // The scheme must be explicit: a relative URL resolves to http(s): and the constructor rejects it.
    const origin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

    const socket = new WebSocket(
      `${origin}/api/workspaces/${encodeURIComponent(workspace)}/terminal`
      + `?executor=${encodeURIComponent(executor)}&cols=${term.cols}&rows=${term.rows}`,
    );

    // Bytes rather than Blob, so output goes straight into xterm.
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    let dataSubscription: IDisposable | null = null;
    let resizeSubscription: IDisposable | null = null;

    socket.onopen = () => {
      dataSubscription = term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });
      resizeSubscription = resizeFrames(term, socket);
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));

        return;
      }

      if (event.data instanceof Blob) return;
      // A non-JSON frame is the one tolerated failure; anything else propagates.
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

    return releaseSocketPane({
      socket, subscriptions: [dataSubscription, resizeSubscription], disposeChrome, copyOperation, termRef,
    });
  }, [workspace, executor]);

  useTerminalPalette(termRef, theme);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 p-meta p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>{state === "connected" ? "interactive shell" : state}</span>
        {failure !== null && <span className="p-danger truncate" title={failure}>{failure}</span>}
        <span className="ml-auto shrink-0" title="⌃C interrupts the foreground program.">
          ⇧⌃C copies
        </span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}


/** `ready` arrives after the runtime replayed scrollback, so a reload lands on the same screen. */
function WorkspaceTerminal({ workspace, executor }: { workspace: string; executor: string }) {
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
    const origin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

    const socket = new WebSocket(
      `${origin}/api/workspaces/${encodeURIComponent(workspace)}/terminal`
      + `?executor=${encodeURIComponent(executor)}&cols=${term.cols}&rows=${term.rows}`,
    );

    let dataSubscription: IDisposable | null = null;
    let resizeSubscription: IDisposable | null = null;

    socket.onopen = () => {
      // The runtime sizes its editor from frames, never the query, so declare the window on open.
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      dataSubscription = term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
      });
      resizeSubscription = resizeFrames(term, socket);
    };

    socket.onmessage = (event) => {
      // Process notices share this socket; unknown frames are dropped.
      const parsed = v.safeParse(WorkspaceTerminalOutputSchema, tolerate(() => JSON.parse(String(event.data)), "malformed-input"));

      if (!parsed.success) return;
      const message = parsed.output;

      switch (message.type) {
        case "output":
          term.write(message.data);
          break;
        case "ready":
          setState("connected");
          term.focus();
          break;
      }
    };

    socket.onclose = (event) => {
      setState("disconnected");

      if (event.reason !== "") setFailure(event.reason);
    };

    socket.onerror = () => {
      setState("disconnected");
      setFailure("the connection dropped");
    };

    return releaseSocketPane({
      socket, subscriptions: [dataSubscription, resizeSubscription], disposeChrome, copyOperation, termRef,
    });
  }, [workspace, executor]);

  useTerminalPalette(termRef, theme);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 p-meta p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>{state === "connected" ? "workspace shell" : state}</span>
        {failure !== null && <span className="p-danger truncate" title={failure}>{failure}</span>}
        <span className="ml-auto shrink-0" title="⌃C interrupts the running command.">
          ⇧⌃C copies
        </span>
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}


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

  lineStateRef.current ??= new LineTerminalState();
  const lineState = lineStateRef.current;
  const commandOperation = useRef<TerminalOperation | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Held in a ref so the effect stays keyed on the executor; rebuilding per render wipes scrollback.
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
      const cmd = feedInput(term, lineState, data);

      if (cmd === null) return;
      lineState.beginCommand();
      term.write(BUSY);
      setFailure(null);
      // xterm's data callback is synchronous, so retain the promise until it settles.
      const owner: TerminalOperation = { promise: null };
      commandOperation.current = owner;
      owner.promise = (async () => {
        try {
          // A failed command is an outcome for the terminal row: the rejection is held as a value so both fences apply alike.
          let thrown: { readonly cause: unknown } | undefined;

          try {
            await run(cmd);
          } catch (cause) {
            thrown = { cause };
          }

          if (!lineState.finishCommand(generation)) return;

          if (termRef.current !== term) return;

          if (thrown !== undefined) {
            // A rejected exec produces no output row, so clear the marker and reprint the prompt here.
            clearBusy(term, lineState);
            term.write(`\x1b[31m${describeError(thrown)}\x1b[0m\r\n`);
            writePrompt(term);
          }
        } catch (cause) {
          if (lineState.finishCommand(generation) && termRef.current === term) {
            clearBusy(term, lineState);
            setFailure(describeError({ cause }));
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

  useTerminalPalette(termRef, theme);

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
      <div className="flex items-center gap-2 px-3 py-1 shrink-0 p-meta p-text-3">
        <span className="font-mono">{executor}</span>
        <span>·</span>
        <span>{LINE_MODE_LABEL}</span>
        {failure !== null && <span className="ml-auto p-danger truncate" title={failure}>{failure}</span>}
      </div>
      <div ref={hostRef} className="p-bg flex-1 min-h-0 rounded-lg border p-border overflow-hidden" />
    </div>
  );
}


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
 * xterm needs concrete colours, so the palette is read off the document at theme time.
 * ANSI status slots take their role's token; magenta and cyan are pulled into the warm family.
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
