// Kinu-only gate; see upstream.json's `kinuRules` and `kinuRuleGates`.
//
// `rules/require-runtime-import-extension.test.ts` proves the rule function behaves. Three things
// it cannot prove live here.
//
// 1. THE BOUNDARY IS THE MEASURED ONE. The rule declares a two-entry `RAW_NODE_MODULE` pattern and
//    `scripts/sources.ts` exposes it as `isRawNodeModule`, the same direction `TEST_FILE` already
//    travels — a gate asks the ONE enumeration rather than writing a path pattern of its own. This
//    file recomputes the transitive closure of modules reachable from the raw-Node entrypoints —
//    read out of `package.json`'s `test:anti-slop` and `.oxlintrc.json`'s `jsPlugins`, not listed
//    here — and asserts it equals exactly what the pattern matches. A new import out of the plugin
//    into a third file fails this naming that file, rather than silently widening the exception.
// 2. THE CENSUS IS ZERO AND THE DENOMINATOR IS NOT. Oxlint's `ignorePatterns` excludes the plugin
//    directory, so `bun run lint` never reaches the raw-Node half; a static scan over the whole
//    tracked tree is what governs it. The counts are asserted non-trivial, because a scan that read
//    nothing also finds no `.js`.
// 3. IT FIRES THROUGH THE REAL BINARY, both directions. Seeded fixtures under the real
//    `.oxlintrc.json`: red for the `.js` convention this repository shipped 3,325 times, red for a
//    `.ts` specifier under a bundler, and green for the corrected form of each.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { isParseable, isRawNodeModule, readMatching, trackedFiles } from "../../../scripts/sources.ts";

const repoRoot = process.cwd();

/** `oxlint -f json`. `code` is spelled `anti-slop(require-runtime-import-extension)`. */
type Diagnostic = { readonly code?: string; readonly filename?: string };
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};

const RULE = "require-runtime-import-extension";
const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"),
);

