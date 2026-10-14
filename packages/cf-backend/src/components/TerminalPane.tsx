// Native container PTY, device PTY, workspace shell and line-mode terminal lanes.

import { Cause, Effect, type Exit } from 'effect';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as v from 'valibot';
import "@xterm/xterm/css/xterm.css";
import { describeError } from "@/hooks/use-async-resource";
import { renderThrownChain, showing, tolerate, detach, hold } from "@kinu.run/core/obs";
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
  /** What the pane's bar shows at its left, before the terminal's own state: the view's switch, or its name. */
  leading?: ReactNode;
  /** The computer's terminal session this pane attaches to (D90); the box's first without one. */
  session?: string;
  /** The pane's bar on the terminal's own ground, under a rule its caller draws, where tabs sit above it. */
  barOnGround?: boolean;
  /** What the bar's right edge offers besides the terminal's own action: a split, say. */
  trailing?: ReactNode;
}

type PtyState = 'connecting' | 'connected' | 'disconnected' | 'error';

const STATE_SAYS: Record<PtyState, { readonly word: string; readonly tone: string }> = {
  connecting: { word: "Connecting", tone: "working" },
  connected: { word: "Connected", tone: "ready" },
  disconnected: { word: "Disconnected", tone: "off" },
  error: { word: "Not connected", tone: "danger" },
};

/**
 * A terminal's one bar and its ground: the leading content, then the connection's state, the copy key and the
 * pane's one action on the right; under a hairline, the terminal itself, edge to edge to the column's foot.
 */
function TerminalFrame({ leading, state, failure, copies, action, hostRef, barOnGround = false, trailing }: {
  leading: ReactNode;
  barOnGround?: boolean;
  trailing?: ReactNode;
  state: PtyState | null;
  failure: string | null;
  /** The copy key's note, and what ⌃C reaches here; null where the lane has no copy chord. */
  copies: { readonly note: string; readonly title: string } | null;
  action: ReactNode;
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className={`flex shrink-0 items-center gap-3 pr-3 pl-4 ${barOnGround ? "p-terminal-ground h-9" : "h-11"}`}>
        {leading}
        <span className="ml-auto flex shrink-0 items-center gap-3 p-meta p-text-3">
          {failure !== null && <span className="max-w-[16rem] truncate p-danger" title={failure}>{failure}</span>}
          {state !== null && (
            <span data-terminal-state className="inline-flex shrink-0 items-center gap-1.5">
              <span aria-hidden className="p-env-dot" data-tone={STATE_SAYS[state].tone} />{STATE_SAYS[state].word}
            </span>
          )}
          {copies !== null && <span className="hidden shrink-0 @[36rem]:inline" title={copies.title}>{copies.note}</span>}
          {trailing}
          {action}
        </span>
      </div>
      {/* FitAddon measures the host less its padding, so the text starts on the column's left edge. */}
      <div ref={hostRef} className={`p-terminal-ground min-h-0 flex-1 overflow-hidden pl-4 ${barOnGround ? "pt-1" : "border-t p-border pt-2"}`} />
    </div>
  );
}

/** The durable container lease moves only on object operations, not proxied frames;
 *  this beat keeps a container from quiescing under a typing user. */
const KEEPALIVE_MS = 60_000;

/** xterm's default is 1000 lines, which a build log overruns in seconds. */
const SCROLLBACK_LINES = 5_000;

export function TerminalPane({ workspace, executor, outputs, onExecute, leading, session, barOnGround, trailing }: TerminalPaneProps) {
  const lane = terminalLane(executor);
  const frame = { leading, barOnGround, trailing };

  if (lane.mode === "line") return <LineTerminal executor={executor} outputs={outputs ?? []} onExecute={onExecute} frame={frame} />;

  if (lane.mode === "shell") return <WorkspaceTerminal workspace={workspace} executor={executor} frame={frame} />;

  return <PtyTerminal workspace={workspace} executor={executor} session={session} frame={frame} />;
}

/** What a pane's caller puts in its bar, and where the bar sits. */
interface FrameParts { readonly leading: ReactNode; readonly barOnGround?: boolean; readonly trailing?: ReactNode }



