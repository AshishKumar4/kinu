import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isShippedSource } from "../../../../scripts/sources.ts";

/**
 * A synchronous spawn in shipped source.
 *
 * While Bun's `spawnSync` waits, it runs the child in an event loop of its own. A collection that lands inside that
 * wait can finalize something the main loop polls (on 2026-09-24, an earlier stderr FileSink) and release it against
 * the private loop instead, and from then on a later synchronous spawn spins at 100% CPU over a zombie child, for
 * good (oven-sh/bun#34069; reproduced on 1.4.0 and 1.4.2). The CLI suite wedged that way, and the device daemon
 * and the CLI run the same calls on users' machines, where a wedge is a machine that goes dark with no error. So
 * shipped code spawns asynchronously and awaits the child's exit, or reads what the kernel already answers (`/proc`
 * on Linux).
 *
 * Shipped source is `isShippedSource` in scripts/sources.ts: every package's `src` but `test-utils`, the suites'
 * own helpers. Tests are outside it.
 *
 * KNOWN MISSED: a spawner reached through a binding this rule does not follow (`const run = cp.execFileSync`, a
 * module that re-exports one), `await import('node:child_process')`, and `process.binding`.
 */

const SYNC_SPAWNERS: ReadonlySet<string> = new Set(["spawnSync", "execSync", "execFileSync"]);

const CHILD_PROCESS: ReadonlySet<string> = new Set(["child_process", "node:child_process"]);

/** Shipped source by the enumeration's own predicate, asked of the path from its `packages/` root. */
function inScope(filename: string): boolean {
	const normalized = `/${filename.replaceAll("\\", "/")}`;
	const root = normalized.lastIndexOf("/packages/");

	return root !== -1 && isShippedSource(normalized.slice(root + 1));
}

/** `require("child_process")`, either spelling. */
function requiresChildProcess(node: ESTree.Node | null | undefined): boolean {
	if (node?.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "require") return false;
	const [specifier] = node.arguments;

	return specifier?.type === "Literal" && typeof specifier.value === "string" && CHILD_PROCESS.has(specifier.value);
}

/** The name a member expression reads, when it is spelled out. */
function memberName(node: ESTree.MemberExpression): string | null {
	if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;

	return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : null;
}

/** The name a destructured property reads, when it is spelled out. */
function propertyKey(property: ESTree.Node): string | null {
	if (property.type !== "Property" || property.computed) return null;

	if (property.key.type === "Identifier") return property.key.name;

	return property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : null;
}

export const noSyncSpawnRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow synchronous spawns in shipped source: under Bun a collection inside one can wedge the process at 100% CPU for good.",
		},
		messages: {
			syncSpawn:
				"`{{name}}` spawns synchronously. While Bun waits on it, a collection can finalize a poll the main loop owns (a stderr FileSink on 2026-09-24) against the wait's own loop, and a later synchronous spawn then spins at 100% CPU over a zombie child for good (oven-sh/bun#34069). Spawn asynchronously and await the child's exit (`Bun.spawn` and `await child.exited`, or `execFile` with a callback), or read what the kernel answers (`/proc` on Linux).",
		},
	},
	createOnce(context) {
		let governed = false;
		/** Local names bound to the module itself: `import * as cp`, `import cp`, `const cp = require(...)`. */
		let modules = new Set<string>();
		/** `cp.spawnSync` on a local name, judged once every binding in the file has been seen. */
		let reads: { readonly node: ESTree.MemberExpression; readonly object: string; readonly name: string }[] = [];

		return {
			Program() {
				governed = inScope(context.filename);
				modules = new Set();
				reads = [];
			},
			ImportDeclaration(node) {
				if (!governed || typeof node.source.value !== "string" || !CHILD_PROCESS.has(node.source.value)) return;

				for (const specifier of node.specifiers) {
					if (specifier.type !== "ImportSpecifier") {
						modules.add(specifier.local.name);
						continue;
					}

					const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);

					if (SYNC_SPAWNERS.has(imported)) context.report({ node: specifier, messageId: "syncSpawn", data: { name: imported } });
				}
			},
			VariableDeclarator(node) {
				if (!governed || !requiresChildProcess(node.init)) return;

				if (node.id.type === "Identifier") {
					modules.add(node.id.name);

					return;
				}

				if (node.id.type !== "ObjectPattern") return;

				for (const property of node.id.properties) {
					const name = propertyKey(property);

					if (name !== null && SYNC_SPAWNERS.has(name)) context.report({ node: property, messageId: "syncSpawn", data: { name } });
				}
			},
			MemberExpression(node) {
				if (!governed) return;
				const name = memberName(node);

				if (name === null || !SYNC_SPAWNERS.has(name)) return;

				if ((node.object.type === "Identifier" && node.object.name === "Bun") || requiresChildProcess(node.object)) {
					context.report({ node, messageId: "syncSpawn", data: { name } });
				} else if (node.object.type === "Identifier") {
					reads.push({ node, object: node.object.name, name });
				}
			},
			"Program:exit"() {
				for (const { node, object, name } of reads) {
					if (modules.has(object)) context.report({ node, messageId: "syncSpawn", data: { name } });
				}
			},
		};
	},
});
