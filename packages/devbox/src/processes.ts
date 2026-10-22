import { Files, SandboxFileError } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { DevboxError, attempt, attemptSync, observe, settle } from './errors';
import { TERM_GRACE_MS } from './lifecycle';
import { BOX_CHROMIUM_POLICY, BOX_CHROMIUM_POLICY_KEYS, CHROMIUM_POLICIES, CHROMIUM_PROFILES } from './desktop';
import { INSTALL_SESSION_FILES, READS_TERMINAL, SAVED_SESSIONS, SESSION_FILES, SESSION_RC_FILE, SESSION_RESUME_FILE, TMUX_CONF_FILE } from './sessions';
import DISTRUSTED from './distrusted-roots.json';

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.system.crt';

/** Node reads OpenSSL's store (the bundle and the hashed directory the trust step rebuilds), not the roots compiled into
 *  it, so the roots that store leaves out are out for Node too (its `--use-system-ca` adds the system's roots to its
 *  own, which keeps them). Last among a process's options, so a program's own `NODE_OPTIONS` keeps it (`boxEnv`). */
const NODE_TRUST = '--use-openssl-ca';

// Native exec does not inherit start() env; the upstream coding-agents example passes this per process. The trust
// bundles, and the desktop's display, so a window a program opens lands on the screen the owner watches (D89). The
// tools' Bun 1.4.3 has no option that drops its own roots (`--use-system-ca` and `--use-openssl-ca` both still answered
// G3B, 2026-10-21): it distrusts when tools-setup.sh pins a Bun that does, the CLI's (a test holds the two pins equal,
// and pc-agent's trust test goes red the day that Bun ships the distrust).
const CONTAINER_ENV = { NODE_EXTRA_CA_CERTS: CA_PATH, NODE_OPTIONS: NODE_TRUST, REQUESTS_CA_BUNDLE: BUNDLE, DISPLAY: ':0' };

/** A value of `name` as a box process gets it: a program's own `NODE_OPTIONS` with the box's trust after it. */
function boxValue(name: string, value: string): string {
  return name === 'NODE_OPTIONS' && value !== NODE_TRUST ? `${value} ${NODE_TRUST}`.trim() : value;
}

/** `env` over the box's own, each value as `boxValue` gives it. */
export function boxEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...CONTAINER_ENV, ...env }).map(([name, value]) => [name, boxValue(name, value)]));
}

/**
 * What the box asks of an exec. `stdin: 'pipe'` is a caller's own pipe, which it writes and closes; every other exec's
 * stdin the seam closes. `signal` bounds the box's wait for the exec: aborted before the exec is answered and its stdin
 * closed, the exec fails as cancelled and its process is ended by an exec. The platform never sees it, and a process
 * once answered is its caller's to end.
 */
export type ExecRequest = Omit<ContainerExecOptions, 'signal' | 'stdin'> & { readonly stdin?: 'pipe'; readonly signal?: AbortSignal };

/** What `raced` answers when its signal aborts before the exec does. */
const ABORTED = Symbol('aborted');

/** The exec's answer, or `ABORTED` once `signal` aborts first; neither leaves a listener behind. */
async function raced(launched: Promise<ExecProcess>, signal: AbortSignal | undefined): Promise<ExecProcess | typeof ABORTED> {
  if (signal === undefined) return await launched;
  let off = (): void => {};

  const aborted = new Promise<typeof ABORTED>((resolve) => {
    const on = (): void => { resolve(ABORTED); };

    off = () => { signal.removeEventListener('abort', on); };

    signal.addEventListener('abort', on, { once: true });
  });

  return await Promise.race([launched, aborted]).finally(off);
}

/**
 * The one way the box runs a command in its container. workerd makes three things of an exec that are tasks nobody can
 * await, and on a lost connection each failed the box's request as an uncaught "Network connection lost.": the end of a
 * stdin it was given none of (`Container::exec`: "If stdin is undefined, the JS API promises immediate EOF"; staging
 * rc29, 2026-10-21), the kill an exec's signal makes when it aborts, and `kill()` and `resize()` on its process (rc23).
 * So every exec carries a pipe the box closes before it answers, a signal is the box's own, and the process it hands
 * back kills and resizes by exec. A lost connection fails the exec, where its caller reads it.
 */
