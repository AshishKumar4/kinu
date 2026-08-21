import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EXCLUSION_GROUPS, SERIAL_GATES, deployExclusions, deployWaves } from "./ladder";

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
  "bun test packages/cf-backend/",
  "bun run test:workerd",
  "bun test packages/cli-backend/",
  "bun test packages/cli/",
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
  "bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts",
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
      KINU_DEPLOY_DIRTY: dirty ? "1" : "0",
      SKIP_E2E: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const events = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: run.exitCode, events, stdout: run.stdout.toString() };
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
  //   - the two SERIAL_GATES sit alone at the ends, which is the only ordering the
  //     pipeline actually requires;
  //   - a failing gate stops the pipeline: no build mutation, and the run is
  //     strictly shorter than a whole run;
  //   - nothing mutates before the gates finish.
  test("runs every declared gate before the first build mutation", () => {
    const run = runDeploy("");

    expect(run.status).not.toBe(0);
    expect([...run.events].sort()).toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"].sort());
    expect(run.events.at(-1)).toBe("MUTATE bunx vite build");
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
    // Three waves, so the middle one really is one concurrent block. A barrier
    // after every gate would satisfy the line above and be fully serial again.
    expect(waves.length).toBe(3);
    expect(waves[0]).toEqual(["bun scripts/preflight.ts"]);
    expect(waves.at(-1)).toEqual(["bun run gate:infra"]);
    expect(waves[1]?.length).toBe(50);
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

  test("the serial gates are the ends of the real run too", () => {
    const run = runDeploy("");
    const gates = run.events.filter((event) => !event.startsWith("MUTATE "));

    expect(gates[0]).toBe("bun scripts/preflight.ts");
    expect(gates.at(-1)).toBe("bun run gate:infra");
  });

  // The budget is EXPLICIT because the work is quadratic and bun's 5000ms
  // default is not a decision anybody made about this test. One deploy run per
  // gate, each running every earlier gate's stub: 52 gates is ~2,700 process
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
  });

  test("an unknown environment deploys nothing", () => {
    const run = runDeploy("", false, "preprod");

    expect(run.status).toBe(2);
    expect(run.events).toEqual([]);
    expect(run.stdout).toContain("Usage: scripts/deploy.sh <production|staging>");
  });
});
