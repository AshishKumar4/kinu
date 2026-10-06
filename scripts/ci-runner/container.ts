/**
 * What runs inside a CI container, and the one way the Worker runs it. Preparation starts Cloudflare's managed
 * `cloudflare/debian-trixie` (DEVBOX-DECISIONS D72: no image of ours to build, push or roll out), gives it what the
 * GitHub runner has and the tier needs, installs one tree's locked dependencies, and snapshots it. A shard starts from
 * that snapshot and only takes in its commit.
 */

/** The account's largest instance (DEVBOX-DECISIONS D50): 4 vCPU, 12 GiB, 20 GB, the GitHub runner's CPU count. */
export const INSTANCE = 'standard-4';

/** The unprivileged user every test runs as, as on a GitHub runner. */
export const USER = 'ci';

/** What the ladder runs under: the lock's own bun first, as `scripts/repo-runtime.sh` puts it on a GitHub runner. */
export const SHELL_ENV = {
  PATH: '/work/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/ci',
  CI: 'true',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
} satisfies Record<string, string>;

/**
 * The GitHub runner's tools the tier reads, as root: git, Chrome where `scripts/test-chrome.ts` looks for it
 * (`/usr/bin/google-chrome`), bubblewrap and ffmpeg as `.github/workflows/ci.yml` installs them, and a bootstrap bun
 * only to run the install; every row then runs the lock's.
 */
export const SYSTEM = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
hostname localhost || true
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git unzip xz-utils procps psmisc lsof python3 \
  bubblewrap ffmpeg sqlite3 jq openssl tzdata fonts-liberation fonts-dejavu-core fonts-noto-color-emoji
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y -qq --no-install-recommends /tmp/chrome.deb
rm -f /tmp/chrome.deb
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
id ci >/dev/null 2>&1 || useradd -m -s /bin/bash ci
mkdir -p /work /ci
chown ci:ci /work /ci
apt-get clean
rm -rf /var/lib/apt/lists/*`;

/** As the user: the commit's pack from stdin into the repository the environment holds (a new one when preparing),
 *  then the commit checked out on a local branch, as a GitHub runner's checkout leaves it, and clean. */
export const RECEIVE = String.raw`set -eu
sha="$1"
cd /work
[ -d .git ] || git init -q .
git index-pack --stdin >/dev/null
git checkout -q -f -B ci "$sha"
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then printf 'the checkout of %s is not clean:\n%s\n' "$sha" "$dirty" >&2; exit 1; fi`;

/** As the user: the locked install with its `prepare` hook, and the smoke a shard depends on. */
export const INSTALL = String.raw`set -eu
cd /work
PATH=/usr/local/bin:/usr/bin:/bin bun install --frozen-lockfile
node_modules/.bin/bun --version
test -x node_modules/.bin/workerd && node_modules/.bin/workerd --version
google-chrome --version
bwrap --unshare-all --die-with-parent --ro-bind / / true
ffmpeg -version | head -n 1`;

/** As the user: the bun cache goes, since the install linked its files out of it. The repository and its checkout stay,
 *  so a shard's checkout moves only the files its commit changed. */
export const LEAVE_INSTALLED = 'rm -rf /home/ci/.bun/install/cache';

/** Detached, so the exec that launches it returns: the ladder's argv, its stdout to `$1`, its exit code to /ci/exit. */
export const LAUNCH = String.raw`set -eu
out="$1"; shift
rm -f /ci/exit /ci/log /ci/plan.json /ci/verdicts.json
cd /work
setsid sh -c 'out="$1"; shift; if [ "$out" = log ]; then "$@" >/ci/log 2>&1; else "$@" >"$out" 2>/ci/log; fi; echo $? > /ci/exit' ci-shard "$out" "$@" </dev/null >/dev/null 2>&1 &`;

/** One line of state: the exit code once there is one, the log's size, and its last line. */
export const STATUS = String.raw`exit_code="$(cat /ci/exit 2>/dev/null || true)"
size="$(stat -c %s /ci/log 2>/dev/null || echo 0)"
last="$(tail -c 2000 /ci/log 2>/dev/null | tr -d '\r' | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-300 || true)"
printf '%s\t%s\t%s\n' "$exit_code" "$size" "$last"`;

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `argv` in the container, its whole output, bounded by `ms`: an exec can wait on a container that never answers. */
export async function run(container: Container, argv: string[], options: ContainerExecOptions & { readonly ms: number }): Promise<Ran> {
  const { ms, ...exec } = options;
  const child = await container.exec(argv, { ...exec, signal: AbortSignal.timeout(ms) });
  const out = await child.output();
  const decoder = new TextDecoder();

  return { exitCode: out.exitCode, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

/** `run`, refused on a non-zero exit with the tail of what it said. */
export async function must(container: Container, doing: string, argv: string[], options: ContainerExecOptions & { readonly ms: number }): Promise<Ran> {
  const ran = await run(container, argv, options);

  if (ran.exitCode !== 0) throw new Error(`${doing} exited ${String(ran.exitCode)}: ${(ran.stderr + ran.stdout).slice(-3000)}`);

  return ran;
}
