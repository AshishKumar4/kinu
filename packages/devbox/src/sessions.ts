/**
 * The computer's terminal sessions (D90): named tmux sessions the page attaches to by id, each with the folder it was
 * last in. tmux keeps a session's shell and screen across reattaches; a restart of the container ends them all, so the
 * box keeps each session's id, name and folder, and the next attach opens a fresh shell there under the same name.
 */
import * as v from 'valibot';

import { SHELL_RC } from './shown-name';

/**
 * tmux keeps the shell and its screen across reattaches (DEVBOX-DECISIONS, the PTY proof); none of its own chrome shows.
 * No status line, no prefix key, and the page's terminal keeps its own screen, so what scrolls by lands in its scrollback.
 * A server already running takes the settings at the next attach.
 */
export const TMUX_CONF = [
  'set -g status off',
  'set -g prefix None',
  'unbind C-b',
  'set -g escape-time 0',
  'set -g history-limit 50000',
  "set -ga terminal-overrides ',xterm*:smcup@:rmcup@'",
].join('\n');

/**
 * A session's shell starts from the box's rc, the person's own first and the box's shown name in their prompt (D93),
 * then records how its last command ended on its own pane, where the sessions read finds it (D90): the exit status,
 * the time, and the command line, once per command the history numbers.
 */
export const SESSION_RC = [
  SHELL_RC,
  '__kinu_entry() { HISTTIMEFORMAT= fc -l -1 2>/dev/null; }',
  '__kinu_seen=$(__kinu_entry); __kinu_seen=${__kinu_seen%%[[:space:]]*}',
  '__kinu_mark() {',
  '  local status=$? entry',
  '  entry=$(__kinu_entry) || return $status',
  '  if [ -n "$entry" ] && [ "${entry%%[[:space:]]*}" != "$__kinu_seen" ]; then',
  '    __kinu_seen=${entry%%[[:space:]]*}',
  '    entry=${entry#*[[:space:]]}',
  '    entry=${entry#"${entry%%[![:space:]]*}"}',
  '    tmux set -p -t "$TMUX_PANE" @kinu_exit "$status" \\; set -p -t "$TMUX_PANE" @kinu_at "$(date +%s)" \\; set -p -t "$TMUX_PANE" @kinu_last "$entry" 2>/dev/null',
  '  fi',
  '  return $status',
  '}',
  'PROMPT_COMMAND="__kinu_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
].join('\n');

/** A tmux session name the attach and the read can pass unquoted: tmux reads `.` and `:` as targets. */
const SessionIdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,31}$/u));

export const SessionNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40));

const SessionRecordSchema = v.object({
  id: SessionIdSchema,
  name: SessionNameSchema,
  cwd: v.string(),
  /** The agent's job that runs in it (D95): its supervised process's id. */
  job: v.optional(v.string()),
});

export type SessionRecord = v.InferOutput<typeof SessionRecordSchema>;

export const SessionRecordsSchema = v.array(SessionRecordSchema);

export const SESSIONS_KEY = 'devbox:sessions';

/** The session an agent's job runs in (D95): its id from the job's, so a restored job lands in the same session. */
export function jobSessionId(processId: string): string {
  return `j-${processId.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 30)}`;
}

/** A job's session is named by what it runs, as a person would name it. */
export function jobSessionName(command: string): string {
  const line = command.replace(/\s+/gu, ' ').trim();

  return line.length <= 40 ? line : `${line.slice(0, 37)}...`;
}

/** The session a box has before anyone opens another, and again when every other is closed. */
export const FIRST_SESSION: SessionRecord = { id: 'shell', name: 'shell', cwd: '/workspace' };

/** How a session's last command ended, as its shell's prompt recorded it. */
export interface SessionLast { readonly exit: number; readonly at: number; readonly command: string }

export interface TerminalSession extends SessionRecord {
  /** Its tmux session runs now; false after a restart, until the next attach opens it again. */
  readonly open: boolean;
  /** The command in its foreground, while one runs. */
  readonly running: string | null;
  readonly last: SessionLast | null;
  /** The ports a process under its shell listens on. */
  readonly ports: readonly number[];
  readonly branch: string | null;
  /** A program in its foreground is reading from its terminal: a prompt waits for an answer (D95). */
  readonly needsInput: boolean;
}

/** A running session's state as the read finds it, before its record names it. */
type SessionState = Omit<TerminalSession, 'name' | 'open'>;

/** Each running session's state, keyed by its id. */
export type SessionsRead = ReadonlyMap<string, Omit<TerminalSession, 'name' | 'open'>>;

/**
 * The read, one exec: each session's pane (`P`), each listening port under a session's shell (`L`), the branch of
 * each folder a pane is in (`B`), and each session whose foreground reads its terminal (`W`), tab-separated. A program
 * waiting at a prompt is in `read(0)` on the pane's pts; a shell at its own prompt is in `pselect` (D95, measured). `$1` is the box's listener probe (`port pid stamp command` rows).
 */