interface TerminalOperation {
  promise: Promise<Exit.Exit<void>> | null;
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
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => navigator.clipboard.writeText(selection)), (failed) => Effect.sync(() => {
      if (copyOperation.current === owner) {
        // The header advertises the chord, so a refused clipboard write must be shown.
        setFailure(`clipboard refused the copy: ${renderThrownChain({ cause: Cause.squash(failed) })}`);
      }
    })), Effect.sync(() => {
      if (copyOperation.current === owner) copyOperation.current = null;
    })));

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

/**
 * One PTY pane for the device and the native container: bytes each way, the first geometry in the query, `resize`
 * frames out. The device speaks `ready`/`exit`/`error` frames and is connected at `ready`; the native PTY sends bytes
 * only, is connected at open, and needs the keepalive and a restart the device does not.
 */
function PtyTerminal({ workspace, executor, session, frame }: { workspace: string; executor: string; session?: string; frame: FrameParts }) {
  // The computer's session rides every route's query; the device and its first session name none.
  const sessionQuery = session === undefined ? "" : `&session=${encodeURIComponent(session)}`;
  const device = executor === "device";
  const theme = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connection, reconnect] = useState(0);
  const copyOperation = useRef<TerminalOperation | null>(null);
  const keepaliveOperations = useRef(new Map<string, TerminalOperation>());
  const [state, setState] = useState<PtyState>("connecting");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;

    if (!host) return;

    const { term, dispose: disposeChrome } = mountPtyTerminal(host, theme.mode, copyOperation, setFailure);
    termRef.current = term;

    setState("connecting");
    setFailure(null);
    // The scheme must be explicit: a relative URL resolves to http(s): and the constructor rejects it.
    const origin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

    const socket = new WebSocket(`${origin}/api/workspaces/${encodeURIComponent(workspace)}/terminal`
      + `?executor=${encodeURIComponent(executor)}&cols=${term.cols}&rows=${term.rows}${sessionQuery}`);

    socket.binaryType = "arraybuffer";

    socket.onopen = () => { if (!device) setState("connected"); };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));

        return;
      }

      if (!device || event.data instanceof Blob) return;
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

    socket.onclose = (event) => {
      setState("disconnected");

      if (!device && event.code !== 1000 && event.code !== 1001) setFailure(event.reason || `terminal closed (${event.code})`);
    };

    socket.onerror = () => {
      setState(device ? "disconnected" : "error");
      setFailure(device ? "the connection dropped" : "terminal connection failed");
    };

    const binary = term.onBinary(data => { if (socket.readyState === WebSocket.OPEN) socket.send(Uint8Array.from(data, byte => byte.charCodeAt(0))); });

    const release = releaseSocketPane({
      socket, subscriptions: [inputFrames(term, socket), windowFrames(term, socket), binary], disposeChrome, copyOperation, termRef,
    });

    return () => {
      keepaliveOperations.current.clear();
      release();
    };
  }, [workspace, executor, device, connection, sessionQuery]);

  useTerminalPalette(termRef, theme);

  useEffect(() => {
    if (device || state !== "connected") return;

    const beat = setInterval(() => {
      const keepaliveKey = crypto.randomUUID();
      const owner: TerminalOperation = { promise: null };
      // Several keepalives may be outstanding at once; each owns its own map entry.
      keepaliveOperations.current.set(keepaliveKey, owner);
      owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(
          `/api/workspaces/${encodeURIComponent(workspace)}/terminal/keepalive`
          + `?executor=${encodeURIComponent(executor)}`,
          { method: "POST", credentials: "same-origin" },
        ));

        // Shown, not fatal: the reason (container gone, attach failed) arrives here before the socket reports it.
        if (keepaliveOperations.current.get(keepaliveKey) === owner && !response.ok) {
          setFailure(`the computer refused the terminal's keepalive (${response.status})`);
        }
      }), (failed) => Effect.sync(() => {
        if (keepaliveOperations.current.get(keepaliveKey) === owner) {
          setFailure(describeError({ cause: Cause.squash(failed) }));
        }
      })), Effect.sync(() => {
        if (keepaliveOperations.current.get(keepaliveKey) === owner) {
          keepaliveOperations.current.delete(keepaliveKey);
        }
      })));
    }, KEEPALIVE_MS);

    return () => {
      clearInterval(beat);
      keepaliveOperations.current.clear();
    };
  }, [device, state, workspace, executor]);

  // An exited shell leaves a dead PTY handed to every later attach, so restart must be reachable from the pane.
  const restart = async () => {
    setFailure(null);

    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspace)}/terminal/reset`
      + `?executor=${encodeURIComponent(executor)}${sessionQuery}`,
      { method: "POST", credentials: "same-origin" },
    );

    if (!response.ok) {
      setFailure(describeError({ cause: await response.text() }));

      return;
    }

    termRef.current?.reset();
    reconnect(value => value + 1);
  };

  // Job control is unavailable on the container's PTY: its shell is not a session leader, so ⌃C reaches only
  // full-screen programs.
  const copies = device
    ? { note: "⇧⌃C copies", title: "⌃C interrupts the foreground program." }
    : { note: "⇧⌃C copies", title: "⌃C reaches a full-screen program. Suspend, fg and bg do not work here." };

  const restartShell = device ? null : (
    <button type="button" aria-label="Restart the shell" title="Restart the shell: a new one, for after a shell exits"
      onClick={() => detach(Effect.catchCause(Effect.gen(function* () {
        yield* Effect.promise(async () => restart());
      }), showing(setFailure)))}
      className="p-bar-icon shrink-0">
      <ArrowCounterClockwiseIcon size={14} />
    </button>
  );

  return <TerminalFrame {...frame} state={state} failure={failure} copies={copies} action={restartShell} hostRef={hostRef} />;
}

/** Keystrokes out as bytes: the frame both PTY routes read. */
function inputFrames(term: Terminal, socket: WebSocket): IDisposable {
  const encoder = new TextEncoder();

  return term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
  });
}

/**
 * The shell's window is the pane's: declared when the socket opens and at every resize after. The query's geometry is
 * the pane's at mount, before layout settles, and a resize while the socket connected was dropped, so the computer's
 * tmux kept drawing for a taller pane and scrolled its prompt off the top (staging 71d06f4a9, 2026-10-13).
 */
function windowFrames(term: Terminal, socket: WebSocket): IDisposable {
  const declare = () => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };

  socket.addEventListener("open", declare);
  const resized = term.onResize(declare);

  return { dispose: () => { socket.removeEventListener("open", declare); resized.dispose(); } };
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
    socket.close(1000, "pane closed");
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

/** `ready` arrives after the runtime replayed scrollback, so a reload lands on the same screen. */
function WorkspaceTerminal({ workspace, executor, frame }: { workspace: string; executor: string; frame: FrameParts }) {
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

    // The runtime sizes its editor from frames, never the query; the window is declared before any input.
    const shellWindow = windowFrames(term, socket);

    const typing = term.onData((typed) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data: typed }));
    });

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
        // Prompt and command marks: nothing on the pane reads them yet.
        case "shell-integration":
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
      socket, subscriptions: [shellWindow, typing], disposeChrome, copyOperation, termRef,
    });
  }, [workspace, executor]);

  useTerminalPalette(termRef, theme);

  return (
    <TerminalFrame {...frame} state={state} failure={failure} hostRef={hostRef} action={null}
      copies={{ note: "⇧⌃C copies", title: "⌃C interrupts the running command." }} />
  );
}


function LineTerminal(
  { executor, outputs, onExecute, frame }: {
    executor: string;
    outputs: readonly TerminalPaneOutput[];
    onExecute?: (cmd: string) => Promise<ExecutorCommandResult>;
    frame: FrameParts;
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
      owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
        // A failed command is an outcome for the terminal row: the rejection is held as a value so both fences apply alike.
        const thrown = yield* Effect.matchCause(Effect.promise(() => run(cmd)), {
          onSuccess: () => undefined,
          onFailure: (failed) => ({ cause: Cause.squash(failed) }),
        });

        if (!lineState.finishCommand(generation)) return;

        if (termRef.current !== term) return;

        if (thrown !== undefined) {
          // A rejected exec produces no output row, so clear the marker and reprint the prompt here.
          clearBusy(term, lineState);
          term.write(`\x1b[31m${describeError(thrown)}\x1b[0m\r\n`);
          writePrompt(term);
        }
      }), (failed) => Effect.sync(() => {
        if (lineState.finishCommand(generation) && termRef.current === term) {
          clearBusy(term, lineState);
          setFailure(describeError({ cause: Cause.squash(failed) }));
        }
      })), Effect.sync(() => {
        if (commandOperation.current === owner) commandOperation.current = null;
      })));
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
    <TerminalFrame {...frame} state={null} failure={failure} hostRef={hostRef} action={null}
      copies={{ note: LINE_MODE_LABEL, title: LINE_MODE_LABEL }} />
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
