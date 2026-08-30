import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import antiSlopPlugin from "./index.ts";
import { isParseable, isRunnableSuite, readRepositoryFile, trackedFiles } from "../../../scripts/sources.ts";

const expectedRules = [
  "anti-slop/no-ambient-git-in-tests",
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-copy-rpc-stub",
  "anti-slop/no-ddl-in-catch",
  "anti-slop/no-empty-catch",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-sentinel-catch",
  "anti-slop/no-shape-in-symbol-names",
  "anti-slop/no-unaccounted-catch",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-untyped-console",
  "anti-slop/no-wait-until-in-durable-object",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-cause-on-rethrow",
  "anti-slop/require-runtime-import-extension",
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
const ruleEntries = trackedFiles()
  .filter((file) => file.startsWith(`${pluginDirectory}/rules/`))
  .map((file) => file.slice(`${pluginDirectory}/rules/`.length));
const ruleFiles = ruleEntries
  .filter((entry) => isParseable(entry) && !isRunnableSuite(entry))
  .map((entry) => `anti-slop/${entry.slice(0, -".ts".length)}`)
  .sort();
const registeredRules = Object.keys(antiSlopPlugin.rules ?? {})
  .map((rule) => `anti-slop/${rule}`)
  .sort();
const testedRules = expectedRules.filter((name) =>
  ruleEntries.some((entry) =>
    entry.startsWith(`${name.slice("anti-slop/".length)}.`) && isRunnableSuite(entry)),
);

assert.ok(ruleFiles.length > 0, "no rule source files found");
assert.ok(registeredRules.length > 0, "the plugin registered no rules");
assert.deepEqual(ruleFiles, [...expectedRules].sort(), "every rule file must be an expected rule");
assert.deepEqual(registeredRules, [...expectedRules].sort(), "every rule must be registered in index.ts");
assert.deepEqual([...testedRules].sort(), [...expectedRules].sort(), "every rule must own a suite");

// Value mapping extends the four-way key equality above. A registry value can point at a
// sibling rule and leave every key set equal, so parse index.ts itself: each property key must
// resolve to an import whose rule-module basename is that key. The module path is authoritative,
// not the symbol spelling — no-shape-in-symbol-names intentionally uses
// noForbiddenTermInSymbolNamesRule from ./rules/no-shape-in-symbol-names.ts.
type RegistryEntry = readonly [key: string, symbol: string];

function parseRuleRegistry(source: string): {
  readonly importModuleBySymbol: ReadonlyMap<string, string>;
  readonly entries: readonly RegistryEntry[];
} {
  const importModuleBySymbol = new Map<string, string>();
  for (const match of source.matchAll(
    /^import \{ (\w+) \} from "\.\/rules\/([a-z0-9-]+)\.ts";$/gmu,
  )) {
    const symbol = match[1]!;
    assert.ok(
      !importModuleBySymbol.has(symbol),
      `index.ts imports ${JSON.stringify(symbol)} from more than one rule module`,
    );
    importModuleBySymbol.set(symbol, match[2]!);
  }

  const entries: RegistryEntry[] = [];
  let inRules = false;
  let closedRules = false;
  for (const line of source.split("\n")) {
    if (line === "\trules: {") {
      assert.equal(inRules, false, "index.ts declares more than one rules registry");
      inRules = true;
      continue;
    }
    if (!inRules) continue;
    if (line === "\t},") {
      closedRules = true;
      break;
    }
    const match = line.match(/^\t\t"([a-z0-9-]+)": (\w+),$/u);
    if (match !== null) entries.push([match[1]!, match[2]!]);
  }
  assert.ok(inRules, "index.ts declares no rules registry");
  assert.ok(closedRules, "index.ts does not close its rules registry");
  return { importModuleBySymbol, entries };
}

function registryValueMappingFindings(
  importModuleBySymbol: ReadonlyMap<string, string>,
  entries: readonly RegistryEntry[],
): readonly string[] {
  return entries.flatMap(([key, symbol]) => {
    const module = importModuleBySymbol.get(symbol);
    if (module === undefined) {
      return [`${key}: ${symbol} is not imported from ./rules/${key}.ts`];
    }
    return module === key
      ? []
      : [`${key}: ${symbol} is imported from ./rules/${module}.ts, not ./rules/${key}.ts`];
  });
}

const indexRegistry = parseRuleRegistry(
  readRepositoryFile(process.cwd(), `${pluginDirectory}/index.ts`),
);
assert.equal(
  indexRegistry.entries.length,
  expectedRules.length,
  "the parsed registry must carry every expected value",
);
assert.deepEqual(
  indexRegistry.entries.map(([key]) => `anti-slop/${key}`).sort(),
  registeredRules,
  "the parsed index.ts registry must cover every runtime registration",
);
assert.deepEqual(
  [...indexRegistry.importModuleBySymbol.values()]
    .map((module) => `anti-slop/${module}`)
    .sort(),
  registeredRules,
  "every registered key must have one imported rule module",
);
assert.deepEqual(
  registryValueMappingFindings(indexRegistry.importModuleBySymbol, indexRegistry.entries),
  [],
  "every registry value must resolve to the rule module its key names",
);

// Self-test: give no-reflect-apply the value from its adjacent no-reflect-get entry. Only the
// sabotaged mapping should fail; a key-only gate would report green here.
const sabotageIndex = indexRegistry.entries.findIndex(([key]) => key === "no-reflect-apply");
assert.ok(sabotageIndex >= 0, "the mapping self-test key is missing from index.ts");
const adjacentMapping = indexRegistry.entries[sabotageIndex + 1];
assert.ok(adjacentMapping !== undefined, "the mapping self-test needs an adjacent registry entry");
assert.equal(adjacentMapping[0], "no-reflect-get", "the mapping self-test entries must stay adjacent");
const sabotagedMapping = indexRegistry.entries[sabotageIndex];
assert.ok(sabotagedMapping !== undefined, "the mapping self-test cannot copy a missing entry");
const sabotagedEntries = [...indexRegistry.entries];
sabotagedEntries[sabotageIndex] = [sabotagedMapping[0], adjacentMapping[1]];
assert.deepEqual(
  registryValueMappingFindings(indexRegistry.importModuleBySymbol, sabotagedEntries),
  [
    `${sabotagedMapping[0]}: ${adjacentMapping[1]} is imported from ./rules/${adjacentMapping[0]}.ts, not ./rules/${sabotagedMapping[0]}.ts`,
  ],
  "sabotaging one adjacent registry value mapping must fail exactly once",
);

for (const name of expectedRules) {
  const setting = config.rules[name];
  const severity = Array.isArray(setting) ? setting[0] : setting;
  assert.equal(severity, "error", `${name} must remain an error`);
}

assert.equal(config.rules["anti-slop/no-runtime-typeof"], "error");
assert.deepEqual(config.ignorePatterns, ["node_modules", "dist", "tools/oxlint/anti-slop"]);
assert.equal(config.options?.denyWarnings, true);
assert.equal(config.options?.reportUnusedDisableDirectives, "error");

// KINU-069. These two are oxlint BUILT-INS, so they own no rule file, no suite and no entry in
// `expectedRules`; their whole existence is this config. That makes them the one kind of rule that
// can be deleted without leaving a trace anywhere else, so the policy is pinned here as well as
// behaviourally in typescript-escapes.gate.test.ts. The options matter as much as the severity:
// `ignoreRestArgs` would re-admit the `(...args: any[])` wrapper this ticket removed, and
// ban-ts-comment's own default of "allow-with-description" would re-admit the described
// `@ts-expect-error` it removed.
assert.equal(config.rules["typescript/no-explicit-any"], "error");
assert.deepEqual(
  config.rules["typescript/ban-ts-comment"],
  ["error", { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true }],
  "all three suppression directives must be banned outright",
);

assert.equal(packageJson.devDependencies.oxlint, packageJson.devDependencies["@oxlint/plugins"]);
assert.equal(packageJson.devDependencies.oxlint, "1.78.0");
assert.equal(pluginPackage.private, true);
assert.equal(pluginPackage.type, "module");
assert.match(packageJson.scripts["test:anti-slop"], /tsc --noEmit -p tools\/oxlint\/anti-slop/u);
assert.match(packageJson.scripts["test:anti-slop"], /anti-slop\/rules\.test\.ts/u);
assert.match(packageJson.scripts["test:anti-slop"], /anti-slop\/drift\.test\.ts/u);
/**
 * Parse the restricted `&&` command chain we deliberately use for gate runners.
 * The parser understands shell quotes and escapes, but refuses other operators:
 * a conditional branch or pipeline would mean a gate could be textually present
 * without being reached by the mandatory sequence.
 */
function commandTokens(script: string): readonly (readonly string[])[] {
  const commands: string[][] = [];
  let command: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  const finishToken = (): void => {
    if (token.length > 0) command.push(token);
    token = "";
  };
  const finishCommand = (): void => {
    finishToken();
    assert.ok(command.length > 0, "test:anti-slop has an empty command");
    commands.push(command);
    command = [];
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      finishToken();
      continue;
    }
    if (char === "&" && script[index + 1] === "&") {
      finishCommand();
      index += 1;
      continue;
    }
    assert.ok(
      !["#", ";", "|", "(", ")", "<", ">", "`"].includes(char),
      `test:anti-slop uses unsupported shell syntax ${JSON.stringify(char)}; gate reachability must be an unconditional && chain`,
    );
    assert.ok(
      char !== "&",
      "test:anti-slop uses a background shell operator; the gate sequence must wait for every command",
    );
    token += char;
  }
  assert.equal(quote, undefined, "test:anti-slop has an unclosed shell quote");
  assert.equal(escaped, false, "test:anti-slop ends with a shell escape");
  finishCommand();
  return commands;
}