export const SESSIONS_READ = `panes=$(tmux list-panes -a -F '#{pane_pid}	#{session_name}' 2>/dev/null) || exit 0
tmux list-panes -a -F 'P	#{session_name}	#{pane_current_path}	#{pane_current_command}	#{@kinu_exit}	#{@kinu_at}	#{@kinu_last}'
sh -c "$1" port-listeners '' | while IFS='	' read -r port pid _; do
  p=$pid
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    name=$(printf '%s\\n' "$panes" | awk -F '	' -v p="$p" '$1 == p { print $2; exit }')
    if [ -n "$name" ]; then printf 'L\\t%s\\t%s\\n' "$name" "$port"; break; fi
    p=$(awk '/^PPid:/ { print $2 }' "/proc/$p/status" 2>/dev/null)
  done
done
tmux list-panes -a -F '#{pane_current_path}' | sort -u | while read -r dir; do
  branch=$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null) && printf 'B\\t%s\\t%s\\n' "$dir" "$branch"
done
printf '%s\\n' "$panes" | while IFS='	' read -r pane name; do
  group=$(sed 's/.*) //' "/proc/$pane/stat" 2>/dev/null | awk '{ print $6 }')
  [ -n "$group" ] || continue
  for p in $(ps -eo pid=,pgid= | awk -v g="$group" '$2 == g { print $1 }'); do
    [ "$(cut -d' ' -f1-2 "/proc/$p/syscall" 2>/dev/null)" = '0 0x0' ] || continue
    case "$(readlink "/proc/$p/fd/0")" in /dev/pts/*) printf 'W\\t%s\\n' "$name"; break ;; esac
  done
done`;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash']);

/** A pane: the session it is in, its folder, its foreground command, and its last command's exit, time and line. */
const PaneRow = v.tuple([v.literal('P'), SessionIdSchema, v.string(), v.string(), v.string(), v.string(), v.string()]);

const ListenerRow = v.tuple([v.literal('L'), SessionIdSchema, v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(65_535))]);

const BranchRow = v.tuple([v.literal('B'), v.string(), v.pipe(v.string(), v.minLength(1))]);

const WaitingRow = v.tuple([v.literal('W'), SessionIdSchema]);

const Mark = v.pipe(v.string(), v.minLength(1), v.toNumber(), v.integer());

/** A pane's row as its session's state; the marks stay unset until its first numbered command. */
function paneState([, id, cwd, command, exit, at, last]: v.InferOutput<typeof PaneRow>): SessionState & { ports: number[] } {
  const ended = v.safeParse(v.tuple([Mark, Mark]), [exit, at]);

  return {
    id,
    cwd,
    running: SHELLS.has(command) ? null : command,
    last: ended.success ? { exit: ended.output[0], at: ended.output[1] * 1000, command: last } : null,
    ports: [],
    branch: null,
    needsInput: false,
  };
}

/** The read's rows, one record a line, each validated by its kind's schema; a row no schema takes is no row. */
export function parseSessionsRead(text: string): SessionsRead {
  const rows = text.split('\n').map((line) => line.split('\t'));
  const sessions = new Map<string, SessionState & { ports: number[] }>();
  const branches = new Map<string, string>();
  const waiting = new Set<string>();

  for (const row of rows) {
    const pane = v.safeParse(PaneRow, row);

    if (pane.success) sessions.set(pane.output[1], paneState(pane.output));
    const branch = v.safeParse(BranchRow, row);

    if (branch.success) branches.set(branch.output[1], branch.output[2]);
    const reading = v.safeParse(WaitingRow, row);

    if (reading.success) waiting.add(reading.output[1]);
  }

  for (const row of rows) {
    const listener = v.safeParse(ListenerRow, row);
    const session = listener.success ? sessions.get(listener.output[1]) : undefined;

    if (listener.success && session !== undefined && !session.ports.includes(listener.output[2])) session.ports.push(listener.output[2]);
  }

  return new Map([...sessions].map(([id, session]) => [id, { ...session, branch: branches.get(session.cwd) ?? null, needsInput: waiting.has(id) }]));
}

/** Every recorded session, as the read finds it running or as it was left; records the read moved keep its folder. */
export function mergeSessions(records: readonly SessionRecord[], read: SessionsRead | null): TerminalSession[] {
  return records.map((record) => {
    const seen = read?.get(record.id);

    return seen === undefined
      ? { ...record, open: false, running: null, last: null, ports: [], branch: null, needsInput: false }
      : { ...seen, name: record.name, open: true };
  });
}

/** A new session's id: unused, short, and what tmux and the attach take unquoted. */
export function newSessionId(records: readonly SessionRecord[]): string {
  const used = new Set(records.map((record) => record.id));

  for (let n = records.length + 1; ; n++) {
    const id = `s${String(n)}`;

    if (!used.has(id)) return id;
  }
}

/** The next free name in the `shell`, `shell 2` sequence. */
export function newSessionName(records: readonly SessionRecord[]): string {
  const names = new Set(records.map((record) => record.name));

  if (!names.has('shell')) return 'shell';

  for (let n = 2; ; n++) if (!names.has(`shell ${String(n)}`)) return `shell ${String(n)}`;
}
