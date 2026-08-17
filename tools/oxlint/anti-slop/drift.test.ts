import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import antiSlopPlugin from "./index.ts";

type VendoredFile = {
  readonly upstream?: string;
  readonly local?: string;
  readonly reason?: string;
  readonly proteusOnly?: true;
};

type Manifest = {
  readonly repository: string;
  readonly commit: string;
  readonly commitDate: string;
  readonly commitSubject: string;
  readonly upstreamSourceRoot: string;
  readonly upstreamTestRoot: string;
  /** Rules authored here rather than vendored. Exact complement of the upstream-pinned rules. */
  readonly proteusRules: readonly string[];
  readonly vendored: Readonly<Record<string, VendoredFile>>;
};

const pluginRoot = import.meta.dirname;
const manifestPath = join(pluginRoot, "upstream.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function vendoredPaths(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      found.push(relative(pluginRoot, absolute).split(sep).join("/"));
    }
  };
  walk(pluginRoot);
  return found.sort();
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
    if (declared?.proteusOnly === true) {
      refreshed[path] = { proteusOnly: true };
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
  if (declared.proteusOnly === true) continue;
  assert.ok(
    declared.upstream !== undefined,
    `${path}: needs either an upstream digest or proteusOnly`,
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
const proteusRules = [...manifest.proteusRules].sort();
assert.ok(registeredRules.length > 0, "the plugin registered no rules");

// An exact partition of the registered rules, asserted in both directions. Accepting
// "upstream digest OR proteusOnly" here instead would let any vendored rule be demoted to
// {proteusOnly:true} and escape byte comparison forever — a manifest rewritten that way leaves
// every file present and nothing compared. Naming the local rules makes adding one a visible
// two-line act and demoting an upstream one impossible without a reviewer seeing the name.
const unpinned = registeredRules.filter(
  (rule) => manifest.vendored[`rules/${rule}.ts`]?.upstream === undefined,
);
assert.deepEqual(
  unpinned,
  proteusRules,
  "every registered rule must either carry an upstream digest or be named in proteusRules",
);
assert.deepEqual(
  proteusRules.filter((rule) => manifest.vendored[`rules/${rule}.ts`]?.upstream !== undefined),
  [],
  "a rule named in proteusRules must not also claim an upstream digest",
);
assert.deepEqual(
  proteusRules.filter((rule) => !registeredRules.includes(rule)),
  [],
  "proteusRules names a rule the plugin does not register",
);
assert.ok(
  proteusRules.length > 0,
  "proteusRules is empty; the Proteus-authored rules would then be unaccounted for rather than declared",
);
assert.ok(
  proteusRules.length < registeredRules.length,
  `proteusRules claims ${proteusRules.length} of ${registeredRules.length} rules; declaring the whole plugin Proteus-authored would disable drift comparison entirely`,
);

assert.ok(
  comparedAgainstUpstream >= registeredRules.length - proteusRules.length,
  `compared ${comparedAgainstUpstream} files against upstream for ${registeredRules.length - proteusRules.length} vendored rules; a drift check that compares nothing reports no drift`,
);

assert.deepEqual(
  drifted,
  [],
  `vendored anti-slop drifted from pinned upstream ${manifest.commit}:\n  ${drifted.join("\n  ")}`,
);

process.stdout.write(
  `anti-slop: ${comparedAgainstUpstream} files match pinned upstream ${manifest.commit.slice(0, 7)} (${Object.values(manifest.vendored).filter((file) => file.local !== undefined).length} declared local deltas)\n`,
);
