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
 *   - Enter                   → submits via onExecute; output prints on
 *                                next broadcast (handled by the parent
 *                                `outputs` prop — we re-render as outputs
 *                                grows)
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenIdsRef = useRef<Set<string>>(new Set());
  const lineBufferRef = useRef<string>("");
  const runningRef = useRef<boolean>(false);

  // Init
  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: "#0b0b0b",
        foreground: "#e4e4e4",
        cursor: "#e4e4e4",
        black: "#0b0b0b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4e4",
      },
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
            runningRef.current = true;
            Promise.resolve(onExecute(cmd)).finally(() => {
              runningRef.current = false;
              // prompt is reprinted when the outputs-effect runs for the new entry
            });
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

  // Re-fit when the executor changes (label in the prompt + reset buffer).
  useEffect(() => {
    const t = termRef.current;
    if (t) {
      t.clear();
      writtenIdsRef.current.clear();
      lineBufferRef.current = "";
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

  return <div ref={ref} className="w-full h-full rounded-lg border p-border overflow-hidden" style={{ background: "#0b0b0b" }} />;
}

function promptLine(t: Terminal) {
  t.write("\x1b[32m$\x1b[0m ");
}
