/**
 * The computer's terminal sessions (D90): named tmux sessions the page attaches to by id, each with the folder it was
 * last in. tmux keeps a session's shell and screen across reattaches; a restart of the container ends them all, so the
 * box keeps each session's id, name and folder, and the next attach opens a fresh shell there under the same name, with
 * what it showed and the line it was running (D97).
 */
import * as v from 'valibot';

/**
 * tmux keeps the shell and its screen across reattaches (DEVBOX-DECISIONS, the PTY proof); none of its own chrome shows.
 * No status line, no prefix key, and the page's terminal keeps its own screen, so what scrolls by lands in its scrollback.
 * A server already running takes the settings at the next attach.
 */
const TMUX_CONF = [
  'set -g status off',
  'set -g prefix None',
  'unbind C-b',
  'set -g escape-time 0',
  'set -g history-limit 50000',
  "set -ga terminal-overrides ',xterm*:smcup@:rmcup@'",
].join('\n');

/** Where a stopping box keeps each session's screen and the line it was running (D97); its checkpoint carries them. */
export const SAVED_SESSIONS = '/var/lib/devbox/sessions';

/** The key chord the attach sends to put a saved line in the shell's edit buffer: bound below, never typed text. */
const PREFILL_KEYS = ['C-x', 'C-]'] as const;

/**
 * A session's shell starts from the person's own rc, then records on its own pane, where the sessions read and a
 * stopping box find them: how its last command ended (D90), and while one runs, the line the person typed for it, from
 * PS0, which bash expands after it reads a line and before it runs it (D97). A line the history did not number (a
 * leading space under ignorespace, HISTIGNORE, history off) is not recorded: the last entry would be another line,
 * and a line kept out of the history is the person's to keep. Lines ride base64: tmux reads an argument
 * ending in `;` as a command separator (measured, tmux 3.6). At its first prompt after a restart the shell offers the
 * line it was running in its edit buffer, through readline (`bind -x`), so nothing runs before the person's Enter.
 */
const SESSION_RC = [
  '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
  '[ -f ~/.bashrc ] && . ~/.bashrc',
  '__kinu_entry() { HISTTIMEFORMAT= fc -l -1 2>/dev/null; }',
  '__kinu_line() { local entry; entry=$(__kinu_entry) || return 1; entry=${entry#*[[:space:]]}; printf %s "${entry#"${entry%%[![:space:]]*}"}"; }',
  '__kinu_seen=$(__kinu_entry); __kinu_seen=${__kinu_seen%%[[:space:]]*}',
  '__kinu_mark() {',
  '  local status=$? entry',
  '  entry=$(__kinu_entry) || return $status',
  '  tmux set -pu -t "$TMUX_PANE" @kinu_running 2>/dev/null',
  '  if [ -n "$entry" ] && [ "${entry%%[[:space:]]*}" != "$__kinu_seen" ]; then',
  '    __kinu_seen=${entry%%[[:space:]]*}',
  '    tmux set -p -t "$TMUX_PANE" @kinu_exit "$status" \\; set -p -t "$TMUX_PANE" @kinu_at "$(date +%s)" \\; set -p -t "$TMUX_PANE" @kinu_last "$(__kinu_line | base64 -w0)" 2>/dev/null',
  '  fi',
  '  return $status',
  '}',
  '__kinu_start() {',
  '  local entry',
  '  entry=$(__kinu_entry) && [ -n "$entry" ] && [ "${entry%%[[:space:]]*}" != "$__kinu_seen" ] || return 0',
  '  tmux set -p -t "$TMUX_PANE" @kinu_running "$(__kinu_line | base64 -w0)" 2>/dev/null',
  '}',
  '__kinu_prefill() {',
  `  local saved=${SAVED_SESSIONS}/$(tmux display -p -t "$TMUX_PANE" '#{session_name}')/running`,
  '  [ -f "$saved" ] || return',
  '  READLINE_LINE=$(cat "$saved"); READLINE_POINT=${#READLINE_LINE}; rm -f "$saved"; stty echoctl 2>/dev/null',
  '}',
  'bind -x \'"\\C-x\\C-]": __kinu_prefill\' 2>/dev/null',
  'PROMPT_COMMAND="__kinu_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
  'PS0="${PS0}\\$(__kinu_start)"',
].join('\n');

