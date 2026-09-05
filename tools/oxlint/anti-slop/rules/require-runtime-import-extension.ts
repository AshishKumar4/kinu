import { existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * A relative import must be spelled the way the runtime that loads the file resolves it.
 *
 * Nothing in this repository emits JavaScript. Every project sets `noEmit`, no `outDir` exists,
 * and all three runtimes read the TypeScript directly: Vite and wrangler bundle the Worker from
 * source, Bun runs the CLI and every suite from source, and the deploy publishes a CLI source
 * archive with a checksum rather than a build. `AGENTS.md` nonetheless mandated ".js extension
 * (ESM convention, even for .ts source files)" and produced 3,325 specifiers naming files that
 * have never existed and never will (the migration count, recorded 2026-08-18). They resolved
 * only because a bundler was willing to guess.
 *
 * A specifier is not decoration; it is the one place a module says what it depends on. When it
 * names `./x.js` and the dependency is `./x.ts`, every reader — human, `grep`, jump-to-definition,
 * and any resolver stricter than the current one — is reading a false statement, and the day the
 * resolver changes the whole tree moves at once. Measured 2026-08-18, `scripts/` had drifted to
 * 82 `.ts` against 94 `.js` with nothing to stop it, which is what a convention with no
 * enforcement looks like.
 *
 * TWO REGIMES, BECAUSE THERE ARE GENUINELY TWO RESOLVERS.
 *
 * Bundled-or-Bun code — everything Vite, wrangler or Bun loads — takes NO extension. Both resolvers
 * find `./x` for `./x.ts`, the extension carries no information, and omitting it is the only
 * spelling that is true under every one of them. `tsc` agrees: `moduleResolution: bundler` resolves
 * it, and `allowImportingTsExtensions` is deliberately absent from `tsconfig.base.json` so that a
 * stray `.ts` specifier is a type error as well as a lint error.
 *
 * The raw-Node regime keeps EXPLICIT `.ts`. `tools/oxlint/anti-slop/*` runs under
 * `node --experimental-strip-types` because oxlint's `RuleTester` needs raw transfer, which Bun
 * does not implement — running the suites under Bun throws "`RuleTester` is not supported on
 * 32-bit or big-endian systems, versions of NodeJS prior to v22.0.0, versions of Deno prior to
 * v2.0.0, or other runtimes" out of `oxlint/dist/plugins-dev.js` before a single case runs. So the
 * exception is forced, not chosen. Node's ESM resolver takes a real, complete path: it resolves
 * neither an extensionless specifier nor a directory index, so inside that regime the specifier
 * must name a file that is actually there.
 *
 * `RAW_NODE_MODULE` is the boundary, and it carries entries beyond the plugin directory because
 * `scripts/sources.ts` — the repository's single file enumeration — is imported by the plugin's
 * suites and imports `no-ambient-git-in-tests.ts` back, and the enumerator spawns git through
 * `packages/test-utils/src/git.ts`'s rebuilt environment so a hook-exported `GIT_DIR` cannot
 * re-point it. `import-extension.gate.test.ts` recomputes the transitive closure from the `node`
 * entrypoints in `package.json` and asserts it equals exactly what this pattern matches, so the
 * boundary cannot drift away from the measurement: a new import out of the plugin into another
 * file fails the gate naming that file, instead of silently widening the exception.
 *
 * The existence check is what keeps the rule honest in both directions. `.mjs` and `.cjs` fixtures,
 * `.json` data, `packages/pc-agent/src/index.js` (a genuinely CommonJS package) and the Vite
 * `?raw` text import of that same file all name files that are really on disk, and none of them is
 * a phantom build output. The rule reports a `.js` specifier only when nothing of that name exists,
 * which is precisely the defect and never the fixture.
 */

/**
 * The raw-Node regime: the anti-slop plugin, plus the files outside it that the plugin's
 * entrypoints reach. Repo-relative paths. Proven exact by `import-extension.gate.test.ts`.
 */
export const RAW_NODE_MODULE =
	/^(?:tools\/oxlint\/anti-slop\/.+\.ts|scripts\/sources\.ts|packages\/test-utils\/src\/git\.ts)$/u;

/** Extensions TypeScript would have emitted from. A specifier ending in one of these names a build
 *  output, and there are no build outputs. Set membership over `extname`, not a pattern: the
 *  question is which of four fixed extensions a specifier carries, and a regex that reads as a
 *  filename predicate is a finding in `gate-set-equality` for good reasons that do not apply here. */
const EMITTED_EXTENSION: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** TypeScript source extensions, which only the raw-Node regime may name. */
const SOURCE_EXTENSION: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts"]);

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

export const requireRuntimeImportExtensionRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Require relative import specifiers to name a module the way the loading runtime resolves it: no extension under a bundler or Bun, an explicit existing path under raw Node, and never a .js file this repository does not emit.",
		},
		messages: {
			emittedExtension:
				"`{{specifier}}` names a JavaScript file that does not exist and never will — nothing here emits, so there is no `{{missing}}` for this specifier to point at. Write `{{fix}}`: Vite, wrangler and Bun all resolve the TypeScript source directly.",
			superfluousExtension:
				"`{{specifier}}` carries a TypeScript extension, but this file is loaded by a bundler or by Bun, both of which resolve `{{fix}}`. `tsconfig.base.json` omits `allowImportingTsExtensions` for the same reason, so this is a type error too. Write `{{fix}}`.",
			nodeNeedsRealPath:
				"`{{specifier}}` does not name an existing file, and this module runs under raw `node --experimental-strip-types`, whose ESM resolver takes a complete path — it resolves neither a missing extension nor a directory index. Write the real path to the file, extension included.",
		},
	},
	createOnce(context) {
		/** Repo-relative path of the file being linted. `context.filename` is absolute against
		 *  `context.cwd`, and the two disagree about where the repository is: under `RuleTester`
		 *  both are rooted at `node_modules/oxlint`, so the pair is the only reliable way to
		 *  recover the path, and `process.cwd()` below is the only reliable repository root.
		 *  Getting this wrong would silently reclassify every file into the bundled regime. */
		const repoPath = (): string => {
			const { filename, cwd } = context;
			return isAbsolute(filename) ? relative(cwd, filename) : filename;
		};

		const check = (node: ESTree.Node | null): void => {
			if (node === null || node.type !== "Literal") return;
			const specifier = node.value;
			if (typeof specifier !== "string" || !specifier.startsWith(".")) return;

			// A bundler query (`?raw`, `?url`, `?worker`) is an asset request, not a module request:
			// it deliberately names a literal file and the existence check below is the whole test.
			const queryAt = specifier.indexOf("?");
			const path = queryAt === -1 ? specifier : specifier.slice(0, queryAt);
			const target = resolve(process.cwd(), dirname(repoPath()), path);

			if (RAW_NODE_MODULE.test(repoPath())) {
				if (isFile(target)) return;
				context.report({ node, messageId: "nodeNeedsRealPath", data: { specifier } });
				return;
			}

			const extension = extname(path);
			if (SOURCE_EXTENSION.has(extension)) {
				const fix = path.slice(0, -extension.length);
				context.report({ node, messageId: "superfluousExtension", data: { specifier, fix } });
				return;
			}
			if (!EMITTED_EXTENSION.has(extension) || isFile(target)) return;
			context.report({
				node,
				messageId: "emittedExtension",
				data: { specifier, missing: path, fix: path.slice(0, -extension.length) },
			});
		};

		return {
			ImportDeclaration: (node) => check(node.source),
			ImportExpression: (node) => check(node.source),
			ExportNamedDeclaration: (node) => check(node.source),
			ExportAllDeclaration: (node) => check(node.source),
			TSImportType: (node) => check(node.source),
		};
	},
});
