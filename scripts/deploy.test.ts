import { beforeAll, describe, expect, test } from "bun:test";
import { statSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv, scratchDir } from "@kinu.run/test-utils";
import { parseReleaseManifest } from "@kinu.run/core/deploy";
import {
  DEPLOY_PHASES, GATE_DEADLINE_SECONDS, LADDER, PATH_IGNORE_FLAG, SHARED_RESOURCES, claims, deployPlan,
  printPlan,
} from "./ladder";
import { costRssMb, costThreads, readCosts } from "./gate-cost";
import { CONTROL_PLANE_ACCESS_PATHS, deriveInfrastructure } from "./infra-manifest";
import { isControlPlaneSurface } from "../packages/cf-backend/src/control-plane/access-gate";
import { isDocument, readRepositoryFile, trackedFiles } from "./sources";
import * as v from "valibot";
import { inkBefore, runTuiInPty, type PtyRun } from "../packages/cli/tests/helpers/pty-screen";
import { BUILTIN_TUI_THEMES, createThemeRegistry, DEFAULT_TUI_THEME_SELECTION } from "../packages/cli/src/tui/theme";

const REPO_ROOT = resolve(import.meta.dir, "..");


/** The plan the runner consumes, and the same plan expanded the way bash
 *  expands it inside the fixture: every glob word replaced by the files
 *  `claims()` resolves it to, which is the set the ladder credits the gate
 *  with. One derivation drives the files the fixture writes, the plan the
 *  fixture's `bun` stub prints, and every expected command line below, so no
 *  list here can drift from the ladder. */
const tracked = trackedFiles();

const PLAN = deployPlan();

const PLAN_TEXT = printPlan(PLAN);

function expandGlobs(run: string): string {
  if (!run.includes("*")) return run;
  const words = run.split(" ");
  const files = claims(run, tracked);

  return [...words.filter((word) => !word.includes("/") || word.startsWith(PATH_IGNORE_FLAG)), ...files].join(" ");
}

const GLOB_EXPANDED_FILES = [...new Set(PLAN.filter((row) => row.run.includes("*")).flatMap((row) => claims(row.run, tracked)))];

/** Every pre-publish gate in plan order, as the fixture's event log spells it. */
const REQUIRED_GATES: readonly string[] = PLAN.filter((row) => row.phase !== "post-publish").map((row) => expandGlobs(row.run));

/** The gates that run AFTER the upload. The fixture's build stub exits
 *  non-zero on purpose, so no run here reaches them; what is asserted about
 *  them is structural: they are the plan's last phase. */
const POST_DEPLOY_GATES: readonly string[] = PLAN.filter((row) => row.phase === "post-publish").map((row) => expandGlobs(row.run));

/** The pre-publish waves, in order: each phase before `post-publish` is one. */
const PRE_PUBLISH_WAVES: readonly (readonly string[])[] = DEPLOY_PHASES
  .filter((phase) => phase !== "post-publish")
  .map((phase) => PLAN.filter((row) => row.phase === phase).map((row) => expandGlobs(row.run)));

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

  return childEnv({ HOME: home, KINU_HOME: join(home, ".kinu") });
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
# The planner, answered from the file the fixture wrote: the plan is the
# ladder's, and the stub only carries it. Not logged as an event, because it
# is not a gate.
if [ "$command_line" = "bun scripts/ladder.ts --plan" ]; then
  cat "$KINU_DEPLOY_PLAN"
  exit 0
fi
if [ "$1" = "scripts/ladder.ts" ] && [ "$2" = "--gate" ]; then
  gate="$3"
  set -- $gate
  command_line="$*"
fi
printf '%s\\n' "$command_line" >> "$KINU_DEPLOY_GATE_LOG"
# WHAT THE INFRASTRUCTURE GATE ACTUALLY SAW. The phase travels in the
# environment because the gate line has to stay one string for ladder.ts to
# parse, so the only way to assert which phase a deploy ran is to record it from
# inside the gate. Written to its own file: the log above is compared for set
# equality against REQUIRED_GATES and an extra line there is a dropped gate.
if [ "$command_line" = "bun run gate:infra" ]; then
  printf '%s\\n' "\${KINU_INFRA_PHASE:-unset}" > "$KINU_DEPLOY_PHASE_LOG"
fi
# WHEN EACH GATE RAN, for the one question a launch log cannot answer: did two
# rows holding the same resource overlap. Written only when a run asks for it,
# because it costs every stub a sleep long enough to be measurable against the
# clock, and every other test here spawns the whole tier per gate.
if [ -n "$KINU_DEPLOY_SPAN_LOG" ]; then
  printf 'start\\t%s\\t%s\\n' "$(date +%s%N)" "$command_line" >> "$KINU_DEPLOY_SPAN_LOG"
  sleep "$KINU_DEPLOY_SPAN_SLEEP"
  printf 'end\\t%s\\t%s\\n' "$(date +%s%N)" "$command_line" >> "$KINU_DEPLOY_SPAN_LOG"
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

/** How long a stub gate holds its slot in a span run. Long enough that two
 *  rows launched together overlap by more than the clock's own resolution,
 *  short enough that the whole tier is a few seconds: the wave admits most
 *  rows in parallel, so the run's wall is the shared lane's chain. */
const SPAN_SLEEP_SECONDS = 0.4;

/** One gate's run, as the span log records it: nanoseconds, from the stub's
 *  own clock, so the two ends of one row are comparable with another row's. */
interface Span {
  readonly run: string;
  readonly start: number;
  readonly end: number;
}

function readSpans(text: string): Span[] {
  const started = new Map<string, number>();
  const spans: Span[] = [];

  for (const line of text.trim().split("\n").filter(Boolean)) {
    const [edge, stamp, run] = line.split("\t");

    if (edge === undefined || stamp === undefined || run === undefined) continue;

    if (edge === "start") {
      started.set(run, Number(stamp));
      continue;
    }

    const start = started.get(run);

    if (start === undefined) continue;
    started.delete(run);
    spans.push({ run, start, end: Number(stamp) });
  }

  return spans;
}

/** Two runs of the wave that were in flight at the same moment. */
function overlapping(spans: readonly Span[]): [Span, Span][] {
  const pairs: [Span, Span][] = [];

  for (const [index, left] of spans.entries()) {
    for (const right of spans.slice(index + 1)) {
      if (left.start < right.end && right.start < left.end) pairs.push([left, right]);
    }
  }

  return pairs;
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
  /** Further options after `option`, for the combinations the script accepts. */
  readonly options?: readonly string[];
  readonly ambientPhase?: string;
  /** The thread cap the wave schedules against; the box's count when absent. */
  readonly threads?: number;
  /** The resident-set cap in MiB; derived from MemAvailable when absent. */
  readonly rssMb?: number;
  /** Record when each gate started and ended, each stub holding its slot for
   *  `spanSleep` seconds: the only way to see whether two rows overlapped. */
  readonly spans?: boolean;
}

