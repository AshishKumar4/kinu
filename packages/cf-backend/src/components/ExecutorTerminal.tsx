/**
 * xterm.js-backed terminal for the Executors tab.
 *
 * The upstream @cloudflare/sandbox SDK doesn't expose a raw PTY session for
 * non-codeserver use, so this terminal runs one-shot exec commands — type a
 * command, Enter, the output lands in the scrollback. That matches the
 * previous input/pre behaviour exactly but with real ANSI rendering
 * (colours, cursor control, UTF-8) via xterm.
 *
 * Keyboard behaviour:
 *   - printable keys + space → buffered as input line
 *   - Backspace               → erases last char
 *   - Enter                   → submits via onExecute; a "running" marker
 *                                holds the line until either the output
 *                                broadcast arrives (via the parent `outputs`
 *                                prop) or the exec rejects, which prints the
 *                                error and hands the prompt back
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { describeError } from "@/hooks/use-async-resource";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";

export interface TerminalOutput {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  created_at: number;
}

export interface ExecutorTerminalProps {
  executor: string;
  outputs: TerminalOutput[];
  onExecute: (cmd: string) => Promise<unknown>;
}

export function ExecutorTerminal({ executor, outputs, onExecute }: ExecutorTerminalProps) {
  const mode = useTheme();
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenIdsRef = useRef<Set<string>>(new Set());
  const lineBufferRef = useRef<string>("");
  const runningRef = useRef<boolean>(false);
  const busyRef = useRef<boolean>(false);

  // Init
  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      theme: TERMINAL_THEME[mode],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    try { fit.fit(); } catch { /* ignore */ }
    termRef.current = term;
    fitRef.current = fit;
    term.write(`\x1b[2m# ${executor} — type a command, Enter to run\x1b[0m\r\n`);
    promptLine(term);

    // Handle user input
    const sub = term.onData((data) => {
      if (runningRef.current) return;
      const t = termRef.current;
      if (!t) return;
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 0x0d) {
          // Enter
          const cmd = lineBufferRef.current;
          lineBufferRef.current = "";
          t.write("\r\n");
          if (cmd.trim()) {
            // Keystrokes are dropped while a command runs, so say so; the
            // marker is cleared by whichever of the two paths below lands.
            runningRef.current = true;
            busyRef.current = true;
            t.write(BUSY);
            Promise.resolve(onExecute(cmd)).catch((err: unknown) => {
              // A rejected exec produces no output row, so nothing else will
              // ever clear the marker or reprint the prompt — the terminal
              // used to just stop reading.
              clearBusy(t, busyRef);
              t.write(`\x1b[31m${describeError(err)}\x1b[0m\r\n`);
              promptLine(t);
            }).finally(() => { runningRef.current = false; });
          } else {
            promptLine(t);
          }
        } else if (code === 0x7f || code === 0x08) {
          // Backspace
          if (lineBufferRef.current.length > 0) {
            lineBufferRef.current = lineBufferRef.current.slice(0, -1);
            t.write("\b \b");
          }
        } else if (code === 0x03) {
          // Ctrl-C
          lineBufferRef.current = "";
          t.write("^C\r\n");
          promptLine(t);
        } else if (code >= 0x20) {
          lineBufferRef.current += ch;
          t.write(ch);
        }
      }
    });

    const onResize = () => { try { fit.fit(); } catch { /* ignore */ } };
    window.addEventListener("resize", onResize);

    return () => {
      sub.dispose();
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // xterm can't read CSS variables, so the palette is applied imperatively —
  // and re-applied on every toggle. Baking it into the mount-once effect left
  // a dark terminal sitting in a light page.
  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.theme = TERMINAL_THEME[mode];
  }, [mode]);

  // Re-fit when the executor changes (label in the prompt + reset buffer).
  useEffect(() => {
    const t = termRef.current;
    if (t) {
      t.clear();
      writtenIdsRef.current.clear();
      lineBufferRef.current = "";
      busyRef.current = false;
      t.write(`\x1b[2m# ${executor} — type a command, Enter to run\x1b[0m\r\n`);
      promptLine(t);
    }
  }, [executor]);

  // Render new outputs as ANSI-coloured rows. Dedup via writtenIdsRef so
  // state-driven re-renders don't re-print existing rows.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    let wroteSomething = false;
    for (const o of outputs) {
      if (writtenIdsRef.current.has(o.id)) continue;
      writtenIdsRef.current.add(o.id);
      clearBusy(t, busyRef);
      if (o.stdout) {
        t.write(o.stdout);
        if (!o.stdout.endsWith("\n")) t.write("\r\n");
      }
      if (o.stderr && o.exit_code !== 0) {
        t.write(`\x1b[31m${o.stderr}\x1b[0m`);
        if (!o.stderr.endsWith("\n")) t.write("\r\n");
      }
      wroteSomething = true;
    }
    if (wroteSomething) promptLine(t);
  }, [outputs]);

  return <div ref={ref} className="w-full h-full rounded-lg border p-border overflow-hidden" style={{ background: "var(--c-bg)" }} />;
}

/** The two palettes, mirroring the --c-bg / --c-text / --c-accent tokens.
 *  The ANSI eight have no token equivalents, so they are tuned per mode for
 *  contrast against that mode's background. */
const TERMINAL_THEME: Record<ThemeMode, NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"]> = {
  dark: {
    background: "#1A1613", foreground: "#F5EFE6", cursor: "#E0A458",
    black: "#1A1613", red: "#f87171", green: "#4ade80", yellow: "#facc15",
    blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#F5EFE6",
  },
  light: {
    background: "#FBF7F0", foreground: "#241E18", cursor: "#B5793A",
    black: "#241E18", red: "#b91c1c", green: "#15803d", yellow: "#a16207",
    blue: "#1d4ed8", magenta: "#7e22ce", cyan: "#0e7490", white: "#FBF7F0",
  },
};

function promptLine(t: Terminal) {
  t.write("\x1b[32m$\x1b[0m ");
}

/** The in-flight marker, on its own line so it can be erased whole. */
const BUSY = "\x1b[2m⋯ running\x1b[0m";

function clearBusy(t: Terminal, busy: { current: boolean }) {
  if (!busy.current) return;
  busy.current = false;
  t.write("\r\x1b[2K"); // carriage return + erase line
}
