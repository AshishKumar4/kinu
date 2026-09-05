// Kinu-only gate; see upstream.json's `kinuRules` and `kinuRuleGates`.
//
// `rules/no-untyped-console.test.ts` proves the rule function behaves. It does not prove the rule is
// reachable through the command the repo gates on, and — more importantly for THIS rule — it does not
// prove the migration the rule protects actually happened.
//
// A console ban is the easiest gate in the world to satisfy dishonestly. Three green-for-the-wrong-
// reason states, each invisible to `oxlint` and to every unit test:
//
//   1. NOTHING LOGS. Delete every diagnostic and the ban is satisfied perfectly. This is not a
//      hypothetical: 650 `console.*` calls were the migration's denominator, and a tree with zero
//      calls and zero log lines passes the rule while being strictly worse than where it started.
//   2. ONE GENERIC NAME. `diagnostics.failure('error.occurred', …)` on 168 sites passes the ban and
//      passes typecheck, and defeats the entire purpose — the NAME is what makes a failure greppable
//      across Workers Logs and the CLI journal, and one name for 168 outcomes is not greppable, it is
//      a synonym for "something happened".
//   3. THE BOUNDARY COLLAPSED. Someone "finishes the job" by routing `packages/cli/src` through the
//      logger too. The rule stays green (that tree is out of scope), and the product's rendered
//      tables become JSON in a user's terminal.
//
// So this gate proves red->green through the real binary AND measures all three denominators. The
// scope comes from the RULE's own exported `isDiagnosticSource`, never a pattern of its own: a gate
// that measured one set while governing another is the defect `scripts/sources.ts` documents fifteen
// instances of.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDiagnosticSource } from "./rules/no-untyped-console.ts";
import { readSources } from "../../../scripts/sources.ts";

const repoRoot = process.cwd();

/** `oxlint -f json`. `code` is spelled `anti-slop(no-untyped-console)`. */
type Diagnostic = { readonly code?: string; readonly filename?: string };
type LintReport = {
	readonly diagnostics: ReadonlyArray<Diagnostic>;
	readonly number_of_files: number;
	readonly number_of_rules: number;
};

/**
 * The exact shape the census found, 650 times: a `[kinu]` prose prefix, the outcome in English,
 * and a second argument that is an object nobody looked inside. Nothing can key a query on it.
 */
const HISTORICAL_SHAPE = `declare const outcome: { reason: unknown };
export function scoreHead(): void {
  console.warn('[kinu] head could not be scored — reporting no grounded signal:', outcome.reason);
}
`;

/** The same code after the migration: a stable dotted name, a classified error, scalar fields. */
const MIGRATED_SHAPE = `import { diagnostics, toKinuError } from '@kinu.run/core/obs';

declare const outcome: { reason: unknown };
declare const headId: string;
export function scoreHead(): void {
  diagnostics.failure('head.score_failed', toKinuError({
    doing: 'scoring a head report against the grounded judge',
    cause: outcome.reason,
    otherwise: 'unavailable',
  }), { headId });
}
`;

