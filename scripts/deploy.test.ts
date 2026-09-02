import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  EXCLUSION_GROUPS, GATE_DEADLINES, SERIAL_GATES, deployDeadlines, deployExclusions, deployWaves,
} from "./ladder";
import { CONTROL_PLANE_ACCESS_PATHS, deriveInfrastructure } from "./infra-manifest";
import { isControlPlaneSurface } from "../packages/cf-backend/src/control-plane/access-gate";
import { isDocument, readRepositoryFile, trackedFiles } from "./sources";
import * as v from "valibot";

const REPO_ROOT = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

/** The bench gate's argv AS THE FIXTURE REPO EXPANDS IT: the first seven words
 *  are what bash resolves the two globs to inside `runDeploy`'s fixture, and the
 *  rest are literal path words. One list drives both the files written into that
 *  fixture and the command line REQUIRED_GATES expects, so the two cannot
 *  disagree. */
const BENCH_GATE_FILES = [
  "scripts/bench-inference-proxy.test.ts",
  "scripts/bench-pi-worker.test.ts",
  "scripts/bench.test.ts",
  "packages/core/tests/unit-bench-longhorizon.test.ts",
  "packages/core/tests/unit-bench-report.test.ts",
  "packages/core/tests/unit-bench-split.test.ts",
  "packages/core/tests/unit-bench-stats.test.ts",
  "scripts/sandbox-durability-probe.test.ts",
  "scripts/capture-probe.test.ts",
  "scripts/capture-probe-live.test.ts",
  "scripts/storage-matrix-admission.test.ts",
  "scripts/storage-matrix-cleanup.test.ts",
  "scripts/storage-matrix-manifest.test.ts",
  "scripts/storage-matrix-protocol.test.ts",
  "scripts/deploy-substrate.test.ts",
  "scripts/payload-transport.test.ts",
  "scripts/devbox-e2e.test.ts",
] as const;

const REQUIRED_GATES = [
  "bun scripts/preflight.ts",
  "bun run check",
  "bun test scripts/deploy.test.ts",
  "bun run test",
  "bun run gate:python-suites",
  "bun run test:mutation",
  "bun run gate:mutation-fences",
  "bun run gate:twin-differential",
  "bun test packages/devbox/",
  "bun test packages/test-utils/",
  "bun test --parallel=4 packages/cf-backend/",
  "bun run test:workerd",
  "bun test --parallel=4 packages/cli-backend/",
  "bun run test:cli",
  "bun test scripts/eval.test.ts scripts/eval-triage.test.ts scripts/staging-preflight.test.ts",
  `bun test ${BENCH_GATE_FILES.join(" ")}`,
  "bun test scripts/secret-scan.test.ts scripts/sources.test.ts",
  "bun scripts/secret-scan.ts",
  "bun scripts/schema-drift.ts",
  "bun scripts/tracing-gate.ts",
  "bun test scripts/hammer.test.ts scripts/mutation-fences.test.ts",
  "bun test scripts/gates.test.ts scripts/schema-drift.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts scripts/silent-drop.test.ts scripts/analytics-datasets.test.ts scripts/release-config.test.ts scripts/complexity.test.ts scripts/dead-code.test.ts scripts/scanner-bundle-gate.test.ts scripts/coverage-merge.test.ts",
  "bun test scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts scripts/python-suites.test.ts",
  "bun test scripts/gate-set-equality.test.ts",
  "bun test scripts/wired.test.ts",
  "bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts scripts/control-plane-ux.test.ts scripts/feedback-ux.test.ts scripts/plan-review-ux.test.ts",
  "bun test scripts/public-pages.test.ts",
  "bun test scripts/client-error-ux.test.ts scripts/lazy-route-ux.test.ts",
  "bun test scripts/react-runtime-identity.test.ts",
  "bun test scripts/nested-container-resolution.test.ts",
      "bun test scripts/swarm-tree-geometry.test.ts",
  "bun test scripts/chat-scroll.test.ts",
  "bun test scripts/ladder.test.ts",
  "bun run gate:complexity",
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
  "bun run gate:commit-message",
  "bun run gate:install-scripts",
  "bun run gate:scanner-bundle",
  "bun run gate:dependency-advisories",
  "bun run gate:patch-parity",
  "bun run gate:bench-corpus",
  "bun test packages/pc-agent/",
  "bun test ./tests/",
  "bun run layergate",
  "bun run layergate --matrix",
  "bun run verify:lean",
  "bun run gate:hammer",
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
# WHAT THE INFRASTRUCTURE GATE ACTUALLY SAW. The phase travels in the
# environment because the gate line has to stay one string for ladder.ts to
# parse, so the only way to assert which phase a deploy ran is to record it from
# inside the gate. Written to its own file: the log above is compared for set
# equality against REQUIRED_GATES and an extra line there is a dropped gate.
if [ "$command_line" = "bun run gate:infra" ]; then
  printf '%s\\n' "\${KINU_INFRA_PHASE:-unset}" > "$KINU_DEPLOY_PHASE_LOG"
fi
if [ "$KINU_DEPLOY_KILL" = "$command_line" ]; then
  # SIGKILL the process the runner is waiting on: the timeout wrapper, which is
  # this stub's parent. The gate then ends having published nothing about itself,
  # which is the OOM-kill shape — the runner has to settle it from the child's
  # fate alone.
  kill -9 "$PPID"
  sleep 30
fi
if [ "$KINU_DEPLOY_FAIL" = "$command_line" ]; then
  exit 47
fi
exit 0
`;
}

/** One deploy run against stub gates.
 *
 *  `failingGate` exits 47; `killGate` SIGKILLs the process the runner waits on,
 *  so that gate settles with no verdict of its own. `tmpdir` points the gate log
 *  directory somewhere, including somewhere that cannot exist. `option` is the
 *  script's second word, and `ambientPhase` is a KINU_INFRA_PHASE already on the
 *  environment — the one thing that must never decide how strictly a deploy is
 *  checked. */
interface DeployRun {
  readonly failingGate?: string;
  readonly killGate?: string;
  readonly dirty?: boolean;
  readonly environment?: string;
  readonly tmpdir?: string;
  readonly option?: string;
  readonly ambientPhase?: string;
}

function runDeploy({
  failingGate = "",
  killGate = "",
  dirty = false,
  environment = "production",
  tmpdir: temporaryRoot,
  option,
  ambientPhase = "",
}: DeployRun = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "kinu-deploy-gate-"));
  temporaryDirectories.push(fixture);
  const log = join(fixture, "events.log");
  const buildEnvironmentLog = join(fixture, "build-environment.log");
  const phaseLog = join(fixture, "infra-phase.log");

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

  const argv = ["/usr/bin/bash", "scripts/deploy.sh", environment];
  if (option !== undefined) argv.push(option);
  const run = Bun.spawnSync(argv, {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${fixture}:/usr/bin:/bin`,
      KINU_DEPLOY_FAIL: failingGate,
      KINU_DEPLOY_KILL: killGate,
      // Always explicit. The gate runner creates its log directory under TMPDIR,
      // and one test points it somewhere that cannot exist.
      TMPDIR: temporaryRoot ?? tmpdir(),
      KINU_DEPLOY_GATE_LOG: log,
      KINU_DEPLOY_BUILD_ENV_LOG: buildEnvironmentLog,
      KINU_DEPLOY_PHASE_LOG: phaseLog,
      // Always set, so the assertion that the script overrides it is about the
      // script rather than about whichever shell ran the suite.
      KINU_INFRA_PHASE: ambientPhase,
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
  const infraPhase = existsSync(phaseLog) ? readFileSync(phaseLog, "utf8").trim() : null;
  return {
    status: run.exitCode, events, stdout: run.stdout.toString(), buildEnvironment, infraPhase,
  };
}

