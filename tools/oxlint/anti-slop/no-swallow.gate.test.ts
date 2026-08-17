// Proteus-only gate; see upstream.json's `proteusRules`.
//
// The four no-swallow rules own RuleTester suites, but a suite proves only that the rule function
// behaves — not that the rule is reachable through the command the repo actually gates on. This
// file runs the real `oxlint` binary with the real `.oxlintrc.json`, over a seeded instance of each
// defect and over its corrected form, in one process, and asserts red on the first and green on the
// second. It also asserts the live denominator: a rule that inspects no `catch` in `packages/`
// reports no swallowing and would pass silently.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readSources } from "../../../scripts/sources.ts";

const repoRoot = process.cwd();

/** `oxlint -f json`. `code` is spelled `anti-slop(no-empty-catch)`, not `anti-slop/...`. */
type Diagnostic = { readonly code?: string; readonly filename?: string };
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};

/**
 * The `workspace_capability` read exactly as it stood at 5183d69d, before this rule existed. It
 * returned `null` when the table was absent and `null` when the workspace held no token, so the
 * capability existed in production only as a side effect of a call that failed on its way down and
 * nobody could see it for months. Rule (b) exists for this shape; the fixture is the shape itself.
 */
const HISTORICAL_CAPABILITY_READ = `  protected async workspaceCapabilityToken(): Promise<string | null> {
    try {
      this.ensureCapabilityTable();
      const rows = this.sql<{ token: string }>\`SELECT token FROM workspace_capability LIMIT 1\`;
      return rows[0]?.token || null;
    } catch { return null; }
  }
`;
const HISTORICAL_DIGEST = "dba2441145698ea03973ca92de1395c9684c7b5fa25ae0b5566f482b613e4f6f";
const HISTORICAL_SOURCE = {
  commit: "5183d69d",
  path: "packages/cf-backend/src/actor-agent.ts",
  lines: [388, 394] as const,
};

// Unconditional: the fixture is pinned by digest, so it cannot be quietly reworded into a shape the
// rule happens to catch. Checked before the git comparison, which depends on the object surviving.
assert.equal(
  createHash("sha256").update(HISTORICAL_CAPABILITY_READ).digest("hex"),
  HISTORICAL_DIGEST,
  "the historical workspace_capability fixture no longer matches its pinned digest",
);

const historical = spawnSync(
  "git",
  ["show", `${HISTORICAL_SOURCE.commit}:${HISTORICAL_SOURCE.path}`],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (historical.status === 0) {
  const [from, to] = HISTORICAL_SOURCE.lines;
  assert.equal(
    `${historical.stdout.split("\n").slice(from - 1, to).join("\n")}\n`,
    HISTORICAL_CAPABILITY_READ,
    `${HISTORICAL_SOURCE.path}:${from}-${to} at ${HISTORICAL_SOURCE.commit} is not the fixture this gate claims to replay`,
  );
} else {
  process.stdout.write(
    `no-swallow: ${HISTORICAL_SOURCE.commit} unreachable from this checkout; fixture verified by pinned digest only\n`,
  );
}

/** Red fixture, then the corrected form of the same code, per rule. */
const cases: ReadonlyArray<{
  readonly rule: string;
  readonly bad: string;
  readonly good: string;
}> = [
  {
    rule: "no-empty-catch",
    bad: `export function ensureScoreBounds(execRaw: (sql: string) => void): void {
  try { execRaw('UPDATE replay_evals SET score_lo = 0'); } catch { /* non-fatal */ }
}
`,
    good: `export function ensureScoreBounds(
  execRaw: (sql: string) => void,
  log: { warn: (m: string, d: { event: string; error: unknown }) => void },
): void {
  try {
    execRaw('UPDATE replay_evals SET score_lo = 0');
  } catch (error) {
    log.warn('score bounds not written', { event: 'replay.score_bounds_failed', error });
  }
}
`,
  },
  {
    rule: "no-sentinel-catch",
    bad: `declare const base: { ensureCapabilityTable(): void; sql<T>(q: TemplateStringsArray): T[] };
export class Historical {
${HISTORICAL_CAPABILITY_READ}}
`,
    // The classifier takes `{ cause }` rather than an `unknown` parameter, which is what
    // anti-slop/no-unknown-parameters requires and what `new Error(msg, { cause })` already spells.
    good: `declare const isMissingTable: (options: { cause: unknown }) => boolean;
export class Corrected {
  protected async workspaceCapabilityToken(): Promise<string | null> {
    try {
      this.ensureCapabilityTable();
      const rows = this.sql<{ token: string }>\`SELECT token FROM workspace_capability LIMIT 1\`;
      return rows[0]?.token || null;
    } catch (error) {
      if (!isMissingTable({ cause: error })) throw error;
      return null;
    }
  }
}
`,
  },
  {
    rule: "require-cause-on-rethrow",
    bad: `export function loadPlan(read: () => string): string {
  try {
    return read();
  } catch (error) {
    throw new Error('plan unreadable');
  }
}
`,
    good: `export function loadPlan(read: () => string): string {
  try {
    return read();
  } catch (error) {
    throw new Error('plan unreadable', { cause: error });
  }
}
`,
  },
  {
    rule: "no-ddl-in-catch",
    // The catch logs, so no-empty-catch is silent and this fixture isolates what rule (d) adds:
    // logging a swallowed ALTER TABLE still leaves a locked table indistinguishable from success.
    bad: `export function addSourceColumn(
  execRaw: (sql: string) => void,
  log: { warn: (m: string, d: { event: string; error: unknown }) => void },
): void {
  try {
    execRaw("ALTER TABLE alternate_takes ADD COLUMN source TEXT NOT NULL DEFAULT 'mcts'");
  } catch (error) {
    log.warn('column exists', { event: 'schema.alter_skipped', error });
  }
}
`,
    good: `export function addSourceColumn(
  execRaw: (sql: string) => void,
  columns: (table: string) => ReadonlyArray<{ name: string }>,
): void {
  if (columns('alternate_takes').some((c) => c.name === 'source')) return;
  execRaw("ALTER TABLE alternate_takes ADD COLUMN source TEXT NOT NULL DEFAULT 'mcts'");
}
`,
  },
];

/** Ensures the four rules are exactly the ones this gate is assigned. `proteusRuleGates` is the
 *  source of truth rather than a list here, and drift.test.ts asserts those slices partition
 *  `proteusRules` exactly — so a Proteus rule with no gate still fails, and this gate still cannot
 *  quietly stop covering one of its own. */
const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"),
);
assert.deepEqual(
  cases.map((entry) => entry.rule).sort(),
  [...manifest.proteusRuleGates["no-swallow.gate.test.ts"]].sort(),
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}

