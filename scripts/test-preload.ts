// Every test process gets a throwaway PROTEUS_HOME.
//
// `proteusHome()` falls back to `~/.proteus`, and a test that drives the local
// runtime writes there for real: `createCLIRuntime` builds a shadow-git
// checkpoint engine rooted at `$PROTEUS_HOME/checkpoints`, and every /pc or
// /workspace write snapshots into it. That is how packages/cli-backend/tests/
// mount-plane.test.ts put ~580 checkpoint stores — keyed by its own /tmp
// scratch directories — into the developer's real home.
//
// Setting it per suite would be one more thing to remember in each of the
// eleven test files that build a runtime, so it is set once, here, for every
// `bun test` process. Tests that need the fallback still delete the variable
// themselves.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'proteus-test-home-'));
process.env.PROTEUS_HOME = home;
// `exit` fires on a normal end and on an uncaught throw, but NOT when the
// process is signalled — and every agent and CI step runs suites under
// `timeout <n> bun test`, whose default kill is SIGTERM. That single gap leaked
// 3,655 `proteus-test-home-*` directories into /tmp, which reached 100% of its
// inodes (with 8 GB of bytes still free) and made `mkdtemp` fail, so `bun test`
// died before collecting a single test. SIGKILL remains uncatchable by
// definition; `scripts/preflight.ts --reclaim` is the backstop for that.
const release = (): void => rmSync(home, { recursive: true, force: true });
process.on('exit', release);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    release();
    // Re-raise the default disposition rather than swallowing the signal: a
    // runner that reports success for a killed suite is worse than the leak.
    // The listener must go first — re-raising while it is still registered
    // re-enters this handler instead of terminating.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// Self-healing, because none of the above is sufficient. Bun's test runner does
// not reach a JS signal handler on every kill path, and SIGKILL is uncatchable
// by definition, so a suite that dies under `timeout` still strands its home.
// Measured: 3,655 stranded directories took /tmp to 100% of its INODES while 8
// GB of bytes were still free, and `mkdtemp` then failed so `bun test` died
// before collecting a single test — an environment fault that reads as a code
// defect in whatever change happened to be under test.
//
// So every test process also reclaims homes old enough that no live suite can
// own one. The bound is 30 minutes against a `timeout 600` ceiling, which is
// 3x headroom; the cost is one readdir plus a stat per entry.
const STALE_HOME_MS = 30 * 60 * 1000;
const cutoff = Date.now() - STALE_HOME_MS;
const tmp = tmpdir();
for (const name of readdirSync(tmp)) {
  if (!name.startsWith('proteus-test-home-') || join(tmp, name) === home) continue;
  const path = join(tmp, name);
  // A racing peer may remove it between the stat and the rm; `force` covers
  // that. Anything else — a permission fault, a path that is not ours — must
  // surface rather than be swallowed into a silently growing directory.
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || stat.mtimeMs >= cutoff) continue;
  rmSync(path, { recursive: true, force: true });
}