describe("deploy gate", () => {
  // WHAT PARALLELISM CHANGED, and what it did not.
  //
  // These assertions used to be `events == REQUIRED_GATES` and, per failing gate,
  // `events == REQUIRED_GATES.slice(0, n + 1)`. Both read a total order off the
  // event log, and deploy.sh now runs the middle 55 gates concurrently, so that
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
    const run = runDeploy();

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
    // FOUR waves: preflight, one concurrent source block, the hammer, then
    // infrastructure. The hammer earned its own barrier by being the one gate
    // whose subject is contention — it starves nproc/2 threads on purpose, so
    // anything beside it would be measured on a machine this gate is
    // deliberately loading. Barriers around every source gate would satisfy
    // `alone` and make the pipeline serial, so the middle size is pinned.
    // DERIVED from the two lists above rather than written as a number: a
    // literal here has to be edited every time a gate is added, and a number
    // nobody can derive gets edited without being read. The property is the
    // same either way, because a gate that leaves the middle wave has to appear
    // in `SERIAL_GATES` to satisfy the assertion above it.
    expect(waves.length).toBe(4);
    expect(waves[0]).toEqual(["bun scripts/preflight.ts"]);
    expect(waves[1]?.length).toBe(REQUIRED_GATES.length - Object.keys(SERIAL_GATES).length);
    expect(waves[2]).toEqual(["bun run gate:hammer"]);
    expect(waves[3]).toEqual(["bun run gate:infra"]);
  });

  // The Worker version is what a persisted error names, so it has to name the
  // build. Asserted as text because the fixture cannot reach step 3: its build
  // stub fails on purpose, which is what every other test here depends on.
  test("the published version is annotated with the build sha", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source).toContain(
      'KINU_WRANGLER_ARGS+=(--tag "$KINU_SHA" --message "kinu $KINU_ENV $KINU_SHA")',
    );
    expect(source).toContain('npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}"');
  });

  test("every gate has a process-tree deadline", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source).toContain("GATE_DEADLINE_SECONDS=480");
    expect(source).toContain(
      'timeout --signal=TERM --kill-after=5s "${GATE_DEADLINES[${GATE_CMDS[pick]}]:-$GATE_DEADLINE_SECONDS}"'
      + ' ${GATE_CMDS[pick]}',
    );

    // A PER-GATE EXCEPTION IS A DECLARATION, in both files. The runner is bash
    // and cannot import the reason, so the two tables are written twice and
    // held equal here — the same shape as the exclusion table above. Without
    // this, the shared 480s wall could be lifted off every source gate by one
    // edit that looks like it only touches one of them.
    const declared = Object.fromEntries(
      Object.entries(GATE_DEADLINES).map(([run, entry]) => [run, entry.seconds]),
    );
    expect(deployDeadlines(source)).toEqual(declared);
    for (const [run, entry] of Object.entries(GATE_DEADLINES)) {
      const gates: string[] = [...REQUIRED_GATES];
      expect(gates, `${run} has a deadline and is not a gate`).toContain(run);
      expect(entry.seconds, `${run} declares no longer than the shared deadline`)
        .toBeGreaterThan(480);
      expect(entry.why.length, `${run} declares no reason for its own deadline`)
        .toBeGreaterThan(80);
    }
  });

  // A gate can end without saying anything about itself: the OOM killer takes it,
  // or something outside its process tree SIGKILLs it. The runner settles that
  // from the child's exit status, which the kernel supplies whether the gate
  // cooperates or not.
  //
  // The previous runner published each verdict into a status FILE and, when the
  // file was missing, probed `kill -0` on a pid it had already reaped. A recycled
  // pid answers that probe as somebody else's live process, so the gate never
  // settled, nothing was left to wait on, and the wave spun at 100% CPU with the
  // deploy unable to finish. Asserted through a real run rather than by reading
  // the script: the source-text version of this test passed over a runner that
  // could not report.
  test("a gate killed without a verdict of its own fails the deploy", () => {
    const run = runDeploy({ killGate: "bun run check" });

    expect(run.status).not.toBe(0);
    // 128 + SIGKILL. The status is the child's fate, not a claim the gate made.
    expect(run.stdout).toContain("Strict lint and TypeScript failed (exit 137)");
    expect(run.events, "the killed gate never launched").toContain("bun run check");
    expect(
      run.events.some((event) => event.startsWith("MUTATE ")),
      "a gate died unreported and the build ran anyway",
    ).toBe(false);
  }, 30_000);

  // Every gate's output lands in one temp directory and every failure is reported
  // out of it, so a directory that cannot be created is a wave that cannot be
  // reported on. With the creation unchecked, `$dir` is empty, each gate writes to
  // `/0.log`, and a box out of inodes deploys on the strength of logs nobody has.
  test("a gate log directory that cannot be created deploys nothing", () => {
    const run = runDeploy({ tmpdir: join(tmpdir(), "kinu-deploy-no-such-root", "nowhere") });

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain("cannot create a gate log directory");
    expect(run.events).toEqual([]);
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
    const run = runDeploy();
    const gates = run.events.filter((event) => !event.startsWith("MUTATE "));

    expect(gates[0]).toBe("bun scripts/preflight.ts");
    expect(gates.at(-1)).toBe("bun run gate:infra");
  });

  // The budget is EXPLICIT because the work is quadratic and bun's 5000ms
  // default is not a decision anybody made about this test. One deploy run per
  // gate, each running every earlier gate's stub: 57 gates is ~3,200 process
  // spawns.
  test("every gate fails closed even when the former skip variable is set", () => {
    const last = REQUIRED_GATES.at(-1);
    // WHICH WAVE EACH DECLARED GATE IS IN, BY POSITION. deploy.sh spells one
    // gate with a glob and REQUIRED_GATES carries what that glob expands to in
    // the fixture, so matching the two by text finds nothing for that one line
    // — and a not-found wave silently made the assertion below "no gate ran at
    // all". Both lists are the same gates in the same order, which is what the
    // set-equality test above already holds, so position is the exact mapping.
    const waves = deployWaves(readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8"));
    const waveOfGate = waves.flatMap((wave, index) => wave.map(() => index));
    expect(waveOfGate).toHaveLength(REQUIRED_GATES.length);
    for (const gate of REQUIRED_GATES) {
      const run = runDeploy({ failingGate: gate });

      expect(run.status, `${gate} did not fail the deploy`).not.toBe(0);
      expect(run.events, `${gate} failed and never ran`).toContain(gate);
      expect(
        run.events.some((event) => event.startsWith("MUTATE ")),
        `${gate} failed and the build ran anyway`,
      ).toBe(false);
      // A failure TRUNCATES the run. Only the final gate can fail with every
      // other gate already behind it.
      //
      // Expressed over WAVES, which is what the runner actually orders: gates
      // inside one wave run concurrently and finish in no fixed order, so the
      // checkable property is that no gate from a LATER wave ran at all. This
      // was written as "the Cloudflare gate never ran", which said the same
      // thing only while that gate happened to be last — and silently stopped
      // saying anything about the wave that followed it.
      const failedWave = waveOfGate[REQUIRED_GATES.indexOf(gate)] ?? -1;
      const downstream = REQUIRED_GATES.filter(
        (_gate, index) => (waveOfGate[index] ?? -1) > failedWave,
      );
      for (const later of downstream) {
        expect(run.events, `${gate} failed and ${later} ran anyway`).not.toContain(later);
      }
      if (gate !== last) {
        expect(run.events.length, `${gate} failed and the whole tier ran anyway`)
          .toBeLessThan(REQUIRED_GATES.length);
      }
    }
  }, 60_000);

  test("a dirty checkout is rejected before verification or mutation", () => {
    const run = runDeploy({ dirty: true });

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
    const run = runDeploy({ environment: "staging" });

    expect([...run.events].sort()).toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(run.stdout).toContain("Environment:  staging");
    expect(run.stdout).toContain("Target:       https://staging.kinu.run/");
    expect(run.buildEnvironment).toBe("staging");
  });

  test("an unknown environment deploys nothing", () => {
    const run = runDeploy({ environment: "preprod" });

    expect(run.status).toBe(2);
    expect(run.events).toEqual([]);
    expect(run.stdout).toContain("Usage: scripts/deploy.sh <production|staging>");
  });

  // ── The bootstrap option and the phase it selects ──────────────
  //
  // A deploy that DECLARES a resource only a deploy can create used to refuse
  // itself: `ControlPlaneDO` landed in `migrations`, staging's 55 source gates
  // passed, and the infrastructure gate then blocked the one upload that could
  // have created the namespace — telling the operator to run
  // `bun run infra:provision`, which cannot create a Durable Object namespace and
  // is forbidden from trying.
  //
  // `--bootstrap` answers that, and these tests are about the two properties that
  // keep it from being a bypass: it changes the PRE-DEPLOY PHASE and nothing else
  // (no gate is added, dropped or softened), and it cannot be reached by
  // accident, ambient environment, or a typo.
  test("bootstrap changes the phase and not one gate", () => {
    const bootstrap = runDeploy({ environment: "staging", option: "--bootstrap" });

    // Same gates, same set, same failure semantics as any other deploy. This is
    // the assertion that would catch a future `--bootstrap` that skipped a check
    // rather than re-scoping one.
    expect([...bootstrap.events].sort())
      .toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(bootstrap.infraPhase).toBe("bootstrap");
    // The operator is told what is deferred and what is not, before the gates run.
    expect(bootstrap.stdout).toContain("BOOTSTRAP");
    expect(bootstrap.stdout).toContain("Still refused before the upload");

    const normal = runDeploy({ environment: "staging" });
    expect(normal.infraPhase).toBe("full");
    expect([...normal.events].sort()).toEqual([...bootstrap.events].sort());
    expect(normal.stdout).not.toContain("BOOTSTRAP");
  });

  test("an ambient phase variable cannot relax a deploy nobody bootstrapped", () => {
    // The bypass this design refuses. The phase travels in the environment
    // because the gate line has to stay one string for ladder.ts to parse, so the
    // script assigns it in BOTH arms rather than reading whatever was exported —
    // otherwise `export KINU_INFRA_PHASE=bootstrap` in a shell would quietly
    // weaken every deploy launched from it.
    const inherited = runDeploy({ environment: "staging", ambientPhase: "bootstrap" });

    expect(inherited.infraPhase).toBe("full");
    expect(inherited.stdout).not.toContain("BOOTSTRAP");

    // And the flag still wins when it is actually passed, ambient value or not.
    const asked = runDeploy({
      environment: "staging", option: "--bootstrap", ambientPhase: "post-deploy",
    });
    expect(asked.infraPhase).toBe("bootstrap");
  });

  test("an unknown option deploys nothing", () => {
    // Refused rather than ignored. A silently-dropped `--bootstrp` would fail the
    // deploy at the infrastructure gate with a diagnostic about a Durable Object
    // namespace, which is the wrong thing to debug.
    const run = runDeploy({ environment: "staging", option: "--bootstrp" });

    expect(run.status).toBe(2);
    expect(run.events).toEqual([]);
    expect(run.infraPhase).toBeNull();
    expect(run.stdout).toContain("Usage: scripts/deploy.sh <production|staging> [--bootstrap]");
  });

  // ── The post-deploy phase ──────────────────────────────────────
  //
  // Asserted as TEXT, for the reason the version-annotation test above is: the
  // fixture's build stub fails on purpose, which is what every behavioural test
  // in this file depends on, so no run here reaches step 5. The properties that
  // matter are structural anyway — that the invocation exists, that it is
  // unconditional, that it names the strictest phase, and that its failure ends
  // the deploy.
  test("the post-deploy infrastructure phase is unconditional and fails the deploy", () => {
    // EXECUTABLE lines, whole-line comments dropped — the same reading the "no
    // shell script but the deploy script publishes" rule below takes, and for the
    // same reason: this script's prose names every command it runs, so a claim
    // about what it RUNS cannot be made against its comments.
    const lines = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    const source = lines.join("\n");

    // At column zero, and after the upload: nested inside any `if`, this would be
    // a phase some deploys skip, which is the whole thing `--bootstrap` must not
    // become.
    const invocation = 'if bun scripts/infra-verify.ts "$KINU_ENV" --phase=post-deploy; then';
    const upload = 'if npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}" 2>&1 | tee "$KINU_DEPLOY_LOG"; then';
    expect(lines).toContain(invocation);
    expect(lines).toContain(upload);
    expect(lines.indexOf(invocation)).toBeGreaterThan(lines.indexOf(upload));

    // Its failure arm exits. A phase that reported and continued would print
    // findings above a "deployed and verified" summary.
    const arm = lines.slice(lines.indexOf(invocation));
    expect(arm.slice(0, arm.indexOf("fi"))).toContain("  exit 1");

    // `post-deploy` is the only phase spelled on an argv here, and it is the
    // strictest. `bootstrap` reaches the pre-deploy gate through the environment,
    // because that gate line has to stay one string for ladder.ts to parse; a
    // second argv spelling would be a second place for the two to disagree.
    const argvPhases = [...source.matchAll(/--phase=(\S+?)(?=[\s;]|$)/gu)].map(([, phase]) => phase);
    expect(argvPhases).toEqual(["post-deploy"]);

    // The pre-deploy phase is one of exactly two literals, both assigned here, so
    // an ambient value is never what decides it.
    expect(source).toContain('export KINU_INFRA_PHASE="bootstrap"');
    expect(source).toContain('export KINU_INFRA_PHASE="full"');
    expect([...source.matchAll(/KINU_INFRA_PHASE=/gu)]).toHaveLength(2);
  });

  // ── The control plane's outer gate ─────────────────────────────
  //
  // The admin plane fails CLOSED without a verifiable Cloudflare Access
  // assertion, which means a production deploy carrying no Access application
  // does not break loudly — it makes `/control` answer 404 to its own operators,
  // indistinguishable from an allowlist typo. So the proof has to be a gate, and
  // the gate has to be one no deploy can proceed past.
  test("no deploy can proceed without the gate that proves Access covers the admin plane", () => {
    // The declaration, from the manifest rather than from prose: production
    // declares the organization, the application, its Allow policy and the
    // NEGATIVE scope assertion, and every one of them is required — so an absent
    // or unreadable row is a finding and `gate:infra` exits non-zero.
    const infrastructure = deriveInfrastructure();
    const access = infrastructure.resources.filter((resource) =>
      resource.id.startsWith('access-') && resource.environments.includes('production'));
    expect(access.map((resource) => resource.id).sort()).toEqual([
      'access-application.kinu.run',
      'access-organization.kinu.run',
      'access-policy.kinu.run',
      'access-scope.kinu.run',
    ]);
    for (const resource of access) expect(resource.required).toBe(true);

    // And the gate that observes them is a REQUIRED gate of this pipeline,
    // running in its own wave after every source gate. Both halves matter: a
    // declared-and-unobserved resource proves nothing, and an observed-but-
    // optional gate is a warning.
    expect(REQUIRED_GATES).toContain('bun run gate:infra');
    const waves = deployWaves(readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8"));
    // ITS OWN WAVE, AFTER EVERY SOURCE GATE. It is the final required gate,
    // so an account that cannot be proved never reaches Wrangler deployment.
    const infraWave = waves.findIndex((wave) => wave.includes('bun run gate:infra'));
    expect(waves[infraWave]).toEqual(['bun run gate:infra']);
    expect(infraWave).toBe(waves.length - 1);
    expect(readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8")).toContain(
      'run_required_gate "Declared infrastructure exists and is bound" bun run gate:infra',
    );
  });

  test("the Worker demands an assertion for a subset of what Access is told to cover", () => {
    // The containment direction is the whole correctness argument, and it is
    // checkable here because both sides are in this repository: the paths the
    // manifest tells an operator to protect, and the paths the Worker refuses
    // without an assertion.
    //
    // Access covering LESS than the Worker demands is a permanent 404 no operator
    // can clear — there is no way to obtain an assertion for a path the
    // application does not cover. Covering MORE puts an interactive login in
    // front of the public product.
    expect(CONTROL_PLANE_ACCESS_PATHS).toEqual(['/control*', '/api/control*']);
    const covered = (path: string): boolean => CONTROL_PLANE_ACCESS_PATHS.some((pattern) =>
      path.startsWith(pattern.slice(0, -1)));

    for (const path of [
      '/control', '/control/', '/control/users', '/api/control', '/api/control/overview',
    ]) {
      expect(isControlPlaneSurface(path)).toBe(true);
      expect(covered(path)).toBe(true);
    }
    // The routes that must NOT be behind Access, and are not: the public product,
    // the two authenticated write endpoints any signed-in user reaches, and the
    // asset paths a preview app loads.
    for (const path of [
      '/', '/login', '/api/health', '/api/feedback', '/api/client-errors', '/api/user/profile',
      '/assets/index-abc123.js', '/downloads/kinu', '/controlpanel', '/api/controllers/list',
    ]) {
      expect(isControlPlaneSurface(path)).toBe(false);
    }
  });
});

