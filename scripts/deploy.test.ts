import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  "bun test --cwd packages/test-utils",
  "bun test --cwd packages/cf-backend",
  "bun test --cwd packages/cli-backend",
  "bun test --cwd packages/cli",
  "bun test scripts/eval.test.ts",
  `bun test ${BENCH_GATE_FILES.join(" ")}`,
  "bun test scripts/secret-scan.test.ts",
  "bun scripts/secret-scan.ts",
  "bun scripts/schema-drift.ts",
  "bun scripts/tracing-gate.ts",
  "bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts",
  "bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts",
  "bun test scripts/ladder.test.ts",
  "bun run gate:dead-code",
  "bun run gate:duplication",
  "bun run gate:capability-parity",
  "bun run gate:do-init",
  "bun run gate:reachability",
  "bun run gate:platform",
  "bun run gate:egress-interception",
  "bun test --cwd packages/pc-agent",
  "bun test ./tests/",
  "bun run layergate",
  "bun run layergate --matrix",
  "bun run verify:lean",
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
printf '%s\\n' "$command_line" >> "$PROTEUS_DEPLOY_GATE_LOG"
if [ "$PROTEUS_DEPLOY_FAIL" = "$command_line" ]; then
  exit 47
fi
exit 0
`;
}

function runDeploy(failingGate: string, dirty = false) {
  const fixture = mkdtempSync(join(tmpdir(), "proteus-deploy-gate-"));
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
elif [ "$3" = "status" ] && [ "$PROTEUS_DEPLOY_DIRTY" = "1" ]; then
  printf ' M source.ts\\n'
fi
exit 0
`);
  executable(join(fixture, "bunx"), `#!/usr/bin/bash
printf 'MUTATE bunx %s\\n' "$*" >> "$PROTEUS_DEPLOY_GATE_LOG"
exit 86
`);
  executable(join(fixture, "npx"), `#!/usr/bin/bash
if [ "$*" = "wrangler whoami" ]; then
  exit 0
fi
printf 'MUTATE npx %s\\n' "$*" >> "$PROTEUS_DEPLOY_GATE_LOG"
exit 87
`);

  const run = Bun.spawnSync(["/usr/bin/bash", "scripts/deploy.sh"], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${fixture}:/usr/bin:/bin`,
      PROTEUS_DEPLOY_FAIL: failingGate,
      PROTEUS_DEPLOY_GATE_LOG: log,
      PROTEUS_DEPLOY_DIRTY: dirty ? "1" : "0",
      SKIP_E2E: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const events = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: run.exitCode, events };
}

describe("production deploy gate", () => {
  test("runs every deterministic gate before the first build mutation", () => {
    const run = runDeploy("");

    expect(run.status).not.toBe(0);
    expect(run.events).toEqual([...REQUIRED_GATES, "MUTATE bunx vite build"]);
  });

  test("every gate fails closed even when the former skip variable is set", () => {
    for (const [index, gate] of REQUIRED_GATES.entries()) {
      const run = runDeploy(gate);

      expect(run.status).not.toBe(0);
      expect(run.events).toEqual(REQUIRED_GATES.slice(0, index + 1));
      expect(run.events.some((event) => event.startsWith("MUTATE "))).toBe(false);
    }
  });

  test("a dirty checkout is rejected before verification or mutation", () => {
    const run = runDeploy("", true);

    expect(run.status).not.toBe(0);
    expect(run.events).toEqual([]);
  });
});