const cases: ReadonlyArray<{
	readonly rule: string;
	readonly bad: string;
	readonly good: string;
}> = [
	{ rule: "no-untyped-console", bad: HISTORICAL_SHAPE, good: MIGRATED_SHAPE },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const manifest = JSON.parse(
	readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"),
);
assert.deepEqual(
	cases.map((entry) => entry.rule).sort(),
	[...manifest.kinuRuleGates["no-untyped-console.gate.test.ts"]].sort(),
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
 * Every `diagnostics.event` / `diagnostics.failure` / `logger.*` call in the governed tree, with its
 * event name.
 *
 * Source text rather than an AST walk, deliberately: the assertion is about the NAME ARGUMENT, and the
 * only three shapes it takes are a quoted literal, a `SCREAMING_CASE` constant, or a TEMPLATE LITERAL.
 * The third is the defect — `` `head.${id}_failed` `` produces a name per id, so nothing can be
 * grepped and the varying part belongs in a field. The second is not: `const RUN_SHELL_ABSENT =
 * 'run.shell_absent'` is one spelling in one place, which is what `builtins.ts:357-361` already does
 * and is strictly better than repeating the literal. Both are counted as named; only interpolation is
 * rejected.
 */
const CALL = /\b(?:diagnostics|logger|log)\.(?:event|failure)\(\s*(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_]*)|(`))?/gu;

/** The literal a `SCREAMING_CASE` event-name constant is declared as, so a constant contributes its
 *  actual name to the distinctness and reuse counts instead of being trusted blind. */
const NAME_CONSTANT = (identifier: string): RegExp =>
	new RegExp(`\\b${identifier}\\s*(?::[^=]+)?=\\s*['"]([^'"]+)['"]`, "u");

interface SinkCensus {
	readonly governedFiles: number;
	readonly sites: number;
	/** One entry per call site, so a reuse count is a count of SITES. */
	readonly names: readonly string[];
	/** Names built by interpolation, and names whose constant could not be resolved to a literal —
	 *  both are names a query cannot be written against, and both are failures. */
	readonly unqueryableNames: readonly string[];
	readonly viaConstant: number;
	readonly filesWithSinks: number;
}

function sinkCensus(): SinkCensus {
	const sources = readSources();
	const governed = [...sources].filter(([file]) => isDiagnosticSource(file));
	const wholeTree = [...sources.values()].join("\n");
	const names: string[] = [];
	const unqueryableNames: string[] = [];
	const filesWithSinks = new Set<string>();
	let sites = 0;
	let viaConstant = 0;
	for (const [file, source] of governed) {
		for (const match of source.matchAll(CALL)) {
			sites += 1;
			filesWithSinks.add(file);
			const literal = match[1] ?? match[2];
			const identifier = match[3];
			if (literal !== undefined) {
				names.push(literal);
			} else if (identifier !== undefined) {
				// Resolved against the whole tree, not just this file: a shared name constant may be
				// declared where it is exported from. Unresolvable is a finding, not a pass.
				const declared = NAME_CONSTANT(identifier).exec(wholeTree)?.[1];
				if (declared === undefined) unqueryableNames.push(`${file}: ${identifier} (unresolved)`);
				else { names.push(declared); viaConstant += 1; }
			} else {
				unqueryableNames.push(`${file}: interpolated name`);
			}
		}
	}
	return {
		governedFiles: governed.length,
		sites,
		names,
		unqueryableNames,
		viaConstant,
		filesWithSinks: filesWithSinks.size,
	};
}

/**
 * The most times one event name may name a distinct site.
 *
 * Two, and the bound is measured rather than chosen: every reuse in the tree today is ONE cross-layer
 * pair reporting ONE outcome — `compaction.debug`/`degraded`/`failed` and `drain.timer_callback_failed`
 * adapting the same third-party port in both backends, and `email.owner_notification_failed` raised by
 * the outbox and by its caller. Three sites sharing a name is a different thing: it is the beginning
 * of state 2 above, where a name stops identifying an outcome and starts identifying a category.
 */
const MAX_NAME_REUSE = 2;

/** `packages/cli/src` is the product's terminal UI, and the rule's scope excludes it. This is the
 *  count that proves the exclusion is still load-bearing: if it goes to zero, someone converted the
 *  CLI's output to structured logs and the rule went green over a broken product. */
function preservedUiCalls(): number {
	// The census config lives in the system temp dir, not beside this gate: gates built on
	// scripts/sources.ts enumerate untracked worktree files on purpose, so a scratch config
	// inside the plugin directory is visible mid-run to every one of them (and to drift.test.ts,
	// which fails on any undeclared file there). oxlint takes an absolute `-c` path.
	const configPath = join(mkdtempSync(join(tmpdir(), "kinu-no-untyped-console-census-")), "census.oxlintrc.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({ rules: { "no-console": "error" }, ignorePatterns: ["node_modules", "dist"] }, null, 2)}\n`,
	);
	try {
		const run = spawnSync(
			"./node_modules/.bin/oxlint",
			["-c", configPath, "-f", "json", "packages/cli/src"],
			{ cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		assert.ok(run.stdout.length > 0, `oxlint produced no JSON for packages/cli/src:\n${run.stderr}`);
		const report: LintReport = JSON.parse(run.stdout);
		return report.diagnostics.length;
	} finally {
		rmSync(join(configPath, ".."), { recursive: true, force: true });
	}
}

const census = sinkCensus();
const uiCalls = preservedUiCalls();

assert.ok(
	census.governedFiles > 0,
	"the rule's own isDiagnosticSource selected 0 files from readSources(); it then governs nothing and cannot fire",
);
assert.ok(
	census.sites > 0,
	`${String(census.governedFiles)} governed files hold 0 typed-logger calls. The console ban is then satisfied by logging NOTHING, which is worse than the 650 bare calls it replaced`,
);
const byName = new Map<string, number>();
for (const name of census.names) byName.set(name, (byName.get(name) ?? 0) + 1);
assert.ok(
	byName.size > 0,
	`${String(census.sites)} typed-logger calls carry 0 resolvable event names; a name a query cannot be written against is the defect this migration existed to fix`,
);
const worst = [...byName].sort((left, right) => right[1] - left[1]);
const overused = worst.filter(([, count]) => count > MAX_NAME_REUSE);
assert.deepEqual(
	overused,
	[],
	`event name(s) reused on more than ${String(MAX_NAME_REUSE)} sites: ${JSON.stringify(overused)}. `
		+ "A name shared by three distinct outcomes has stopped identifying an outcome, which passes a "
		+ "console ban while defeating the reason for one",
);
assert.deepEqual(
	census.unqueryableNames,
	[],
	`typed-logger call(s) whose event name cannot be grepped: ${JSON.stringify(census.unqueryableNames)}. `
		+ "An interpolated name produces one name per value — the varying part belongs in a FIELD, where "
		+ "it is queryable, and the name stays a constant",
);
assert.ok(
	uiCalls > 0,
	"packages/cli/src holds 0 console calls. Either the product's terminal output was routed through "
		+ "the structured logger — which replaces a user's rendered table with JSON — or the tree moved, "
		+ "and either way this rule's scope exclusion is no longer the boundary it claims to be",
);

const prefixes = new Set(census.names.map((name) => name.split(".")[0]));
assert.ok(
	prefixes.size > 1,
	`every event name shares one subsystem prefix (${[...prefixes].join(", ")}); the prefix is then decoration rather than a discriminator`,
);

const fixtures = mkdtempSync(join(tmpdir(), "kinu-no-untyped-console-gate-"));
try {
	// The fixtures carry a governed path SEGMENT (`packages/core/src`), because this rule is
	// path-scoped and a fixture the rule does not govern proves nothing about it — the first draft
	// of this gate put them at the temp-dir root and measured 0 findings on a genuine defect.
	// They sit under the system temp dir rather than the repo root: gates built on
	// scripts/sources.ts enumerate untracked worktree files on purpose, so repo-root scratch is
	// visible mid-run to every one of them. `isDiagnosticSource` matches the segment anywhere in
	// the path (`includes`, not `startsWith`), which is what makes a temp copy of a source tree
	// governed and is also what makes it testable at all.
	const governedPath = join("packages", "core", "src");
	const badDirectory = join(fixtures, "red", governedPath);
	const goodDirectory = join(fixtures, "green", governedPath);
	mkdirSync(badDirectory, { recursive: true });
	mkdirSync(goodDirectory, { recursive: true });
	for (const { rule, bad, good } of cases) {
		writeFileSync(join(badDirectory, `${rule}.ts`), bad);
		writeFileSync(join(goodDirectory, `${rule}.ts`), good);
	}

	const lint = (directory: string): LintReport => {
		const run = spawnSync(
			"./node_modules/.bin/oxlint",
			["-c", ".oxlintrc.json", "-f", "json", directory],
			{ cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${directory}:\n${run.stderr}`);
		const report: LintReport = JSON.parse(run.stdout);
		assert.equal(
			report.number_of_files,
			cases.length,
			`oxlint linted ${String(report.number_of_files)} of ${String(cases.length)} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
		);
		assert.ok(
			report.number_of_rules > 0,
			`oxlint ran ${String(report.number_of_rules)} rules; a lint with no rules loaded reports no findings`,
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
			`anti-slop/${rule} fired ${String(firedIn(red, rule).length)} times on the one seeded defect through \`oxlint -c .oxlintrc.json\`; expected exactly 1. Diagnostics seen: ${JSON.stringify(red.map(ruleOf))}`,
		);
		assert.equal(
			firedIn(green, rule).length,
			0,
			`anti-slop/${rule} fires on the migrated form, so the cutover has no green state to reach`,
		);
	}

	process.stdout.write(
		`no-untyped-console: ${String(cases.length)} rule proven red->green through oxlint over `
			+ `${String(census.governedFiles)} governed files — ${String(census.sites)} typed-logger calls in `
			+ `${String(census.filesWithSinks)} files (${String(census.viaConstant)} via a name constant), `
			+ `${String(byName.size)} distinct event names across `
			+ `${String(prefixes.size)} subsystems, worst reuse ${String(worst[0]?.[1] ?? 0)} `
			+ `(${String(worst[0]?.[0] ?? "none")}), ${String(uiCalls)} product-UI console calls preserved in `
			+ `packages/cli/src\n`,
	);
} finally {
	rmSync(fixtures, { recursive: true, force: true });
}