// ── One deploy path ───────────────────────────────────────────────────
//
// `scripts/deploy.sh` publishes both environments, and the way that stops being
// true is a SECOND entry point rather than a change to this script. There was
// one: `packages/cf-backend` declared `deploy:staging` as
// `CLOUDFLARE_ENV=staging vite build && … && wrangler deploy && vite build`,
// which skips every required gate, the CLI download asset check and all six
// post-deploy smoke checks — and docs/DEPLOYMENT.md § Staging documented it as
// the way to deploy staging, so following the documentation was the bypass.
//
// The manifests, the workflows, the composite actions and the shell scripts all
// come from the one repository enumerator, so a new package, a new workflow or a
// new script cannot be outside this assertion's denominator.
describe("one deploy path", () => {
  /** Publishing a Worker or its assets. A manifest script, a workflow step or a
   *  shell line naming one of these is a deploy path, wherever it lives.
   *
   *  Read off `wrangler --help` at the installed 4.125.0 rather than remembered.
   *  `triggers deploy` is in that surface and was missing here: it re-points the
   *  routes and crons an uploaded version serves, so it publishes without the
   *  bytes ever passing through this repository's deploy script. `wrangler
   *  preview` is deliberately absent — it is private beta, and it creates a
   *  preview rather than moving what a route serves. */
  const PUBLISH_COMMANDS = [
    "wrangler deploy",
    "wrangler versions upload",
    "wrangler versions deploy",
    "wrangler pages deploy",
    "wrangler rollback",
    "wrangler triggers deploy",
  ] as const;

  /** Reaching `scripts/deploy.sh`: the root scripts, or the script itself.
   *  `bun run deploy` is a prefix of `bun run deploy:staging`, so these two
   *  words cover both environments and every documented spelling. */
  const DEPLOY_ENTRYPOINTS = ["bun run deploy", "scripts/deploy.sh"] as const;

  /** A per-package deploy: `--cwd <package> deploy`. ONE shape, read by the
   *  document check and by the workflow check — a command is no less a bypass
   *  for sitting in a step body rather than in prose. */
  const PER_PACKAGE_DEPLOY = /--cwd\s+\S+\s+deploy/u;

  /** Launching an eval. The tier script, the root scripts that run it, and the
   *  report driver a workflow runs directly. */
  const EVAL_LAUNCHERS = [
    "scripts/eval-tier.sh",
    "scripts/eval.ts",
    "bun run test:eval",
    "bun run evals:",
  ] as const;

  /** The one process that rules on which deployment an eval credential may name
   *  (`packages/test-utils/src/eval-identity.ts` holds the allowlist it reads).
   *  The benchmark job used to take an origin and an auth header straight from
   *  repository secrets, so one secret could name production and nothing asked. */
  const EVAL_RESOLVER = "scripts/eval-credentials.ts";

  const ScriptsSchema = v.object({ scripts: v.optional(v.record(v.string(), v.string())) });
  const manifests = trackedFiles().filter((file) => basename(file) === "package.json");
  const scriptsOf = (manifest: string): Record<string, string> =>
    v.parse(ScriptsSchema, JSON.parse(readRepositoryFile(REPO_ROOT, manifest))).scripts ?? {};

  test("every tracked package manifest is in the denominator", () => {
    expect(manifests, "the enumerator stopped listing the root manifest").toContain("package.json");
    expect(manifests, "the enumerator stopped listing the deployed package")
      .toContain("packages/cf-backend/package.json");
    expect(manifests.length, "the manifest corpus collapsed").toBeGreaterThan(2);
  });

  test("the root scripts are the deploy script, one per environment", () => {
    const scripts = scriptsOf("package.json");

    expect(scripts.deploy).toBe("bash scripts/deploy.sh production");
    expect(scripts["deploy:staging"]).toBe("bash scripts/deploy.sh staging");
  });

  test("no package script publishes anything itself", () => {
    for (const manifest of manifests) {
      for (const [name, body] of Object.entries(scriptsOf(manifest))) {
        for (const command of PUBLISH_COMMANDS) {
          expect(body, `${manifest} script "${name}" publishes with \`${command}\``)
            .not.toContain(command);
        }
      }
    }
  });

  // Harness boundary: the manifest's own `scripts` block, parsed. Blind spot:
  // one level of indirection — a script that runs `bun scripts/x.ts` is one word
  // here whatever `x.ts` launches.
  test("no package script launches an eval outside the tier script", () => {
    let tierLaunches = 0;
    for (const manifest of manifests) {
      for (const [name, body] of Object.entries(scriptsOf(manifest))) {
        if (body.includes("scripts/eval-tier.sh")) tierLaunches += 1;
        // The tier resolves the credential, writes a spend file per arm and runs
        // the skip ratchet. A script around the report driver has none of that,
        // and an eval that measures nothing reads as an eval that passed.
        expect(body, `${manifest} script "${name}" runs the eval driver outside the tier script`)
          .not.toContain("scripts/eval.ts");
      }
    }
    // Non-vacuity: the corpus really does contain the eval launch site.
    expect(tierLaunches, "no package script launches the eval tier any more").toBeGreaterThan(0);
  });

  // The documented commands and the runnable ones are the same set or the
  // documentation is a bypass. A `--cwd <package> deploy…` line is that shape.
  test("no document names a per-package deploy command", () => {
    const documents = trackedFiles().filter(isDocument);
    expect(documents.length, "the document corpus collapsed").toBeGreaterThan(0);

    let rootCommands = 0;
    for (const document of documents) {
      const text = readRepositoryFile(REPO_ROOT, document);
      const scoped = PER_PACKAGE_DEPLOY.exec(text);
      expect(scoped?.[0], `${document} documents a per-package deploy command`).toBeUndefined();
      if (text.includes("bun run deploy")) rootCommands += 1;
    }
    // Non-vacuity: the check runs over prose that really does name the deploy.
    expect(rootCommands, "no document names the root deploy command any more")
      .toBeGreaterThan(0);
  });

  /** Every YAML GitHub executes, from the one repository enumerator: the
   *  workflows AND the composite actions beside them. `release-config.test.ts`
   *  reads `.github/workflows` alone, and a composite action's `run:` body is a
   *  command this repository executes inside the job that holds the deploy
   *  credential — `setup-lean` is one, which is why it is checksum-verified. */
  const automationFiles = trackedFiles()
    .filter((file) => file.startsWith(".github/") && /\.ya?ml$/u.test(file));

  /** The two shapes GitHub takes a shell body in, named at the boundary. A
   *  workflow keeps its steps under `jobs.<id>.steps[]` and a composite action
   *  keeps them under `runs.steps[]`. `looseObject` on purpose: these assertions
   *  read one key, and a schema that stripped the rest would start answering
   *  other questions. */
  const StepSchema = v.looseObject({ run: v.optional(v.string()) });
  const StepListSchema = v.looseObject({ steps: v.optional(v.array(StepSchema)) });
  const AutomationSchema = v.looseObject({
    jobs: v.optional(v.record(v.string(), StepListSchema)),
    runs: v.optional(StepListSchema),
  });

  /** `run:` bodies, grouped by the job that runs them, because a job is the unit
   *  GitHub binds an environment and its secrets to. A composite action makes
   *  one group under its own file name: the job it runs in belongs to whoever
   *  used it.
   *
   *  Blind spot of the parse: a third place GitHub grows for a shell body needs
   *  an arm above. The two named are every place it allows one today, and a file
   *  that parses as neither yields no bodies — which the non-vacuity count below
   *  fails on rather than passing quietly. */
  function automationJobs(): readonly { label: string; bodies: readonly string[] }[] {
    const bodiesOf = (steps: v.InferOutput<typeof StepListSchema> | undefined): string[] =>
      (steps?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));

    return automationFiles.flatMap((file) => {
      const parsed = v.parse(AutomationSchema, Bun.YAML.parse(readRepositoryFile(REPO_ROOT, file)));
      return [
        ...Object.entries(parsed.jobs ?? {})
          .map(([job, definition]) => ({ label: `${file}#${job}`, bodies: bodiesOf(definition) })),
        { label: file, bodies: bodiesOf(parsed.runs) },
      ].filter(({ bodies }) => bodies.length > 0);
    });
  }

  const automation = automationJobs();
  const automationSteps = automation
    .flatMap(({ label, bodies }) => bodies.map((body) => ({ label, body })));

  // Harness boundary: the PARSED YAML of every tracked `.github` file, so a body
  // is read as GitHub will run it and a commented-out command is not a finding.
  // Blind spot: what a body then executes — `bun scripts/x.ts` is one word here
  // whatever `x.ts` publishes.
  test("every automation file GitHub executes is in the denominator", () => {
    expect(automationFiles, "the enumerator stopped listing the deploy workflow")
      .toContain(".github/workflows/deploy-staging.yml");
    expect(automationFiles, "the enumerator stopped listing the composite actions")
      .toContain(".github/actions/setup-lean/action.yml");
    expect(automationFiles.length, "the automation corpus collapsed").toBeGreaterThan(4);
    expect(automationSteps.length, "the parse read no run body").toBeGreaterThan(10);

    // Non-vacuity: the corpus really contains a deploy, and that deploy really
    // does go through the root script. Without this the rule below is satisfied
    // by a repository that deploys nothing.
    const deploying = automationSteps.filter(({ body }) =>
      DEPLOY_ENTRYPOINTS.some((entrypoint) => body.includes(entrypoint)));
    expect(deploying.map(({ label }) => label), "no workflow deploys through the deploy script")
      .toContain(".github/workflows/deploy-staging.yml#deploy");
  });

  // Harness boundary: string containment over a step body, the same authority
  // `PUBLISH_COMMANDS` gives the manifest check. Blind spot: an argv array —
  // `scripts/bench-*.ts` spell theirs `runWrangler(root, ['deploy', …])`, which
  // writes no such word — and any command assembled at run time.
  test("no automation step publishes anything itself", () => {
    // Positive control, as a literal: a matcher that stops matching is
    // indistinguishable from a clean tree.
    expect(PUBLISH_COMMANDS.some((command) =>
      "bunx wrangler deploy --env staging".includes(command))).toBe(true);

    for (const { label, body } of automationSteps) {
      for (const command of PUBLISH_COMMANDS) {
        expect(body, `${label} publishes with \`${command}\` instead of running scripts/deploy.sh`)
          .not.toContain(command);
      }
      expect(PER_PACKAGE_DEPLOY.exec(body)?.[0], `${label} deploys one package around the deploy script`)
        .toBeUndefined();
    }
  });

  /** The one script that may publish. Every other shell script is a caller of
   *  it, or of nothing. */
  const SHELL_PUBLISHER = "scripts/deploy.sh";
  const shellScripts = trackedFiles().filter((file) => file.endsWith(".sh"));

  // Harness boundary: the script's executable lines, with whole-line `#`
  // comments dropped — deploy.sh's own header names the publish in prose a dozen
  // times, and so does the header of the archive builder beside it. Blind spot:
  // a trailing `# wrangler deploy` comment reads as an invocation here, and a
  // publish assembled from variables reads as none.
  test("no shell script but the deploy script publishes", () => {
    const executable = (file: string): string => readRepositoryFile(REPO_ROOT, file)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(shellScripts, "the enumerator stopped listing the deploy script").toContain(SHELL_PUBLISHER);
    expect(shellScripts.length, "the shell corpus collapsed").toBeGreaterThan(5);
    // Non-vacuity: the known publishing site is in the corpus, and this reading
    // of it really does contain the publish this rule is about.
    expect(executable(SHELL_PUBLISHER), "the deploy script stopped publishing")
      .toContain("npx wrangler deploy");

    for (const file of shellScripts) {
      if (file === SHELL_PUBLISHER) continue;
      for (const command of PUBLISH_COMMANDS) {
        expect(executable(file), `${file} publishes with \`${command}\`; the deploy path is ${SHELL_PUBLISHER}`)
          .not.toContain(command);
      }
    }
  });

  // Harness boundary: the JOB, because a job is the unit GitHub binds an
  // environment and its secrets to. Blind spot: ORDER inside the job — this
  // reads that the resolving step is in the same job, not that it runs first.
  // `eval-credentials.ts` refusing a target it does not allow is what stops a
  // credential aimed at production; this only proves the refusal is reachable.
  test("an eval a workflow launches resolves its target through the one resolver", () => {
    let launching = 0;
    for (const { label, bodies } of automation) {
      if (!bodies.some((body) => EVAL_LAUNCHERS.some((launcher) => body.includes(launcher)))) continue;
      launching += 1;
      expect(
        bodies.some((body) => body.includes(EVAL_RESOLVER)),
        `${label} launches an eval without resolving its target through ${EVAL_RESOLVER}`,
      ).toBe(true);
    }
    // Non-vacuity: a workflow really does launch an eval with a credential.
    expect(launching, "no workflow launches an eval any more").toBeGreaterThan(0);
  });
});

