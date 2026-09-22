/**
 * Type-aware linting gate. `oxlint-tsgolint` stays pinned to the version this
 * policy measured. `typeAware` is the only semantic-engine switch; `typeCheck`
 * stays absent because compiler diagnostics belong to `tsc`.
 *
 * The enabled set is every `typescript/*` rule in the config except
 * `no-explicit-any` and `ban-ts-comment`, which are pinned in `gate.test.ts`.
 * It is asserted exactly, so a rule cannot be quietly turned off later, and
 * every member carries a red fixture that violates it and a green fixture that
 * does not. `consistent-type-assertions`, `no-inferrable-types` and
 * `no-non-null-assertion` resolve without type information; they are governed
 * here because the TypeScript block is one policy and one set.
 *
 * Two default type-aware rules stay off, each on a measurement taken on
 * 2026-09-21 under oxlint 1.78.0 with oxlint-tsgolint 7.0.2001.
 *
 * `await-thenable` fired 1,115 times; 1,077 of those were
 * `await expect(...).rejects.toThrow(...)` in tests, where bun-types declare
 * the matcher chain as `void` while the runtime returns a promise the caller
 * must await. The rule is adoptable the day bun-types type that promise.
 *
 * `no-implied-eval` fired 18 times. Every product finding is inside the two
 * executors that run model-written JavaScript — the inline executor in
 * `packages/core/src/identity/inline-primitives.ts`,
 * `packages/cli-backend/src/executor.ts` and
 * `packages/cli-backend/src/codemode-tool-factory.ts` — and the rest are their
 * test doubles. The rule bans the product's own capability, so the mechanism is
 * governed structurally instead: one compile helper, counted by a gate.
 *
 * Option shapes carry as much policy as the severities:
 * `consistent-type-assertions` is `assertionStyle: "never"`,
 * `no-floating-promises` keeps `ignoreVoid: false`, and `return-await` keeps
 * `error-handling-correctness-only`.
 *
 * Not enabled, measured 2026-09-21:
 * - `no-unnecessary-condition` needs `noUncheckedIndexedAccess`, which is off;
 *   turning it on reports 914 type errors in `packages/core` alone, so the rule
 *   would read real index guards as dead code.
 * - `strict-boolean-expressions`: 3,751 findings. It bans `if (nullableObject)`,
 *   an idiom this tree treats as correct.
 * - `no-await-in-loop`: 1,984 findings. Sequential awaits are the intended order
 *   in most of them.
 * - `unicorn/consistent-function-scoping`: 639 findings, 566 of them in tests.
 *   Hoisting a test helper to module scope trades locality for nothing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { TEST_FILE } from "./rules/no-ambient-git-in-tests.ts";
import * as v from "valibot";
import { describeDiagnostic, lintJson } from "./shared/oxlint-json.ts";

const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

// The pin is the contract between the lockfile, the installed binary and every
// measurement taken with it. A range would let a release change rule behavior
// under a green tree.
assert.equal(
  packageJson.devDependencies["oxlint-tsgolint"],
  "7.0.2001",
  "oxlint-tsgolint must be pinned at the exact measured version",
);

// One switch for the type-aware layer, read from config so the CLI flag and
// the config file cannot disagree. `typeCheck` is deliberately absent: it
// would fold tsc's own diagnostics into the lint run and blur which gate
// caught a defect.
assert.equal(config.options?.typeAware, true, "typeAware must be on in config");
assert.equal(
  "typeCheck" in (config.options ?? {}),
  false,
  "typeCheck must be absent from options; compiler diagnostics belong to tsc",
);

// The 15 correctness rules oxlint-tsgolint@7.0.2001 marks both type-aware and
// default-on. The metadata comparison below fails when a release changes that set.
const defaultTypeAwareRules = [
  "typescript/await-thenable",
  "typescript/no-array-delete",
  "typescript/no-base-to-string",
  "typescript/no-duplicate-type-constituents",
  "typescript/no-floating-promises",
  "typescript/no-for-in-array",
  "typescript/no-implied-eval",
  "typescript/no-meaningless-void-operator",
  "typescript/no-misused-spread",
  "typescript/no-redundant-type-constituents",
  "typescript/no-unsafe-unary-minus",
  "typescript/no-useless-default-assignment",
  "typescript/require-array-sort-compare",
  "typescript/restrict-template-expressions",
  "typescript/unbound-method",
] as const;

assert.equal(defaultTypeAwareRules.length, 15, "the semantic default set must be 15 rules");

const RuleMetadataSchema = v.array(v.object({
  scope: v.string(),
  value: v.string(),
  category: v.string(),
  type_aware: v.boolean(),
  default: v.boolean(),
}));

const metadataRun = spawnSync(
  "./node_modules/.bin/oxlint",
  ["--type-aware", "--rules", "--format", "json"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
assert.equal(metadataRun.status, 0, `oxlint rule metadata failed:\n${metadataRun.stderr}`);
const metadata = v.parse(RuleMetadataSchema, JSON.parse(metadataRun.stdout));
const installedDefaults = metadata
  .filter((entry) =>
    entry.scope === "typescript"
    && entry.type_aware
    && entry.category === "correctness"
    && entry.default)
  .map((entry) => `${entry.scope}/${entry.value}`)
  .sort();
assert.deepEqual(
  installedDefaults,
  [...defaultTypeAwareRules].sort(),
  "the installed semantic default set must equal the 15 rules this gate governs by name",
);

// Everything the config turns on beyond the installed defaults. The expected
// enabled set is derived — defaults minus the measured exceptions, plus these —
// so a default that disappears from a future release cannot silently shrink
// what this gate demands.
const explicitAdditions = [
  "typescript/consistent-type-assertions",
  "typescript/no-inferrable-types",
  "typescript/no-non-null-assertion",
  "typescript/no-unnecessary-type-assertion",
  "typescript/no-unnecessary-type-parameters",
  "typescript/prefer-nullish-coalescing",
  "typescript/prefer-readonly",
  "typescript/return-await",
  "typescript/switch-exhaustiveness-check",
  "typescript/use-unknown-in-catch-callback-variable",
] as const;

// The defaults the header's measurements excuse, named once: they are subtracted
// from the expected enabled set and asserted as the whole of what is off, so a
// third rule cannot join them quietly and neither of these can carry no fixture
// while still being enabled.
const measuredExceptions = [
  "typescript/await-thenable",
  "typescript/no-implied-eval",
] as const;

const expectedEnabled = [
  ...installedDefaults.filter((name) => !measuredExceptions.some((excused) => excused === name)),
  ...explicitAdditions,
].sort();

const disabledDefaults = defaultTypeAwareRules.filter((name) => config.rules[name] === "off");
assert.deepEqual(
  disabledDefaults,
  [...measuredExceptions],
  "only the defaults the header measures may be off: await-thenable on bun-types, no-implied-eval on the executors that run model-written JavaScript",
);

const enabledTypeAware = Object.entries(config.rules)
  .filter(([name, setting]) => {
    if (!name.startsWith("typescript/")) return false;
    if (name === "typescript/no-explicit-any" || name === "typescript/ban-ts-comment") return false;
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return severity === "error" || severity === "warn";
  })
  .map(([name]) => name)
  .sort();

assert.deepEqual(
  enabledTypeAware,
  expectedEnabled,
  "the enabled set must match exactly: a rule added here needs a fixture, a rule dropped here needs this list changed",
);

assert.deepEqual(
  config.rules["typescript/consistent-type-assertions"],
  ["error", { assertionStyle: "never" }],
  "assertionStyle never: a type assertion is a claim the compiler cannot check, so product source carries none",
);

/**
 * Where a test drives the Worker entry or constructs a Durable Object class, the value it hands over
 * is typed by the vendor as a whole stub (`DurableObjectStub<UserDO>` has 249 required members,
 * `DurableObjectStub<KinuSandbox>` 112, `AgentContext` the platform state plus the SDK's; measured
 * 2026-09-22 with @cloudflare/workers-types and agents 0.3), and a recording double cannot satisfy
 * it without lying. Sixteen such sites remained after every narrowable parameter was narrowed
 * (`Pick<Env, …>`, `ObjectNamespace<Id, Pick<Class, …>>`, injected resolvers). So in TEST code the
 * governing rule is `require-safety-comment-for-type-assertion`: an assertion must state concrete
 * evidence, and the unverifiable classes (`any`, a caller-selected generic, raw JSON) stay refused
 * outright. The override's file set is the tree's one definition of a test file, asserted here so
 * the two cannot drift.
 */