/**
 * The live denominator. `catch` occurrences in product source, from the ONE
 * enumeration: the rules are worth running only over a corpus that contains
 * failure handling at all, and a corpus that has silently gone to zero must fail
 * loudly rather than report a clean lint.
 *
 * `readSources()` and not a walk of its own. The hand-rolled version skipped
 * `node_modules` by name and selected `.ts` / `.tsx` by name, which is
 * `isProductSource` spelled a second time — and it differed: it counted colocated
 * `*.test.ts` and `.d.ts` files that `readSources` excludes, so this gate's
 * denominator described a different population from the one every other gate
 * measures. Its own docstring already said "a moved source root, a changed glob"
 * was the hazard; the fix is to stop having a second glob.
 */
function countCatchOccurrences(): { readonly files: number; readonly occurrences: number } {
  let files = 0;
  let occurrences = 0;
  for (const [, text] of readSources()) {
    files += 1;
    occurrences += text.match(/\bcatch\b/gu)?.length ?? 0;
  }
  return { files, occurrences };
}

const corpus = countCatchOccurrences();
assert.ok(
  corpus.files > 0,
  "found no TypeScript sources under packages/*/src; the no-swallow rules would then be gating nothing",
);
assert.ok(
  corpus.occurrences > 0,
  `found ${corpus.files} sources but 0 \`catch\` occurrences under packages/*/src; a no-swallow gate that inspected no failure handling is vacuous`,
);

const fixtures = mkdtempSync(join(repoRoot, ".no-swallow-gate-"));
try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  for (const { rule, bad, good } of cases) {
    writeFileSync(join(badDirectory, `${rule}.ts`), bad);
    writeFileSync(join(goodDirectory, `${rule}.ts`), good);
  }

  const lint = (directory: string): LintReport => {
    const run = spawnSync(
      "./node_modules/.bin/oxlint",
      ["-c", ".oxlintrc.json", "-f", "json", relative(repoRoot, directory)],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${directory}:\n${run.stderr}`);
    const report: LintReport = JSON.parse(run.stdout);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    assert.ok(
      report.number_of_rules > 0,
      `oxlint ran ${report.number_of_rules} rules; a lint with no rules loaded reports no findings`,
    );
    return report;
  };

  // Only the four no-swallow rules; the other 15 also run over these fixtures and their findings
  // are not this gate's subject.
  const ruleOf = (diagnostic: Diagnostic): string | null => {
    const match = /^anti-slop\(([a-z-]+)\)$/u.exec(diagnostic.code ?? "");
    const rule = match?.[1];
    return rule !== undefined && cases.some((entry) => entry.rule === rule) ? rule : null;
  };

  const red = lint(badDirectory).diagnostics;
  const green = lint(goodDirectory).diagnostics;

  const firedIn = (
    diagnostics: ReadonlyArray<Diagnostic>,
    rule: string,
  ): ReadonlyArray<Diagnostic> =>
    diagnostics.filter(
      (d) => ruleOf(d) === rule && (d.filename ?? "").endsWith(`${rule}.ts`),
    );

  for (const { rule } of cases) {
    assert.ok(
      firedIn(red, rule).length > 0,
      `anti-slop/${rule} did not fire on its seeded defect through \`oxlint -c .oxlintrc.json\`. Diagnostics seen: ${JSON.stringify(red.map(ruleOf))}`,
    );
    assert.equal(
      firedIn(green, rule).length,
      0,
      `anti-slop/${rule} fires on the corrected form, so the cutover has no green state to reach`,
    );
  }

  // One rule that flagged everything would satisfy every per-rule check above. These two do not
  // let it: the corrected fixtures must draw no no-swallow finding at all, and each fixture must
  // be flagged by its own rule, which a single over-broad rule cannot produce for all four.
  assert.deepEqual(
    green.filter((d) => ruleOf(d) !== null).map((d) => `${d.filename}: ${d.code}`),
    [],
    "a corrected fixture still draws a no-swallow finding",
  );
  assert.deepEqual(
    [...new Set(red.map(ruleOf).filter((rule) => rule !== null))].sort(),
    cases.map((entry) => entry.rule).sort(),
    "the red run must exercise every no-swallow rule and no rule the fixtures did not seed",
  );

  process.stdout.write(
    `no-swallow: ${cases.length} rules proven red->green through oxlint over ${corpus.occurrences} \`catch\` occurrences in ${corpus.files} sources\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}