const gateFiles = trackedFiles()
  .filter((file) => file.startsWith(`${pluginDirectory}/`) && file.endsWith(".gate.test.ts"))
  .map((file) => file.slice(`${pluginDirectory}/`.length))
  .sort();
assert.ok(gateFiles.length > 0, "no *.gate.test.ts found, so this enumeration proves nothing");
const antiSlopCommands = commandTokens(packageJson.scripts["test:anti-slop"]);
function runsNodeGate(tokens: readonly string[], program: string): boolean {
  if (tokens[0] !== "node" || tokens.at(-1) !== program) return false;
  // Model exactly the flags the repository runner permits. In particular, an
  // `--eval` or `--print` token would make the final path an argv value rather
  // than an executed module while still satisfying a mere token-membership check.
  return tokens.slice(1, -1).every((token) =>
    ["--no-warnings", "--experimental-strip-types"].includes(token));
}

assert.throws(
  () => commandTokens("node gate.test.ts # && node hidden.gate.test.ts"),
  /unsupported shell syntax/u,
  "an unquoted shell comment must not let a hidden gate look reachable",
);
assert.equal(
  runsNodeGate(["node", "-e", "", "gate.test.ts"], "gate.test.ts"),
  false,
  "a Node eval body must not treat a trailing argv value as an executed gate",
);
assert.equal(
  runsNodeGate(["node", "--no-warnings", "--experimental-strip-types", "gate.test.ts"], "gate.test.ts"),
  true,
  "the runner's supported Node flags must still reach its final gate module",
);