const testOverride = config.overrides.find((entry: { rules: Record<string, unknown> }) =>
  "typescript/consistent-type-assertions" in entry.rules);
assert.deepEqual(
  testOverride?.rules,
  { "typescript/consistent-type-assertions": "off" },
  "the test override relaxes exactly the assertion-style rule and nothing else",
);
assert.deepEqual(
  testOverride?.files,
  ["**/tests/**", "**/test/**", "**/__tests__/**", "**/*.test.*", "**/*.eval.*", "**/*.spec.*"],
  "the override's file set is the directory arm and the suffix arm of TEST_FILE, spelled as globs",
);
for (const sample of ["packages/x/tests/helpers/a.ts", "packages/x/test/a.ts", "a/__tests__/b.ts", "src/a.test.ts", "tests/evals/a.eval.ts", "src/a.spec.tsx"]) {
  assert.ok(TEST_FILE.test(sample), `TEST_FILE must match the override's sample ${sample}`);
}
for (const sample of ["packages/x/src/contests/run.ts", "packages/x/src/latest/x.ts", "src/testing.ts"]) {
  assert.ok(!TEST_FILE.test(sample), `TEST_FILE must not match ${sample}, and neither does the override`);
}
assert.equal(
  config.rules["anti-slop/require-safety-comment-for-type-assertion"],
  "error",
  "the safety-comment rule is what governs an assertion in test code, so it must stay on",
);
assert.deepEqual(
  config.rules["typescript/no-floating-promises"],
  ["error", { ignoreVoid: false }],
  "no-floating-promises must reject both bare and void-discarded promises",
);
assert.deepEqual(
  config.rules["typescript/return-await"],
  ["error", "error-handling-correctness-only"],
  "return-await must stay at error-handling-correctness-only",
);
assert.equal(
  config.rules["typescript/use-unknown-in-catch-callback-variable"],
  "error",
  "Promise rejection callbacks must receive unknown values",
);

