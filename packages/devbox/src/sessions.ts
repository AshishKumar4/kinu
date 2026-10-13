/**
 * The computer's terminal sessions (D89): named tmux sessions the page attaches to by id, each with the folder it was
 * last in. tmux keeps a session's shell and screen across reattaches; a restart of the container ends them all, so the
 * box keeps each session's id, name and folder, and the next attach opens a fresh shell there under the same name.
 */
import * as v from 'valibot';

/** A tmux session name the attach and the read can pass unquoted: tmux reads `.` and `:` as targets. */
export const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export const SessionIdSchema = v.pipe(v.string(), v.regex(SESSION_ID));

export const SessionNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40));

export const SessionRecordSchema = v.object({ id: SessionIdSchema, name: SessionNameSchema, cwd: v.string() });

export type SessionRecord = v.InferOutput<typeof SessionRecordSchema>;

export const SessionRecordsSchema = v.array(SessionRecordSchema);

export const SESSIONS_KEY = 'devbox:sessions';

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
}

/** A running session's state as the read finds it, before its record names it. */
export type SessionState = Omit<TerminalSession, 'name' | 'open'>;

/** Each running session's state, keyed by its id. */
export type SessionsRead = ReadonlyMap<string, SessionState>;

/**
 * The read, one exec: each session's pane (`P`), each listening port under a session's shell (`L`), and the branch of
 * each folder a pane is in (`B`), tab-separated. `$1` is the box's listener probe (`port pid stamp command` rows).
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
done`;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash']);

/** The read's rows as each running session's state, keyed by id. */
export function parseSessionsRead(text: string): SessionsRead {
  const sessions = new Map<string, SessionState & { ports: number[] }>();
  const branches = new Map<string, string>();
  const listening: Array<[string, number]> = [];

  for (const line of text.split('\n')) {
    const [kind, ...fields] = line.split('\t');

    if (kind === 'P') {
      const [id = '', cwd = '', command = '', exit = '', at = '', last = ''] = fields;

      if (!SESSION_ID.test(id)) continue;
      const ended = exit === '' || at === '' ? null : { exit: Number(exit), at: Number(at) * 1000, command: last };
      sessions.set(id, { id, cwd, running: SHELLS.has(command) ? null : command, last: ended, ports: [], branch: null });
    }

    if (kind === 'L' && fields[0] !== undefined) listening.push([fields[0], Number(fields[1])]);

    if (kind === 'B' && fields[0] !== undefined && fields[1] !== undefined) branches.set(fields[0], fields[1]);
  }

  for (const [id, port] of listening) {
    const session = sessions.get(id);

    if (session !== undefined && Number.isInteger(port) && !session.ports.includes(port)) session.ports.push(port);
  }

  return new Map([...sessions].map(([id, session]) => [id, { ...session, branch: branches.get(session.cwd) ?? null }]));
}

/** Every recorded session, as the read finds it running or as it was left; records the read moved keep its folder. */
export function mergeSessions(records: readonly SessionRecord[], read: SessionsRead | null): TerminalSession[] {
  return records.map((record) => {
    const seen = read?.get(record.id);

    return seen === undefined
      ? { ...record, open: false, running: null, last: null, ports: [], branch: null }
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