export function containerExec(container: Pick<Container, 'exec'>, argv: readonly string[], options: ExecRequest = {}): Promise<ExecProcess> {
  const { signal, stdin, ...asked } = options;
  const command = argv[0] ?? 'a command';
  const aborted = (): boolean => signal?.aborted === true;
  const abort = (): DevboxError => new DevboxError('cancelled', `${command} was not waited for`, { cause: signal?.reason });

  return settle(Effect.gen(function* () {
    if (aborted()) return yield* Effect.fail(abort());
    const launched = container.exec([...argv], { ...asked, stdin: 'pipe' });
    const answer = yield* attempt('process', async () => await raced(launched, signal), `running ${command}`);

    if (answer === ABORTED) {
      // It may still start: once it answers, it ends.
      endProcess(container, launched.then((late) => late.pid), `ending ${command}, no longer waited for`);

      return yield* Effect.fail(abort());
    }

    // What an SDK client calls on the process never becomes a task of the platform's: its kill and resize are execs.
    const seamed = new Proxy(answer, {
      get: (target, key: keyof ExecProcess) => {
        if (key === 'kill') return () => { endProcess(container, answer.pid, 'ending a process its client killed'); };

        if (key === 'resize') {
          return (cols: number, rows: number) => observe(resizePty(container, answer.pid, { cols, rows }), {
            success: () => undefined,
            failure: (cause) => { console.error(`[devbox] ${cause.message}`); },
          });
        }

        const value = target[key];

        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    if (stdin === 'pipe') return seamed;
    const own = answer.stdin;

    // A pipe the platform did not hand back is one nobody can end: the exec fails, and says so. Ending its process is an
    // exec too, which the same platform would answer the same way, so none is sent.
    if (own === null) return yield* Effect.fail(new DevboxError('process', `the platform gave ${command} no stdin to close`));

    // A close that fails leaves a process waiting on its input: ended, and the exec fails with why.
    yield* attempt('process', async () => { await own.close(); }, `closing the stdin of ${command}`)
      .pipe(Effect.tapError(() => Effect.sync(() => { endProcess(container, answer.pid, `ending ${command}, whose stdin would not close`); })));

    // A signal that aborted while the stdin closed came before the answer the caller would have had.
    if (aborted()) {
      endProcess(container, answer.pid, `ending ${command}, no longer waited for`);

      return yield* Effect.fail(abort());
    }

    return seamed;
  }));
}

/** `container` as an SDK client (Files, S3Mount) execs on it: through the seam, each argv after `prefix`. */
export function seamedContainer(container: Pick<Container, 'exec'>, prefix: readonly string[] = []): Pick<Container, 'exec'> {
  return {
    exec: async (argv, options = {}) => {
      const { stdin, ...asked } = options;

      // No client of the box's hands the platform a stream to pump: one would be another task of its own.
      if (stdin !== undefined && stdin !== 'pipe') return await settle(Effect.fail(new DevboxError('process', 'an exec was handed a stream for its stdin')));

      return await containerExec(container, [...prefix, ...argv], stdin === 'pipe' ? { ...asked, stdin } : asked);
    },
  };
}

/** A terminal's size, as its pane asks for one. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** What the resize exits with when the process it sizes is gone, and with it the terminal `/proc/<pid>/fd/0` named. */
const CLIENT_GONE = 3;

/** `stty` on the terminal of the process `$1`, to `$2` columns and `$3` rows; a process gone before or during it is no failure. */
const RESIZE = `stty -F "/proc/$1/fd/0" cols "$2" rows "$3" && exit 0
[ -e "/proc/$1/fd/0" ] || exit ${String(CLIENT_GONE)}
exit 1`;

/**
 * Sets the size of the PTY `pid` reads, by an exec of `stty` on that process's own terminal, whose new size the kernel
 * tells its tmux client (SIGWINCH): the platform's resize is a task nobody can await (`containerExec`). `pid` is a
 * container-namespace pid, and `stty` from another exec sizes the pane (D107, measured on a staging computer). A process
 * that is gone answers `ended`: its terminal ended, which its own output says.
 */
export function resizePty(container: Pick<Container, 'exec'>, pid: number, size: TerminalSize): Effect.Effect<'resized' | 'ended', DevboxError> {
  return Effect.gen(function* () {
    const sized = yield* attempt('process', async () => await (await containerExec(container, [
      '/bin/sh', '-c', RESIZE, 'devbox-resize', String(pid), String(size.cols), String(size.rows),
    ])).output(), "resizing a terminal's client");

    if (sized.exitCode === CLIENT_GONE) return 'ended';

    if (sized.exitCode !== 0) {
      return yield* Effect.fail(new DevboxError('process', `stty could not resize the terminal: ${new TextDecoder().decode(sized.stderr).trim()}`));
    }

    return 'resized';
  });
}

/**
 * Sends TERM to every process in the container but PID 1 and the kill itself, by an exec of `kill`; a kill that refuses
 * fails in its own words. `--` before `-1`: the box's procps kill (4.0.4) reads a `-1` after the signal as a second option
 * and refuses it, exit 1, signalling nothing (staging rc30, 2026-10-21, where the box's stop then waited on a container
 * never told to end). A kill that ends by a signal, 128 and above, went with the container it ended (137 on a golden
 * container the same day): it was sent, which the container's end says.
 */
export function endEveryProcess(container: Pick<Container, 'exec'>): Promise<void> {
  return settle(Effect.gen(function* () {
    const sent = yield* attempt('process', () => containerExec(container, ['kill', '-TERM', '--', '-1']), 'ending every process');
    const { exitCode, stderr } = yield* attempt('process', () => sent.output(), 'ending every process');

    if (exitCode !== 0 && exitCode < SIGNALLED) {
      return yield* Effect.fail(new DevboxError('process', `kill -TERM -- -1 exited ${String(exitCode)}: ${new TextDecoder().decode(stderr).trim()}`));
    }
  }));
}

/** The exit at and above which a process ended by a signal (128 + its number), not by its own choice. */
const SIGNALLED = 128;

/**
 * Ends `pid` in the container with an exec of `kill`, whose failure the box reads and says; a pid still to come is ended
 * once it comes. The platform's own kill (`ExecProcess.kill()`, or aborting the signal an exec was given) is a task
 * workerd adds and nobody can await: on a container whose connection was lost it failed the box's request as an uncaught
 * "Network connection lost." (staging rc23, 2026-10-19; `connection-lost.test.ts`). So no exec of the box's is given a
 * signal or killed by the platform.
 */
export function endProcess(container: Pick<Container, 'exec'>, pid: number | PromiseLike<number>, doing: string): () => void {
  return observe(attempt('process', async () => await (await containerExec(container, ['kill', '-KILL', String(await pid)])).output(), doing), {
    success: () => undefined,
    failure: (cause) => { console.error(`[devbox] ${cause.message}`); },
  });
}

/** Each certificate in the CA file as a JSON string of its base64 DER, comma-separated. */
const CA_DER = String.raw`awk '/-----BEGIN/{der="";next} /-----END/{printf "%s\"%s\"", sep, der; sep=",";next} {der=der $0}' ${CA_PATH}`;

/**
 * Each Chromium profile's last exit, marked clean: a box's stop ends the browser with the container, and a box restarts
 * as a matter of course, so Chromium's "Restore pages? Chromium didn't shut down correctly" was noise at every start.
 * A person who wants their tabs back sets Chromium's own "Continue where you left off", which a clean exit honours. A
 * profile that does not read as JSON is left as it is, and the start goes on.
 */
const CLEAN_EXIT = String.raw`for prefs in ${CHROMIUM_PROFILES}/*/Preferences; do
  [ -f "$prefs" ] && python3 -c 'import json, sys
path = sys.argv[1]
prefs = json.load(open(path))
prefs.setdefault("profile", {}).update(exit_type="Normal", exited_cleanly=True)
json.dump(prefs, open(path + ".tmp", "w"))' "$prefs" 2>/dev/null && mv "$prefs.tmp" "$prefs"
done`;

const CA_CONF = '/etc/ca-certificates.conf';

const CA_SOURCES = '/usr/share/ca-certificates';

const LOCAL_CA = '/usr/local/share/ca-certificates';

const CA_DIR = '/etc/ssl/certs';

const CA_HOOKS = '/etc/ca-certificates/update.d';

/**
 * The roots eMudhra's compromised intermediates chain to (Mozilla bug 2083449), as Debian's ca-certificates names the
 * two it carries (distrusted-roots.json, the one list, which the daemon reads too). Deselected the Debian way: a `!` in
 * ca-certificates.conf, and update-ca-certificates rebuilds the bundle and the hashed directory OpenSSL reads (curl,
 * Python, Node with `--use-openssl-ca`), for what the box's programs reach directly; 443 goes through the platform's
 * proxy, which judges the chain itself. Once per filesystem: a box whose conf deselects them already skips it.
 * Deleted when the tools' snapshot (block-lower/tools-setup.sh) serves Debian's ca-certificates 20250419+deb13u1,
 * which carries neither (https://bugs.debian.org/1151413).
 */
const DESELECTED = DISTRUSTED.roots.flatMap((root) => (root.debian === null ? [] : [root.debian]));

const DESELECT = `if grep -qxF ${DESELECTED.map((name) => `-e '${name}'`).join(' ')} ${CA_CONF}; then
  sed -i ${DESELECTED.map((name) => `-e 's|^${name.replaceAll('.', '\\.')}$|!&|'`).join(' ')} ${CA_CONF} \\
  && /usr/sbin/update-ca-certificates --certsconf ${CA_CONF} --certsdir ${CA_SOURCES} --localcertsdir ${LOCAL_CA} --etccertsdir ${CA_DIR} --hooksdir ${CA_HOOKS} >/dev/null \\
  && cp ${BUNDLE} ${SYSTEM_BUNDLE}.tmp && mv ${SYSTEM_BUNDLE}.tmp ${SYSTEM_BUNDLE}
fi`;

/**
 * The one of those Chromium's own root store holds (emSign ECC Root CA - G3; Chrome Root Store), as its policy
 * `CADistrustedCertificates` (Chromium 132+) takes it: base64 DER, distrusting every certificate with its key.
 * Chromium verifies with its own store, not the system's, so no Debian package retires this: deleted when the box's
 * Chromium is one whose Chrome Root Store no longer holds that root (net/data/ssl/chrome_root_store/root_store.textproto).
 */
const CHROMIUM_DISTRUSTED = 'MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwHhcNMTgwMjE4MTgzMDAwWhcNNDMwMjE4MTgzMDAwWjBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3iAhKAnjlfSU2fySU0WXTsuwYc58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4PPwT01xySfvalY8L1X44uT6EYGQIrMgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuBzhccLikenEhjQjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+DCBeQyh+KTOgNG3qxrdWBCUfvO6wIBHxcmbHtRwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7jHvrZQnD+JbNR6iC8hZVdyR+EhCVBCyj';

/** The policy's keys, each named once, where an eval's audit of the browser reads them too. */
const [TRUSTED_KEY, DISTRUSTED_KEY, FLAG_WARNINGS_KEY] = BOX_CHROMIUM_POLICY_KEYS;

/**
 * The SDK docs' trust step, which keeps no earlier container's CA: the system bundle, and Chromium's policy. The
 * desktop's earlier policy file, `devbox.json`, is folded into the box's own. It is the start's step for the desktop's
 * browser too, before any browser runs: its last exit is marked clean first, which no failure of it stops.
 */
export const TRUST = ['/bin/sh', '-c', `${CLEAN_EXIT}
${DESELECT} && { [ -e ${SYSTEM_BUNDLE} ] || { cp ${BUNDLE} ${SYSTEM_BUNDLE}.tmp && mv ${SYSTEM_BUNDLE}.tmp ${SYSTEM_BUNDLE}; }; } \\
  && timeout 10 sh -c 'until [ -s ${CA_PATH} ]; do sleep 0.1; done' && cat ${SYSTEM_BUNDLE} ${CA_PATH} >${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE} \\
  && mkdir -p ${CHROMIUM_POLICIES} && rm -f ${CHROMIUM_POLICIES}/devbox.json \\
  && printf '{"${TRUSTED_KEY}":[%s],"${DISTRUSTED_KEY}":["${CHROMIUM_DISTRUSTED}"],"${FLAG_WARNINGS_KEY}":false}\\n' "$(${CA_DER})" >${BOX_CHROMIUM_POLICY}.tmp \\
  && mv ${BOX_CHROMIUM_POLICY}.tmp ${BOX_CHROMIUM_POLICY}`, 'devbox-trust'] as const;

const ROOT = '/var/tmp/devbox/processes';

const KERNEL_READ = ['/bin/sh', '-c', 'cat /proc/sys/kernel/random/boot_id', 'devbox-incarnation-read'] as const;

// A command queued before stop may be delivered to a replacement kernel. Bind the actual argv, not
// merely its post-call result, so private file mutations, RUN, UNLAUNCH and KILL all share this fence.
const IN_KERNEL = `expected=$1; shift
[ "$(cat /proc/sys/kernel/random/boot_id)" = "$expected" ] || exit 125
exec "$@"`;

const IdSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/));

const RecordSchema = v.object({ id: IdSchema, command: v.string(), cwd: v.string() });

/**
 * `$1` as the kernel's name for this boot, and how a lookup of it answers (D96): the image resolves the box's own name
 * to its own addresses (libnss-myhostname, `hosts: files myhostname dns`), so no lookup leaves the box. Prints
 * `named=yes` with the addresses, or `named=no` and why; exits 0 whatever happened.
 */
const NAME_BOX = String.raw`hostname "$1" 2>/dev/null || { echo "named=no kernel refused"; exit 0; }
grep -q myhostname /etc/nsswitch.conf 2>/dev/null || sed -i 's/^hosts:.*files/& myhostname/' /etc/nsswitch.conf 2>/dev/null
found=$(timeout 1 getent ahosts "$1" | awk '{ print $1 }' | sort -u | paste -sd ' ')
if [ -n "$found" ]; then echo "named=yes $found"; else echo "named=no unresolved"; fi`;

/** How naming the box went: named, or what is off. */
export interface BoxNaming { readonly named: boolean; readonly detail: string }

/**
 * Names the box for this boot (D83, D92, D96): its prompt, its terminal titles, its desktop and its processes answer
 * to `name`. A name that does not resolve at once is a handled outcome, never a refusal: the box keeps it, as a valid
 * name, and starts.
 */
export function nameBox(container: Container, name: string): Promise<BoxNaming> {
  return settle(attempt('process', async () => await (await containerExec(container, ['sh', '-c', NAME_BOX, 'name-box', name])).output()).pipe(
    Effect.map((ran): BoxNaming => {
      const said = new TextDecoder().decode(ran.stdout).trim();

      return { named: said.startsWith('named=yes'), detail: said === '' ? `exit ${String(ran.exitCode)}` : said };
    }),
    Effect.catch((failure) => Effect.succeed<BoxNaming>({ named: false, detail: causeChain(failure) })),
  ));
}

/** A failure's messages down its cause chain, outermost first, each once. */
function causeChain(failure: Error): string {
  const said: string[] = [];

  for (let at: unknown = failure; at instanceof Error && said.length < 8; at = at.cause) {
    if (said.at(-1) !== at.message) said.push(at.message);
  }

  return said.join(': ');
}

export interface ProcessRecord {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly pid: number | undefined;
  readonly status: 'starting' | 'running' | 'completed' | 'failed';
  readonly exitCode: number | undefined;
  /** While it runs: the last line it wrote, when it waits at a prompt for an answer (D95). */
  readonly waiting: string | undefined;
}

export function isProcessLive(status: string): boolean {
  return status === 'starting' || status === 'running';
}

/** The claim remains held while native I/O settles, but expiry revokes permission to issue a later mutation. */
function whileCurrent<A>(current: (() => boolean) | undefined, mutate: () => Effect.Effect<A, DevboxError>): Effect.Effect<A, DevboxError> {
  return current === undefined || current() ? mutate()
    : Effect.fail(new DevboxError('cancelled', 'process launch reservation was superseded'));
}

// File-backed identities survive a DO eviction; a process group carries signals. A launch whose exec
// answer was lost is decided by one symlink: `launched` before anything runs, or `unlaunched` set by
// a caller finding no pid and no exit (D48). A missing cwd is the launch's own recorded failure.
/**
 * An agent's job in its terminal session (D95): the pane waits until its output is copied to the job's log, shows what
 * runs, runs it in the foreground of its terminal, so a prompt waits for whoever answers it there, records how it ended,
 * and leaves a shell under its output. `trap : INT` keeps the pane alive past a ^C its job takes with the default action.
 * After a restart it first shows what the session had (D97); the job runs again from its spec, so no line is offered.
 */
const JOB_PANE_FILE = '/etc/devbox-job-pane.sh';

const JOB_PANE = `dir=$1
trap : INT
if [ -f "${SAVED_SESSIONS}/$2/screen" ]; then rm -f "${SAVED_SESSIONS}/$2/running"; sh ${SESSION_RESUME_FILE} "$2"; fi
while [ ! -e "$dir/piped" ]; do sleep 0.05; done
printf '\\033[2m$ %s\\033[0m\\n' "$(cat "$dir/command")"
[ -f "$dir/env" ] && . "$dir/env"
sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" /bin/bash -c "$(cat "$dir/command")"
echo "$?" >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
exec /bin/bash --rcfile ${SESSION_RC_FILE} -i`;

/**
 * In a session (D95): the session's files, then the session, its pane copied to the job's one log. The values named in
 * `DEVBOX_REVEALED` are the session's environment from its start, in tmux's memory only; a session that does not start
 * fails the job with tmux's reason, as any failed start does.
 */
const RUN_IN_SESSION = `session=$DEVBOX_SESSION
${INSTALL_SESSION_FILES}
printf '%s\\n' "$DEVBOX_JOB_PANE" >${JOB_PANE_FILE}
unset DEVBOX_SESSION DEVBOX_JOB_PANE
printf '%s' "$3" >"$dir/command"
: >"$dir/stdout.log"; : >"$dir/stderr.log"
# The values named in DEVBOX_REVEALED become the session's own, by tmux's -e, and leave this shell before tmux runs:
# a server it starts takes its client's variables as every pane's.
set --
for name in \${DEVBOX_REVEALED:-}; do eval "set -- \\"\\$@\\" -e \\"\\$name=\\\${$name}\\""; unset "$name"; done
unset DEVBOX_REVEALED
tmux kill-session -t "=$session" 2>/dev/null
if ! tmux -f ${TMUX_CONF_FILE} new-session -d -s "$session" -x 160 -y 48 -c "$cwd" "$@" "sh ${JOB_PANE_FILE} $dir $session" 2>"$dir/stderr.log"; then
  echo 1 >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
  exit 0
fi
tmux pipe-pane -t "=$session:" -o "cat >>$dir/stdout.log"
touch "$dir/piped"`;

const RUN = `dir=$1; cwd=$2; shift 2
ln -s launched "$dir/launch" 2>/dev/null || exit 0
if ! cd -- "$cwd" 2>/dev/null; then
  printf "Failed to change directory to '%s'\\n" "$cwd" >"$dir/stderr.log"
  echo 1 >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
  exit 0
fi
if [ -n "\${DEVBOX_SESSION:-}" ]; then
${RUN_IN_SESSION}
  exit 0
fi
[ -f "$dir/env" ] && . "$dir/env"
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"`;

/** `$1/pid`'s pid if alive and from this boot: `RUN` records the boot beside it. */
const LIVE = `live() {
  [ -f "$1/pid" ] || return 1
  read -r p b < "$1/pid"
  [ "$b" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 1
  kill -0 "$p" 2>/dev/null && echo "$p"
}`;

/** Exits 0 when the launch in `$1` never ran, claiming it for nobody. */
const UNLAUNCH = `[ -f "$1/pid" ] || [ -f "$1/exit" ] || ln -s unlaunched "$1/launch" 2>/dev/null
[ "$(readlink "$1/launch")" = unlaunched ]`;

/**
 * \`waiting PID\`: a process in PID's tree reads its terminal, as a prompt does (D95). \`last_line DIR\`: the last line
 * the job wrote, its colours stripped, base64 so it rides one status line.
 */
const WAITING = `${READS_TERMINAL}
waiting() {
  for c in $(cat /proc/$1/task/$1/children 2>/dev/null); do waiting "$c" && return 0; done
  reads_terminal "$1"
}
last_line() {
  tail -c 4096 "$1/stdout.log" 2>/dev/null | tr -d '\\r' | sed 's/\\x1b\\[[0-9;?]*[a-zA-Z]//g' | awk 'NF { l = $0 } END { print l }' | base64 -w0
}`;

const STATUS = `${LIVE}
${WAITING}
for dir in "$@"; do
  [ -f "$dir/process.json" ] || continue
  if [ -f "$dir/exit" ]; then state="exit $(cat "$dir/exit")"
  elif [ "$(readlink "$dir/launch")" = unlaunched ]; then state=unlaunched
  elif [ ! -f "$dir/pid" ]; then state=starting
  elif p=$(live "$dir"); then
    state="running $p"
    if waiting "$p"; then state="waiting $p $(last_line "$dir")"; fi
  else state=lost
  fi
  printf '%s\\n' "$state"
  cat "$dir/process.json"; printf '\\n'
done`;

/** `end_tree PID`: its tree and the groups they lead, gone (D69). Status 3: none was alive. */
export const END_TREE = `end_tree() {
  tree() { for c in $(cat /proc/$1/task/$1/children 2>/dev/null); do tree "$c"; done; [ -d /proc/$1 ] && echo "$1"; }
  first=$(tree "$1")
  groups=$(ps -o pid=,pgid= -p "$(echo $first | tr ' ' ,)" 2>/dev/null | awk '$1 == $2 { print $1 }')
  standing() {
    ps -eo pid=,pgid=,stat= | awk -v pids=" $(echo $first $(tree "$1")) " -v groups=" $(echo $groups) " \\
      '$3 !~ /^Z/ && (index(pids, " " $1 " ") || index(groups, " " $2 " ")) { print $1 }'
  }
  left=$(standing "$1")
  [ -n "$left" ] || return 3
  kill -s TERM $left 2>/dev/null
  waited=0
  while left=$(standing "$1"); [ -n "$left" ]; do
    [ "$waited" -ge ${TERM_GRACE_MS / 100} ] && kill -s KILL $left 2>/dev/null
    sleep 0.1; waited=$((waited + 1))
  done
}`;

/** A job's most recent output, as its terminal showed it, colours stripped: `$2` lines, then at most `$3` bytes when set.
 *  Exit 3 when no job has the directory. */
const LOGS = `dir=$1; lines=$2; bytes=$3
[ -f "$dir/process.json" ] || exit 3
cat "$dir/stdout.log" "$dir/stderr.log" 2>/dev/null | tr -d '\\r' | sed 's/\\x1b\\[[0-9;?]*[a-zA-Z]//g' | tail -n "$lines" | if [ "$bytes" -gt 0 ]; then tail -c "$bytes"; else cat; fi`;

/** Lines a log read answers when the caller names none. */
const LOG_LINES = 200;

const directory = (id: string) => attemptSync('invalid-input', () => `${ROOT}/${v.parse(IdSchema, id)}`);

export class Processes {
  readonly #files: Files;
  /** `trace`: the owner's structured log (devbox.ts `#trace`), told when a status read's exec and its output answer. */
  constructor(
    readonly container: Pick<Container, 'exec' | 'running'>,
    readonly kernel?: string,
    readonly trace: (event: string, fields: Record<string, string | number | boolean | undefined>) => void = () => {},
  ) {
    this.#files = new Files(seamedContainer(container));
  }

  incarnation(): Promise<string> {
    return settle(Effect.gen({ self: this }, function* () {
      this.trace('incarnation.exec.enter', {});
      const read = yield* attempt('process', () => containerExec(this.container, [...KERNEL_READ]));
      this.trace('incarnation.exec.exit', {});
      const output = yield* attempt('process', () => read.output());
      this.trace('incarnation.output.exit', { exitCode: output.exitCode });
      const kernel = new TextDecoder().decode(output.stdout).trim();

      if (output.exitCode !== 0 || kernel === '') return yield* Effect.fail(new DevboxError('process', 'native kernel identity could not be read'));

      return kernel;
    }));
  }

  inIncarnation(kernel: string): Processes {
    const native = this.container;

    return new Processes({
      get running() { return native.running; },
      exec: seamedContainer(native, ['/bin/sh', '-c', IN_KERNEL, 'devbox-incarnation', kernel]).exec,
    }, kernel, this.trace);
  }

  /** With `session`, the job runs in that terminal session, where a person can watch and answer it (D95). */
  /**
   * `env` is written beside the job and read by its launch, in a session's pane too, which inherits no caller's
   * variables. `revealed` is never written: it rides the launch in memory, and into a session as its environment.
   */
  start(command: string, options: {
    readonly cwd?: string; readonly processId: string; readonly current?: () => boolean; readonly session?: string;
    readonly env?: Readonly<Record<string, string>> | undefined; readonly revealed?: Readonly<Record<string, string>> | undefined;
  }): Promise<ProcessRecord> {
    if (this.kernel === undefined) return settle(attempt('process', async () => {
      const kernel = await this.incarnation();

      return this.inIncarnation(kernel).start(command, options);
    }));

    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(options.processId);
      yield* whileCurrent(options.current, () => attempt('file', () => this.#files.mkdir(ROOT, { recursive: true })));
      const made = yield* Effect.result(whileCurrent(options.current, () => attempt('file', () => this.#files.mkdir(dir))));

      if (Result.isFailure(made)) {
        const cause = made.failure.cause;

        if (!SandboxFileError.is(cause) || cause.code !== 'EEXIST') return yield* Effect.fail(made.failure);
        const held = (yield* this.#status([dir]))[0];

        if (held === undefined) return yield* Effect.fail(made.failure);

        // A launch with no pid yet is live only if its wrapper claimed it.
        if (held.status === 'running' || (held.status === 'starting' && !(yield* this.#unlaunched(dir, options.current)))) return held;
        yield* whileCurrent(options.current, () => attempt('file', () => this.#files.remove(dir, { recursive: true })));
        yield* whileCurrent(options.current, () => attempt('file', () => this.#files.mkdir(dir)));
      }

      const record = { id: options.processId, command, cwd: options.cwd ?? '/workspace' };
      yield* whileCurrent(options.current, () => attempt('file', () => this.#files.writeFile(`${dir}/process.json`, JSON.stringify(record))));

      // A name it reads the value of is left out: the pane sources this file after the session's own values are set.
      const variables = Object.entries(options.env ?? {}).filter(([name]) => options.revealed?.[name] === undefined)
        .map(([name, value]) => `export ${name}='${boxValue(name, value).replaceAll("'", "'\\''")}'\n`).join('');

      if (variables !== '') yield* whileCurrent(options.current, () => attempt('file', () => this.#files.writeFile(`${dir}/env`, variables)));

      const revealed = options.revealed ?? {};

      const env = options.session === undefined ? boxEnv(revealed) : {
        ...boxEnv(revealed),
        ...SESSION_FILES,
        DEVBOX_SESSION: options.session,
        DEVBOX_JOB_PANE: JOB_PANE,
        ...(Object.keys(revealed).length > 0 && { DEVBOX_REVEALED: Object.keys(revealed).join(' ') }),
      };

      const launched = yield* Effect.result(whileCurrent(options.current, () => attempt('process', () => containerExec(this.container, ['/bin/sh', '-c', RUN, 'devbox-process', dir, record.cwd, '/bin/bash', '-c', command], {
        env, stdout: 'ignore', stderr: 'ignore',
      }))));

      if (Result.isFailure(launched)) {
        // The claim records a launch that never ran, so neither a retry nor a kill adopts it.
        const decided = yield* Effect.result(this.#unlaunched(dir, options.current));

        return yield* Effect.fail(Result.isSuccess(decided) ? launched.failure : new DevboxError(launched.failure.code,
          `${launched.failure.message}; whether it ran is left to the next start or kill: ${decided.failure.message}`, { cause: launched.failure }));
      }

      return { ...record, pid: undefined, status: 'starting' as const, exitCode: undefined, waiting: undefined };
    }));
  }

  get(id: string): Promise<ProcessRecord | null> {
    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(id);

      return (yield* this.#status([dir]))[0] ?? null;
    }));
  }

  list(): Promise<ProcessRecord[]> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.container.running) return [];
      const listed = yield* Effect.result(attempt('file', () => this.#files.readDirectory(ROOT)));

      if (Result.isFailure(listed)) {
        const cause = listed.failure.cause;

        if (SandboxFileError.is(cause) && cause.code === 'ENOENT') return [];

        return yield* Effect.fail(listed.failure);
      }

      const dirs = yield* Effect.forEach(listed.success, entry => directory(entry.name));

      return yield* this.#status(dirs);
    }));
  }

  /** What job `id` wrote most recently (D95: one log for both streams in a session). */
  logs(id: string, limits: { readonly lines?: number | undefined; readonly bytes?: number | undefined }): Promise<string> {
    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(id);
      const ran = yield* attempt('process', () => containerExec(this.container, ['/bin/sh', '-c', LOGS, 'devbox-logs', dir, String(limits.lines ?? LOG_LINES), String(limits.bytes ?? 0)]));
      const output = yield* attempt('process', () => ran.output());

      if (output.exitCode === 3) return yield* Effect.fail(new DevboxError('missing', `no process ${id}`));

      return new TextDecoder().decode(output.stdout);
    }));
  }

  kill(id: string, options: { readonly current?: () => boolean } = {}): Promise<void> {
    if (this.kernel === undefined) return settle(attempt('process', async () => {
      const kernel = await this.incarnation();

      return this.inIncarnation(kernel).kill(id, options);
    }));

    return settle(Effect.gen({ self: this }, function* () {
      const dir = yield* directory(id);

      const token = yield* Effect.result(attempt('file', async () => (await this.#files.readFile(`${dir}/pid`)).text()));
      const expected = Result.isSuccess(token) ? token.success.trim() : '';

      if (Result.isFailure(token) && !(SandboxFileError.is(token.failure.cause) && token.failure.cause.code === 'ENOENT')) return yield* Effect.fail(token.failure);

      const ended = yield* whileCurrent(options.current, () => attempt('process', () => containerExec(this.container, ['/bin/sh', '-c', `dir=$1; expected=$2
      [ -f "$dir/process.json" ] || exit 0
      if [ -n "$expected" ]; then [ "$(cat "$dir/pid" 2>/dev/null)" = "$expected" ] || exit 0; fi
      set -- "$dir"
      ${UNLAUNCH} && exit 0
      while [ ! -f "$dir/pid" ] && [ ! -f "$dir/exit" ]; do sleep 0.1; done
      [ -f "$dir/exit" ] && exit 0
      ${LIVE}
      pid=$(live "$dir") || exit 0
      ${END_TREE}
      end_tree "$pid" || [ $? -eq 3 ]`, 'devbox-kill', dir, expected])));

      const result = yield* attempt('process', () => ended.output());

      if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `process ${id} was not stopped: ${new TextDecoder().decode(result.stderr)}`));
    }));
  }

  /** `true`: the launch in `dir` never ran, and never will. */
  #unlaunched(dir: string, current?: () => boolean): Effect.Effect<boolean, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const claim = yield* whileCurrent(current, () => attempt('process', () => containerExec(this.container, ['/bin/sh', '-c', UNLAUNCH, 'devbox-unlaunch', dir])));
      const result = yield* attempt('process', () => claim.output());

      if (result.exitCode > 1) return yield* Effect.fail(new DevboxError('process', `the launch claim failed: ${new TextDecoder().decode(result.stderr)}`));

      return result.exitCode === 0;
    });
  }

  #status(dirs: string[]): Effect.Effect<ProcessRecord[], DevboxError> {
    return Effect.gen({ self: this }, function* () {
      if (dirs.length === 0 || !this.container.running) return [];
      this.trace('status.exec.enter', { dirs: dirs.length });
      const process = yield* attempt('process', () => containerExec(this.container, ['/bin/sh', '-c', STATUS, 'devbox-status', ...dirs]));
      this.trace('status.exec.exit', {});
      const result = yield* attempt('process', () => process.output());
      this.trace('status.output.exit', { exitCode: result.exitCode });

      if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `process status failed: ${new TextDecoder().decode(result.stderr)}`));

      return yield* attemptSync('process', () => readProcessRows(new TextDecoder().decode(result.stdout)));
    });
  }
}

function readProcessRows(output: string): ProcessRecord[] {
  const lines = output.trimEnd().split('\n');
  const found: ProcessRecord[] = [];

  for (let at = 0; at + 1 < lines.length; at += 2) {
    const record = v.parse(RecordSchema, JSON.parse(lines[at + 1] ?? ''));
    const [state, value, line] = (lines[at] ?? '').split(' ');
    const exitCode = state === 'exit' ? Number(value) : undefined;
    let status: ProcessRecord['status'] = exitCode === 0 ? 'completed' : 'failed';

    if (state === 'running' || state === 'starting') status = state;

    if (state === 'waiting') status = 'running';
    const waiting = state === 'waiting' ? new TextDecoder().decode(Uint8Array.from(atob(line ?? ''), (char) => char.charCodeAt(0))) : undefined;

    found.push({ ...record, pid: state === 'running' || state === 'waiting' ? Number(value) : undefined, status, exitCode, waiting });
  }

  return found;
}