/** One rule, the minimal program that violates it, and the corrected form. */
type RuleFixture = {
  readonly rule: string;
  readonly findings: number;
  readonly red: string;
  readonly green: string;
};

const fixtures: readonly RuleFixture[] = [
  {
    rule: "consistent-type-assertions",
    findings: 1,
    red: `declare const value: string | number;

export const text = value as string;
`,
    green: `declare const value: string | number;

export const text = String(value);
`,
  },
  {
    rule: "no-array-delete",
    findings: 1,
    red: `declare const slots: Array<number | undefined>;

export function drop(): void {
  delete slots[0];
}
`,
    green: `declare const slots: Array<number | undefined>;

export function drop(): void {
  slots.splice(0, 1);
}
`,
  },
  {
    rule: "no-base-to-string",
    findings: 1,
    red: `declare const point: { readonly x: number };

export const label = String(point);
`,
    green: `declare const point: { readonly x: number };

export const label = String(point.x);
`,
  },
  {
    rule: "no-duplicate-type-constituents",
    findings: 1,
    red: `export type Mode = string | string;
`,
    green: `export type Mode = string | number;
`,
  },
  {
    rule: "no-floating-promises",
    findings: 2,
    red: `export function droppedPromises(): void {
  Promise.resolve();
  void Promise.resolve();
}
`,
    green: `export async function ownedPromises(): Promise<void> {
  await Promise.resolve();
}
`,
  },
  {
    rule: "no-for-in-array",
    findings: 1,
    red: `declare const names: readonly string[];

export function walk(): void {
  for (const index in names) {
    String(index);
  }
}
`,
    green: `declare const names: readonly string[];

export function walk(): void {
  for (const name of names) {
    String(name);
  }
}
`,
  },
  {
    rule: "no-inferrable-types",
    findings: 1,
    red: `export const retries: number = 3;
`,
    green: `export const retries = 3;
`,
  },
  {
    rule: "no-meaningless-void-operator",
    findings: 1,
    red: `declare function reset(): void;

export function go(): void {
  void reset();
}
`,
    green: `declare function reset(): void;

export function go(): void {
  reset();
}
`,
  },
  {
    rule: "no-misused-spread",
    findings: 1,
    red: `declare const counts: Map<string, number>;

export const copied = { ...counts };
`,
    green: `declare const counts: Map<string, number>;

export const copied = Object.fromEntries(counts);
`,
  },
  {
    rule: "no-non-null-assertion",
    findings: 1,
    red: `declare const label: string | undefined;

export const text = label!;
`,
    green: `declare const label: string | undefined;

export const text = label ?? "";
`,
  },
  {
    rule: "no-redundant-type-constituents",
    findings: 1,
    red: `export type Mode = string | never;
`,
    green: `export type Mode = string | number;
`,
  },
  {
    rule: "no-unnecessary-type-assertion",
    findings: 1,
    red: `declare const count: number;

export const same = count as number;
`,
    green: `declare const count: number;

export const same = count;
`,
  },
  {
    rule: "no-unnecessary-type-parameters",
    findings: 1,
    red: `export function firstLine<T extends readonly string[]>(lines: T): string | undefined {
  return lines[0];
}
`,
    green: `export function firstLine(lines: readonly string[]): string | undefined {
  return lines[0];
}
`,
  },
  {
    rule: "no-unsafe-unary-minus",
    findings: 1,
    red: `declare const measured: number | string;

export const negated = -measured;
`,
    green: `declare const measured: number;

export const negated = -measured;
`,
  },
  {
    rule: "no-useless-default-assignment",
    findings: 1,
    red: `declare const options: { readonly retries: number };

export function readRetries(): number {
  const { retries = 3 } = options;

  return retries;
}
`,
    green: `declare const options: { readonly retries: number };

export function readRetries(): number {
  const { retries } = options;

  return retries;
}
`,
  },
  {
    rule: "prefer-nullish-coalescing",
    findings: 1,
    red: `declare const label: string | undefined;

export const shown = label || "anonymous";
`,
    green: `declare const label: string | undefined;

export const shown = label ?? "anonymous";
`,
  },
  {
    rule: "prefer-readonly",
    findings: 1,
    red: `export class Holder {
  private total = 1;

  read(): number {
    return this.total;
  }
}
`,
    green: `export class Holder {
  private readonly total = 1;

  read(): number {
    return this.total;
  }
}
`,
  },
  {
    rule: "require-array-sort-compare",
    findings: 1,
    red: `declare const sizes: readonly number[];

export function sorted(): number[] {
  return [...sizes].sort();
}
`,
    green: `declare const sizes: readonly number[];

export function sorted(): number[] {
  return [...sizes].sort((left, right) => left - right);
}
`,
  },
  {
    rule: "restrict-template-expressions",
    findings: 1,
    red: `declare const point: { readonly x: number };

export const label = \`point \${point}\`;
`,
    green: `declare const point: { readonly x: number };

export const label = \`point \${point.x}\`;
`,
  },
  {
    rule: "return-await",
    findings: 1,
    red: `declare function closeDb(): void;
declare function work(): Promise<number>;

export async function withLocalWritableDb(): Promise<number> {
  try {
    return work();
  } finally {
    closeDb();
  }
}
`,
    green: `declare function closeDb(): void;
declare function work(): Promise<number>;

export async function withLocalWritableDb(): Promise<number> {
  try {
    return await work();
  } finally {
    closeDb();
  }
}
`,
  },
  {
    rule: "switch-exhaustiveness-check",
    findings: 1,
    red: `declare const mode: "read" | "write";

export function label(): string {
  switch (mode) {
    case "read":
      return "read";
  }

  return "unknown";
}
`,
    green: `declare const mode: "read" | "write";

export function label(): string {
  switch (mode) {
    case "read":
      return "read";
    case "write":
      return "write";
  }
}
`,
  },
  {
    rule: "unbound-method",
    findings: 1,
    red: `class Counter {
  count = 0;

  increment(): void {
    this.count += 1;
  }
}

declare const counter: Counter;

export const step = counter.increment;
`,
    green: `class Counter {
  count = 0;

  increment(): void {
    this.count += 1;
  }
}

declare const counter: Counter;

export const step = (): void => {
  counter.increment();
};
`,
  },
  {
    rule: "use-unknown-in-catch-callback-variable",
    findings: 2,
    red: `export const observedCatch = Promise.reject(new Error("failed"))
  .catch((reason) => String(reason));

export const observedThen = Promise.resolve()
  .then(() => undefined, (reason) => String(reason));
`,
    green: `export async function observed(): Promise<void> {
  try {
    await Promise.reject(new Error("failed"));
  } catch (reason) {
    String(reason);
  }
}
`,
  },
];