function runDeploy({
  failingGate = "",
  killGate = "",
  dirty = false,
  tmpdir: temporaryRoot,
  option,
  options = [],
  ambientPhase = "",
  threads,
  rssMb,
  spans = false,
}: DeployRun = {}) {
  const fixture = scratchDir("deploy-gate");
  const log = join(fixture, "events.log");
  const buildEnvironmentLog = join(fixture, "build-environment.log");
  const phaseLog = join(fixture, "infra-phase.log");
  const spanLog = join(fixture, "spans.log");

  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "node_modules"));
  mkdirSync(join(fixture, "packages", "cf-backend"), { recursive: true });

  const planFile = join(fixture, "plan.tsv");
  writeFileSync(planFile, `${PLAN_TEXT}\n`);

  for (const relativePath of GLOB_EXPANDED_FILES) {
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

  const argv = ["/usr/bin/bash", "scripts/deploy.sh"];

  if (option !== undefined) argv.push(option);
  argv.push(...options);
  const budget: Record<string, string> = {};

  if (threads !== undefined) budget.KINU_DEPLOY_THREADS = String(threads);

  if (rssMb !== undefined) budget.KINU_DEPLOY_RSS_MB = String(rssMb);

  const run = Bun.spawnSync(argv, {
    cwd: fixture,
    env: childEnv({
      PATH: `${fixture}:/usr/bin:/bin`,
      KINU_DEPLOY_FAIL: failingGate,
      KINU_DEPLOY_KILL: killGate,
      // Always explicit. The gate runner creates its log directory under TMPDIR,
      // and one test points it somewhere that cannot exist.
      TMPDIR: temporaryRoot ?? fixture,
      KINU_DEPLOY_GATE_LOG: log,
      KINU_DEPLOY_PLAN: planFile,
      KINU_DEPLOY_BUILD_ENV_LOG: buildEnvironmentLog,
      KINU_DEPLOY_PHASE_LOG: phaseLog,
      // A span run only: every other run leaves both empty, and the stub then
      // writes no span and sleeps not at all.
      KINU_DEPLOY_SPAN_LOG: spans ? spanLog : "",
      KINU_DEPLOY_SPAN_SLEEP: spans ? String(SPAN_SLEEP_SECONDS) : "0",
      // Always set, so the assertion that the script overrides it is about the
      // script rather than about whichever shell ran the suite.
      KINU_INFRA_PHASE: ambientPhase,
      ...budget,
      KINU_DEPLOY_DIRTY: dirty ? "1" : "0",
      SKIP_E2E: "1",
    }),
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
    status: run.exitCode,
    events,
    stdout: run.stdout.toString(),
    buildEnvironment,
    infraPhase,
    spans: existsSync(spanLog) ? readSpans(readFileSync(spanLog, "utf8")) : [],
  };
}

describe("deploy gate", () => {
  // WHY THESE ARE SET PROPERTIES AND NOT AN ORDERED COMPARE.
  //
  // deploy.sh runs the middle gates concurrently, so the order they reach the
  // event log is scheduling noise. `events == REQUIRED_GATES` — or, per failing
  // gate, `events == REQUIRED_GATES.slice(0, n + 1)` — reads a total order off
  // that log and pins the noise.
  //
  // Every property a total order stands in for is asserted directly, and one
  //   - every SERIAL_GATE that runs pre-publish sits in its own wave at the
  //     position it declares;
  test("runs every declared gate before the first build mutation", () => {
    const run = runDeploy();

    expect(run.status).not.toBe(0);
    expect([...run.events].sort()).toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(run.events.at(-1)).toBe("MUTATE bunx vite build");
    expect(run.buildEnvironment).toBe("root");
  });

  // STRUCTURAL, over the plan the runner consumes: every phase but `source`
  // holds gates that run alone, one wave each, in DEPLOY_PHASES order; the
  // runner walks the phases in that order and puts a barrier after each. The
  // preflight is first because nothing may report on a machine the preflight
  // has not passed; the hammer and the account gate follow the source wave so
  // a cheap source red fails first; the post-publish phase runs after the
  // upload against the build that just shipped. Reading this off the stub log
  // could not see a missing barrier, since the scheduler launches index 0
  // first either way; the plan's phase column can.
  test("every gate outside the source wave declares its phase and why it runs alone", () => {
    expect(DEPLOY_PHASES).toEqual(["preflight", "source", "hammer", "infra", "post-publish"]);
    const byPhase = Object.fromEntries(DEPLOY_PHASES.map((phase) => [phase, PLAN.filter((row) => row.phase === phase).map((row) => row.run)]));
    expect(byPhase.preflight).toEqual(["bun scripts/preflight.ts"]);
    expect(byPhase.hammer).toEqual(["bun run gate:hammer"]);
    expect(byPhase.infra).toEqual(["bun run gate:infra"]);
    expect(byPhase["post-publish"]).toEqual(["bun run gate:first-run", "bash scripts/product-flows-tier.sh"]);
    expect(byPhase.source?.length).toBe(PLAN.length - 5);

    for (const gate of LADDER) {
      if (gate.phase === undefined) {
        expect(gate.alone, `${gate.run} explains running alone but runs in the source wave`).toBeUndefined();
        continue;
      }

      expect(gate.alone?.length ?? 0, `${gate.run} runs alone with no reason`).toBeGreaterThan(80);
    }
  });


  // The Worker version is what a persisted error names, so it has to name the
  // build. Asserted as text because the fixture cannot reach step 3: its build
  // stub fails on purpose, which is what every other test here depends on.
  test("the published version is annotated with the build sha", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source).toContain(
      'KINU_WRANGLER_ARGS+=(--tag "$KINU_SHA" --message "kinu production $KINU_SHA")',
    );
    expect(source).toContain('npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}"');
  });

  test("every gate has a process-tree deadline, from its row or the shared figure", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source).toContain('timeout --signal=TERM --kill-after=5s "${GATE_DEADLINE[pick]}" bun scripts/ladder.ts --gate "${GATE_CMDS[pick]}"');
    expect(GATE_DEADLINE_SECONDS).toBe(480);

    for (const row of PLAN) {
      const gate = LADDER.find((candidate) => candidate.run === row.run);

      if (gate?.deadline === undefined) {
        expect(row.deadline, `${row.run} carries a deadline its row does not declare`).toBe(GATE_DEADLINE_SECONDS);
        continue;
      }

      // A PER-GATE EXCEPTION IS A DECLARATION with a reason, longer than the
      // shared wall: raising the shared figure would take the wall off every
      // source gate at once.
      expect(row.deadline).toBe(gate.deadline.seconds);
      expect(gate.deadline.seconds, `${row.run} declares no longer than the shared deadline`).toBeGreaterThan(GATE_DEADLINE_SECONDS);
      expect(gate.deadline.why.length, `${row.run} declares no reason for its own deadline`).toBeGreaterThan(80);
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
  // ONE SOURCE. deploy.sh consumes the plan the ladder prints and names no
  // gate itself: a `bun test`, `bun run gate:` or `bun scripts/` command in
  // the runner would be a second list, which is the defect this replaced
  // (fifteen suites named by hand in three files on 2026-09-14).
  test("deploy.sh names no gate; it consumes the ladder's plan", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    const commands = source.split("\n").filter((line) => /^\s*(?:bun test |bun run gate:|bun scripts\/(?!ladder\.ts --plan))/.test(line));
    expect(commands).toEqual([]);
    expect(source).toContain('plan="$(bun scripts/ladder.ts --plan)"');
    expect(source).toContain("run_phase preflight");
    expect(source).toContain("run_phase source");
    expect(source).toContain("run_phase post-publish");
    expect(source).not.toContain("run_required_gate");

    // The plan is machine-readable and complete: one line per gate, seven
    // tab-separated fields, no quotes, and every command a plain argv.
    for (const line of PLAN_TEXT.split("\n")) {
      const fields = line.split("\t");
      expect(fields).toHaveLength(7);
      const phases: readonly string[] = DEPLOY_PHASES;
      expect(phases).toContain(fields[0] ?? "");
      expect(Number(fields[2])).toBeGreaterThan(0);
      expect(Number(fields[3])).toBeGreaterThan(0);
      expect(Number(fields[4])).toBeGreaterThan(0);
      const resources: readonly string[] = [...SHARED_RESOURCES, "none"];
      expect(resources).toContain(fields[5] ?? "");
      expect(fields[6]).not.toMatch(/['"]/u);
    }
  });

  test("a gate killed without a verdict of its own fails the deploy", () => {
    const run = runDeploy({ killGate: "bun run lint" });

    expect(run.status).not.toBe(0);
    // 128 + SIGKILL. The status is the child's fate, not a claim the gate made.
    expect(run.stdout).toContain("Anti-slop lint failed (exit 137)");
    expect(run.events, "the killed gate never launched").toContain("bun run lint");
    expect(
      run.events.some((event) => event.startsWith("MUTATE ")),
      "a gate died unreported and the build ran anyway",
    ).toBe(false);
  });

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

  // THE WAVE IS SCHEDULED BY MEASURED COST IN TWO DIMENSIONS. A count of gates
  // is not a measure of load, and neither is a declared thread figure: on
  // 2026-09-16 five source rows died on their deadline across two deploys —
  // one of them at 137, a SIGKILL no thread budget can predict — while each
  // passed alone. The three workerd rows declared one thread each and no
  // memory at all. Nothing declares a cost now; scripts/gate-cost.json holds
  // what each row was measured to take, and the runner admits against both
  // figures under a cap read from the box.
  test("the wave admits on measured threads AND resident set, both under a machine cap", () => {
    // BOTH CAPS, AS THE RUNNER ANNOUNCES THEM, given both figures. This was a
    // grep over deploy.sh for `nproc` and `MemAvailable` and NOT `MemTotal`,
    // which the script's own comment — "MemAvailable, not MemTotal: MemTotal
    // includes memory nothing can have" — defeated the day it was written. A
    // source-text assertion over a file that explains itself is the class of
    // check that goes stale; the two dimensions being load-bearing is proved
    // by the two rows below, which serialise the wave on each cap in turn.
    const named = runDeploy({ threads: 7, rssMb: 1234 });
    expect(named.stdout).toContain("within 7 threads and 1234 MiB of measured cost");

    // DERIVED FROM THE BOX when neither is given: the thread cap is `nproc`
    // exactly, and the memory cap is a reserve fraction of what the kernel
    // says can be handed out right now — never of MemTotal, which includes
    // memory nothing can have and would cap the wave above the available
    // figure. Bounds rather than an equality, because MemAvailable moves
    // while other lanes work on the same box.
    const derived = runDeploy();
    const announced = /within (\d+) threads and (\d+) MiB of measured cost/u.exec(derived.stdout);
    const availableMb = Number(/^MemAvailable:\s+(\d+) kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) / 1024;
    expect(availableMb).toBeGreaterThan(0);
    expect(announced?.[1]).toBe(String(cpus().length));
    expect(Number(announced?.[2])).toBeGreaterThan(availableMb * 0.5);
    expect(Number(announced?.[2])).toBeLessThan(availableMb);

    const costs = readCosts();

    for (const row of PLAN) {
      const cost = costs.rows[row.run];
      const gate = LADDER.find((candidate) => candidate.run === row.run);

      // Outside the one concurrent wave a row is declared to run alone or is a
      // live probe against the deployment, so its cost is not what admits it.
      if (row.phase !== "source") continue;

      if (cost === undefined || gate === undefined) {
        expect(cost, `${row.run} runs in the concurrent wave with no measured cost`).toBeDefined();
        continue;
      }

      expect(row.threads).toBe(costThreads(cost, gate.seconds));
      expect(row.rssMb).toBe(costRssMb(cost));
    }

    // A row that opens Chrome or four workers may NOT be admitted as free in
    // both dimensions at once. It read "more than one thread" until the cost
    // sampler was fixed to walk the row's process tree (L7): measured
    // 2026-09-17, a browser row's Chrome burns little CPU beside its wall —
    // chat-scroll is 12.6 CPU seconds over a 21.2 s wall, one sustained thread
    // with 25 tasks runnable at its peak — and what makes these rows heavy is
    // memory, 3.1 GiB there and 3.2 to 5.1 GiB across the family. So the claim
    // is per dimension, and the 2026-09-16 shape it was written for still
    // fails it: the three workerd rows read one thread AND no memory at all.
    // Derived from the tree, not a list: the plan's own `shared` column, which
    // is the closure over the modules each row claims.
    const browserRows = PLAN.filter((row) => row.shared === "browser").map((row) => row.run);

    for (const row of PLAN) {
      const opensChrome = browserRows.includes(row.run);
      const multiWorker = row.run.includes("--parallel=") || row.run === "bun run test:core" || row.run === "bun run test:cli";

      if (!opensChrome && !multiWorker) continue;
      expect(
        row.threads > 1 || row.rssMb > 1_024,
        `${row.run} opens Chrome or workers and is admitted as one thread and ${String(row.rssMb)} MiB`,
      ).toBeTrue();
    }
  });

  // THE MEMORY DIMENSION DECIDES, not just the thread one. The gate self-tests
  // row settled at 137 on 2026-09-16 — the kernel's status for a SIGKILL — and
  // a wave that counts only threads cannot see that coming. With a cap of one
  // MiB no row fits beside a running row, so the event log is the declared
  // order: the same observation as the thread test, through the other figure.
  test("a resident-set cap of one MiB runs the wave one gate at a time", () => {
    const run = runDeploy({ rssMb: 1 });
    const gates = run.events.filter((event) => !event.startsWith("MUTATE "));

    expect(gates).toEqual([...REQUIRED_GATES]);
    expect(run.stdout).toContain("1 MiB");
  });

  test("a budget of one thread runs the wave in declared order, one gate at a time", () => {
    const run = runDeploy({ threads: 1 });
    const gates = run.events.filter((event) => !event.startsWith("MUTATE "));
    // With one thread nothing fits beside a running gate, so the scheduler
    // launches the first unlaunched gate only after the previous settled: the
    // event log IS the declared order. A count-based width would need six
    // gates in flight to be observable at all.
    expect(gates).toEqual([...REQUIRED_GATES]);
    expect(run.stdout).toContain("within 1 threads and");
  });

  // ONE BROWSER ROW AT A TIME, WHICH NO COST FIGURE CAN EXPRESS. The nine rows
  // that boot Chrome are admitted at 1 to 3 threads and 0.5 to 6.4 GiB, so no
  // value of either cap refuses the overlap — the lane is the only admission
  // that can. Whether the overlap HARMS them is unproved and written as a
  // hypothesis: measured 2026-09-18 on the 24-thread workstation, quiet box,
  // the three browser rows of that day's red wave ran 480.1 s/124, 480.1 s/124
  // and 152.8 s/1 concurrently and 480.2 s/124, 480.2 s/124 and 149.7 s/1
  // serially — red either way, on one product defect (L9 in
  // docs/ARCHITECTURE-DECISIONS.md).
  //
  // Read off SPANS rather than the launch log, because the launch log cannot
  // see an overlap at all: it records the order rows started, and the
  // scheduler starts them in plan order whether they overlap or not. Each stub
  // holds its slot for SPAN_SLEEP_SECONDS, which is longer than the clock's
  // resolution by three orders of magnitude. RED on the pre-mutex scheduler:
  // with the resource check taken out of the admission loop (measured
  // 2026-09-18) this reports twelve overlapping browser-row pairs.
  test("two rows holding the browser never overlap, and the rest of the wave still does", () => {
    const run = runDeploy({ spans: true });
    const sharedRuns = PLAN.filter((row) => row.shared === "browser").map((row) => expandGlobs(row.run));

    expect(sharedRuns.length, "no row holds the browser; the derivation stopped deriving").toBeGreaterThan(1);
    const shared = run.spans.filter((span) => sharedRuns.includes(span.run));
    expect(shared.map((span) => span.run).sort()).toEqual([...sharedRuns].sort());

    expect(
      overlapping(shared).map(([left, right]) => `${left.run} || ${right.run}`),
      "two rows held the browser at the same moment",
    ).toEqual([]);

    // AND THE WAVE IS STILL A WAVE. A mutex that serialised everything would
    // pass the assertion above and cost the deploy its concurrency, so the
    // rows that hold nothing are held to the opposite property.
    const free = run.spans.filter((span) => !sharedRuns.includes(span.run));
    expect(overlapping(free).length, "no two unshared rows overlapped; the wave ran serially").toBeGreaterThan(0);
  });

  test("the serial gates are the ends of the real run", () => {
    const run = runDeploy();
    const gates = run.events.filter((event) => !event.startsWith("MUTATE "));

    expect(gates[0]).toBe("bun scripts/preflight.ts");
    // The fixture's build stub fails on purpose, so the last gate to RUN is
    // the last pre-publish one — the post-publish wave is unreachable here.
    expect(gates.at(-1)).toBe("bun run gate:infra");
  });

  // The budget is EXPLICIT because the work is quadratic and bun's 5000ms
  // default is not a decision anybody made about this test. One deploy run per
  // gate, each running every earlier gate's stub: the per-gate count below is
  // ~3,200 process spawns.
  test("every gate fails closed even when the former skip variable is set", () => {
    const last = REQUIRED_GATES.at(-1);
    // WHICH WAVE EACH GATE IS IN, BY POSITION: the plan's phase index. The
    // plan spells one gate with a glob and REQUIRED_GATES carries what that
    // glob expands to in the fixture, so the mapping is positional rather
    // than by text, and both lists are the plan in plan order.
    const waveOfGate = PLAN.map((row) => DEPLOY_PHASES.indexOf(row.phase));
    expect(waveOfGate).toHaveLength(REQUIRED_GATES.length + POST_DEPLOY_GATES.length);

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
    // BUDGETED PER GATE, not as a literal. This spawns one real `deploy.sh`
    // per required gate, so its cost is linear in the tier and a fixed number
    // silently tightens every time a gate is added — which is exactly what
    // happened on 2026-09-10, when moving `gate:wired` and `gate:dead-code` to
    // the commit tier pushed a 60s literal into a timeout. Measured that day on
    // the reference box: 55.2 s and 55.4 s for 23 gates, so ~2.4 s per gate.
    // 4 s is declared, because a loaded box must not read as a broken deploy.
  }, REQUIRED_GATES.length * 4_000);


  test("a dirty checkout is rejected before verification or mutation", () => {
    const run = runDeploy({ dirty: true });

    expect(run.status).not.toBe(0);
    expect(run.events).toEqual([]);
  });



  // ── The bootstrap option and the phase it selects ──────────────
  //
  // Without it, a deploy that DECLARES a resource only a deploy can create
  // refuses itself: `ControlPlaneDO` landed in `migrations`, the 55 source gates
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
    const bootstrap = runDeploy({ option: "--bootstrap" });

    // Same gates, same set, same failure semantics as any other deploy. This is
    // the assertion that would catch a future `--bootstrap` that skipped a check
    // rather than re-scoping one.
    expect([...bootstrap.events].sort())
      .toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(bootstrap.infraPhase).toBe("bootstrap");
    // The operator is told what is deferred and what is not, before the gates run.
    expect(bootstrap.stdout).toContain("BOOTSTRAP");
    expect(bootstrap.stdout).toContain("Still refused before the upload");

    const normal = runDeploy();
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
    const inherited = runDeploy({ ambientPhase: "bootstrap" });

    expect(inherited.infraPhase).toBe("full");
    expect(inherited.stdout).not.toContain("BOOTSTRAP");

    // And the flag still wins when it is actually passed, ambient value or not.
    const asked = runDeploy({
      option: "--bootstrap", ambientPhase: "post-deploy",
    });

    expect(asked.infraPhase).toBe("bootstrap");
  });

  test("an unknown option deploys nothing", () => {
    // Refused rather than ignored. A silently-dropped `--bootstrp` would fail the
    // deploy at the infrastructure gate with a diagnostic about a Durable Object
    // namespace, which is the wrong thing to debug.
    const run = runDeploy({ option: "--bootstrp" });

    expect(run.status).toBe(2);
    expect(run.events).toEqual([]);
    expect(run.infraPhase).toBeNull();
    expect(run.stdout).toContain("Usage: scripts/deploy.sh [--bootstrap] [--gates-only] [--all]");
  });

  // The rehearsal path: every pre-publish gate, no build, no upload. It is how
  // the wave's wall time is measured for the width figures in scripts/ladder.ts,
  // so it has to run exactly the gates a deploy runs and touch nothing after.
  // FAIL FAST, WITH A FULL AUDIT ON REQUEST. The default wave stops launching
  // at its first red and lets what is running finish; `--all` keeps launching
  // so one run reports every red. Proved at budget 1 so the order is
  // deterministic and the difference is exactly "the gates after the red".
  test("the first red stops new launches by default, and --all runs every gate anyway", () => {
    const second = REQUIRED_GATES[2];

    if (second === undefined) throw new Error("no third gate");
    const stopped = runDeploy({ failingGate: second, threads: 1 });
    expect(stopped.status).not.toBe(0);
    expect(stopped.events).toEqual(REQUIRED_GATES.slice(0, 3));
    expect(stopped.stdout).toContain("stopping new launches at the first failure");

    // The WHOLE WAVE, and only the wave: a red wave still ends the pipeline
    // before the next barrier, so the hammer and the account gate never run.
    const audited = runDeploy({ failingGate: second, threads: 1, option: "--gates-only", options: ["--all"] });
    expect(audited.status).not.toBe(0);
    const prePublish = (PRE_PUBLISH_WAVES[0]?.length ?? 0) + (PRE_PUBLISH_WAVES[1]?.length ?? 0);
    expect(audited.events).toEqual(REQUIRED_GATES.slice(0, prePublish));
    expect(audited.stdout).toContain("every gate regardless of failures (--all)");
    expect(audited.events.some((event) => event.startsWith("MUTATE ")), "--all published on a red").toBe(false);
  });

  test("gates-only runs every pre-publish gate and mutates nothing", () => {
    const run = runDeploy({ option: "--gates-only" });

    expect(run.status).toBe(0);
    expect([...run.events].sort()).toEqual([...REQUIRED_GATES].sort());
    expect(run.events.some((event) => event.startsWith("MUTATE ")), "gates-only built or published").toBe(false);
    expect(run.stdout).toContain("Gates only: stopping before the build");
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
    const invocation = 'if bun scripts/infra-verify.ts --phase=post-deploy; then';
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
    // The declaration, from the manifest rather than from prose: the Worker
    // declares the organization, the application, its Allow policy and the
    // NEGATIVE scope assertion, and every one of them is required — so an absent
    // or unreadable row is a finding and `gate:infra` exits non-zero.
    const infrastructure = deriveInfrastructure();

    const access = infrastructure.resources.filter((resource) => resource.id.startsWith('access-'));

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
    // ITS OWN WAVE, AFTER EVERY SOURCE GATE, so an account that cannot be
    // proved never reaches Wrangler deployment; and THE LAST WAVE BEFORE THE
    // UPLOAD, which is what the property has always meant: a live gate against
    // the deployment runs after the publish, beside first-run, because a
    // pre-publish live gate can only measure the previous build and refuses
    // the deploy carrying its fix.
    expect(PRE_PUBLISH_WAVES.at(-1)).toEqual(['bun run gate:infra']);
    expect(POST_DEPLOY_GATES).toContain('bun run gate:first-run');
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source.indexOf('run_phase infra')).toBeLessThan(source.indexOf('Step 2: Building Kinu'));
    expect(source.indexOf('run_phase post-publish')).toBeGreaterThan(source.indexOf('Step 4: Post-deploy smoke test'));
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
// `scripts/deploy.sh` is the one deploy path, and the way that stops being
// true is a SECOND entry point rather than a change to this script. There was
// one: a per-package deploy script ran `vite build && … && wrangler deploy`,
// which skips every required gate, the CLI download asset check and all six
// post-deploy smoke checks — and the deploy documentation named it, so
// following the documentation was the bypass.
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

  /** Reaching `scripts/deploy.sh`: the root script, or the script itself. */
  const DEPLOY_ENTRYPOINTS = ["bun run deploy", "scripts/deploy.sh"] as const;

  /** A per-package deploy: `--cwd <package> deploy`. ONE shape, read by the
   *  document check and by the workflow check — a command is no less a bypass
   *  for sitting in a step body rather than in prose. */
  const PER_PACKAGE_DEPLOY = /--cwd\s+\S+\s+deploy/u;

  /** Launching a run that spends on a credential: the live tier's script, the
   *  root script that runs it, and the eval suite. */
  const EVAL_LAUNCHERS = [
    "scripts/live-tier.sh",
    "bun run test:live",
    "bun run evals",
  ] as const;

  /** What rules on which deployment a credential may name
   *  (`packages/test-utils/src/eval-identity.ts` holds the allowlist both read):
   *  `eval-credentials.ts` for a tier that takes KINU_EVAL_TOKEN, and the eval
   *  suite's own harness, which refuses an origin outside the allowlist before any
   *  trial (evals/src/target.test.ts). Without one, a job takes an origin and an
   *  auth header straight from repository secrets, so one secret can name
   *  production and nothing asks. */
  const EVAL_RESOLVERS = ["scripts/eval-credentials.ts", "bun run evals"] as const;

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

  test("the root deploy script is the deploy script", () => {
    expect(scriptsOf("package.json").deploy).toBe("bash scripts/deploy.sh");
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
  // one level of indirection — a script that runs `bun scripts/<name>.ts` is one word
  // here whatever `x.ts` launches.
  test("no package script launches a live suite outside the tier script", () => {
    let tierLaunches = 0;

    for (const manifest of manifests) {
      for (const [name, body] of Object.entries(scriptsOf(manifest))) {
        if (body.includes("scripts/live-tier.sh")) tierLaunches += 1;
        // The tier resolves the credential, writes a spend file and runs the
        // skip ratchet. A script running the live suites directly has none of
        // that, and a run that measures nothing reads as a run that passed.
        expect(body, `${manifest} script "${name}" runs the live suites outside the tier script`)
          .not.toMatch(/bun test[^&|;]*tests\/live/u);
      }
    }

    // Non-vacuity: the corpus really does contain the tier's launch site.
    expect(tierLaunches, "no package script launches the live tier").toBeGreaterThan(0);
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
    expect(rootCommands, "no document names the root deploy command")
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
  // Blind spot: what a body then executes — `bun scripts/<name>.ts` is one word here
  // whatever `x.ts` publishes.
  test("every automation file GitHub executes is in the denominator", () => {
    expect(automationFiles, "the enumerator stopped listing the workflows")
      .toContain(".github/workflows/ci.yml");
    expect(automationFiles, "the enumerator stopped listing the composite actions")
      .toContain(".github/actions/setup-lean/action.yml");
    expect(automationFiles.length, "the automation corpus collapsed").toBeGreaterThan(3);
    expect(automationSteps.length, "the parse read no run body").toBeGreaterThan(10);

    // Deploys are run by a person through `bun run deploy`; no workflow deploys.
    // Named so a workflow that starts deploying is a deliberate change here.
    const deploying = automationSteps.filter(({ body }) =>
      DEPLOY_ENTRYPOINTS.some((entrypoint) => body.includes(entrypoint)));

    expect(deploying.map(({ label }) => label)).toEqual([]);
  });

  // Harness boundary: string containment over a step body, the same authority
  // `PUBLISH_COMMANDS` gives the manifest check. Blind spot: an argv array —
  // `scripts/bench-*.ts` spell theirs `runWrangler(root, ['deploy', …])`, which
  // writes no such word — and any command assembled at run time.
  test("no automation step publishes anything itself", () => {
    // Positive control, as a literal: a matcher that stops matching is
    // indistinguishable from a clean tree.
    expect(PUBLISH_COMMANDS.some((command) =>
      "bunx wrangler deploy".includes(command))).toBe(true);

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
    const commandLines = (file: string): string => readRepositoryFile(REPO_ROOT, file)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(shellScripts, "the enumerator stopped listing the deploy script").toContain(SHELL_PUBLISHER);
    expect(shellScripts.length, "the shell corpus collapsed").toBeGreaterThan(5);
    // Non-vacuity: the known publishing site is in the corpus, and this reading
    // of it really does contain the publish this rule is about.
    expect(commandLines(SHELL_PUBLISHER), "the deploy script stopped publishing")
      .toContain("npx wrangler deploy");

    for (const file of shellScripts) {
      if (file === SHELL_PUBLISHER) continue;

      for (const command of PUBLISH_COMMANDS) {
        expect(commandLines(file), `${file} publishes with \`${command}\`; the deploy path is ${SHELL_PUBLISHER}`)
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
        bodies.some((body) => EVAL_RESOLVERS.some((resolver) => body.includes(resolver))),
        `${label} launches an eval without resolving its target through ${EVAL_RESOLVERS.join(' or ')}`,
      ).toBe(true);
    }

    // Non-vacuity: a workflow really does launch an eval with a credential.
    expect(launching, "no workflow launches an eval").toBeGreaterThan(0);
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

  function buildDist() {
    const directory = scratchDir("cli-dist-test");
    const manifest = join(REPO_ROOT, "packages", "cli", "package.json");
    const before = { bytes: readFileSync(manifest, "utf8"), mtimeMs: statSync(manifest).mtimeMs };

    const build = Bun.spawnSync(
      ["bash", join(REPO_ROOT, "scripts", "build-cli-dist.sh"), directory],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );

    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

    return { directory, before };
  }

  let distribution: ReturnType<typeof buildDist>;

  beforeAll(() => { distribution = buildDist(); });

  function members(archive: string): Set<string> {
    const decoder = new TextDecoder();
    const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
    expect(listing.exitCode, decoder.decode(listing.stderr)).toBe(0);

    return new Set(decoder.decode(listing.stdout).trim().split("\n"));
  }

  test("the build reads the CLI manifest and never writes it", () => {
    // The deploy runs its gates six at a time, and this build is one of them:
    // a stamp written into packages/cli/package.json and restored on exit was
    // read mid-flight by the CLI suite's version test on 2026-09-02 (staging
    // failed on `0.2.0+<sha>` against an imported `0.2.0`). The stamp is a
    // bundle-time define now, so the manifest's bytes AND mtime survive a
    // build — a restore-on-exit would keep the bytes and move the mtime.
    const manifest = join(REPO_ROOT, "packages", "cli", "package.json");
    const { directory, before } = distribution;
    expect(readFileSync(manifest, "utf8")).toBe(before.bytes);
    expect(statSync(manifest).mtimeMs).toBe(before.mtimeMs);
    // And the stamp still lands where it belongs: in what ships.
    const stamp = JSON.parse(readFileSync(join(directory, "kinu-version.json"), "utf8"));
    const base = JSON.parse(before.bytes).version;
    expect(stamp.version).toBe(`${base}+${stamp.sha}`);
  });

  test("publishes one artifact per platform, plus the runtime they share", () => {
    const { directory } = distribution;

    for (const platform of PLATFORMS) {
      const artifact = join(directory, `kinu-cli-${platform}.tar.gz`);
      expect(existsSync(artifact), `no artifact for ${platform}`).toBe(true);
      const entries = members(artifact);
      expect(entries.has("kinu/cli.js"), `${platform} artifact carries no cli.js`).toBe(true);

      // The daemon and its stamp, for a daemon updating itself from this archive.
      for (const name of ["pc-agent.js", "sandbox.js", "pty.js", "update.js", "pc-agent.version"]) {
        expect(entries.has(`kinu/pc-agent/${name}`), `${platform} artifact carries no pc-agent/${name}`).toBe(true);
      }

      // The tree-sitter worker the markdown renderer spawns and the web-tree-
      // sitter wasm it parses through: bun materializes the worker beside
      // cli.js as parser.worker-<hash>.js, and an archive without it renders
      // raw markers.
      expect(
        [...entries].some((entry) => /^kinu\/parser\.worker-\w+\.js$/.test(entry)),
        `${platform} artifact carries no emitted parser worker`,
      ).toBe(true);
      expect(
        entries.has("kinu/node_modules/web-tree-sitter/tree-sitter.wasm"),
        `${platform} artifact carries no web-tree-sitter wasm`,
      ).toBe(true);

      // The native library is the whole reason this artifact is per platform.
      expect(
        [...entries].some((entry) => entry.startsWith(`kinu/node_modules/@opentui/core-${platform}/`)),
        `${platform} artifact carries no @opentui/core-${platform}`,
      ).toBe(true);

      // Grammar assets the worker loads offline: markdown and its inline
      // variant power the conceal and code highlighting in the chat surface.
      expect(
        [...entries].some((entry) => /^kinu\/tree-sitter-markdown-\w+\.wasm$/.test(entry)),
        `${platform} artifact carries no markdown grammar`,
      ).toBe(true);
      expect(
        [...entries].some((entry) => /^kinu\/tree-sitter-markdown_inline-\w+\.wasm$/.test(entry)),
        `${platform} artifact carries no markdown_inline grammar`,
      ).toBe(true);
      expect(
        [...entries].some((entry) => /^kinu\/highlights-\w+\.scm$/.test(entry)),
        `${platform} artifact carries no highlight queries`,
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
  });

  test("every artifact carries a matching checksum and fits the asset limit", () => {
    const { directory } = distribution;

    for (const name of [...PLATFORMS.map((p) => `kinu-cli-${p}.tar.gz`), CPYTHON]) {
      const artifact = join(directory, name);
      const bytes = readFileSync(artifact);
      expect(bytes.byteLength, `${name} is over Cloudflare's per-file asset limit`)
        .toBeLessThanOrEqual(MAX_ASSET_BYTES);
      const declared = readFileSync(`${artifact}.sha256`, "utf8").trim().split(/\s+/)[0];
      expect(declared, `${name} has no published checksum`).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(declared);
    }
  });

  // The install this asserts is the one a stranger runs: unpack both archives
  // over one directory and launch. Nothing resolves a dependency here, so the
  // failure the old source archive kept having — a fresh machine installing
  // cleanly and then dying on `Cannot find module` — has no path left.
  test("the unpacked artifacts launch and report the build's stamped version", () => {
    const { directory } = distribution;
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

    // The base version read off the manifest rather than retyped: the literal
    // this pinned had to be edited on every minor bump, beside the file that
    // already declares it.
    const manifest = v.parse(
      v.object({ version: v.string() }),
      JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8")),
    );

    expect(stamp.version).toBe(`${manifest.version}+${stamp.sha}`);

    const version = Bun.spawnSync([process.execPath, "run", join(root, "cli.js"), "--version"], {
      cwd: root, env: freshHome(directory), stdout: "pipe", stderr: "pipe",
    });

    expect(version.exitCode, launchFailure(version)).toBe(0);
    // The stamp the assets advertise is the stamp the program reports. Two
    // stamping sites is how `kinu update` learns to chase a version nothing has.
    expect(decoder.decode(version.stdout).trim()).toBe(stamp.version);

    // The shipped daemon, run the way a daemon updating itself runs it: it
    // loads its siblings from the archive and reports the same stamp.
    const daemon = Bun.spawnSync([process.execPath, join(root, "pc-agent", "pc-agent.js"), "--selftest"], {
      cwd: root, env: { ...freshHome(directory), KINU_HOME: join(root, "pc-agent") }, stdout: "pipe", stderr: "pipe",
    });

    expect(daemon.exitCode, launchFailure(daemon)).toBe(0);
    expect(decoder.decode(daemon.stdout).trim()).toBe(stamp.version);

    // What install.sh itself greps for before calling the install good.
    const help = Bun.spawnSync([process.execPath, "run", join(root, "cli.js"), "--help"], {
      cwd: root, env: freshHome(directory), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });

    expect(help.exitCode, launchFailure(help)).toBe(0);
    expect(decoder.decode(help.stdout)).toMatch(/^[ \t]+setup[ \t]/m);
  });
  // The markdown pipeline the archive is for: the parser worker beside
  // cli.js, its web-tree-sitter wasm and grammar assets resolving from the
  // unpack dir alone. The run happens in a PTY off a scratch install with a
  // scratch KINU_HOME, a scrubbed child env (childEnv carries only PATH) and
  // a loopback proxy that answers every request 502 — so nothing in it can
  // fall back to the repository's node_modules, a warm TreeSitter cache, or
  // the network. The probe fetch through the same env proves the guard
  // actually intercepts, not merely that the network is down.

  const MARKDOWN_TURN = [
    "Ship verdict: **two green lanes** now.",
    "",
    "- worker bundle `parser.worker.js`",
    "- markdown grammar `tree-sitter-markdown.wasm`",
    "",
    "1. archive unpacked",
    "2. TUI rendered",
    "",
    "### Heading marker",
    "",
    "```ts",
    "const PACKAGED = true;",
    "```",
  ].join("\n");

  function unpackHostCli(into: string): string {
    const host = `${process.platform}-${process.arch}`;
    const decoder = new TextDecoder();

    for (const name of [`kinu-cli-${host}.tar.gz`, CPYTHON]) {
      const unpack = Bun.spawnSync(["tar", "-xzf", join(distribution.directory, name), "-C", into], {
        stdout: "pipe", stderr: "pipe",
      });

      expect(unpack.exitCode, decoder.decode(unpack.stderr)).toBe(0);
    }

    return join(into, "kinu");
  }

  const MockLlmReadySchema = v.object({ model: v.number(), proxy: v.number() });

  async function startMockLlmProcess(): Promise<{ modelPort: number; proxyPort: number; stop: () => void }> {
    const proc = Bun.spawn(
      [process.execPath, join(REPO_ROOT, "packages/cli/tests/fixtures/mock-llm-server.ts")],
      { env: { MOCK_LLM_ANSWER: MARKDOWN_TURN }, stdout: "pipe", stderr: "pipe" },
    );

    let banner = "";

    for await (const chunk of proc.stdout) {
      banner += new TextDecoder().decode(chunk);

      if (banner.includes("\n")) break;
    }

    const ready = /^READY (.+)$/m.exec(banner);
    const ports = v.parse(MockLlmReadySchema, JSON.parse(ready?.[1] ?? "null"));

    return { modelPort: ports.model, proxyPort: ports.proxy, stop: () => { proc.kill(); } };
  }

  // Every child the fixture runs — the provisioning CLI calls, the PTY chat,
  // and the guard probe — carries the same isolation policy: all traffic must
  // go through the rejecting loopback proxy except the loopback host itself.
  function offlineChildEnv(home: string, proxyPort: number) {
    const proxy = `http://127.0.0.1:${String(proxyPort)}`;

    return {
      ...freshHome(home),
      KINU_SKIP_DAEMON: "1",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    };
  }

  const NetworkCheckSchema = v.object({ attempted: v.boolean() });

  async function networkAttempted(modelPort: number): Promise<boolean> {
    const response = await fetch(`http://127.0.0.1:${String(modelPort)}/network-check`);

    return v.parse(NetworkCheckSchema, await response.json()).attempted;
  }

  // The red control: a fetch that must fail, and must fail AT the proxy —
  // if the proxy environment did not apply, this either succeeds outright or
  // fails somewhere the guard never saw, and `attempted` stays false. The
  // rejecting proxy answers with a status, which fetch resolves — the child
  // turns anything but a real 200 into a nonzero exit.
  async function proveNetworkGuard(env: Record<string, string>, modelPort: number): Promise<void> {
    const probe = Bun.spawnSync(
      [process.execPath, "-e", "const r = await fetch('https://example.com'); if (r.status !== 200) process.exit(1)"],
      { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" },
    );

    expect(probe.exitCode, "guard probe got a real 200 from example.com: isolation is not intercepting").not.toBe(0);
    expect(await networkAttempted(modelPort), "guard probe failed without touching the proxy").toBe(true);

    const reset = await fetch(`http://127.0.0.1:${String(modelPort)}/network-check`, { method: "POST" });
    expect(reset.status).toBe(200);
  }

  function provisionWorkspace(root: string, env: Record<string, string>, baseURL: string): void {
    const kinuHome = join(env.HOME ?? "", ".kinu");

    // The session override only reaches the resolver when the provider has a
    // stored credential: openaiCompat.default is the shape `provider connect`
    // writes for an OpenAI-compatible endpoint.
    mkdirSync(kinuHome, { recursive: true });
    writeFileSync(join(kinuHome, "config.json"), `${JSON.stringify({
      providers: { openaiCompat: { default: { baseURL, apiKey: "mock" } } },
    })}\n`);

    const run = (args: string[]) => {
      const proc = Bun.spawnSync([process.execPath, "run", join(root, "cli.js"), ...args], {
        cwd: root, env, stdout: "pipe", stderr: "pipe",
      });

      expect(proc.exitCode, launchFailure(proc)).toBe(0);
    };

    run(["create", "w1", "--mode", "local", "--model", "openai-compat/mock-model"]);
    // Turns read the profile tier, not the actor's stored hint: `create
    // --model` writes the hint, and only `kinu model` updates the tier the
    // resolver actually consults.
    run(["model", "w1", "openai-compat/mock-model"]);
  }

  function chatSurface(root: string, env: Record<string, string>): PtyRun {
    return runTuiInPty(join(root, "cli.js"), {
      args: ["chat", "w1"],
      cwd: root,
      steps: [
        { wait: "Send a message" },
        { send: "say hi" },
        { wait: "say hi" },
        { send: "\r" },
        { wait: "two green lanes" },
        { wait: "archive unpacked" },
        // Only once the reply is all there is the absence of its markers
        // meaningful: `gone` holds the run open for them to leave, which is
        // where conceal fails when the worker never starts.
        { gone: "**" },
        { gone: "###" },
        { gone: "`" },
      ],
      env,
    });
  }

  test("a packaged chat renders streamed markdown: worker, conceal, and theme ink", async () => {
    const server = await startMockLlmProcess();

    try {
      const install = scratchDir("cli-dist-installed");
      const root = unpackHostCli(install);
      const env = offlineChildEnv(join(install, "home"), server.proxyPort);

      // The control: this environment cannot reach the outside, and reaching
      // it provably goes through the guard. Until this holds, an `attempted:
      // false` verdict at the end means nothing.
      await proveNetworkGuard(env, server.modelPort);

      provisionWorkspace(root, env, `http://127.0.0.1:${String(server.modelPort)}/v1`);

      const run = chatSurface(root, env);

      expect(run.waits.every((w) => w.met), `PTY waits failed: ${JSON.stringify(run.waits)}`).toBe(true);

      // Conceal: every marker the text carries is gone from the frame. A
      // worker that never starts leaves all of them literal.
      expect(run.screen).toContain("two green lanes");
      expect(run.screen).not.toContain("**");
      expect(run.screen).not.toContain("###");
      expect(run.screen).not.toContain("`");
      expect(run.screen).toContain("worker bundle parser.worker.js");
      expect(run.screen).toContain("1. archive unpacked");
      expect(run.screen).toContain("2. TUI rendered");
      expect(run.screen).toContain("Heading marker");
      expect(run.screen).toContain("const PACKAGED = true;");

      // The grammar actually painted: the bold span carries the bold attribute
      // and the inline code span carries the theme's code ink — both emitted
      // only when tree-sitter answers.
      expect(run.raw).toContain("\x1b[1mtwo green lanes");
      expect(run.raw).toContain("\x1b[1mHeading marker");

      const codeInk = createThemeRegistry(BUILTIN_TUI_THEMES)
        .get(DEFAULT_TUI_THEME_SELECTION.themeId).colors.well.code;

      expect(inkBefore(run.raw, "parser.worker.js")).toBe(codeInk);

      // Nothing the render needed came from the network: every asset the
      // worker asked for was already in the unpack dir.
      expect(await networkAttempted(server.modelPort)).toBe(false);
    } finally {
      server.stop();
    }
  });

  // The regression this guards: an archive without the worker files renders
  // the same turn with every marker literal — the state before this fix.
  test("a packaged chat without the worker ships raw markdown", async () => {
    const server = await startMockLlmProcess();

    try {
      const install = scratchDir("cli-dist-noworker");
      const root = unpackHostCli(install);
      const env = offlineChildEnv(join(install, "home"), server.proxyPort);

      // Only files the runtime can resolve: what the bundled cli.js imported
      // with type: "file" — a stray parser.worker.js beside it is not proof.
      const workers = readdirSync(root)
        .filter((name) => /^parser\.worker-\w+\.js$/.test(name))
        .map((name) => join(root, name));

      expect(workers.length, "no emitted parser.worker-*.js in the unpack dir").toBeGreaterThan(0);

      for (const worker of workers) renameSync(worker, `${worker}.off`);

      try {
        provisionWorkspace(root, env, `http://127.0.0.1:${String(server.modelPort)}/v1`);

        const run = chatSurface(root, env);

        expect(run.screen).toContain("**two green lanes**");
        expect(run.screen).toContain("### Heading marker");
        expect(run.screen).toContain("`parser.worker.js`");
      } finally {
        for (const worker of workers) renameSync(`${worker}.off`, worker);
      }
    } finally {
      server.stop();
    }
  });
});

/**
 * The worker release artifact is ~29 MB and Cloudflare's per-file asset limit
 * is 25 MiB, which the CLI distribution row above already measures for the
 * tarballs it publishes. Staging this one beside them would fail the deploy at
 * asset upload, so it is published into R2 and streamed by the Worker at the
 * same public path; only the manifest and the checksum stay assets.
 */
describe("worker release artifact", () => {
  const MAX_ASSET_BYTES = 25 * 1024 * 1024;

  const VERSION = "0.0.0+deploytest";

  const ARTIFACT = `kinu-worker-${VERSION}.tar.gz`;

  let dist: string;

  beforeAll(() => {
    dist = scratchDir("worker-release-test");
    mkdirSync(join(dist, "kinu", "assets"), { recursive: true });
    mkdirSync(join(dist, "client", "assets"), { recursive: true });
    mkdirSync(join(dist, "client", "downloads"), { recursive: true });
    writeFileSync(join(dist, "kinu", "index.js"), "export default { fetch() { return new Response('k'); } };\n");
    writeFileSync(join(dist, "kinu", "index.js.map"), "{}\n");
    writeFileSync(join(dist, "kinu", "wrangler.json"), "{}\n");
    writeFileSync(join(dist, "kinu", "assets", "chunk.js"), "export const a = 1;\n");
    // What the real build writes beside the modules and a release must never
    // carry: the plugin's copy of this checkout's local-dev secrets, and the
    // build's own index. And one member the runtime does load: a compiled
    // WebAssembly module.
    writeFileSync(join(dist, "kinu", ".dev.vars"), "CREDENTIAL_ENCRYPTION_KEY='not-for-the-public'\n");
    mkdirSync(join(dist, "kinu", ".vite"), { recursive: true });
    writeFileSync(join(dist, "kinu", ".vite", "manifest.json"), "{}\n");
    writeFileSync(join(dist, "kinu", "assets", "esbuild-abc.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    writeFileSync(join(dist, "client", "index.html"), "<!doctype html><title>k</title>\n");
    writeFileSync(join(dist, "client", "assets", "app.js"), "console.log('app');\n");
    writeFileSync(join(dist, "client", "downloads", "kinu-cli-linux-x64.tar.gz"), "not really a tarball\n");

    const build = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts", "build-worker-release.ts"), VERSION, "deploytest", dist],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: childEnv() },
    );

    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
  });

  test("the tarball is not under the assets directory at all", () => {
    expect(existsSync(join(dist, "client", "downloads", ARTIFACT))).toBe(false);
    expect(existsSync(join(dist, "worker-release", ARTIFACT))).toBe(true);
  });

  test("what does stay an asset is under Cloudflare's per-file limit", () => {
    for (const name of ["release.json", `${ARTIFACT}.sha256`]) {
      const published = join(dist, "client", "downloads", name);

      expect(existsSync(published)).toBe(true);
      expect(statSync(published).size).toBeLessThan(MAX_ASSET_BYTES);
    }
  });

  test("the published checksum is the artifact's", () => {
    const stated = readFileSync(join(dist, "client", "downloads", `${ARTIFACT}.sha256`), "utf8").trim().split(/\s+/)[0];
    const measured = createHash("sha256").update(readFileSync(join(dist, "worker-release", ARTIFACT))).digest("hex");

    expect(stated).toBe(measured);
  });

  test("the artifact carries the worker's modules and the client's assets, and neither the maps nor the downloads", () => {
    const listed = Bun.spawnSync(["tar", "-tzf", join(dist, "worker-release", ARTIFACT)], { stdout: "pipe" });
    const entries = new TextDecoder().decode(listed.stdout).split("\n").filter((line) => line.trim() !== "");

    expect(entries).toContain("worker/index.js");
    expect(entries).toContain("worker/assets/esbuild-abc.wasm");
    expect(entries).toContain("client/index.html");
    expect(entries.some((entry) => entry.endsWith(".map"))).toBe(false);
    // The build stamp rides along (it is what `/api/health` answers `build`
    // from); the CLI tarballs beside it at kinu.run do not.
    expect(entries.filter((entry) => entry.startsWith("client/downloads/") && !entry.endsWith("/")))
      .toEqual(["client/downloads/kinu-version.json"]);
    expect(entries).toContain("release.json");
  });

  // Measured 2026-09-21: release 0.2.0+bd1872f73 carried both, and the
  // `.dev.vars` was this checkout's local-dev root key, published to anyone
  // who installs. A member is what the runtime loads; scaffolding is not.
  test("the artifact carries no local-dev secrets and no build index, and the manifest names only modules", () => {
    const listed = Bun.spawnSync(["tar", "-tzf", join(dist, "worker-release", ARTIFACT)], { stdout: "pipe" });
    const entries = new TextDecoder().decode(listed.stdout).split("\n").filter((line) => line.trim() !== "");

    expect(entries.some((entry) => entry.endsWith(".dev.vars"))).toBe(false);
    expect(entries.some((entry) => entry.includes("/.vite/"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith("wrangler.json"))).toBe(false);

    const manifest = parseReleaseManifest(readFileSync(join(dist, "client", "downloads", "release.json"), "utf8"));

    expect([...manifest.worker.modules].sort()).toEqual(["assets/chunk.js", "assets/esbuild-abc.wasm", "index.js"]);
    expect(manifest.files.map((file) => file.path).filter((path) => path.startsWith("worker/")).sort())
      .toEqual(["worker/assets/chunk.js", "worker/assets/esbuild-abc.wasm", "worker/index.js"]);
  });

  /**
   * The order is part of the artifact, not an accident of the tar line. The
   * Cloudflare door installs this with one pass of the stream and holds the
   * module set to the end, because a version is one multipart request
   * (`packages/core/src/deploy/steps.ts`). Modules first would mean holding
   * them through every asset, which is the difference between a peak set by
   * the largest member and one set by the release.
   */
  test("every asset comes before every module", () => {
    const listed = Bun.spawnSync(["tar", "-tzf", join(dist, "worker-release", ARTIFACT)], { stdout: "pipe" });
    const entries = new TextDecoder().decode(listed.stdout).split("\n").filter((line) => line.trim() !== "");
    const lastAsset = entries.reduce((last, entry, at) => (entry.startsWith("client/") ? at : last), -1);
    const firstModule = entries.findIndex((entry) => entry.startsWith("worker/"));

    expect(lastAsset).toBeGreaterThan(-1);
    expect(firstModule).toBeGreaterThan(lastAsset);
  });
});
