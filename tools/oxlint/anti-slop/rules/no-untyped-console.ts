import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject `console.*` in the runtime packages, where a diagnostic must carry a stable dotted event
 * name.
 *
 * WHY. AGENTS.md § Errors, Logging & Traceability has required a dotted event name since before any
 * of this code was written, and the convention did not survive. Measured 2026-08-17 with oxlint's own
 * `no-console` over `packages/<pkg>/src` — an AST census, so the twelve occurrences that are prose in a
 * comment or a string literal are excluded:
 *
 *     cli          479   cf-backend 99   core 55   cli-backend 17   agent-utils 0   compaction 0
 *     TOTAL        650 across 86 files
 *
 * The shape they settled on is `console.warn('[kinu] <prose>', someValue)`. Nothing can key a
 * query on it: the subsystem is inside a prose string, the outcome is inside a prose string, and the
 * second argument is routinely an object nobody looked inside — which is also how a secret reaches a
 * log line. `packages/core/src/obs/log.ts` closes both halves with types, and this rule is what stops
 * the 651st bare call landing beside it next week. A convention that needs remembering has already
 * failed once here.
 *
 * ## THE BOUNDARY, which is the whole design of this rule
 *
 * A diagnostic is written for whoever reads the logs later. Most `console.*` in this repository is
 * not that — it is the product's OUTPUT, and routing output through a structured logger does not
 * improve traceability, it breaks the product. 479 of the 650 calls are in `packages/cli/src`, whose
 * `display.ts` calls itself "single source of truth for all CLI visual output": every one carries
 * chalk styling and a human is reading it. So the allowlist below is not a set of exemptions granted
 * to code that could not be bothered — it is the boundary between telemetry and interface, and each
 * entry states which side it is on and why.
 *
 * `CONSOLE_ALLOWED` is a prefix list rather than a glob set so that an entry names a FILE or a
 * DIRECTORY that someone can open, and so that adding one is a visible edit here next to its reason.
 *
 * The scope is EXPORTED, and `no-untyped-console.gate.test.ts` computes its denominator from
 * `isDiagnosticSource` rather than from a pattern of its own. That is the same direction
 * `scripts/sources.ts` already takes with `TEST_FILE`: the rule owns the pattern, the gate imports it,
 * and "which files did you measure" and "which files do you govern" are one expression. The defect
 * that discipline exists for appeared fifteen times in one evening — a gate measuring one set and
 * governing another — and a private copy of this list in the gate would be the sixteenth.
 *
 * ## What this rule cannot see
 *
 * The matcher is the `console` receiver, so an alias (`const out = console; out.log(x)`) is outside
 * it, as is `globalThis.console.log`. There is deliberately no attempt to chase either: the gate
 * beside this rule asserts the live denominator instead, because a rule that inspects a corpus with
 * no `console` left in it reports nothing and passes silently — which is the state this rule is
 * supposed to detect a regression from, not the state that proves it works.
 */

/** The packages whose `src` is diagnostics. `compaction` and `agent-utils` are already at zero and
 *  are in scope to KEEP them there — a rule scoped only to the trees that had a problem cannot stop
 *  the problem appearing in the trees that did not. */
export const RUNTIME_SOURCE_ROOTS = [
	"packages/core/src/",
	"packages/cf-backend/src/",
	"packages/cli-backend/src/",
	"packages/agent-utils/src/",
	"packages/compaction/src/",
] as const;

/**
 * Where `console` is the product or the sink, not a diagnostic. Order is irrelevant; each entry is a
 * path prefix under the repository root.
 */
export const CONSOLE_ALLOWED = [
	/** The typed logger's own emitter. `createConsoleLogger` writes one JSON line per event to
	 *  `console`, which is the sink both readers already collect — Workers Logs on workerd, and the
	 *  daemon journal on the CLI, which captures both streams (`commands/daemon.ts` spawns with
	 *  `stdio: ['ignore', logFd, logFd]`). This is the file every other site now routes through. */
	"packages/core/src/obs/log.ts",
	/** The BROWSER half of the cf-backend bundle. `src/index.tsx` mounts these with
	 *  `createRoot(document.getElementById('root'))`, so their `console` reaches neither of the two
	 *  sinks `diagnostics` exists for — not Workers Logs, not the daemon journal — only a developer
	 *  with devtools open, which is the same audience as the CLI's terminal output. And the conversion
	 *  is not merely pointless there: `ErrorBoundary` logs a live `Error` plus a multi-KB
	 *  `componentStack`, and log fields are scalars, so routing it through the logger would flatten
	 *  the expandable, source-mapped Error that is the only reason the line exists. `Sidebar`'s
	 *  failure is already surfaced as product UI (`setListError(true)` renders the roster's error
	 *  affordance); its console line is the developer's companion to a handled UI state.
	 *
	 *  This is a DIRECTORY, so the whole client tree is out — a React component's console is a
	 *  developer artefact wherever it sits, and enumerating files would fail on the next component. */
	"packages/cf-backend/src/components/",
] as const;