assert.deepEqual(
  [...manifest.kinuRuleGates["import-extension.gate.test.ts"]],
  [RULE],
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
assert.equal(
  config.rules[`anti-slop/${RULE}`],
  "error",
  `anti-slop/${RULE} must be enabled at error; a rule proven here but off in the config is silently dead`,
);

// ---------------------------------------------------------------------------
// 1. The raw-Node boundary, recomputed.
// ---------------------------------------------------------------------------

/**
 * Every module raw `node` is asked to load. Read out of the two places that actually invoke it —
 * the `test:anti-slop` script and the oxlint plugin specifier — because a list written here would
 * be a second answer to "what does Node load", free to disagree with the commands that run.
 *
 * `rules.test.ts` then dynamically imports every runnable suite under `rules/` via
 * `pathToFileURL`, which no static scan can see. Those are seeded from `trackedFiles()` filtered by
 * the same predicate that file uses, so this is the same answer rather than a second one.
 */
function rawNodeEntrypoints(): readonly string[] {
  const script: string = packageJson.scripts["test:anti-slop"];
  const invoked = [...script.matchAll(/--experimental-strip-types\s+(\S+\.ts)/gu)].map((m) => m[1]!);
  assert.ok(
    invoked.length > 0,
    "`test:anti-slop` invokes no `node --experimental-strip-types` target; the raw-Node regime would then be empty and this gate would certify nothing",
  );
  const plugins: readonly string[] = (config.jsPlugins ?? []).map(
    (plugin: { readonly specifier: string }) => plugin.specifier.replace(/^\.\//u, ""),
  );
  assert.ok(
    plugins.length > 0,
    ".oxlintrc.json declares no jsPlugins; the plugin entrypoint would then be outside the measured closure while oxlint still loads it",
  );
  const suites = trackedFiles().filter(
    (file) => file.startsWith("tools/oxlint/anti-slop/rules/") && file.endsWith(".test.ts"),
  );
  assert.ok(
    suites.length > 0,
    "no rule suite found under tools/oxlint/anti-slop/rules/; rules.test.ts imports them dynamically, so an empty set would leave every one of them unmeasured",
  );
  return [...new Set([...invoked, ...plugins, ...suites])];
}

const sourceText = readMatching(isParseable);

/**
 * Relative specifiers of one tracked file, for the closure walk only.
 *
 * A text scan, anchored to statement position, because this half of the tree is where the
 * RuleTester fixtures live: `code: "import { x } from './y'"` is a string, not an import, and an
 * unanchored scan reads eleven of them as edges. Anchoring plus the resolve filter below leaves the
 * walk an OVER-approximation at worst — a fixture that happens to name a real neighbouring file
 * adds a node and fails the boundary assertion loudly. It cannot silently drop an edge, which is
 * the direction that would matter.
 */
function relativeSpecifiers(file: string): readonly string[] {
  const text = sourceText.get(file);
  assert.ok(text !== undefined, `${file} is tracked and parseable but was not read`);
  const found = new Set<string>();
  for (const pattern of [
    // `[^;]` spans newlines, because an import clause may: `import {\n  A,\n} from "./x.ts"`.
    // Missing one of those dropped `shared/dictionary-types.ts` out of the measured closure.
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["'](\.[^"']*)["']/gmu,
    /^[ \t]*import\s+["'](\.[^"']*)["']/gmu,
  ]) {
    for (const match of text.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

const trackedSet = new Set(trackedFiles());

/** The repo-relative path a specifier names verbatim, before any resolver guessing. */
const verbatim = (from: string, specifier: string): string =>
  relative(repoRoot, resolve(repoRoot, dirname(from), specifier.split("?")[0]!));

/** What a specifier names on disk, under either regime's spelling. `null` when nothing does. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = verbatim(from, specifier);
  const stem = base.replace(/\.[cm]?[jt]sx?$/u, "");
  for (const candidate of [
    base,
    ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"].flatMap((ext) => [
      stem + ext,
      `${base}/index${ext}`,
    ]),
  ]) {
    if (trackedSet.has(candidate)) return candidate;
  }
  return null;
}

const closure = new Set<string>();
{
  const queue = [...rawNodeEntrypoints()];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (closure.has(file)) continue;
    closure.add(file);
    for (const specifier of relativeSpecifiers(file)) {
      const target = resolveSpecifier(file, specifier);
      if (target !== null && !closure.has(target)) queue.push(target);
    }
  }
}

const claimed = trackedFiles().filter((file) => isRawNodeModule(file));
assert.deepEqual(
  [...closure].sort(),
  [...claimed].sort(),
  "`isRawNodeModule` no longer matches the modules raw Node actually loads. Every file in the closure must keep explicit `.ts` specifiers, so a file entering or leaving it is a change to the rule's pattern and to this assertion — never a silent one. If the closure grew, ask whether the new import should exist before widening the exception.",
);
assert.ok(
  closure.size > 1,
  `the raw-Node closure measured ${closure.size} files; a closure of one is the entrypoint alone and means the walk followed no import`,
);

// ---------------------------------------------------------------------------
// 2 and 3. The live tree, and red -> green, both through the real oxlint binary.
// ---------------------------------------------------------------------------

function lintJson(args: readonly string[]): LintReport {
  const run = spawnSync("./node_modules/.bin/oxlint", ["-f", "json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(run.stdout.length > 0, `oxlint produced no JSON for \`${args.join(" ")}\`:\n${run.stderr}`);
  const report: LintReport = JSON.parse(run.stdout);
  assert.ok(
    report.number_of_rules > 0,
    `oxlint ran ${report.number_of_rules} rules; a lint with no rules loaded reports no findings`,
  );
  return report;
}

const firedIn = (diagnostics: readonly Diagnostic[], suffix: string): readonly Diagnostic[] =>
  diagnostics.filter(
    (d) => d.code === `anti-slop(${RULE})` && (d.filename ?? "").endsWith(suffix),
  );

/** The convention AGENTS.md mandated, and the corrected form of the same code. One `.js`
 *  specifier and one `.ts` specifier, because the rule has to be red in both directions: the
 *  extension that is always false, and the extension that is true only outside the closure. */
const cases: ReadonlyArray<{ readonly name: string; readonly bad: string; readonly good: string }> = [
  {
    name: "js-specifier",
    bad: 'import { helper } from "./helper.js";\nexport const use = (): unknown => helper;\n',
    good: 'import { helper } from "./helper";\nexport const use = (): unknown => helper;\n',
  },
  {
    name: "ts-specifier",
    bad: 'import { helper } from "./helper.ts";\nexport const use = (): unknown => helper;\n',
    good: 'import { helper } from "./helper";\nexport const use = (): unknown => helper;\n',
  },
];

const fixtures = mkdtempSync(join(tmpdir(), "kinu-scratch-import-extension-gate-"));
/** The raw-Node config lives with the fixtures. Absolute plugin paths keep
 *  Oxlint resolution anchored to this repository without writing into it. */
const rawNodeConfig = join(fixtures, "raw-node.oxlintrc.json");
try {
  // --- 2a. The bundled/Bun half: the whole tree, under the real config. -----
  const tree = lintJson(["-c", ".oxlintrc.json", "."]);
  assert.ok(
    tree.number_of_files > 1000,
    `oxlint linted ${tree.number_of_files} files of this repository; a repo-wide clean bill from a run that saw almost nothing is not evidence`,
  );
  assert.deepEqual(
    firedIn(tree.diagnostics, ".ts").map((d) => d.filename),
    [],
    "a relative specifier in the bundled/Bun half still names a file the loading runtime will not resolve",
  );

  // --- 2b. The raw-Node half, which `.oxlintrc.json` deliberately ignores. --
  // Oxlint never lints the plugin directory, so the enforcement there is Node itself: a bad
  // specifier throws ERR_MODULE_NOT_FOUND and `test:anti-slop` dies before reaching this file.
  // That is real but invisible in a passing run, and it says nothing about a `.ts` specifier that
  // resolves yet should not be there. This run says it out loud, over exactly the closure.
  writeFileSync(
    rawNodeConfig,
    JSON.stringify({
      jsPlugins: (config.jsPlugins ?? []).map((plugin: { readonly specifier: string }) => ({
        ...plugin,
        specifier: resolve(repoRoot, plugin.specifier),
      })),
      rules: { [`anti-slop/${RULE}`]: "error" },
      ignorePatterns: ["node_modules", "dist"],
    }),
  );
  const rawNode = lintJson(["-c", rawNodeConfig, ...closure]);
  assert.equal(
    rawNode.number_of_files,
    closure.size,
    `oxlint linted ${rawNode.number_of_files} of the ${closure.size} raw-Node modules; a run that skipped one certifies nothing about it`,
  );
  assert.deepEqual(
    firedIn(rawNode.diagnostics, ".ts").map((d) => `${d.filename}`),
    [],
    "a specifier inside the raw-Node closure is not a complete path; Node's ESM resolver will not find it",
  );

  // --- 3. Red -> green on seeded fixtures. ---------------------------------
  const red = join(fixtures, "red");
  const green = join(fixtures, "green");
  for (const directory of [red, green]) {
    mkdirSync(directory);
    writeFileSync(join(directory, "helper.ts"), "export const helper = 1;\n");
  }
  for (const { name, bad, good } of cases) {
    writeFileSync(join(red, `${name}.ts`), bad);
    writeFileSync(join(green, `${name}.ts`), good);
  }
  const seeded = (directory: string): readonly Diagnostic[] => {
    const report = lintJson(["-c", ".oxlintrc.json", directory]);
    assert.equal(
      report.number_of_files,
      cases.length + 1,
      `oxlint linted ${report.number_of_files} of ${cases.length + 1} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    return report.diagnostics;
  };
  const redDiagnostics = seeded(red);
  const greenDiagnostics = seeded(green);
  for (const { name } of cases) {
    assert.equal(
      firedIn(redDiagnostics, `${name}.ts`).length,
      1,
      `anti-slop/${RULE} fired ${firedIn(redDiagnostics, `${name}.ts`).length} times on the ${name} defect through \`oxlint -c .oxlintrc.json\`; expected exactly 1`,
    );
    assert.equal(
      firedIn(greenDiagnostics, `${name}.ts`).length,
      0,
      `anti-slop/${RULE} fires on the corrected ${name} form, so the cutover has no green state to reach`,
    );
  }

  process.stdout.write(
    `import-extension: ${cases.length} directions proven red->green through oxlint; clean over ${tree.number_of_files} bundled/Bun files and the ${closure.size}-file raw-Node closure\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(rawNodeConfig, { force: true });
}
