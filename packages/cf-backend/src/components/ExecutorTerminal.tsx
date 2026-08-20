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
import type { ExecutorCommandResult } from "@/lib/protocol";

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
  onExecute: (cmd: string) => Promise<ExecutorCommandResult>;
}

export function ExecutorTerminal({ executor, outputs, onExecute }: ExecutorTerminalProps) {
  const theme = useTheme();
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
      theme: terminalTheme(theme.mode),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
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
            Promise.resolve(onExecute(cmd)).catch((err) => {
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

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      sub.dispose();
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // xterm can't read CSS variables, so the palette is applied imperatively —
  // and re-applied on every toggle of EITHER axis. Baking it into the
  // mount-once effect left a dark terminal sitting in a light page; keying it
  // to the mode alone left an umber terminal sitting in a silk one.
  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.theme = terminalTheme(theme.mode);
  }, [theme]);

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

  return <div ref={ref} className="p-bg w-full h-full rounded-lg border p-border overflow-hidden" />;
}

/**
 * xterm needs concrete colours, not custom properties, so the palette is read
 * off the document at theme time. Hardcoding it here is what let this file
 * drift a whole palette behind — it still carried the pre-v2 browns.
 *
 * ANSI is a protocol: a program that emits `\x1b[31m` means "error", so the
 * four slots with a status role take that role's token. Magenta and cyan have
 * no status meaning and no token; they stay distinguishable (a shell that
 * colours by type needs them to be) but are pulled into the warm family
 * rather than shipping the only violet and cyan in the product.
 */
const ANSI_UNTOKENED = {
  dark:  { magenta: "#c9a0c6", cyan: "#8fbdb8" },
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
