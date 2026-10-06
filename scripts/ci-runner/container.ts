/**
 * What runs inside a CI container, and the one way the Worker runs it. Preparation starts Cloudflare's managed
 * `cloudflare/debian-trixie` (DEVBOX-DECISIONS D72: no image of ours to build, push or roll out), gives it what the
 * GitHub runner has and the tier needs, installs one tree's locked dependencies, and snapshots it. A shard starts from
 * that snapshot and only takes in its commit.
 */

/** The account's largest instance (DEVBOX-DECISIONS D50): 4 vCPU, 12 GiB, 20 GB, the GitHub runner's CPU count. */
export const INSTANCE = 'standard-4';

/** Where the commit is checked out. Three levels under a directory the user owns, as on a GitHub runner
 *  (`/home/runner/work/<repo>/<repo>`): suites write beside the checkout (`../kinu-logs`). */
export const REPO = '/home/ci/work/kinu/kinu';

/** The unprivileged user every test runs as, as on a GitHub runner. The exec's own `user` option fails on this runtime
 *  (`internal error`, measured 2026-10-06 on `user: 'ci'`), so a command drops to it inside. */
const AS_USER = ['setpriv', '--reuid=ci', '--regid=ci', '--init-groups', '--'];

/** What the ladder runs under: the lock's own bun first, as `scripts/repo-runtime.sh` puts it on a GitHub runner. */
export const SHELL_ENV = {
  PATH: `${REPO}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
  HOME: '/home/ci',
  CI: 'true',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
} satisfies Record<string, string>;

/** git as the GitHub runner has it: trixie's 2.47 prints no `path=` records for `rev-list --objects -z`, which the
 *  history corpus (`scripts/sources.ts`) reads. Built once per environment from kernel.org's signed release. */
const GIT = { version: '2.53.0', sha256: '5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653' };

/**
 * The GitHub runner's tools the tier reads, as root: Chrome where `scripts/test-chrome.ts` looks for it
 * (`/usr/bin/google-chrome`); bubblewrap and ffmpeg as `.github/workflows/ci.yml` installs them; iproute2, strace,
 * squashfs-tools and zip, which suites spawn; tini, which reaps what a suite's daemons orphan; git built as above;
 * and a bootstrap bun only to run the install, after which every row runs the lock's.
 */
export const SYSTEM = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
hostname localhost || true
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl unzip zip xz-utils procps psmisc lsof python3 \
  bubblewrap ffmpeg sqlite3 jq openssl tzdata iproute2 strace squashfs-tools tini file \
  fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  build-essential libcurl4-openssl-dev libexpat1-dev libssl-dev zlib1g-dev libpcre2-dev
curl -fsSL -o /tmp/git.tar.xz https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT.version}.tar.xz
echo "${GIT.sha256}  /tmp/git.tar.xz" | sha256sum -c -
tar -xJf /tmp/git.tar.xz -C /tmp
make -C /tmp/git-${GIT.version} -j4 prefix=/usr/local NO_GETTEXT=1 NO_TCLTK=1 USE_LIBPCRE2=1 all install >/dev/null
rm -rf /tmp/git.tar.xz /tmp/git-${GIT.version}
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y -qq --no-install-recommends /tmp/chrome.deb
rm -f /tmp/chrome.deb
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
id ci >/dev/null 2>&1 || useradd -m -s /bin/bash ci
mkdir -p ${REPO} /ci
chown -R ci:ci /home/ci/work /ci
apt-get clean
rm -rf /var/lib/apt/lists/*`;

/** As the user: the commit's pack (`pipeIn` to /ci/pack) into the repository the environment holds (a new one when
 *  preparing), then the commit checked out on a local branch, as a GitHub runner's checkout leaves it, and clean. */
export const RECEIVE = String.raw`set -eu
sha="$1"
cd ${REPO}
[ -d .git ] || git init -q .
git index-pack --stdin < /ci/pack >/dev/null
rm -f /ci/pack
git checkout -q -f -B ci "$sha"
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then printf 'the checkout of %s is not clean:\n%s\n' "$sha" "$dirty" >&2; exit 1; fi`;

/** As the user: the locked install with its `prepare` hook, and the smoke a shard depends on. */
export const INSTALL = String.raw`set -eu
cd ${REPO}
PATH=/usr/local/bin:/usr/bin:/bin bun install --frozen-lockfile
node_modules/.bin/bun --version
test -x node_modules/.bin/workerd && node_modules/.bin/workerd --version
google-chrome --version
bwrap --unshare-all --die-with-parent --ro-bind / / true
ffmpeg -version | head -n 1`;


/**
 * As root, detached so the exec that launches it returns: fresh tmpfs at /tmp and /dev/shm (the container's own /tmp
 * reports no free inodes, which `scripts/preflight.ts` refuses, and its /dev/shm is root's alone), then the ladder's
 * argv as the user under tini as subreaper, its stdout to `$1`, its exit code to /ci/exit.
 */
export const LAUNCH = String.raw`set -eu
out="$1"; shift
for dir in /tmp /dev/shm; do mkdir -p "$dir"; mount -t tmpfs -o mode=1777,size=6g tmpfs "$dir"; done
rm -f /ci/exit /ci/log /ci/plan.json /ci/verdicts.json
cd ${REPO}
setsid tini -s -- ${AS_USER.join(' ')} sh -c 'out="$1"; shift; if [ "$out" = log ]; then "$@" >/ci/log 2>&1; else "$@" >"$out" 2>/ci/log; fi; echo $? > /ci/exit' ci-shard "$out" "$@" </dev/null >/dev/null 2>&1 &`;

/** One line of state: the exit code once there is one, the log's size, and its last line. */
export const STATUS = String.raw`exit_code="$(cat /ci/exit 2>/dev/null || true)"
size="$(stat -c %s /ci/log 2>/dev/null || echo 0)"
last="$(tail -c 2000 /ci/log 2>/dev/null | tr -d '\r' | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-300 || true)"
printf '%s\t%s\t%s\n' "$exit_code" "$size" "$last"`;

/** `body` written to `path` in the container, for the user, as the devbox golden pipes its tools in (golden.ts). */
export async function pipeIn(container: Container, body: ReadableStream, path: string): Promise<void> {
  const writer = await container.exec(['/bin/sh', '-c', 'cat > "$1" && chown ci:ci "$1"', 'pipe-in', path], { stdin: 'pipe' });

  if (writer.stdin === null) throw new Error(`writing ${path}: the exec took no stdin`);
  await body.pipeTo(writer.stdin);
  const written = await writer.output();

  if (written.exitCode !== 0) throw new Error(`writing ${path} exited ${String(written.exitCode)}: ${new TextDecoder().decode(written.stderr).slice(-600)}`);
}

/** A container started anew: one an earlier attempt left running, which `running` may not report yet, goes first. */
export async function startFresh(container: Container, options: ContainerStartupOptions): Promise<void> {
  if (container.running) await container.destroy();

  try {
    container.start(options);
  } catch (cause) {
    if (!(cause instanceof Error && cause.message.includes('already running'))) throw cause;
    await container.destroy();
    container.start(options);
  }
}

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Exec extends Omit<ContainerExecOptions, 'user' | 'signal'> {
  /** An exec can wait on a container that never answers. */
  readonly ms: number;
  readonly asUser?: boolean;
}

/** `argv` in the container, as root or as the user, and its whole output. */
export async function run(container: Container, argv: string[], options: Exec): Promise<Ran> {
  const { ms, asUser = false, ...exec } = options;
  const child = await container.exec(asUser ? [...AS_USER, ...argv] : argv, { ...exec, signal: AbortSignal.timeout(ms) });
  const out = await child.output();
  const decoder = new TextDecoder();

  return { exitCode: out.exitCode, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

/** `run`, refused on a non-zero exit with the tail of what it said, and named on any other failure. */
export async function must(container: Container, doing: string, argv: string[], options: Exec): Promise<Ran> {
  const [settled] = await Promise.allSettled([run(container, argv, options)]);

  if (settled.status === 'rejected') throw new Error(`${doing} failed to run`, { cause: settled.reason });
  const ran = settled.value;

  if (ran.exitCode !== 0) throw new Error(`${doing} exited ${String(ran.exitCode)}: ${(ran.stderr + ran.stdout).slice(-3000)}`);

  return ran;
}
