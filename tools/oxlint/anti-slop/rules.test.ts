import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isRunnableSuite, trackedFiles } from "../../../scripts/sources.ts";

const RULES = "tools/oxlint/anti-slop/rules/";
const rulesDirectory = join(process.cwd(), RULES);

// From the ONE enumeration, filtered — not a `readdirSync` of its own. A second
// walk is a second answer to "which rule suites exist", and this one would have
// counted a stray editor temp file or a build artefact as a suite while the lint
// that governs the directory ignores both.
const suites = trackedFiles()
  .filter((file) => file.startsWith(RULES) && isRunnableSuite(file))
  .map((file) => file.slice(RULES.length))
  .sort();

assert.ok(
  suites.length > 0,
  `no rule suites found under ${rulesDirectory}; a suite runner that runs nothing is not a passing gate`,
);

// Discovered, not listed: a static list of suites is a hardcoded denominator that silently stops
// covering a rule the moment one is added. gate.test.ts asserts the discovered set matches the
// registered rules, so an undiscovered suite cannot pass unnoticed.
for (const suite of suites) {
  await import(pathToFileURL(join(rulesDirectory, suite)).href);
}

process.stdout.write(`anti-slop: ${suites.length} rule suites passed\n`);
