// Kinu-only gate: the ONE lint of the live tree that every other gate's claim
// about the live tree rests on.
//
// Four gates each ran `oxlint -c .oxlintrc.json -f json .` over the whole
// repository to make one assertion about it: no-ambient-git counted its live
// hits, import-extension its live hits and a file floor, typescript-escapes its
// measured-set equality and its parse census, type-aware the empty diagnostic
// list. Same binary, same config, same corpus, four spawns. Measured
// 2026-09-05 on the 24-thread box at load 2.3: 5.5 s to 6.0 s each, of a 22 s
// `test:anti-slop` and a 54 s commit tier. The tree is now linted here, once,
// and each of those gates keeps only what it can prove without the tree: its
// red->green fixtures and, for no-ambient-git and import-extension, the
// denominators it derives from `scripts/sources.ts`.
//
// What one run has to establish, and why an exit code cannot:
//
//   1. The set oxlint MEASURED equals the set this repository GOVERNS. The
//      governed set is the shared enumeration narrowed by the config's literal
//      ignore roots; the measured set is `oxlint --debug=files`, oxlint's own
//      pre-lint list. Equality by NAME, because a count can be met by a
//      thousand files that are not the ones the policy is about, and an
//      `ignorePatterns` expansion then fails naming the exact missing paths.
//   2. Every measured file was reported on. `number_of_files` in the report
//      equals the measured count, so a file oxlint listed and then skipped
//      cannot ride a clean report.
//   3. No diagnostic carries no rule name. A parse failure and an unused
//      disable directive both arrive codeless, and both mean oxlint applied no
//      rule inside that file. A backtick inside a SQL comment inside a
//      `sql.exec(\`...\`)` template literal in `packages/cf-backend/src/user/
//      schema.ts` rode exactly that shape on 2026-08-27.
//   4. The report is empty. `bun run lint` enforces the same through the exit
//      code of its plain `oxlint` run, which is the readable run a person fixes
//      from; this one is the run whose count a claim can cite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isParseable, trackedFiles } from "../../../scripts/sources.ts";
import { describeDiagnostic, lintJson } from "./shared/oxlint-json.ts";

const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));

/** The governed set: the shared enumeration, minus the config's literal ignore
 *  roots. A glob in `ignorePatterns` would make the governed set underivable
 *  here, so a non-literal root fails rather than being approximated. */
function governedSet(): readonly string[] {
  const ignoredRoots = config.ignorePatterns.map((pattern: unknown) => {
    assert.ok(typeof pattern === "string", "every ignore pattern must be a string");
    assert.match(
      pattern,
      /^[^*?[\]{}]+$/u,
      `ignore pattern ${JSON.stringify(pattern)} is not a literal root, so this gate cannot derive its governed source set exactly`,
    );
    return pattern;
  });
  const isIgnored = (file: string): boolean =>
    ignoredRoots.some((root: string) => file === root || file.startsWith(`${root}/`));
  return trackedFiles().filter(isParseable).filter((file) => !isIgnored(file)).sort();
}

/** The measured set: what oxlint lists before it lints. */
function measuredSet(): readonly string[] {
  const run = spawnSync(
    "./node_modules/.bin/oxlint",
    ["-c", ".oxlintrc.json", "--debug=files"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(run.status, 0, `oxlint could not enumerate its measured files:\n${run.stderr}`);
  const files = run.stdout.trimEnd().split("\n").filter((file) => file.length > 0).sort();
  assert.ok(files.length > 0, "oxlint measured no files, so a clean report would prove nothing");
  assert.deepEqual(
    [...new Set(files)],
    files,
    "oxlint listed a measured file more than once; exact set equality would otherwise hide duplicate work",
  );
  return files;
}

const governed = governedSet();
const measured = measuredSet();
assert.deepEqual(
  measured,
  governed,
  `oxlint's measured file set differs from the governed source set. Missing: ${governed.filter((file) => !measured.includes(file)).join(", ") || "none"}. Unexpected: ${measured.filter((file) => !governed.includes(file)).join(", ") || "none"}`,
);

const report = lintJson(["-c", ".oxlintrc.json", "."]);
assert.equal(
  report.number_of_files,
  measured.length,
  `oxlint listed ${measured.length} files before linting but reported ${report.number_of_files} afterward; the clean report may have skipped a measured file`,
);

const unnamed = report.diagnostics.filter((diagnostic) => diagnostic.code === undefined);
assert.deepEqual(
  unnamed.map(describeDiagnostic),
  [],
  `${unnamed.length} governed diagnostic(s) carry no rule name. Either a file failed to parse, so oxlint applied NO rule inside it and a clean result does not cover it, or a disable directive is present, which this repository forbids. Both are hard failures`,
);

assert.deepEqual(
  report.diagnostics.map(describeDiagnostic),
  [],
  `the live tree carries ${report.diagnostics.length} lint finding(s); \`oxlint\` prints each with its code frame`,
);

process.stdout.write(
  `live-tree: ${report.number_of_files} governed files linted once (measured set equals the enumeration by name), `
  + `${report.number_of_rules} rules, 0 diagnostics, 0 unparsed files, 0 disable directives. `
  + "Blind spots: files oxlint cannot parse are counted as governed only when the enumeration "
  + "calls them parseable, and `node_modules`, `dist`, the plugin directory and the committed "
  + "scanner bundle are outside both sets by the config's own ignore roots\n",
);
