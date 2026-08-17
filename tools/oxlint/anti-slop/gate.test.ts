import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import antiSlopPlugin from "./index.ts";

const expectedRules = [
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-shape-in-symbol-names",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-safety-comment-for-type-assertion",
];

const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const pluginPackage = JSON.parse(
  readFileSync("tools/oxlint/anti-slop/package.json", "utf8"),
);
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const agentGuide = readFileSync("AGENTS.md", "utf8");

assert.deepEqual(
  Object.keys(config.rules).filter((name) => name.startsWith("anti-slop/")).sort(),
  [...expectedRules].sort(),
  "every anti-slop rule must remain enabled",
);

// Four-way equality. A rule file with no index.ts registration is dead; a registration with no
// .oxlintrc entry is registered and silently off; a rule with no suite is untested. Each set is
// asserted non-empty so an empty glob cannot report perfect agreement.
const pluginDirectory = "tools/oxlint/anti-slop";
const ruleEntries = readdirSync(join(pluginDirectory, "rules"));
const ruleFiles = ruleEntries
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => `anti-slop/${entry.slice(0, -".ts".length)}`)
  .sort();
const registeredRules = Object.keys(antiSlopPlugin.rules ?? {})
  .map((rule) => `anti-slop/${rule}`)
  .sort();
const testedRules = expectedRules.filter((name) =>
  ruleEntries.some((entry) => entry.startsWith(`${name.slice("anti-slop/".length)}.`) && entry.endsWith(".test.ts")),
);

assert.ok(ruleFiles.length > 0, "no rule source files found");
assert.ok(registeredRules.length > 0, "the plugin registered no rules");
assert.deepEqual(ruleFiles, [...expectedRules].sort(), "every rule file must be an expected rule");
assert.deepEqual(registeredRules, [...expectedRules].sort(), "every rule must be registered in index.ts");
assert.deepEqual([...testedRules].sort(), [...expectedRules].sort(), "every rule must own a suite");

for (const name of expectedRules) {
  const setting = config.rules[name];
  const severity = Array.isArray(setting) ? setting[0] : setting;
  assert.equal(severity, "error", `${name} must remain an error`);
}

assert.equal(config.rules["anti-slop/no-runtime-typeof"], "error");
assert.deepEqual(config.ignorePatterns, ["node_modules", "dist", "tools/oxlint/anti-slop"]);
assert.equal(config.options?.denyWarnings, true);
assert.equal(config.options?.reportUnusedDisableDirectives, "error");

assert.equal(packageJson.devDependencies.oxlint, packageJson.devDependencies["@oxlint/plugins"]);
assert.equal(packageJson.devDependencies.oxlint, "1.78.0");
assert.equal(pluginPackage.private, true);
assert.equal(pluginPackage.type, "module");
assert.match(packageJson.scripts["test:anti-slop"], /tsc --noEmit -p tools\/oxlint\/anti-slop/u);
assert.match(packageJson.scripts["test:anti-slop"], /anti-slop\/rules\.test\.ts/u);
assert.match(packageJson.scripts["test:anti-slop"], /anti-slop\/drift\.test\.ts/u);
assert.match(packageJson.scripts["test:anti-slop"], /gate\.test\.ts/u);
assert.match(packageJson.scripts.lint, /^bun run test:anti-slop && oxlint$/u);
assert.match(packageJson.scripts.check, /^bun run lint && /u);
assert.doesNotMatch(packageJson.scripts.lint, /--quiet|--allow|--fix|baseline/u);

// The strict gate must provably run in CI. ci.yml no longer enumerates commands — it delegates to
// the ladder — so read the property through the ladder instead of grepping ci.yml for a literal.
// Both halves are needed: CI runs the ci tier, and the ci tier claims `bun run check`.
const ladder = readFileSync("scripts/ladder.ts", "utf8");
assert.match(ci, /run: bun scripts\/ladder\.ts --tier=ci/u, "CI must run the ladder's ci tier");
assert.match(
  ladder,
  /run: 'bun run check',\s*\n\s*tier: '(?:commit|push|ci)',/u,
  "the ladder must claim `bun run check` at or before the ci tier",
);
assert.match(agentGuide, /bun run lint\s+# strict Oxlint/u);
assert.doesNotMatch(agentGuide, /No lint command configured/u);

function isForbiddenLintDirective(line: string): boolean {
  const directive = line.match(
    /(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s+(?<rules>[^\n]*))?/u,
  );
  if (directive === null) return false;
  const rules = (directive.groups?.rules ?? "").split("--", 1)[0]?.trim() ?? "";
  if (rules.length === 0) return true;
  return rules.split(/[\s,]+/u).some((rule) => rule.startsWith("anti-slop/"));
}

assert.equal(isForbiddenLintDirective("// oxlint-disable"), true);
assert.equal(
  isForbiddenLintDirective("// eslint-disable-next-line anti-slop/no-runtime-typeof"),
  true,
);
assert.equal(
  isForbiddenLintDirective("// eslint-disable-next-line react-hooks/exhaustive-deps"),
  false,
);

const listedFiles = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
assert.equal(listedFiles.status, 0, listedFiles.stderr);
const forbiddenDirectives: string[] = [];
for (const filename of listedFiles.stdout.split("\0")) {
  if (
    filename.length === 0 ||
    !existsSync(filename) ||
    filename.startsWith("tools/oxlint/anti-slop/") ||
    !/\.[cm]?[jt]sx?$/u.test(filename)
  ) {
    continue;
  }
  for (const [index, line] of readFileSync(filename, "utf8").split("\n").entries()) {
    if (isForbiddenLintDirective(line)) {
      forbiddenDirectives.push(`${filename}:${index + 1}:${line.trim()}`);
    }
  }
}
assert.deepEqual(
  forbiddenDirectives,
  [],
  "blanket and anti-slop-specific lint suppressions are forbidden",
);