/**
 * Run as a box stops (D97), `$@` the recorded session ids: each live session's screen (its last 2000 lines, colours
 * kept) and the line it was running, beside the time; a recorded session not live keeps what it had; an unrecorded one
 * goes. A session's save is written aside and put in place whole: one whose screen did not read keeps what it had, and
 * the script says so and fails, so the box traces it.
 */
export const SESSIONS_SAVE = `d=${SAVED_SESSIONS}
mkdir -p "$d"
for kept in "$d"/* "$d"/.[!.]*; do
  [ -d "$kept" ] || continue
  case " $* " in *" \${kept##*/} "*) ;; *) rm -rf "$kept" ;; esac
done
failed=0
for id in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do
  case " $* " in *" $id "*) ;; *) continue ;; esac
  aside="$d/.$id"
  rm -rf "$aside"; mkdir -p "$aside"
  if ! tmux capture-pane -p -e -J -S -2000 -t "=$id:" > "$aside/raw"; then
    echo "session $id: its screen did not read" >&2; rm -rf "$aside"; failed=1; continue
  fi
  awk '{ line[NR] = $0 } END { n = NR; while (n > 0 && line[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print line[i] }' "$aside/raw" > "$aside/screen"
  rm -f "$aside/raw"
  running=$(tmux show -pv -t "=$id:" @kinu_running 2>/dev/null)
  [ -z "$running" ] || printf %s "$running" | base64 -d > "$aside/running"
  date +%s > "$aside/at"
  rm -rf "\${d:?}/$id"; mv "$aside" "$d/$id"
done
exit $failed`;

/** The ids of sessions closed while their box was stopped (D97): what it saved of them goes at its next start. */
export const SESSIONS_CLOSED_KEY = 'devbox:sessions:closed';

/** `$@` those ids: their saved screens and lines removed, before any attach can show them. */
export const SESSIONS_FORGET = `for id; do rm -rf "${SAVED_SESSIONS}/$id"; done`;

/** Where the attach and a job's pane keep the resume script. */
export const SESSION_RESUME_FILE = '/etc/devbox-session-resume.sh';

/**
 * A session's pane after a restart (D97), \`$1\` its id: the screen it had, a rule saying it restarted and its files
 * stayed, and the line it was running, which it sends the prefill chord for; the shell that follows offers that line.
 * The chord waits in the terminal until readline reads it; the terminal echoes what waits, so its control bytes echo
 * raw (\`-echoctl\`), which a terminal draws as nothing, until the prefill turns echoctl back on. Shown once.
 */
const SESSION_RESUME = `d=${SAVED_SESSIONS}/$1
stty -echoctl 2>/dev/null
cat "$d/screen" 2>/dev/null
printf '\\033[2m-- restarted %s · files kept --\\033[0m\\n' "$(date -d "@$(cat "$d/at" 2>/dev/null || date +%s)" '+%H:%M')"
if [ -f "$d/running" ]; then
  printf '\\033[2mwas running:\\033[0m %s\\n' "$(tr -d '\\000-\\010\\013-\\037\\177' < "$d/running")"
  tmux send-keys -t "=$1:" ${PREFILL_KEYS.join(' ')}
else
  stty echoctl 2>/dev/null
fi
rm -f "$d/screen" "$d/at"`;

/** Where every session's pane reads tmux's settings and its shell's rc. */
export const TMUX_CONF_FILE = '/etc/devbox-tmux.conf';

export const SESSION_RC_FILE = '/etc/devbox-session.bashrc';

/**
 * What a pane needs on the box before it opens: tmux's settings, the session rc and the resume script. A person's attach
 * and an agent's job both carry them in this environment and run `INSTALL_SESSION_FILES` first.
 */
export const SESSION_FILES = { DEVBOX_TMUX_CONF: TMUX_CONF, DEVBOX_SESSION_RC: SESSION_RC, DEVBOX_SESSION_RESUME: SESSION_RESUME } as const;

