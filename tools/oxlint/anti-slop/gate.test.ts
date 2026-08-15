import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

for (const name of expectedRules) {
  const setting = config.rules[name];
  const severity = Array.isArray(setting) ? setting[0] : setting;
  assert.equal(severity, "error", `${name} must remain an error`);
}

assert.deepEqual(config.rules["anti-slop/no-runtime-typeof"], [
  "error",
  { allowInTypeGuards: true },
]);
assert.deepEqual(config.ignorePatterns, ["node_modules", "dist", "tools/oxlint/anti-slop"]);
assert.equal(config.options?.denyWarnings, true);
assert.equal(config.options?.reportUnusedDisableDirectives, "error");

assert.equal(packageJson.devDependencies.oxlint, packageJson.devDependencies["@oxlint/plugins"]);
assert.equal(packageJson.devDependencies.oxlint, "1.78.0");
assert.equal(pluginPackage.private, true);
assert.equal(pluginPackage.type, "module");
assert.match(packageJson.scripts["test:anti-slop"], /tsc --noEmit -p tools\/oxlint\/anti-slop/u);
assert.match(packageJson.scripts["test:anti-slop"], /rules\/rules\.test\.ts/u);
assert.match(packageJson.scripts["test:anti-slop"], /gate\.test\.ts/u);
assert.match(packageJson.scripts.lint, /^bun run test:anti-slop && oxlint$/u);
assert.match(packageJson.scripts.check, /^bun run lint && /u);
assert.doesNotMatch(packageJson.scripts.lint, /--quiet|--allow|--fix|baseline/u);

assert.match(ci, /run: bun run check/u);
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