const gatePrograms = gateFiles.map((gate) => `${pluginDirectory}/${gate}`);
for (const program of gatePrograms) {
  assert.ok(
    antiSlopCommands.some((tokens) => runsNodeGate(tokens, program)),
    `${program} is not the executed final module of an unconditional supported node command in test:anti-slop`,
  );
}
// NODE_OPTIONS is load-bearing, not decoration: oxlint spawns `node` to load this
// plugin, and official Node 22 only strips `.ts` types behind the flag. The pin
// stays exact so any other change to the lint invocation still fails here.
assert.match(packageJson.scripts.lint, /^bun run test:anti-slop && NODE_OPTIONS=--experimental-strip-types oxlint$/u);
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

// From the ONE enumeration, read through the ONE reader. This was `git ls-files --cached --others
// --exclude-standard -z` plus a local `existsSync` filter and a local
// `/\.[cm]?[jt]sx?$/` — three things `scripts/sources.ts` already does for every
// gate, spelled a second time here where they were free to drift from it.
//
// `readRepositoryFile` and not `readFileSync`: the enumeration deliberately keeps a tracked path
// whose working-tree copy is gone, because the index blob is what a push publishes. Reading from
// disk instead threw ENOENT on any tree with an unstaged deletion — a crash, not a finding, in the
// gate that is supposed to be the authority on suppressions.
const forbiddenDirectives: string[] = [];
for (const filename of trackedFiles()) {
  if (filename.startsWith(`${pluginDirectory}/`) || !isParseable(filename)) continue;
  for (const [index, line] of readRepositoryFile(process.cwd(), filename).split("\n").entries()) {
    if (isForbiddenLintDirective(line)) {
      forbiddenDirectives.push(`${filename}:${index + 1}:${line.trim()}`);
    }
  }
}
assert.ok(
  forbiddenDirectives.length > 0 || trackedFiles().filter(isParseable).length > 100,
  "no parseable file was read at all, so finding zero suppressions means nothing",
);
assert.deepEqual(
  forbiddenDirectives,
  [],
  "blanket and anti-slop-specific lint suppressions are forbidden",
);

process.stdout.write(
  `anti-slop: registry-value mapping equality (${indexRegistry.entries.length}/${expectedRules.length})\n`,
);