/**
 * The CLI is built at deploy time and published as artifacts. Before that it
 * shipped as a source archive every user had to `bun install`: measured cold
 * on 2026-09-01, that was 13.35 s of a 16.08 s install, 950 packages and
 * 1.9 GB of their disk. What replaces it must be built, executable, within
 * Cloudflare's per-file asset limit, and complete — a missing platform is a
 * platform that installs nothing.
 */
describe("CLI distribution artifacts", () => {
  const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
  const CPYTHON = "kinu-runtime-cpython.tar.gz";
  // Cloudflare's static-asset limit, per file, on both plans.
  const MAX_ASSET_BYTES = 25 * 1024 * 1024;

  function buildDist(): string {
    const directory = mkdtempSync(join(tmpdir(), "kinu-cli-dist-test-"));
    temporaryDirectories.push(directory);
    const build = Bun.spawnSync(
      ["bash", join(REPO_ROOT, "scripts", "build-cli-dist.sh"), directory],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
    return directory;
  }

  function members(archive: string): Set<string> {
    const decoder = new TextDecoder();
    const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
    expect(listing.exitCode, decoder.decode(listing.stderr)).toBe(0);
    return new Set(decoder.decode(listing.stdout).trim().split("\n"));
  }

  test("publishes one artifact per platform, plus the runtime they share", () => {
    const directory = buildDist();

    for (const platform of PLATFORMS) {
      const artifact = join(directory, `kinu-cli-${platform}.tar.gz`);
      expect(existsSync(artifact), `no artifact for ${platform}`).toBe(true);
      const entries = members(artifact);
      expect(entries.has("kinu/cli.js"), `${platform} artifact carries no cli.js`).toBe(true);
      // The native library is the whole reason this artifact is per platform.
      expect(
        [...entries].some((entry) => entry.startsWith(`kinu/node_modules/@opentui/core-${platform}/`)),
        `${platform} artifact carries no @opentui/core-${platform}`,
      ).toBe(true);
      // Every other platform's native library stays out of it.
      for (const other of PLATFORMS) {
        if (other === platform) continue;
        expect(
          [...entries].some((entry) => entry.includes(`@opentui/core-${other}/`)),
          `${platform} artifact also ships ${other}`,
        ).toBe(false);
      }
      // The CPython blobs are 13.71 MiB gzipped and identical on every
      // platform. Four copies is 41 MiB of duplicate assets.
      expect(
        [...entries].some((entry) => entry.includes("runtime-cpython")),
        `${platform} artifact duplicates the shared CPython runtime`,
      ).toBe(false);
    }

    const runtime = join(directory, CPYTHON);
    expect(existsSync(runtime)).toBe(true);
    expect(members(runtime).has("kinu/node_modules/@nimbus-sh/runtime-cpython/manifest.json")).toBe(true);
  }, 300_000);

  test("every artifact carries a matching checksum and fits the asset limit", () => {
    const directory = buildDist();
    for (const name of [...PLATFORMS.map((p) => `kinu-cli-${p}.tar.gz`), CPYTHON]) {
      const artifact = join(directory, name);
      const bytes = readFileSync(artifact);
      expect(bytes.byteLength, `${name} is over Cloudflare's per-file asset limit`)
        .toBeLessThanOrEqual(MAX_ASSET_BYTES);
      const declared = readFileSync(`${artifact}.sha256`, "utf8").trim().split(/\s+/)[0];
      expect(declared, `${name} has no published checksum`).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(declared);
    }
  }, 300_000);

  // The install this asserts is the one a stranger runs: unpack both archives
  // over one directory and launch. Nothing resolves a dependency here, so the
  // failure the old source archive kept having — a fresh machine installing
  // cleanly and then dying on `Cannot find module` — has no path left.
  test("the unpacked artifacts launch and report the build's stamped version", () => {
    const directory = buildDist();
    const decoder = new TextDecoder();
    const host = `${process.platform}-${process.arch}`;
    const installed = join(directory, "installed");
    mkdirSync(installed);
    for (const name of [`kinu-cli-${host}.tar.gz`, CPYTHON]) {
      const unpack = Bun.spawnSync(["tar", "-xzf", join(directory, name), "-C", installed], {
        stdout: "pipe", stderr: "pipe",
      });
      expect(unpack.exitCode, decoder.decode(unpack.stderr)).toBe(0);
    }
    const root = join(installed, "kinu");

    const stamp = v.parse(
      v.object({ version: v.string(), sha: v.string(), builtAt: v.string() }),
      JSON.parse(readFileSync(join(directory, "kinu-version.json"), "utf8")),
    );
    expect(stamp.version).toMatch(/^0\.2\.0\+/);

    const version = Bun.spawnSync([process.execPath, "run", join(root, "cli.js"), "--version"], {
      cwd: root, env: freshHome(directory), stdout: "pipe", stderr: "pipe",
    });
    expect(version.exitCode, launchFailure(version)).toBe(0);
    // The stamp the assets advertise is the stamp the program reports. Two
    // stamping sites is how `kinu update` learns to chase a version nothing has.
    expect(decoder.decode(version.stdout).trim()).toBe(stamp.version);

    // What install.sh itself greps for before calling the install good.
    const help = Bun.spawnSync([process.execPath, "run", join(root, "cli.js"), "--help"], {
      cwd: root, env: freshHome(directory), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(help.exitCode, launchFailure(help)).toBe(0);
    expect(decoder.decode(help.stdout)).toMatch(/^[ \t]+setup[ \t]/m);
  }, 300_000);

  // The build must not leave the tree it stamped for the bundle behind.
  test("the version stamp does not survive into the working tree", () => {
    const manifest = join(REPO_ROOT, "packages", "cli", "package.json");
    const before = readFileSync(manifest, "utf8");
    buildDist();
    expect(readFileSync(manifest, "utf8")).toBe(before);
  }, 300_000);
});
