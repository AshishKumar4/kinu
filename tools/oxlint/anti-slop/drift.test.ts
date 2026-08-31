import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import antiSlopPlugin from "./index.ts";
import { trackedFiles } from "../../../scripts/sources.ts";

type VendoredFile = {
  readonly upstream?: string;
  readonly local?: string;
  readonly reason?: string;
  readonly kinuOnly?: true;
};

type Manifest = {
  readonly repository: string;
  readonly commit: string;
  readonly commitDate: string;
  readonly commitSubject: string;
  readonly upstreamSourceRoot: string;
  readonly upstreamTestRoot: string;
  /** Rules authored here rather than vendored. Exact complement of the upstream-pinned rules. */
  readonly kinuRules: readonly string[];
  /** Which `*.gate.test.ts` proves each Kinu-authored rule red->green through the real oxlint
   *  binary. An exact partition of `kinuRules`, asserted below. */
  readonly kinuRuleGates: Readonly<Record<string, readonly string[]>>;
  readonly vendored: Readonly<Record<string, VendoredFile>>;
};

const pluginRoot = import.meta.dirname;
const manifestPath = join(pluginRoot, "upstream.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every vendored file, from the ONE enumeration.
 *
 * This walked the plugin directory itself. That is the shape whose whole purpose
 * is to notice an undeclared file, run over a corpus that could disagree with
 * what git — and therefore `.gitignore`, and therefore every other gate — sees:
 * a stale build artefact or an editor swap file arrived as an undeclared vendored
 * source, and a file `.gitignore` covers was declared drift-free while being
 * outside the manifest's reach.
 */
function vendoredPaths(): readonly string[] {
  const prefix = `${relative(process.cwd(), pluginRoot).split(sep).join('/')}/`;
  return trackedFiles()
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .sort();
}

/**
 * Where a vendored file comes from upstream. Rule and shared sources are published in the skill
 * asset tree; the per-rule suites exist only under the plugin's own source tree.
 */
function upstreamPathFor(vendored: string): string {
  return vendored.endsWith(".test.ts")
    ? `${manifest.upstreamTestRoot}/${vendored.slice("rules/".length)}`
    : `${manifest.upstreamSourceRoot}/${vendored}`;
}

if (process.argv.includes("--update")) {
  const checkout = process.env.ANTI_SLOP_UPSTREAM;
  assert.ok(
    checkout !== undefined && checkout.length > 0,
    "--update needs ANTI_SLOP_UPSTREAM pointing at a checkout of the anti-slop repository",
  );
  const refreshed: Record<string, VendoredFile> = {};
  for (const path of vendoredPaths()) {
    if (path === "upstream.json") continue;
    const declared = manifest.vendored[path];
    if (declared?.kinuOnly === true) {
      refreshed[path] = { kinuOnly: true };
      continue;
    }
    const upstream = digest(join(checkout, upstreamPathFor(path)));
    const local = digest(join(pluginRoot, path));
    refreshed[path] =
      local === upstream
        ? { upstream }
        : {
            upstream,
            local,
            reason: declared?.reason ?? "UNDOCUMENTED LOCAL DELTA — state why before committing",
          };
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, vendored: refreshed }, null, 2)}\n`,
  );
  process.stdout.write(`anti-slop: refreshed ${manifestPath}\n`);
  process.exit(0);
}

assert.match(
  manifest.commit,
  /^[0-9a-f]{40}$/u,
  "upstream.json must pin a full upstream commit SHA",
);
assert.equal(manifest.repository, "https://github.com/dmmulroy/anti-slop");

const onDisk = vendoredPaths();
assert.deepEqual(
  onDisk.filter((path) => !(path in manifest.vendored) && path !== "upstream.json"),
  [],
  "every vendored file must be declared in upstream.json; an undeclared file is undetectable drift",
);
assert.deepEqual(
  Object.keys(manifest.vendored).filter((path) => !onDisk.includes(path)),
  [],
  "upstream.json declares files that no longer exist",
);

const drifted: string[] = [];
const undocumented: string[] = [];
let comparedAgainstUpstream = 0;

for (const [path, declared] of Object.entries(manifest.vendored)) {
  if (declared.kinuOnly === true) continue;
  assert.ok(
    declared.upstream !== undefined,
    `${path}: needs either an upstream digest or kinuOnly`,
  );
  comparedAgainstUpstream += 1;
  const actual = digest(join(pluginRoot, path));
  const expected = declared.local ?? declared.upstream;
  if (declared.local !== undefined && (declared.reason ?? "").length < 20) {
    undocumented.push(path);
  }
  if (actual !== expected) {
    drifted.push(
      declared.local === undefined
        ? `${path}: diverged from upstream ${manifest.commit.slice(0, 7)} (expected ${declared.upstream.slice(0, 12)}, found ${actual.slice(0, 12)})`
        : `${path}: declared local delta changed (expected ${declared.local.slice(0, 12)}, found ${actual.slice(0, 12)}) — reason on record: ${declared.reason}`,
    );
  }
}

assert.deepEqual(
  undocumented,
  [],
  "every local delta must state why it exists, not merely that it does",
);

const registeredRules = Object.keys(antiSlopPlugin.rules ?? {}).sort();
const kinuRules = [...manifest.kinuRules].sort();
assert.ok(registeredRules.length > 0, "the plugin registered no rules");

// An exact partition of the registered rules, asserted in both directions. Accepting
// "upstream digest OR kinuOnly" here instead would let any vendored rule be demoted to
// {kinuOnly:true} and escape byte comparison forever — a manifest rewritten that way leaves
// every file present and nothing compared. Naming the local rules makes adding one a visible
// two-line act and demoting an upstream one impossible without a reviewer seeing the name.
const unpinned = registeredRules.filter(
  (rule) => manifest.vendored[`rules/${rule}.ts`]?.upstream === undefined,
);
assert.deepEqual(
  unpinned,
  kinuRules,
  "every registered rule must either carry an upstream digest or be named in kinuRules",
);
assert.deepEqual(
  kinuRules.filter((rule) => manifest.vendored[`rules/${rule}.ts`]?.upstream !== undefined),
  [],
  "a rule named in kinuRules must not also claim an upstream digest",
);
assert.deepEqual(
  kinuRules.filter((rule) => !registeredRules.includes(rule)),
  [],
  "kinuRules names a rule the plugin does not register",
);
assert.ok(
  kinuRules.length > 0,
  "kinuRules is empty; the Kinu-authored rules would then be unaccounted for rather than declared",
);
assert.ok(
  kinuRules.length < registeredRules.length,
  `kinuRules claims ${kinuRules.length} of ${registeredRules.length} rules; declaring the whole plugin Kinu-authored would disable drift comparison entirely`,
);

// The rule -> gate partition. A per-rule RuleTester suite proves the rule function behaves; only a
// `*.gate.test.ts` proves it fires through `bun run lint`. Asserting a PARTITION (every rule proven
// exactly once, every gate file present, no gate empty) is what stops a rule being added with a
// suite and no red->green proof — the shape that has produced nine gates in this repo that existed
// and never ran.
const gateEntries = Object.entries(manifest.kinuRuleGates);
assert.ok(gateEntries.length > 0, "kinuRuleGates is empty; no Kinu rule would be proven to fire at all");
for (const [gate, rules] of gateEntries) {
  assert.ok(
    onDisk.includes(gate),
    `kinuRuleGates names ${gate}, which is not a file in this plugin`,
  );
  assert.ok(rules.length > 0, `${gate} is assigned no rules; a gate that proves nothing must not be listed`);
}
const gatedRules = gateEntries.flatMap(([, rules]) => rules);
assert.equal(
  gatedRules.length,
  new Set(gatedRules).size,
  `a rule is assigned to two gates: ${gatedRules.join(", ")}`,
);
assert.deepEqual(
  [...gatedRules].sort(),
  kinuRules,
  "every Kinu-authored rule must be proven red->green by exactly one gate, and only those",
);

assert.ok(
  comparedAgainstUpstream >= registeredRules.length - kinuRules.length,
  `compared ${comparedAgainstUpstream} files against upstream for ${registeredRules.length - kinuRules.length} vendored rules; a drift check that compares nothing reports no drift`,
);

assert.deepEqual(
  drifted,
  [],
  `vendored anti-slop drifted from pinned upstream ${manifest.commit}:\n  ${drifted.join("\n  ")}`,
);

process.stdout.write(
  `anti-slop: ${comparedAgainstUpstream} files match pinned upstream ${manifest.commit.slice(0, 7)} (${Object.values(manifest.vendored).filter((file) => file.local !== undefined).length} declared local deltas)\n`,
);
