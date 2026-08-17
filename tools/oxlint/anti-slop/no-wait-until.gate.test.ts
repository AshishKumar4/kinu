// Proteus-only gate; see upstream.json's `proteusRules` and `proteusRuleGates`.
//
// `rules/no-wait-until-in-durable-object.test.ts` proves the rule function behaves. It does not
// prove the rule is reachable through the command the repo gates on, and it does not prove the repo
// contains a Durable Object for it to gate. This file runs the real `oxlint` binary with the real
// `.oxlintrc.json` over the historical defect and over its corrected form, asserts red then green,
// and asserts the live denominator: a rule that inspected no Durable Object class reports no misuse
// and would pass silently.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

/** `oxlint -f json`. `code` is spelled `anti-slop(no-wait-until-in-durable-object)`. */
type Diagnostic = { readonly code?: string; readonly filename?: string };
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};

/**
 * `scheduleTimerAt` exactly as it stood at 5183d69d — the last commit deployed to production. Its
 * docstring asserted that "the storage write is held open with `waitUntil` so it lands even if the
 * caller's invocation ends first", which is false in a Durable Object: `waitUntil` there is the same
 * code path as a bare floating promise and both are cancelled silently on eviction or reset. The
 * write it was guarding arms `PROTEUS_TIMER_CALLBACK`, Proteus's own wake-up, so losing it stops all
 * scheduled work with no signal. The fixture is the shape itself, pinned by digest so it cannot be
 * quietly reworded into something the rule happens to catch.
 */
const HISTORICAL_TIMER_ARM = `  /** Idempotent soonest-wins arm of Proteus's own wake-up, expressed as the
   *  agents-SDK schedule row \`PROTEUS_TIMER_CALLBACK\`. A Durable Object has a
   *  single alarm slot and the SDK owns it (\`_scheduleNextAlarm\` deletes any
   *  alarm it does not recognise), so this must never call \`setAlarm\` itself.
   *  Fire-and-forget by interface (\`AlarmScheduler.scheduleAt\`); the storage
   *  write is held open with \`waitUntil\` so it lands even if the caller's
   *  invocation ends first. */
  private scheduleTimerAt(ts: number): void {
    this.ctx.waitUntil(this.armTimer(ts).catch((err) => {
      console.error('[proteus] timer arm failed:', err instanceof Error ? err.message : String(err));
    }));
  }
`;
const HISTORICAL_DIGEST = "c873e1848259e6942e21f12d8b4ae43c6d6eb9378eaefbdbc0ddf15bb4f5f29d";
const HISTORICAL_SOURCE = {
  commit: "5183d69d",
  path: "packages/cf-backend/src/orchestrator.ts",
  lines: [518, 529] as const,
};

// Unconditional: the digest is what makes the fixture the historical shape rather than a shape
// invented to suit the rule. Checked before the git comparison, which needs the object to survive.
assert.equal(
  createHash("sha256").update(HISTORICAL_TIMER_ARM).digest("hex"),
  HISTORICAL_DIGEST,
  "the historical scheduleTimerAt fixture no longer matches its pinned digest",
);

const historical = spawnSync(
  "git",
  ["show", `${HISTORICAL_SOURCE.commit}:${HISTORICAL_SOURCE.path}`],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (historical.status === 0) {
  const [from, to] = HISTORICAL_SOURCE.lines;
  assert.equal(
    `${historical.stdout.split("\n").slice(from - 1, to).join("\n")}\n`,
    HISTORICAL_TIMER_ARM,
    `${HISTORICAL_SOURCE.path}:${from}-${to} at ${HISTORICAL_SOURCE.commit} is not the fixture this gate claims to replay`,
  );
} else {
  process.stdout.write(
    `no-wait-until: ${HISTORICAL_SOURCE.commit} unreachable from this checkout; fixture verified by pinned digest only\n`,
  );
}

const DECLARED_BASE = `declare class Agent<E> { ctx: { waitUntil(promise: Promise<unknown>): void }; }
`;

/** Red fixture, then the corrected form of the same code. */
const cases: ReadonlyArray<{
  readonly rule: string;
  readonly bad: string;
  readonly good: string;
}> = [
  {
    rule: "no-wait-until-in-durable-object",
    bad: `${DECLARED_BASE}export class Historical extends Agent<unknown> {
${HISTORICAL_TIMER_ARM}}
`,
    good: `${DECLARED_BASE}declare function arm(ts: number): Promise<void>;
export class Corrected extends Agent<unknown> {
  /** Awaited inside the invocation that asked for the wake, which is the only retention a Durable
   *  Object has: the output gate holds the response until the schedule row commits, and a failure
   *  reaches the caller instead of a console line. */
  private async armTimer(ts: number): Promise<void> {
    await arm(ts);
  }

  async registerWake(ts: number): Promise<void> {
    await this.armTimer(ts);
  }
}
`,
  },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"),
);
assert.deepEqual(
  cases.map((entry) => entry.rule).sort(),
  [...manifest.proteusRuleGates["no-wait-until.gate.test.ts"]].sort(),
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}

/**
 * The live denominator, in three parts, because each can silently go to zero on its own.
 *
 * `wrangler.jsonc` is the deploy configuration and therefore the authority on what a bound Durable
 * Object is here — not a list in this file, which would stop covering a class the moment one was
 * added. It is not the whole set though: a FACET is a Durable Object surface with its own
 * `ctx.storage` and the same eviction semantics, and it carries no binding at all, so
 * `SubordinateAgent` and `ExplorationAgent` were outside this count while being exactly the classes
 * a head's background work runs in. They are read from the `subAgent`/`abortSubAgent`/
 * `deleteSubAgent` call sites, which is where the deployment actually names them.
 *
 * Of those classes, the ones declared in our own sources are the corpus this rule can act on, and
 * `this.ctx` / `this.state` usage inside those sources is the construct it matches. A moved source
 * root, a renamed binding or a refactor that stopped holding state on `this` all take one of the
 * three to zero, and a rule gating nothing must say so rather than report a clean lint.
 */
function durableObjectCorpus(): {
  readonly bound: readonly string[];
  readonly facets: readonly string[];
  readonly declaredHere: readonly string[];
  readonly stateHandleUses: number;
} {
  // Read the bound class names out of the JSONC text rather than parsing it: wrangler.jsonc carries
  // comments and trailing commas, and a hand-rolled JSONC stripper here would be a second parser
  // that fails in its own way. Every `class_name` in the deploy config names a Durable Object class,
  // which is exactly the set wanted.
  const wranglerText = readFileSync(join(repoRoot, "packages/cf-backend/wrangler.jsonc"), "utf8");
  const bound = [
    ...new Set(
      [...wranglerText.matchAll(/"class_name"\s*:\s*"([A-Za-z0-9_$]+)"/gu)].map((m) => m[1]),
    ),
  ];

  const sources: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(absolute);
        continue;
      }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        sources.push(readFileSync(absolute, "utf8"));
      }
    }
  };
  walk(join(repoRoot, "packages/cf-backend/src"));

  // Facet classes, named where they are instantiated. Deliberately the call sites and not an
  // `extends Agent` scan: a base class or a test double also matches that shape, while a name passed
  // to the SDK's facet API is a class the deployment really activates.
  const facets = [
    ...new Set(
      sources.flatMap((text) => [
        ...text.matchAll(/\b(?:sub|abort|delete)SubAgent\(\s*([A-Z][A-Za-z0-9_$]*)/gu),
      ].map((m) => m[1]!)),
    ),
  ];

  const declaredHere = [...new Set([...bound, ...facets])].filter((name) =>
    sources.some((text) => new RegExp(`\\bclass\\s+${name}\\b[^{]*\\bextends\\b`, "u").test(text)),
  );
  const stateHandleUses = sources.reduce(
    (total, text) => total + (text.match(/\bthis\.(?:ctx|state)\s*\./gu)?.length ?? 0),
    0,
  );
  return { bound, facets, declaredHere, stateHandleUses };
}