assert.deepEqual(
  fixtures.map((fixture) => `typescript/${fixture.rule}`).sort(),
  enabledTypeAware,
  "every enabled rule needs one red fixture and one green fixture here, and no fixture may outlive its rule",
);

const fixtureRoot = mkdtempSync(join(tmpdir(), "type-aware-gate-"));
try {
  const red = join(fixtureRoot, "red");
  const green = join(fixtureRoot, "green");
  mkdirSync(red);
  mkdirSync(green);
  // The semantic engine resolves types through this project, so a fixture that
  // does not typecheck would be measuring the parser instead of the rule.
  const tsconfig = JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["*.ts"],
  });
  writeFileSync(join(red, "tsconfig.json"), tsconfig);
  writeFileSync(join(green, "tsconfig.json"), tsconfig);
  for (const fixture of fixtures) {
    writeFileSync(join(red, `${fixture.rule}.ts`), fixture.red);
    writeFileSync(join(green, `${fixture.rule}.ts`), fixture.green);
  }

  const redReport = lintJson(["-c", ".oxlintrc.json", "--tsconfig", join(red, "tsconfig.json"), red]);
  assert.equal(redReport.number_of_files, fixtures.length, "every red fixture must be linted");
  for (const fixture of fixtures) {
    const fired = redReport.diagnostics.filter((entry) =>
      entry.code === `typescript(${fixture.rule})`
      && basename(entry.filename ?? "") === `${fixture.rule}.ts`);
    assert.equal(
      fired.length,
      fixture.findings,
      `${fixture.rule} must report ${fixture.findings} finding(s) on its own red fixture`,
    );
  }

  const greenReport = lintJson(["-c", ".oxlintrc.json", "--tsconfig", join(green, "tsconfig.json"), green]);
  assert.equal(greenReport.number_of_files, fixtures.length, "every green fixture must be linted");
  assert.deepEqual(
    greenReport.diagnostics
      .filter((entry) => (entry.code ?? "").startsWith("typescript("))
      .map(describeDiagnostic),
    [],
    "the corrected forms must draw no type-aware finding at all",
  );
  assert.deepEqual(
    greenReport.diagnostics.map(describeDiagnostic),
    [],
    "the corrected fixtures must satisfy the semantic rules and strict anti-slop rules together",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// The live tree is linted once, in live-tree.gate.test.ts, under this same config; these rules run
// there with every other rule, and an empty report is asserted there.
process.stdout.write(
  `type-aware: ${fixtures.length} enabled rules proven red-to-green; ${disabledDefaults.length} measured defaults left off (${disabledDefaults.join(", ")}). Blind spots: return-await governs only error-handling contexts; Promise ownership can still be semantically wrong while syntactically handled; rejection values must still be narrowed before member access; a fixture proves a rule fires, not that the tree is free of the defect.\n`,
);
