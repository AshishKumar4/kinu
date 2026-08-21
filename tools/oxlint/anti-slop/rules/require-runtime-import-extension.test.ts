// Proteus-local rule; see upstream.json's `proteusRules`. There is no upstream suite beside this
// one. The repo-wide census, the boundary-equality proof and the seeded red->green run through the
// real `oxlint` binary live in ../import-extension.gate.test.ts.
//
// Every case carries a `filename`, because the filename is what selects the regime, and the paths
// used for the existence checks are REAL files in this checkout — `./no-empty-catch.ts` beside the
// rule, `packages/pc-agent/src/index.js` as the one genuinely-CommonJS module. A fixture invented
// out of thin air would test the rule against a filesystem that does not exist, which is the
// mistake the rule itself is about.
import { RuleTester } from "oxlint/plugins-dev";

import { requireRuntimeImportExtensionRule } from "./require-runtime-import-extension.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

/** Bundled-or-Bun regime: every package's `src`, `tests/`, and the part of `scripts/` outside the
 *  raw-Node closure. */
const bundled = "packages/core/src/mcts/search.ts";
/** Raw-Node regime: `node --experimental-strip-types` loads this file. */
const rawNode = "tools/oxlint/anti-slop/rules/no-empty-catch.ts";

const emitted = { messageId: "emittedExtension" };
const superfluous = { messageId: "superfluousExtension" };
const needsPath = { messageId: "nodeNeedsRealPath" };

tester.run("anti-slop/require-runtime-import-extension", requireRuntimeImportExtensionRule, {
	valid: [
		// The bundled/Bun rule: no extension.
		{ code: 'import { search } from "./tree";', filename: bundled },
		{ code: 'export { node } from "../record-node";', filename: bundled },
		{ code: 'export * from "./types";', filename: bundled },
		{ code: 'const m = await import("./lazy");', filename: bundled },
		{ code: 'type T = import("../heads/types").Head;', filename: bundled },
		{ code: 'import "./register";', filename: bundled },
		// A bare package specifier is the package manager's business, not this rule's.
		{ code: 'import { z } from "zod";', filename: bundled },
		{ code: 'import { Agent } from "@kinu.run/core/obs";', filename: bundled },
		{ code: 'import { readFileSync } from "node:fs";', filename: bundled },
		// Extensions that name something other than a phantom build output.
		{ code: 'import data from "./corpus.json" with { type: "json" };', filename: bundled },
		{ code: 'import "./style.css";', filename: bundled },
		// A real CommonJS module, which pc-agent genuinely is: the file is on disk under that
		// exact name, so the specifier is true.
		{
			code: 'import daemon from "../../pc-agent/src/index.js";',
			filename: "packages/cli-backend/tests/checkpoint-parity.test.ts",
		},
		// Vite's `?raw` text import of that same real file. An asset request, not a module request.
		{
			code: 'import SOURCE from "../../pc-agent/src/index.js?raw";',
			filename: "packages/cf-backend/src/pc-handler.ts",
		},
		// Raw-Node regime: a complete path to a file that is really there.
		{ code: 'import { defineRule } from "@oxlint/plugins";', filename: rawNode },
		{ code: 'import { noDdlInCatchRule } from "./no-ddl-in-catch.ts";', filename: rawNode },
		{
			code: 'import { trackedFiles } from "../../../scripts/sources.ts";',
			filename: "tools/oxlint/anti-slop/gate.test.ts",
		},
		// scripts/sources.ts is inside the closure — the plugin's suites import it — so it takes the
		// raw-Node rule even though every other file in scripts/ does not.
		{
			code: 'import { TEST_FILE } from "../tools/oxlint/anti-slop/rules/no-ambient-git-in-tests.ts";',
			filename: "scripts/sources.ts",
		},
		// ...and its neighbours in scripts/ are Bun-run, so they take the bundled rule.
		{ code: 'import { trackedFiles } from "./sources";', filename: "scripts/dead-code.ts" },
	],
	invalid: [
		{
			name: "the convention AGENTS.md mandated: a .js specifier for a .ts module",
			code: 'import { search } from "./tree.js";',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "a re-export is a specifier too — 462 of these were in cf-backend alone",
			code: 'export { RecordNode } from "../mcts/record-node.js";',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "export * from",
			code: 'export * from "./types.js";',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "a dynamic import resolves at runtime, where the lie actually costs something",
			code: 'const m = await import("./lazy.js");',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "a type-level import(): eleven of these were in the tree",
			code: 'type T = import("../heads/types.js").Head;',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "a side-effect-only import",
			code: 'import "./register.js";',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "a directory index spelled as a build output",
			code: 'import { hub } from "./events/hub/index.js";',
			filename: bundled,
			errors: [emitted],
		},
		{
			name: "the other half of the drift: scripts/ was 82 .ts against 94 .js",
			code: 'import { trackedFiles } from "./sources.ts";',
			filename: "scripts/dead-code.ts",
			errors: [superfluous],
		},
		{
			name: "a .tsx specifier under a bundler is the same defect",
			code: 'import { Panel } from "./panel.tsx";',
			filename: "packages/cli/src/app.tsx",
			errors: [superfluous],
		},
		{
			name: "both regimes' defects in one file are both reported",
			code: 'import a from "./tree.js";\nimport b from "./leaf.ts";',
			filename: bundled,
			errors: [emitted, superfluous],
		},
		{
			name: "extensionless under raw Node: the ESM resolver will not find it",
			code: 'import { noDdlInCatchRule } from "./no-ddl-in-catch";',
			filename: rawNode,
			errors: [needsPath],
		},
		{
			name: "a directory index under raw Node: the ESM resolver does not do index files",
			code: 'import { rules } from "./rules";',
			filename: "tools/oxlint/anti-slop/index.ts",
			errors: [needsPath],
		},
		{
			name: "a .js specifier under raw Node names a file that is not there either",
			code: 'import { noDdlInCatchRule } from "./no-ddl-in-catch.js";',
			filename: rawNode,
			errors: [needsPath],
		},
		{
			name: "a .ts specifier under raw Node that points at nothing",
			code: 'import { gone } from "./no-such-rule.ts";',
			filename: rawNode,
			errors: [needsPath],
		},
		{
			name: "scripts/sources.ts is held to the raw-Node rule, unlike the rest of scripts/",
			code: 'import { TEST_FILE } from "../tools/oxlint/anti-slop/rules/no-ambient-git-in-tests";',
			filename: "scripts/sources.ts",
			errors: [needsPath],
		},
	],
});