const corpus = durableObjectCorpus();
assert.ok(
  corpus.bound.length > 0,
  "packages/cf-backend/wrangler.jsonc declares no durable_objects bindings; there is then no Durable Object for this rule to gate",
);
assert.ok(
  corpus.facets.length > 0,
  "no subAgent/abortSubAgent/deleteSubAgent call site under packages/cf-backend/src names a facet class; the facet half of the corpus — where a head's background work runs — would then be uncounted",
);
assert.ok(
  corpus.declaredHere.length > 0,
  `none of the ${corpus.bound.length} bound and ${corpus.facets.length} facet Durable Object classes (${[...corpus.bound, ...corpus.facets].join(", ")}) is declared under packages/cf-backend/src; this rule would then inspect no Durable Object of ours`,
);
assert.ok(
  corpus.stateHandleUses > 0,
  `found ${corpus.declaredHere.length} Durable Object classes but 0 \`this.ctx\`/\`this.state\` uses under packages/cf-backend/src; a rule keyed on the state handle would then match nothing by construction`,
);

const fixtures = mkdtempSync(join(repoRoot, ".no-wait-until-gate-"));
try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  for (const { rule, bad, good } of cases) {
    writeFileSync(join(badDirectory, `${rule}.ts`), bad);
    writeFileSync(join(goodDirectory, `${rule}.ts`), good);
  }

  const lint = (directory: string): LintReport => {
    const run = spawnSync(
      "./node_modules/.bin/oxlint",
      ["-c", ".oxlintrc.json", "-f", "json", relative(repoRoot, directory)],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${directory}:\n${run.stderr}`);
    const report: LintReport = JSON.parse(run.stdout);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    assert.ok(
      report.number_of_rules > 0,
      `oxlint ran ${report.number_of_rules} rules; a lint with no rules loaded reports no findings`,
    );
    return report;
  };

  // The other anti-slop rules also run over these fixtures; their findings are not this gate's
  // subject.
  const ruleOf = (diagnostic: Diagnostic): string | null => {
    const match = /^anti-slop\(([a-z-]+)\)$/u.exec(diagnostic.code ?? "");
    const rule = match?.[1];
    return rule !== undefined && cases.some((entry) => entry.rule === rule) ? rule : null;
  };
  const firedIn = (
    diagnostics: ReadonlyArray<Diagnostic>,
    rule: string,
  ): ReadonlyArray<Diagnostic> =>
    diagnostics.filter((d) => ruleOf(d) === rule && (d.filename ?? "").endsWith(`${rule}.ts`));

  const red = lint(badDirectory).diagnostics;
  const green = lint(goodDirectory).diagnostics;

  for (const { rule } of cases) {
    assert.equal(
      firedIn(red, rule).length,
      1,
      `anti-slop/${rule} fired ${firedIn(red, rule).length} times on the one seeded defect through \`oxlint -c .oxlintrc.json\`; expected exactly 1. Diagnostics seen: ${JSON.stringify(red.map(ruleOf))}`,
    );
    assert.equal(
      firedIn(green, rule).length,
      0,
      `anti-slop/${rule} fires on the corrected form, so the cutover has no green state to reach`,
    );
  }

  process.stdout.write(
    `no-wait-until: ${cases.length} rule proven red->green through oxlint over ${corpus.declaredHere.length} Durable Object classes — ${corpus.bound.length} bound, ${corpus.facets.length} facet — (${corpus.declaredHere.join(", ")}) and ${corpus.stateHandleUses} state-handle uses\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}
