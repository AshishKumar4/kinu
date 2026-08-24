import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EXCLUSION_GROUPS, SERIAL_GATES, deployExclusions, deployWaves } from "./ladder";
import * as v from "valibot";

const REPO_ROOT = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

const BENCH_GATE_FILES = [
  "scripts/bench-inference-proxy.test.ts",
  "scripts/bench-pi-worker.test.ts",
  "scripts/bench.test.ts",
  "packages/core/tests/unit-bench-longhorizon.test.ts",
  "packages/core/tests/unit-bench-report.test.ts",
  "packages/core/tests/unit-bench-split.test.ts",
  "packages/core/tests/unit-bench-stats.test.ts",
] as const;

const REQUIRED_GATES = [
  "bun scripts/preflight.ts",
  "bun run check",
  "bun test scripts/deploy.test.ts",
  "bun run test",
  "bun run test:mutation",
  "bun test packages/test-utils/",
  "bun test --parallel=4 packages/cf-backend/",
  "bun run test:workerd",
  "bun test --parallel=4 packages/cli-backend/",
  "bun run test:cli",
  "bun test scripts/eval.test.ts scripts/eval-triage.test.ts",
  `bun test ${BENCH_GATE_FILES.join(" ")}`,
  "bun test scripts/secret-scan.test.ts scripts/sources.test.ts",
  "bun scripts/secret-scan.ts",
  "bun scripts/schema-drift.ts",
  "bun scripts/tracing-gate.ts",
  "bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/doc-claims.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts scripts/silent-drop.test.ts",
  "bun test scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts",
  "bun test scripts/gate-set-equality.test.ts",
  "bun test scripts/wired.test.ts",
  "bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts scripts/control-plane-ux.test.ts scripts/feedback-ux.test.ts",
  "bun test scripts/public-pages.test.ts",
      "bun test scripts/swarm-tree-geometry.test.ts",
  "bun test scripts/chat-scroll.test.ts",
  "bun test scripts/ladder.test.ts",
  "bun run gate:dead-code",
  "bun run gate:wired",
  "bun run gate:duplication",
  "bun run gate:capability-parity",
  "bun run gate:policy-drift",
  "bun run gate:silent-drop",
  "bun run gate:scratch-ownership",
  "bun run gate:agents-fields",
  "bun run gate:do-init",
  "bun run gate:reachability",
  "bun run gate:platform",
  "bun run gate:egress-interception",
  "bun run gate:typecheck-coverage",
  "bun run gate:skip-ratchet",
  "bun run gate:set-equality",
  "bun run gate:literature-citations",
  "bun run gate:doc-claims",
  "bun run gate:commit-message",
  "bun run gate:install-scripts",
  "bun run gate:dependency-advisories",
  "bun run gate:patch-parity",
  "bun run gate:bench-corpus",
  "bun test packages/pc-agent/",
  "bun test ./tests/",
  "bun run layergate",
  "bun run layergate --matrix",
  "bun run verify:lean",
  "bun run gate:infra",
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

/** A CLI launched to prove an install works must read no state but the install's.
 *  Left on the ambient environment it opens the developer's own ~/.kinu — live
 *  config and SQLite that another process may be writing — so a launch failure
 *  could mean anything, which is the one thing a smoke test must not mean. */
function freshHome(directory: string) {
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  return { ...process.env, HOME: home, KINU_HOME: join(home, ".kinu") };
}

/** Why a launch failed, in the assertion message. A bare exit code hides a
 *  signal kill behind an empty stderr, and this suite installs two ~2 GB trees
 *  into tmpfs: a red that says nothing cannot be told from a red that means
 *  the distribution no longer resolves. */
function launchFailure(result: Bun.SyncSubprocess): string {
  const decoder = new TextDecoder();
  return [
    `exit=${String(result.exitCode)} signal=${String(result.signalCode)}`,
    decoder.decode(result.stderr).trim(),
    decoder.decode(result.stdout).trim(),
  ].filter((part) => part.length > 0).join("\n");
}

function commandStub(name: string): string {
  return `#!/usr/bin/bash
command_line="${name} $*"
printf '%s\\n' "$command_line" >> "$KINU_DEPLOY_GATE_LOG"
if [ "$KINU_DEPLOY_FAIL" = "$command_line" ]; then
  exit 47
fi
exit 0
`;
}

function runDeploy(failingGate: string, dirty = false, environment = "production") {
  const fixture = mkdtempSync(join(tmpdir(), "kinu-deploy-gate-"));
  temporaryDirectories.push(fixture);
  const log = join(fixture, "events.log");
  const buildEnvironmentLog = join(fixture, "build-environment.log");

  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "node_modules"));
  mkdirSync(join(fixture, "packages", "cf-backend"), { recursive: true });
  for (const relativePath of BENCH_GATE_FILES) {
    const path = join(fixture, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  executable(
    join(fixture, "scripts", "deploy.sh"),
    readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8"),
  );

  executable(join(fixture, "bun"), commandStub("bun"));
  executable(join(fixture, "bash"), commandStub("bash"));
  executable(join(fixture, "git"), `#!/usr/bin/bash
if [ "$3" = "rev-parse" ]; then
  printf 'testsha\\n'
elif [ "$3" = "status" ] && [ "$KINU_DEPLOY_DIRTY" = "1" ]; then
  printf ' M source.ts\\n'
fi
exit 0
`);
  executable(join(fixture, "bunx"), `#!/usr/bin/bash
printf 'MUTATE bunx %s\\n' "$*" >> "$KINU_DEPLOY_GATE_LOG"
printf '%s\n' "\${CLOUDFLARE_ENV:-root}" > "$KINU_DEPLOY_BUILD_ENV_LOG"
exit 86
`);
  executable(join(fixture, "npx"), `#!/usr/bin/bash
if [ "$*" = "wrangler whoami" ]; then
  exit 0
fi
printf 'MUTATE npx %s\\n' "$*" >> "$KINU_DEPLOY_GATE_LOG"
exit 87
`);

  const run = Bun.spawnSync(["/usr/bin/bash", "scripts/deploy.sh", environment], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${fixture}:/usr/bin:/bin`,
      KINU_DEPLOY_FAIL: failingGate,
      KINU_DEPLOY_GATE_LOG: log,
      KINU_DEPLOY_BUILD_ENV_LOG: buildEnvironmentLog,
      KINU_DEPLOY_DIRTY: dirty ? "1" : "0",
      SKIP_E2E: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const events = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const buildEnvironment = existsSync(buildEnvironmentLog)
    ? readFileSync(buildEnvironmentLog, "utf8").trim()
    : null;
  return { status: run.exitCode, events, stdout: run.stdout.toString(), buildEnvironment };
}

describe("deploy gate", () => {
  // WHAT PARALLELISM CHANGED, and what it did not.
  //
  // These assertions used to be `events == REQUIRED_GATES` and, per failing gate,
  // `events == REQUIRED_GATES.slice(0, n + 1)`. Both read a total order off the
  // event log, and deploy.sh now runs the middle 50 gates concurrently, so that
  // order is scheduling noise.
  //
  // The properties the total order was standing in for are all still asserted, and
  // one is new:
  //   - every declared gate RUNS (set equality, so a dropped gate still fails — the
  //     old ordered compare caught that and this catches it too);
  //   - every SERIAL_GATE sits in its own wave at the position it declares;
  //   - a failing gate stops the pipeline: no build mutation, and the run is
  //     strictly shorter than a whole run;
  //   - nothing mutates before the gates finish.
  test("runs every declared gate before the first build mutation", () => {
    const run = runDeploy("");

    expect(run.status).not.toBe(0);
    expect([...run.events].sort()).toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(run.events.at(-1)).toBe("MUTATE bunx vite build");
    expect(run.buildEnvironment).toBe("root");
  });

  test("the serial gates run alone, and everything else runs concurrently", () => {
    // STRUCTURAL, over the waves deploy.sh declares. The first version of this
    // read the order off the stub log, and commenting the preflight barrier out
    // left it GREEN: with the barrier gone preflight is still queue index 0, so
    // the scheduler launched it first and the log looked identical. A grouping
    // cannot be satisfied by luck.
    const waves = deployWaves(readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8"));
    const alone = waves.filter((wave) => wave.length === 1).flat();

    expect(alone.sort()).toEqual(Object.keys(SERIAL_GATES).sort());
    // Three waves: preflight, one concurrent source block, then infrastructure.
    // Barriers around every source gate would satisfy `alone` and make the
    // pipeline serial, so pin the middle size.
    expect(waves.length).toBe(3);
    expect(waves[0]).toEqual(["bun scripts/preflight.ts"]);
    expect(waves[1]?.length).toBe(51);
    expect(waves[2]).toEqual(["bun run gate:infra"]);
  });

  test("every gate has a process-tree deadline", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source).toContain("GATE_DEADLINE_SECONDS=180");
    expect(source).toContain(
      'timeout --signal=TERM --kill-after=5s "$GATE_DEADLINE_SECONDS" ${GATE_CMDS[pick]}',
    );
  });

  test("the exclusion table in the runner is the one the ladder declares", () => {
    // Written twice because the runner is bash and cannot import the
    // declaration, so it is asserted once. Without this the measured reason
    // lives in TypeScript and the behaviour lives in shell, and either can move.
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    const declared = Object.fromEntries(
      Object.entries(EXCLUSION_GROUPS).map(([group, entry]) => [group, [...entry.gates].sort()]),
    );
    const inRunner = Object.fromEntries(
      Object.entries(deployExclusions(source)).map(([group, gates]) => [group, [...gates].sort()]),
    );
    expect(inRunner).toEqual(declared);

    // A group member that is not a gate excludes nothing, and a group of one
    // excludes nothing either. Both read as a rule and are not one.
    for (const [group, entry] of Object.entries(EXCLUSION_GROUPS)) {
      expect(entry.gates.length, `group ${group} holds fewer than two gates`)
        .toBeGreaterThan(1);
      for (const gate of entry.gates) {
        const gates: string[] = [...REQUIRED_GATES];
        expect(gates, `${gate} is in group ${group} and is not a gate`).toContain(gate);
      }
    }
  });

  test("the serial gates are the ends of the real run", () => {
    const run = runDeploy("");
    const gates = run.events.filter((event) => !event.startsWith("MUTATE "));

    expect(gates[0]).toBe("bun scripts/preflight.ts");
    expect(gates.at(-1)).toBe("bun run gate:infra");
  });

  // The budget is EXPLICIT because the work is quadratic and bun's 5000ms
  // default is not a decision anybody made about this test. One deploy run per
  // gate, each running every earlier gate's stub: 53 gates is ~2,800 process
  // spawns.
  test("every gate fails closed even when the former skip variable is set", () => {
    const last = REQUIRED_GATES.at(-1);
    for (const gate of REQUIRED_GATES) {
      const run = runDeploy(gate);

      expect(run.status, `${gate} did not fail the deploy`).not.toBe(0);
      expect(run.events, `${gate} failed and never ran`).toContain(gate);
      expect(
        run.events.some((event) => event.startsWith("MUTATE ")),
        `${gate} failed and the build ran anyway`,
      ).toBe(false);
      // A failure TRUNCATES the run. Only the final gate can fail with every
      // other gate already behind it.
      if (gate !== last) {
        expect(run.events.length, `${gate} failed and the whole tier ran anyway`)
          .toBeLessThan(REQUIRED_GATES.length);
        expect(run.events, `${gate} failed and the Cloudflare gate ran anyway`)
          .not.toContain("bun run gate:infra");
      }
    }
  }, 60_000);

  test("a dirty checkout is rejected before verification or mutation", () => {
    const run = runDeploy("", true);

    expect(run.status).not.toBe(0);
    expect(run.events).toEqual([]);
  });

  // ── The environment argument ───────────────────────────────────
  //
  // staging.kinu.run served for days with nothing deploying it, and the reason a
  // second script was not written is asserted here: one script means the gate
  // set, the asset check and the smoke gate cannot be present for production and
  // absent for staging. The two environments differ in four values, and these
  // tests are about the two an operator can see.
  test("staging runs the same gates as production, against the staging route", () => {
    const run = runDeploy("", false, "staging");

    expect([...run.events].sort()).toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(run.stdout).toContain("Environment:  staging");
    expect(run.stdout).toContain("Target:       https://staging.kinu.run/");
    expect(run.buildEnvironment).toBe("staging");
  });

  test("an unknown environment deploys nothing", () => {
    const run = runDeploy("", false, "preprod");

    expect(run.status).toBe(2);
    expect(run.events).toEqual([]);
    expect(run.stdout).toContain("Usage: scripts/deploy.sh <production|staging>");
  });
});

describe("CLI source archive", () => {
  test("contains every patch declared by its packaged manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "kinu-cli-archive-test-"));
    temporaryDirectories.push(directory);
    const archive = join(directory, "kinu-source.tar.gz");
    const decoder = new TextDecoder();
    const build = Bun.spawnSync(
      ["bash", join(REPO_ROOT, "scripts", "build-cli-source-archive.sh"), archive],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(build.exitCode, decoder.decode(build.stderr)).toBe(0);

    const manifestResult = Bun.spawnSync(
      ["tar", "-xOzf", archive, "kinu/package.json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(manifestResult.exitCode, decoder.decode(manifestResult.stderr)).toBe(0);
    const manifest = v.parse(
      v.object({
        patchedDependencies: v.optional(v.record(v.string(), v.string())),
        scripts: v.optional(v.record(v.string(), v.string())),
      }),
      JSON.parse(decoder.decode(manifestResult.stdout)),
    );
    const patchPaths = Object.values(manifest.patchedDependencies ?? {});
    expect(patchPaths.length, "the fixture stopped exercising archive patches").toBeGreaterThan(0);
    expect(manifest.scripts?.prepare, "distribution archive retained the development prepare hook").toBeUndefined();

    const listingResult = Bun.spawnSync(
      ["tar", "-tzf", archive],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(listingResult.exitCode, decoder.decode(listingResult.stderr)).toBe(0);
    const members = new Set(decoder.decode(listingResult.stdout).trim().split("\n"));
    const lockResult = Bun.spawnSync(
      ["tar", "-xOzf", archive, "kinu/bun.lock"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(lockResult.exitCode, decoder.decode(lockResult.stderr)).toBe(0);

    const extracted = join(directory, "extracted");
    mkdirSync(extracted);
    const unpack = Bun.spawnSync(
      ["tar", "-xzf", archive, "-C", extracted],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(unpack.exitCode, decoder.decode(unpack.stderr)).toBe(0);
    const sourceRoot = join(extracted, "kinu");
    const install = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile"],
      { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(install.exitCode, decoder.decode(install.stderr)).toBe(0);
    const launch = Bun.spawnSync(
      [process.execPath, "packages/cli/bin/cli.ts", "--version"],
      { cwd: sourceRoot, env: freshHome(directory), stdout: "pipe", stderr: "pipe" },
    );
    expect(launch.exitCode, launchFailure(launch)).toBe(0);
    expect(decoder.decode(launch.stdout)).toMatch(/^0\.2\.0\+/);
    const lock = decoder.decode(lockResult.stdout);

    for (const patchPath of patchPaths) {
      expect(members.has(`kinu/${patchPath}`), `archive omitted ${patchPath}`).toBe(true);
      expect(lock, `archive lock stopped naming ${patchPath}`).toContain(patchPath);
    }
  }, 120_000);

  // The install this asserts is the one a stranger runs, and its outcome must not
  // depend on which Bun they happen to have. It did: Bun 1.3.0 and 1.3.1 default a
  // WORKSPACE to the isolated linker, 1.3.1 predates the `configVersion` field that
  // records this project's hoisted intent, and the archive shipped no bunfig — so a
  // fresh macOS install resolved isolated, `packages/core` saw only its declared
  // dependencies, and `kinu --version` died with
  // `Cannot find module '@ai-sdk/provider-utils'`. The test above could not catch it,
  // because it inherits the RUNNER's default rather than stating the distribution's.
  //
  // `configVersion: 1` is Bun's own switch for "default this workspace to isolated",
  // so rewriting it reproduces the 1.3.1 default on any current Bun. The install runs
  // with no linker flag: a flag would override the shipped bunfig and test nothing.
  test("installs and launches on a Bun that defaults a workspace to isolated", () => {
    const directory = mkdtempSync(join(tmpdir(), "kinu-cli-linker-test-"));
    temporaryDirectories.push(directory);
    const decoder = new TextDecoder();
    const archive = join(directory, "kinu-source.tar.gz");
    const build = Bun.spawnSync(
      ["bash", join(REPO_ROOT, "scripts", "build-cli-source-archive.sh"), archive],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(build.exitCode, decoder.decode(build.stderr)).toBe(0);

    const extracted = join(directory, "extracted");
    mkdirSync(extracted);
    const unpack = Bun.spawnSync(
      ["tar", "-xzf", archive, "-C", extracted],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(unpack.exitCode, decoder.decode(unpack.stderr)).toBe(0);
    const sourceRoot = join(extracted, "kinu");

    // The pin is the repository's own line, not a second copy of the decision.
    const repositoryLinker = /^\s*linker\s*=\s*"([^"]+)"/m
      .exec(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8"))?.[1];
    expect(repositoryLinker, "the repository stopped declaring an [install] linker").toBeDefined();
    const shipped = readFileSync(join(sourceRoot, "bunfig.toml"), "utf8");
    expect(shipped, "the distribution bunfig drifted from the repository's linker")
      .toContain(`linker = "${repositoryLinker ?? ""}"`);
    // Shipping the repository's bunfig verbatim exits `bun install` 1 outright:
    // it names ./scripts/security-scanner.ts, which the distribution omits.
    expect(shipped, "the distribution bunfig names a scanner it does not ship")
      .not.toContain("scanner");

    const lockPath = join(sourceRoot, "bun.lock");
    const lock = readFileSync(lockPath, "utf8");
    expect(lock, "bun.lock stopped carrying configVersion").toMatch(/"configVersion": \d+/);
    writeFileSync(lockPath, lock.replace(/"configVersion": \d+/, '"configVersion": 1'));

    const install = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile"],
      { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(install.exitCode, decoder.decode(install.stderr)).toBe(0);
    expect(
      existsSync(join(sourceRoot, "node_modules", ".bun")),
      "the distribution installed isolated: the shipped linker pin was not honoured",
    ).toBe(false);

    const launched = freshHome(directory);
    const version = Bun.spawnSync(
      [process.execPath, "packages/cli/bin/cli.ts", "--version"],
      { cwd: sourceRoot, env: launched, stdout: "pipe", stderr: "pipe" },
    );
    expect(version.exitCode, launchFailure(version)).toBe(0);
    expect(decoder.decode(version.stdout)).toMatch(/^0\.2\.0\+/);

    // What install.sh itself greps for before calling the install good.
    const help = Bun.spawnSync(
      [process.execPath, "packages/cli/bin/cli.ts", "--help"],
      { cwd: sourceRoot, env: launched, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(help.exitCode, launchFailure(help)).toBe(0);
    expect(decoder.decode(help.stdout)).toMatch(/^[ \t]+setup[ \t]/m);
  }, 300_000);
});
