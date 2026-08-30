// This gate proves the activated rule through the real Oxlint binary. Its staging plugin isolates
// this rule's diagnostics; the activation assertion below prevents a staged-only green result.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import { isParseable, trackedFiles } from "../../../scripts/sources.ts";
import {
  BRANCH_PROCESS_SOURCE,
  ELAPSED_WORK_SOURCE_ROOTS,
  isElapsedWorkDeadlineSource,
} from "./rules/no-elapsed-work-deadline.ts";

const repoRoot = process.cwd();
const STAGING_PLUGIN = "elapsed-deadline-stage";
const STAGING_RULE = `${STAGING_PLUGIN}/no-elapsed-work-deadline`;
const STAGING_CODE = `${STAGING_PLUGIN}(no-elapsed-work-deadline)`;
const OXLINT_BINARY = "./node_modules/oxlint/bin/oxlint";
const ACTIVE_RULE = "anti-slop/no-elapsed-work-deadline";

type Diagnostic = {
  readonly code?: string;
  readonly filename?: string;
  readonly message?: string;
};
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};
type HistoricalSource = {
  readonly commit: string;
  readonly path: string;
  readonly constantLine: number;
  readonly timerLines: readonly [number, number];
};
type Fixture = {
  readonly path: string;
  readonly label: string;
  readonly code: string;
};

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8")) as {
  readonly rules: Readonly<Record<string, unknown>>;
};
assert.equal(
  config.rules[ACTIVE_RULE],
  "error",
  `${ACTIVE_RULE} must be active at error; a staged-only rule cannot protect the repository`,
);

const HISTORICAL_SOURCE: HistoricalSource = {
  commit: "b936e3b84101dd7074986da8758363d496b0fb23^",
  path: BRANCH_PROCESS_SOURCE,
  constantLine: 43,
  timerLines: [134, 138],
};
const HISTORICAL_TIMER_BODY = `      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const timeout = setTimeout(() => {
        child.off('message', handler);
        reject(new Error(\`Branch RPC timeout: \${method}\`));
      }, BRANCH_RPC_TIMEOUT_MS);
`;
const HISTORICAL_CONSTANT = "export const BRANCH_RPC_TIMEOUT_MS = TURN_WALL_CLOCK_ENVELOPE_MS;\n";
const HISTORICAL_TIMER_BODY_DIGEST = "1d2143a967aea7e30ce059385cccb2d045b5771a15cbeb5f380f31e5c2aee4eb";
const HISTORICAL_CONSTANT_DIGEST = "abaef6aa6ecbe3a18d22c2e7146feecbf5e52f1caee285e7592d647a7a75a94d";
const HISTORICAL_BLOB_DIGEST = "a944bd66de4e810a2954d2c00c6e986235c393fe4c8f2d8ec7a6e8646a75080b";

/** One named digest operation binds every historical fixture to the same evidence format. */
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

assert.equal(
  sha256(HISTORICAL_TIMER_BODY),
  HISTORICAL_TIMER_BODY_DIGEST,
  "the historical timer body no longer matches its verified digest",
);
assert.equal(
  sha256(HISTORICAL_CONSTANT),
  HISTORICAL_CONSTANT_DIGEST,
  "the historical deadline constant no longer matches its verified digest",
);

