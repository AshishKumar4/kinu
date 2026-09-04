/**
 * The candidate journal readiness probe: one correlated, read-only `stats`
 * request over the same Unix socket checkpoint fences.
 *
 * OWNERSHIP. These bytes run inside the measured container, so they live
 * beside the fixture rather than inside the worker's request handler — and a
 * probe that cannot run in a test cannot be trusted on a box, so the
 * journal-ready suite executes exactly these bytes against a fake journal.
 * The worker stages them to a file and runs `bun` against the path; it never
 * interpolates them into a shell command, because shell double-quotes mangle
 * real newlines into literal backslash-n sequences that Bun's parser rejects
 * (`Unexpected escape sequence` at 1:36 on the deployed probe that motivated
 * this shape).
 *
 * The protocol word `stats` is checked against the daemon source by the
 * decision suite. No elapsed deadline lives here: the driver transport owns
 * its one request bound, as it does for every other container fact.
 */
export const JOURNAL_READY_PROBE = [
  "const socketPath = process.argv[2];",
  "const id = crypto.randomUUID();",
  "const decoder = new TextDecoder();",
  "let received = '';",
  "let settled = false;",
  "await new Promise((resolve, reject) => {",
  "  const settle = (finish) => { if (settled) return; settled = true; finish(); };",
  "  void Bun.connect({",
  "    unix: socketPath,",
  "    socket: {",
  "      open(socket) { socket.write(JSON.stringify({ id, op: 'stats' }) + '\\n'); },",
  "      data(socket, data) {",
  "        received += decoder.decode(data, { stream: true });",
  "        const newline = received.indexOf('\\n');",
  "        if (newline === -1) return;",
  "        let response;",
  "        try { response = JSON.parse(received.slice(0, newline)); }",
  "        catch (error) { settle(() => reject(error)); socket.end(); return; }",
  "        if (response.id !== id || response.ok !== true) {",
  "          settle(() => reject(new Error(response.error ?? 'journal rejected stats')));",
  "          socket.end();",
  "          return;",
  "        }",
  "        console.log(JSON.stringify(response));",
  "        settle(resolve);",
  "        socket.end();",
  "      },",
  "      error(_socket, error) { settle(() => reject(error)); },",
  "      close() { settle(() => reject(new Error('journal closed before answering stats'))); },",
  "    },",
  "  }).catch((error) => settle(() => reject(error)));",
  "});",
].join('\n');

/** Per-container scratch where the fixture stages the probe before running it. */
export const JOURNAL_READY_PROBE_PATH = '/tmp/kinu-journal-ready-probe.mjs';

/** Run the staged probe against one control socket. The path is single-quoted;
 *  it is a fixture constant, never operator input. */
export function journalReadyRunCommand(socketPath: string): string {
  return `bun ${JOURNAL_READY_PROBE_PATH} '${socketPath}'`;
}
