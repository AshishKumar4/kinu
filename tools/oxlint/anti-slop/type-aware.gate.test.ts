/**
 * Type-aware linting gate. `oxlint-tsgolint` stays pinned to the version this
 * policy measured. `typeAware` is the only semantic-engine switch; `typeCheck`
 * stays absent because compiler diagnostics belong to `tsc`.
 *
 * The installed default semantic set is derived from Oxlint metadata. Fourteen
 * default rules stay explicitly off. Three measured rules are active:
 * `no-floating-promises`, `return-await`, and
 * `use-unknown-in-catch-callback-variable`. The fixtures pin each rule's strict
 * option and a corrected form of the same failure.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { lintJson } from "./shared/oxlint-json.ts";

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
// default-on. Fourteen remain explicitly off. `no-floating-promises` is enabled
// below with its strict option. The metadata comparison fails when a release
// changes the default set.
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
  if (name === "typescript/no-floating-promises") continue;
  assert.equal(
    config.rules[name],
    "off",
    `${name} must be explicitly off; only the three measured semantic rules are enabled`,
  );
}

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

// Nothing else in the TypeScript rule block may add semantic policy. The two
// existing syntax rules are excluded because they do not use type information.
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
  [
    "typescript/no-floating-promises",
    "typescript/return-await",
    "typescript/use-unknown-in-catch-callback-variable",
  ],
  "only the three measured semantic rules may be enabled",
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
export function droppedPromises(): void {
  Promise.resolve();
  void Promise.resolve();
}
export const observedCatch = Promise.reject(new Error("failed"))
  .catch((reason) => String(reason));
export const observedThen = Promise.resolve()
  .then(() => undefined, (reason) => String(reason));
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
export async function ownedPromises(): Promise<void> {
  await Promise.resolve();
  try {
    await Promise.reject(new Error("failed"));
  } catch (reason) {
    String(reason);
  }
}
export async function plainReturn(): Promise<number> {
  return work();
}
`);

  const redReport = lintJson(["-c", ".oxlintrc.json", "--tsconfig", join(red, "tsconfig.json"), red]);
  const redReturnAwait = redReport.diagnostics.filter((entry) =>
    entry.code === "typescript(return-await)");
  const redFloating = redReport.diagnostics.filter((entry) =>
    entry.code === "typescript(no-floating-promises)");
  const redUnknown = redReport.diagnostics.filter((entry) =>
    entry.code === "typescript(use-unknown-in-catch-callback-variable)");
  assert.equal(redReport.number_of_files, 1, "red fixture must lint exactly one file");
  assert.equal(redReturnAwait.length, 1, "returning a promise through finally must turn the gate red");
  assert.equal(redFloating.length, 2, "both bare and void-discarded promises must turn the gate red");
  assert.equal(redUnknown.length, 2, "both catch and then rejection callbacks must turn the gate red");

  const greenReport = lintJson(["-c", ".oxlintrc.json", "--tsconfig", join(green, "tsconfig.json"), green]);
  assert.equal(greenReport.number_of_files, 1, "green fixture must lint exactly one file");
  assert.deepEqual(
    greenReport.diagnostics,
    [],
    "the corrected fixture must satisfy the semantic rules and strict anti-slop rules together",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// The live tree is linted once, in live-tree.gate.test.ts, under this same config; the three
// semantic rules run there with every other rule, and an empty report is asserted there.
process.stdout.write(
  `type-aware: 3 semantic rules proven red-to-green; ${installedDefaults.length - 1} default type-aware correctness rules explicitly off. Blind spots: return-await governs only error-handling contexts; Promise ownership can still be semantically wrong while syntactically handled; rejection values must still be narrowed before member access.\n`,
);