const historical = spawnSync(
  "git",
  ["show", `${HISTORICAL_SOURCE.commit}:${HISTORICAL_SOURCE.path}`],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (historical.status === 0) {
  assert.equal(
    sha256(historical.stdout),
    HISTORICAL_BLOB_DIGEST,
    "the historical branch-process blob no longer matches its verified digest",
  );
  const historicalLines = historical.stdout.split("\n");
  assert.equal(
    `${historicalLines[HISTORICAL_SOURCE.constantLine - 1]}\n`,
    HISTORICAL_CONSTANT,
    "the pinned constant line differs from the historical source",
  );
  const [from, to] = HISTORICAL_SOURCE.timerLines;
  assert.equal(
    `${historicalLines.slice(from - 1, to).join("\n")}\n`,
    HISTORICAL_TIMER_BODY,
    "the pinned timer body differs from the historical source",
  );
} else {
  process.stdout.write(
    `no-elapsed-work-deadline: ${HISTORICAL_SOURCE.commit} unreachable; timer and constant fixtures verified by digest only\n`,
  );
}

const HISTORICAL_RED_FIXTURE = `declare const TURN_WALL_CLOCK_ENVELOPE_MS: number;
${HISTORICAL_CONSTANT}declare const child: { off(event: string, listener: object): void };
declare const handler: object;
declare const method: string;
export function historicalRpc<T>(): Promise<T> {
${HISTORICAL_TIMER_BODY}  return promise;
}
`;
const DIRECT_RACE_RED_FIXTURE = `declare const work: Promise<string>;
declare const envelopeMs: number;
export function raceDeadline(): Promise<string> {
  return Promise.race([work, AbortSignal.timeout(envelopeMs)]);
}
`;
const GREEN_FIXTURE = `declare const child: {
  on(event: string, listener: (...args: readonly unknown[]) => void): void;
  off(event: string, listener: object): void;
  once(event: string, listener: () => void): void;
};
declare const method: string;
export function correctedRpc<T>(): Promise<T> {
  const { promise, reject } = Promise.withResolvers<T>();
  let settled = false;
  const onExit = () => {
    if (settled) return;
    settled = true;
    reject(new Error(\`Branch worker exited before answering \${method}\`));
  };
  child.once('exit', onExit);
  return promise;
}
export async function waitForChildReady(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
    const handler = (msg: { method: string }) => {
      if (msg.method === 'ready') {
        clearTimeout(timeout);
        child.off('message', handler);
        resolve();
      }
    };
    child.on('message', handler);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error('Branch worker exited')); }
    });
  });
}
`;

const RED_FIXTURES: readonly Fixture[] = [
  {
    path: BRANCH_PROCESS_SOURCE,
    label: "verified historical branch RPC timer",
    code: HISTORICAL_RED_FIXTURE,
  },
  {
    path: "packages/core/src/providers/direct-abort-signal-race.ts",
    label: "direct Promise.race AbortSignal arm",
    code: DIRECT_RACE_RED_FIXTURE,
  },
];
const BOUNDARIES: readonly Fixture[] = [
  {
    path: "packages/core/src/providers/bounded-io.ts",
    label: "bounded I/O AbortSignal timeout",
    code: "await fetch(url, { signal: AbortSignal.timeout(portWaitMs) });\n",
  },
  {
    path: "packages/core/src/providers/bound-signal-race.ts",
    label: "blind spot: pre-bound AbortSignal timeout raced later",
    code: "const expiry = AbortSignal.timeout(ms); await Promise.race([work, expiry]);\n",
  },
  {
    path: "packages/core/src/providers/clock-delta.ts",
    label: "blind spot: Date.now delta deadline",
    code: `const expirationAt = (
  started: number,
  budgetMs: number,
  reject: (error: Error) => void,
): void => {
  if (Date.now() - started >= budgetMs) reject(new Error('elapsed'));
};
void expirationAt;
`,
  },
  {
    path: "packages/core/src/providers/indirect-callback.ts",
    label: "blind spot: timer callback hidden behind an identifier",
    code: "const deadlineArm = () => reject(new Error('elapsed')); setTimeout(deadlineArm, ms);\n",
  },
  {
    path: "packages/core/src/providers/fixture.test.ts",
    label: "test-file exclusion under a governed root",
    code: "setTimeout(() => reject(new Error('fixture timeout')), 30);\n",
  },
  {
    path: "packages/core/src/web/provider.ts",
    label: "web HTTP transport abort",
    code: "setTimeout(() => controller.abort(new Error('web HTTP timeout')), timeoutMs);\n",
  },
  {
    path: "packages/cli/src/cloud-agent-client.ts",
    label: "cloud WebSocket connect",
    code: "setTimeout(() => reject(new Error('cloud WebSocket connect timeout')), timeoutMs);\n",
  },
  {
    path: "packages/cli/src/version-check.ts",
    label: "version HTTP abort",
    code: "setTimeout(() => controller.abort(new Error('version HTTP timeout')), timeoutMs);\n",
  },
  {
    path: "scripts/liveness-capture.ts",
    label: "liveness-capture timer",
    code: "setTimeout(() => reject(new Error('liveness capture timeout')), timeoutMs);\n",
  },
  {
    path: "scripts/ws-test-harness.ts",
    label: "ws-test-harness timer",
    code: "setTimeout(() => reject(new Error('WebSocket test timeout')), timeoutMs);\n",
  },
  {
    path: "scripts/ws-reconnect-drill.ts",
    label: "ws-reconnect drill timer",
    code: "setTimeout(() => reject(new Error('WebSocket reconnect timeout')), timeoutMs);\n",
  },
  {
    path: "scripts/bench-sandbox.ts",
    label: "bench-sandbox timer",
    code: "setTimeout(() => reject(new Error('sandbox benchmark timeout')), timeoutMs);\n",
  },
];

/** The rule's exported predicate defines the source set; the gate adds parseability and nothing else. */
function governedSourceSet(): readonly string[] {
  return trackedFiles()
    .filter(isParseable)
    .filter(isElapsedWorkDeadlineSource)
    .sort();
}

/** Oxlint's pre-lint file list is the measured set, not a second local glob. */
function measuredSourceSet(configPath: string, governed: readonly string[]): readonly string[] {
  const run = spawnSync(
    process.execPath,
    [OXLINT_BINARY, "-c", configPath, "--debug=files", ...governed],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  assert.equal(
    run.status,
    0,
    `oxlint could not enumerate measured files:\n${run.stderr}\nstdout:\n${run.stdout}`,
  );

  const measured = run.stdout.trimEnd()
    .split("\n")
    .filter((file) => file.length > 0)
    .map((file) => relative(repoRoot, resolve(repoRoot, file)).split(sep).join("/"))
    .sort();
  assert.deepEqual(
    measured.filter((file, index) => index === 0 || measured[index - 1] !== file),
    measured,
    "oxlint measured a source more than once; duplicate work can hide a missing source in a count",
  );
  return measured;
}

/** The isolated binary invocation is the contract under test, so every call checks its file count. */
function lint(configPath: string, paths: readonly string[], expectedFiles: number): LintReport {
  const run = spawnSync(
    process.execPath,
    [OXLINT_BINARY, "-c", configPath, "-f", "json", ...paths],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${paths.join(" ")}:\n${run.stderr}`);
  const report: LintReport = JSON.parse(run.stdout);
  assert.equal(
    report.number_of_files,
    expectedFiles,
    `oxlint linted ${String(report.number_of_files)} of ${String(expectedFiles)} requested files; a skipped file cannot be governed`,
  );
  assert.ok(
    report.number_of_rules > 0,
    `oxlint ran ${String(report.number_of_rules)} rules; the staged rule was not loaded`,
  );
  return report;
}

/** Diagnostics from the one temporary plugin rule, excluding unrelated Oxlint machinery. */
function stagedDiagnostics(report: LintReport): readonly Diagnostic[] {
  return report.diagnostics.filter((diagnostic) => diagnostic.code === STAGING_CODE);
}

function writeFixture(directory: string, fixture: Fixture): void {
  const target = join(directory, fixture.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fixture.code);
}

const workspace = mkdtempSync(join(tmpdir(), "kinu-no-elapsed-deadline-gate-"));
try {
  const pluginPath = join(workspace, "elapsed-deadline-stage.mjs");
  const configPath = join(workspace, "oxlintrc.json");
  const measurementConfigPath = join(workspace, "measure.oxlintrc.json");
  const pluginRuntime = pathToFileURL(
    join(repoRoot, "node_modules", "@oxlint", "plugins", "index.js"),
  ).href;
  const ruleModule = pathToFileURL(
    join(repoRoot, "tools", "oxlint", "anti-slop", "rules", "no-elapsed-work-deadline.ts"),
  ).href;
  writeFileSync(
    pluginPath,
    `import { eslintCompatPlugin } from ${JSON.stringify(pluginRuntime)};
import { noElapsedWorkDeadlineRule } from ${JSON.stringify(ruleModule)};

export default eslintCompatPlugin({
  meta: { name: ${JSON.stringify(STAGING_PLUGIN)} },
  rules: { "no-elapsed-work-deadline": noElapsedWorkDeadlineRule },
});
`,
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      jsPlugins: [{ name: STAGING_PLUGIN, specifier: "./elapsed-deadline-stage.mjs" }],
      rules: { [STAGING_RULE]: "error" },
    }, null, 2)}\n`,
  );
  writeFileSync(
    measurementConfigPath,
    `${JSON.stringify({
      jsPlugins: [{ name: STAGING_PLUGIN, specifier: "./elapsed-deadline-stage.mjs" }],
      rules: { [STAGING_RULE]: "off" },
    }, null, 2)}\n`,
  );

  const governed = governedSourceSet();
  assert.ok(governed.length > 0, "the rule's own path predicate selected 0 parseable policy sources");
  assert.ok(
    governed.includes(BRANCH_PROCESS_SOURCE),
    `${BRANCH_PROCESS_SOURCE} must remain governed for the historical RPC regression`,
  );
  const domainFiles = Object.entries(ELAPSED_WORK_SOURCE_ROOTS).map(([domain, roots]) => ({
    domain,
    files: governed.filter((file) => roots.some((root) => file.includes(root))),
  }));
  for (const { domain, files } of domainFiles) {
    assert.ok(
      files.length > 0,
      `the ${domain} source roots selected 0 parseable files; this policy domain would be ungoverned`,
    );
  }

  const measured = measuredSourceSet(measurementConfigPath, governed);
  assert.deepEqual(
    measured,
    governed,
    `Oxlint's measured file set differs from the governed source set. Missing: ${governed.filter((file) => !measured.includes(file)).join(", ") || "none"}. Unexpected: ${measured.filter((file) => !governed.includes(file)).join(", ") || "none"}`,
  );

  const live = lint(configPath, governed, measured.length);
  const unnamed = live.diagnostics.filter((diagnostic) => diagnostic.code === undefined);
  assert.deepEqual(
    unnamed.map((diagnostic) => `${diagnostic.filename ?? "?"} — ${diagnostic.message ?? "no message"}`),
    [],
    "a codeless diagnostic means a source failed to parse or configuration hid rule execution",
  );
  const liveFindings = stagedDiagnostics(live);
  assert.deepEqual(
    liveFindings.map((diagnostic) => `${diagnostic.filename ?? "?"}: ${diagnostic.message ?? "no message"}`),
    [],
    `governed source carries ${String(liveFindings.length)} elapsed-work deadline finding(s)`,
  );

  const redDirectory = join(workspace, "red");
  const greenDirectory = join(workspace, "green");
  const boundaryDirectory = join(workspace, "boundaries");
  mkdirSync(redDirectory);
  mkdirSync(greenDirectory);
  mkdirSync(boundaryDirectory);
  for (const fixture of RED_FIXTURES) writeFixture(redDirectory, fixture);
  writeFixture(greenDirectory, {
    path: BRANCH_PROCESS_SOURCE,
    label: "child-exit correction and complete ready handshake",
    code: GREEN_FIXTURE,
  });
  for (const boundary of BOUNDARIES) writeFixture(boundaryDirectory, boundary);

  const red = lint(configPath, [redDirectory], RED_FIXTURES.length);
  for (const fixture of RED_FIXTURES) {
    const findings = stagedDiagnostics(red).filter((diagnostic) =>
      diagnostic.filename?.replaceAll("\\", "/").endsWith(fixture.path) === true);
    assert.equal(
      findings.length,
      1,
      `${fixture.label} fired ${String(findings.length)} time(s); expected exactly one staged-rule finding`,
    );
  }
  const green = lint(configPath, [greenDirectory], 1);
  assert.deepEqual(
    green.diagnostics.map((diagnostic) => `${diagnostic.filename ?? "?"}: ${diagnostic.code ?? "?"}`),
    [],
    "the child-exit correction and complete ready handshake must lint clean under the isolated rule",
  );
  const boundaries = lint(configPath, [boundaryDirectory], BOUNDARIES.length);
  assert.deepEqual(
    boundaries.diagnostics.map((diagnostic) => `${diagnostic.filename ?? "?"}: ${diagnostic.code ?? "?"}`),
    [],
    `green boundaries unexpectedly reported: ${BOUNDARIES.map((boundary) => boundary.label).join("; ")}`,
  );

  const domainSummary = domainFiles
    .map(({ domain, files }) => `${domain}=${String(files.length)}`)
    .join(", ");
  process.stdout.write(
    `no-elapsed-work-deadline: activated rule proven red-to-green through isolated oxlint over ${String(governed.length)} governed and ${String(measured.length)} measured files (${domainSummary}); zero live findings. Blind spots: indirect callbacks, Date.now deltas, and pre-bound AbortSignal.timeout races. Transport, scripts, and process-liveness remain outside this work-path scope; only the complete branch ready handshake is structurally exempt\n`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
