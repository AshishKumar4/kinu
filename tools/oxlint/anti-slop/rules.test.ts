import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const rulesDirectory = join(import.meta.dirname, "rules");
const suites = readdirSync(rulesDirectory)
  .filter((entry) => entry.endsWith(".test.ts"))
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