export const INSTALL_SESSION_FILES = `printf '%s\\n' "$DEVBOX_TMUX_CONF" >${TMUX_CONF_FILE}
printf '%s\\n' "$DEVBOX_SESSION_RC" >${SESSION_RC_FILE}
printf '%s\\n' "$DEVBOX_SESSION_RESUME" >${SESSION_RESUME_FILE}
unset DEVBOX_TMUX_CONF DEVBOX_SESSION_RC DEVBOX_SESSION_RESUME`;

/**
 * read(2)'s number on each architecture Linux runs a session on, which `/proc/<pid>/syscall` begins with while a
 * process waits in it: by the kernel's name for the machine (`uname -m`, a `case` pattern) and by Node's (`process.arch`).
 * A PC's daemon reads the same table (pc-agent daemon/session-facts.js).
 */
export const READ_SYSCALLS = [
  { machine: 'x86_64', arch: 'x64', read: '0' },
  { machine: 'aarch64', arch: 'arm64', read: '63' },
  { machine: 'i?86', arch: 'ia32', read: '3' },
  { machine: 'arm*', arch: 'arm', read: '3' },
] as const;

/**
 * `reads_terminal PID`: PID is in `read(0)` on a pts, as a program waiting at a prompt is; a shell at its own prompt
 * is in `pselect` (D95, measured). The sessions read asks it of a pane's foreground group, a job's status of its tree.
 */
export const READS_TERMINAL = `reads_terminal() {
  case "$(uname -m)" in ${READ_SYSCALLS.map(({ machine, read }) => `${machine}) n=${read} ;;`).join(' ')} *) return 1 ;; esac
  [ "$(cut -d' ' -f1-2 "/proc/$1/syscall" 2>/dev/null)" = "$n 0x0" ] || return 1
  case "$(readlink "/proc/$1/fd/0")" in /dev/pts/*) return 0 ;; esac
  return 1
}`;

/** A tmux session name the attach and the read can pass unquoted: tmux reads `.` and `:` as targets. */
const SessionIdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,31}$/u));

/** A session's name, as the strip shows it; a PC's sessions take the same rule (pc-agent daemon/terminals.js). */
const SESSION_NAME_MAX = 40;

export const SessionNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SESSION_NAME_MAX));

/** The rule {@link SessionNameSchema} holds a name to, as a refusal says it. */
export const SESSION_NAME_RULE = `a session's name is 1 to ${String(SESSION_NAME_MAX)} characters`;

/** A session's name as a person typed it, trimmed; null when it breaks {@link SESSION_NAME_RULE}. */
export function sessionName(typed: string): string | null {
  const parsed = v.safeParse(SessionNameSchema, typed);

  return parsed.success ? parsed.output : null;
}

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

  return line.length <= SESSION_NAME_MAX ? line : `${line.slice(0, SESSION_NAME_MAX - 3)}...`;
}

/** The session a box has before anyone opens another, and again when every other is closed. */
export const FIRST_SESSION: SessionRecord = { id: 'shell', name: 'shell', cwd: '/workspace' };

/** How a session's last command ended, as its shell's prompt recorded it. */
interface SessionLast { readonly exit: number; readonly at: number; readonly command: string }

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
 * The read, one exec, one record a line, its fields split at each unescaped space (D90): each session's pane (`P`),
 * each listening port under a session's shell (`L`), and the branch of each folder a pane is in (`B`). tmux writes the
 * pane's fields itself with `#{q:…}`, which puts a backslash before every space, backslash and other special character
 * in a value, so any folder reads back whole; the last command's line is base64, as the rc stores it (D97). A tab
 * printed raw by a format comes out as `_` on the platform's tmux, which is why no field is tab-separated. Each session
 * whose foreground reads its terminal (`W`): a program waiting at a prompt is in `read(0)` on the pane's pts; a shell
 * at its own prompt is in `pselect` (D95, measured). `$1` is the box's listener probe (`port pid ancestry stamp command`).
 */
