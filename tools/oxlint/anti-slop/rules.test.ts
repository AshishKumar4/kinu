import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ANTI_SLOP_RULES, isAntiSlopRuleSuite, trackedFiles } from "../../../scripts/sources.ts";

const rulesDirectory = join(process.cwd(), ANTI_SLOP_RULES);

// From the ONE enumeration, narrowed by the predicate `sources.ts` exports — not
// a `readdirSync` and not a `startsWith` of its own. A second walk is a second
// answer to "which rule suites exist", and this one would have counted a stray
// editor temp file or a build artefact as a suite while the lint that governs the
// directory ignores both. The predicate is shared with `scripts/ladder.test.ts`,
// which holds the 41 suites here equal to the 12 the command line names plus the
// set this loop imports: the two consumers cannot disagree about which files this
// runner reaches.
const suites = trackedFiles()
  .filter(isAntiSlopRuleSuite)
  .map((file) => file.slice(ANTI_SLOP_RULES.length))
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
