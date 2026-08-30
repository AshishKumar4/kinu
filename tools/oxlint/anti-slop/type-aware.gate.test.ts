/**
 * Type-aware linting gate. `oxlint-tsgolint` must be pinned at the exact
 * version the whole lint chain was measured against, `typeAware` must be the
 * one switch that turns the type-aware layer on (no `--type-check` — the
 * TypeScript compiler diagnostics belong to `tsc`, not to the linter), and the
 * 15 installed default type-aware correctness rules must all be explicitly
 * `off` so the default set is governed: a future oxlint release that flips a
 * new default on fails here instead of silently changing what the tree is
 * linted with. `typescript/return-await` is the only type-aware rule enabled,
 * and only at `error-handling-correctness-only`, so the rule catches the
 * `await` that swallows a rejection around a `try`/`finally` boundary and
 * stays silent on plain returns where `await` is stylistic.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

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
// default-on. Every one is explicitly off, so enabling the semantic engine does
// not add policy beside the one measured rule below. The metadata comparison
// fails when a release changes this set.
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

for (const name of defaultTypeAwareRules) {
  assert.equal(
    config.rules[name],
    "off",
    `${name} must be explicitly off; only return-await is enabled`,
  );
}

// The one enabled type-aware rule, and the one option value that keeps it
// pointed at error-handling correctness rather than style. The options matter
// as much as the severity: "always" would flag every plain `return await` and
// bury the rejection-swallowing case this rule exists for.
assert.deepEqual(
  config.rules["typescript/return-await"],
  ["error", "error-handling-correctness-only"],
  "return-await must be the only enabled type-aware rule, at error-handling-correctness-only",
);

// Nothing else in the rules block may be type-aware: a second enabled
// type-aware rule would be an unmeasured behavior change smuggled in beside
// the governed one.
const enabledTypeAware = Object.entries(config.rules)
  .filter(([name, setting]) => {
    if (!name.startsWith("typescript/")) return false;
    if (name === "typescript/no-explicit-any" || name === "typescript/ban-ts-comment" || name === "typescript/return-await") {
      return false;
    }
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return severity === "error" || severity === "warn";
  })
  .map(([name]) => name);

assert.deepEqual(
  enabledTypeAware,
  [],
  "no type-aware rule other than return-await may be enabled",
);

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
  "the installed semantic default set must equal the 15 explicitly governed off rules",
);

const DiagnosticSchema = v.object({
  code: v.optional(v.string()),
  filename: v.optional(v.string()),
  message: v.optional(v.string()),
});
const LintReportSchema = v.object({
  diagnostics: v.array(DiagnosticSchema),
  number_of_files: v.number(),
  number_of_rules: v.number(),
});

function lint(paths: readonly string[], tsconfig?: string) {
  const args = ["-c", ".oxlintrc.json", "-f", "json"];
  if (tsconfig !== undefined) args.push("--tsconfig", tsconfig);
  args.push(...paths);
  const run = spawnSync("./node_modules/.bin/oxlint", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(run.stdout.length > 0, `oxlint returned no JSON:\n${run.stderr}`);
  return v.parse(LintReportSchema, JSON.parse(run.stdout));
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "return-await-gate-"));
try {
  const red = join(fixtureRoot, "red");
  const green = join(fixtureRoot, "green");
  mkdirSync(red);
  mkdirSync(green);
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
  writeFileSync(join(red, "case.ts"), `declare function closeDb(): void;
declare function work(): Promise<number>;
export async function withLocalWritableDb(): Promise<number> {
  try {
    return work();
  } finally {
    closeDb();
  }
}
`);
  writeFileSync(join(green, "case.ts"), `declare function closeDb(): void;
declare function work(): Promise<number>;
export async function withLocalWritableDb(): Promise<number> {
  try {
    return await work();
  } finally {
    closeDb();
  }
}
export async function plainReturn(): Promise<number> {
  return work();
}
`);

  const redReport = lint([red], join(red, "tsconfig.json"));
  const redFindings = redReport.diagnostics.filter((entry) =>
    entry.code === "typescript(return-await)");
  assert.equal(redReport.number_of_files, 1, "red fixture must lint exactly one file");
  assert.equal(redFindings.length, 1, "returning a promise through finally must turn the gate red");

  const greenReport = lint([green], join(green, "tsconfig.json"));
  const greenFindings = greenReport.diagnostics.filter((entry) =>
    entry.code === "typescript(return-await)");
  assert.equal(greenReport.number_of_files, 1, "green fixture must lint exactly one file");
  assert.deepEqual(greenFindings, [], "return await fixes the error path; a plain return stays valid");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const repository = lint(["."]);
assert.ok(repository.number_of_files > 0, "return-await measured no repository files");
assert.ok(repository.number_of_rules > 0, "return-await loaded no lint rules");
assert.deepEqual(
  repository.diagnostics.filter((entry) => entry.code === "typescript(return-await)"),
  [],
  "the active return-await policy has live findings",
);

console.log(
  `type-aware: return-await proven red-to-green; ${installedDefaults.length} default type-aware correctness rules explicitly off; ${repository.number_of_files} live files clean. Blind spots: the selected mode governs only returns whose await changes local error handling; plain promise returns remain outside this policy.`,
);