export const SESSIONS_READ = `${READS_TERMINAL}
panes=$(tmux list-panes -a -F '#{pane_pid} #{session_name}' 2>/dev/null) || exit 0
tmux list-panes -a -F 'P #{q:session_name} #{q:pane_current_path} #{q:pane_current_command} #{q:@kinu_exit} #{q:@kinu_at} #{q:@kinu_last}'
sh -c "$1" port-listeners '' | while IFS='	' read -r port _ chain _; do
  for p in $chain; do
    name=$(printf '%s\\n' "$panes" | awk -v p="$p" '$1 == p { print $2; exit }')
    if [ -n "$name" ]; then printf 'L %s %s\\n' "$name" "$port"; break; fi
  done
done
tmux list-panes -a -F '#{pane_current_path}' | sort -u | while IFS= read -r dir; do
  branch=$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null) &&
    printf 'B %s %s\\n' "$(printf '%s' "$dir" | sed 's/[\\\\ ]/\\\\&/g')" "$branch"
done
printf '%s\\n' "$panes" | while IFS=' ' read -r pane name; do
  group=$(sed 's/.*) //' "/proc/$pane/stat" 2>/dev/null | awk '{ print $6 }')
  [ -n "$group" ] || continue
  for p in $(ps -eo pid=,pgid= | awk -v g="$group" '$2 == g { print $1 }'); do
    if reads_terminal "$p"; then printf 'W %s\\n' "$name"; break; fi
  done
done`;

/** One record of the read: its fields split at each unescaped space, each `\x` read as `x` (tmux's `q:`, D90). */
function recordFields(line: string): string[] {
  const fields = [''];
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      fields[fields.length - 1] += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === ' ') {
      fields.push('');
    } else {
      fields[fields.length - 1] += char;
    }
  }

  return fields;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh']);

/** A shell at its prompt, its login form (`-bash`) too: what holds a terminal's foreground while nothing else runs. */
export function isShell(command: string): boolean {
  return SHELLS.has(command.replace(/^-/u, ''));
}

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
    running: isShell(command) ? null : command,
    last: ended.success ? { exit: ended.output[0], at: ended.output[1] * 1000, command: decoded(last) } : null,
    ports: [],
    branch: null,
    needsInput: false,
  };
}

/** A line the session rc wrote base64 (D97); one that does not decode reads as nothing. */
function decoded(base64: string): string {
  const bytes = v.safeParse(v.pipe(v.string(), v.base64()), base64);

  return bytes.success ? new TextDecoder().decode(Uint8Array.from(atob(bytes.output), (char) => char.charCodeAt(0))) : '';
}

/** The read's rows, one record a line, each validated by its kind's schema; a row no schema takes is no row. */
export function parseSessionsRead(text: string): SessionsRead {
  const rows = text.split('\n').filter((line) => line !== '').map(recordFields);
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

/**
 * Every recorded session, as the read finds it running or as it was left: a running one takes the read's folder and
 * state over its record's, and keeps its name and its job (D95).
 */
export function mergeSessions(records: readonly SessionRecord[], read: SessionsRead | null): TerminalSession[] {
  return records.map((record) => {
    const seen = read?.get(record.id);

    return seen === undefined
      ? { ...record, open: false, running: null, last: null, ports: [], branch: null, needsInput: false }
      : { ...record, ...seen, open: true };
  });
}

/**
 * A new session's id: short, what tmux and the attach take unquoted, and not one a closed session had, whose saved
 * screen (D97) may still be on the disk when it closed on a stopped box.
 */
export function newSessionId(records: readonly SessionRecord[]): string {
  const used = new Set(records.map((record) => record.id));

  for (;;) {
    const id = `s${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

    if (!used.has(id)) return id;
  }
}

/** The next free name in the `shell`, `shell 2` sequence; a PC names its sessions by it too. */
export function newSessionName(records: readonly SessionRecord[]): string {
  const names = new Set(records.map((record) => record.name));
  const first = FIRST_SESSION.name;

  if (!names.has(first)) return first;

  for (let n = 2; ; n++) if (!names.has(`${first} ${String(n)}`)) return `${first} ${String(n)}`;
}
