// Kinu-only gate over an oxlint BUILT-IN policy (`no-restricted-imports`), in the shape of
// typescript-escapes.gate.test.ts: the rule carries no rule file and no `upstream.json` entry,
// so what needs proving is the POLICY in `.oxlintrc.json` and that it fires on the shape it bans.
//
// The shape: an import specifier that walks into `node_modules` by path —
// `'../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js'`. It resolves at build
// time, typechecks, and is invisible to every gate that reads the export map, which is how one
// lived in `packages/cf-backend/src/nimbus-programmatic.ts` from the day `@nimbus-sh/worker` was
// adopted until 2026-09-19. A dependency is used through what it exports; when it exports no
// subpath for a need, the export map is PATCHED under `patches/` and the patch says why. Reaching
// around the map is the one thing that never gets to be the answer, because it pins a file layout
// the publisher never promised and evades `gate:patch-parity`, which measures declared patches.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintJson, type LintDiagnostic } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();

const RULE = "no-restricted-imports";

/** Each red case is one way of spelling the reach; each green case is the same need met through
 *  an export map. Static, dynamic and type-only imports are separate cases because oxlint
 *  reports each through a different node and a policy that caught one could miss another. */
const cases: ReadonlyArray<{ readonly file: string; readonly bad: string; readonly good: string }> = [
  {
    file: "static-value",
    bad: `import { rpcExec } from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

export const exec = rpcExec;
`,
    good: `import { rpcExec } from '@nimbus-sh/worker/programmatic';

export const exec = rpcExec;
`,
  },
  {
    file: "static-type",
    bad: `import type { ProgrammaticHost } from '../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

export type Host = ProgrammaticHost;
`,
    good: `import type { ProgrammaticHost } from '@nimbus-sh/worker/programmatic';

export type Host = ProgrammaticHost;
`,
  },
  {
    file: "dynamic",
    bad: `export const load = () => import('../node_modules/@nimbus-sh/worker/dist/runtime/facet-loader-host.js');
`,
    good: `export const load = () => import('@nimbus-sh/worker/facet-host');
`,
  },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));

// Declaration half. The pattern is the whole policy: a group narrower than `**/node_modules/**`
// (one package, one depth) would re-admit the next reach, so the exact group is asserted.
const declared = config.rules[RULE];

assert.ok(Array.isArray(declared) && declared[0] === "error", `${RULE} must be enabled at error`);
assert.deepEqual(
  declared[1]?.patterns?.map((pattern: { group: readonly string[] }) => pattern.group),
  [["**/node_modules/**"]],
  `${RULE} must ban every path through node_modules, at any depth, for any package`,
);
// An override replaces the rule's options for the files it matches, so each override that sets the rule
// restates the group; one that dropped it would re-admit the reach in exactly those files.
for (const override of config.overrides ?? []) {
  const options = override.rules?.[RULE];

  if (options === undefined) continue;
  assert.deepEqual(
    options[1]?.patterns?.map((pattern: { group: readonly string[] }) => pattern.group),
    [["**/node_modules/**"]],
    `the override for ${JSON.stringify(override.files)} sets ${RULE} without the node_modules ban`,
  );
}
assert.equal(config.options?.denyWarnings, true);
assert.equal(config.options?.reportUnusedDisableDirectives, "error");

const fixtures = mkdtempSync(join(tmpdir(), "no-deep-import-gate-"));

try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);

  for (const { file, bad, good } of cases) {
    writeFileSync(join(badDirectory, `${file}.ts`), bad);
    writeFileSync(join(goodDirectory, `${file}.ts`), good);
  }

  const lint = (directory: string) => {
    const report = lintJson(["-c", ".oxlintrc.json", directory]);

    assert.equal(report.number_of_files, cases.length, `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}`);

    return report.diagnostics;
  };

  const fired = (diagnostics: ReadonlyArray<LintDiagnostic>, file: string): number =>
    diagnostics.filter((d) => d.code === `eslint(${RULE})` && (d.filename ?? "").endsWith(`${file}.ts`)).length;

  const red = lint(badDirectory);
  const green = lint(goodDirectory);

  for (const entry of cases) {
    assert.equal(fired(red, entry.file), 1, `${RULE} fired ${fired(red, entry.file)} times on ${entry.file}'s one reach through node_modules`);
    assert.equal(fired(green, entry.file), 0, `${RULE} fires on ${entry.file}'s export-map form, so there is no green state to reach`);
  }

  // The green forms resolve nothing at lint time (oxlint does not resolve specifiers for this
  // rule), so any diagnostic here is a real finding under the full config, not a resolution error.
  assert.deepEqual(
    green.map((d) => `${d.filename ?? "?"}: ${d.code ?? "?"}`),
    [],
    "the export-map fixtures must lint clean under the full config",
  );

  process.stdout.write(
    `no-deep-import: ${RULE} proven red->green through oxlint over ${cases.length} fixtures (static, type-only, dynamic); `
    + 'the live tree is linted once in live-tree.gate.test.ts\n',
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}