/** ONE entry, and the reason the obvious second one is absent. `cli-backend/src/executor.ts` writes
 *  `console.log(JSON.stringify({ ok, result }))` — the subprocess's entire stdout CONTRACT with its
 *  parent, machine-facing product output where a stray diagnostic is a parse failure rather than a log
 *  line. It needs no entry: both calls sit inside the `wrapper` TEMPLATE LITERAL that is written to a
 *  temp file and run by `Bun.spawn`, so they are generated source text and this rule's AST never sees
 *  them. Measured — `oxlint` reports 0 for that file unmodified, and the file is correspondingly
 *  absent from the 650-site census above. Listing it would be config that governs nothing, which is
 *  the failure mode an allowlist is most prone to: an entry nobody can disprove. If a real
 *  `console.log` is ever added there outside the template, this rule SHOULD fire on it. */

/** `packages/cli/src` is absent from `RUNTIME_SOURCE_ROOTS` rather than listed in `ALLOWED`, and the
 *  distinction is deliberate: it is not a runtime package with exemptions, it is a different KIND of
 *  tree — 479 chalk-styled writes to a terminal a human is reading. The three genuine diagnostics
 *  that were hiding in it (`commands/list.ts`, `local-agent-client.ts`, `acp/agent.ts`) were moved to
 *  the typed logger instead of the tree being converted. `packages/pc-agent` is likewise absent: it
 *  is standalone plain JavaScript with no build and no `@kinu.run/core` dependency, so it cannot
 *  import the logger without becoming a different kind of package. `packages/test-utils` and every
 *  `tests/`, `scripts/` and `tools/` path are outside `packages/<pkg>/src` and so outside the scope
 *  check — a gate script printing its findings to stdout is doing its job. */
export function isDiagnosticSource(filename: string): boolean {
	const normalized = filename.replaceAll("\\", "/");
	if (!RUNTIME_SOURCE_ROOTS.some((root) => normalized.includes(root))) return false;
	return !CONSOLE_ALLOWED.some((allowed) => normalized.includes(allowed));
}

export const noUntypedConsoleRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow console.* in the runtime packages; diagnostics carry a stable dotted event name.",
		},
		messages: {
			untypedConsole:
				"`console.{{method}}` carries no event name, so this failure is not greppable in Workers Logs or the CLI journal, and its second argument is not checked for a secret. Use the typed logger: `import { diagnostics, toKinuError } from '@kinu.run/core/obs'` (relative `../obs/index.js` inside core), then `diagnostics.failure('<subsystem>.<outcome>', toKinuError({ doing, cause, otherwise }), { … })` for a handled failure, or `diagnostics.event('<subsystem>.<outcome>', { … })` for a non-failure fact. If this line is the product's OUTPUT rather than a diagnostic, it does not belong in this package — see the boundary in `no-untyped-console.ts`.",
		},
	},
	createOnce(context) {
		/** Recomputed per file rather than per node: `createOnce` reuses one visitor set across every
		 *  file the linter walks, and the scope decision depends only on the path. */
		let inScope = false;

		return {
			Program() {
				inScope = isDiagnosticSource(context.filename);
			},
			MemberExpression(node: ESTree.MemberExpression) {
				if (!inScope) return;
				if (node.object.type !== "Identifier" || node.object.name !== "console") return;
				// `console.log` and `console['log']` are the same call; a computed key whose value is not
				// a literal string has no method name to report, and `console` itself is already the
				// finding.
				const key = node.property;
				const method = key.type === "Identifier" ? key.name
					: key.type === "Literal" ? String(key.value)
					: "*";
				context.report({ node, messageId: "untypedConsole", data: { method } });
			},
		};
	},
});
