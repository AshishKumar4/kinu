import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * A test that spawns `git` without clearing the inherited git environment.
 *
 * `cwd` is not isolation. Git reads `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 * and every one of them OUTRANKS the working directory. A git hook exports
 * several. So a fixture written as
 * `execFileSync("git", ["commit"], { cwd: scratch })` is correct when the suite
 * is run by hand and operates on the developer's real checkout under
 * `pre-commit` or `pre-push`.
 *
 * Measured 2026-08-17, not hypothetical. `core/tests/unit-workspace-diff.test.ts`
 * ran `git init`, `git config user.email`, `git config user.name` and
 * `git commit -qm seed` against the real repository during `git push`. It left
 * commits named `seed` on the branch being pushed, set `user.name=Proteus Test`
 * repo-wide, and set `core.bare=true` alongside `core.worktree`, which made the
 * primary checkout answer `fatal: unable to set up work tree using invalid
 * config` to every command. Ten commits reached main under the wrong author
 * before anyone noticed, and the suite passed every time it was run directly.
 *
 * Two fixes repaired the two known sites. Neither makes a third impossible, and
 * a safeguard that only covers the instances already found is the shape this
 * repository has shipped repeatedly. Hence a rule.
 *
 * The remedy is `git()` / `gitEnv()` / `initRepo()` from `@proteus/test-utils`,
 * which REMOVE the variables rather than blanking them — an empty `GIT_DIR` is
 * still a `GIT_DIR`, and git resolves the repository to the empty path.
 *
 * Scope is test files only. Production code that shells out to git is running
 * in a workspace the user chose, where inheriting the ambient repository is
 * frequently the point.
 */

const GIT_SPAWNERS: ReadonlySet<string> = new Set([
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
	"spawn",
	"spawnSync",
]);

/**
 * What counts as test code. Two independent shapes, because either alone leaves
 * a hole:
 *
 *   a `.test.` / `.eval.` / `.spec.` segment in the basename, and
 *   anything under a `tests/`, `test/` or `__tests__/` directory.
 *
 * `.eval.` is here before a single eval file exists, on report from two peers
 * building that tier: `vitest-evals` suites are conventionally `*.eval.ts` under
 * their own config so they do not run on every `bun test`, and agent evals
 * copy fixtures into an isolated worktree PER TASK — which is a git spawn, in a
 * file a `.test.` pattern would never have looked at.
 *
 * The first version of this rule matched `.test.` only, and its gate scanned
 * `packages` while `bun run lint` scanned the repo. That gap held three real
 * sites. The durable form of that lesson is not "check your denominator" but:
 * THE SET A GATE MEASURES AND THE SET IT GOVERNS MUST BE THE SAME SET, AND THAT
 * EQUALITY HAS TO BE THE ASSERTION. Widening here, and widening the gate's live
 * scan to `.`, is that equality — so a directory convention nobody has adopted
 * yet cannot open the hole again.
 */
export const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|eval|spec)\.[cm]?[jt]sx?$/;

/** The first argument's literal string, for the two shapes a spawn takes it in:
 *  `spawn("git", […])` and `spawn(["git", …])`. */
function spawnedProgram(node: ESTree.CallExpression): string | null {
	const [first] = node.arguments;
	if (first === undefined) return null;
	if (first.type === "Literal") return typeof first.value === "string" ? first.value : null;
	if (first.type !== "ArrayExpression") return null;
	const [head] = first.elements;
	if (head === null || head === undefined || head.type !== "Literal") return null;
	return typeof head.value === "string" ? head.value : null;
}

/** `git`, however it is spelled as a program name. A path form still runs the
 *  same binary against the same environment. */
function isGit(program: string): boolean {
	const name = program.split("/").at(-1);
	return name === "git" || name === "git.exe";
}

const spawnerName = (callee: ESTree.Expression): string | null => {
	if (callee.type === "Identifier") return callee.name;
	// `Bun.spawnSync(…)`, `child_process.execFileSync(…)`.
	if (!("property" in callee) || !("computed" in callee) || callee.computed) return null;
	return callee.property.type === "Identifier" ? callee.property.name : null;
};

/** True when the call passes an `env` option. The rule does not try to decide
 *  whether that env is CLEAN — that needs types and would be guessable. Naming
 *  `env` at the spawn site is the whole ask: it is the difference between having
 *  thought about the ambient environment and not. */
function passesEnv(node: ESTree.CallExpression): boolean {
	return node.arguments.some(
		(argument) =>
			argument.type === "ObjectExpression" &&
			argument.properties.some(
				(property) =>
					property.type === "Property" &&
					!property.computed &&
					((property.key.type === "Identifier" && property.key.name === "env") ||
						(property.key.type === "Literal" && property.key.value === "env")),
			),
	);
}

export const noAmbientGitInTestsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow spawning git from a test without an explicit environment; the inherited GIT_DIR outranks cwd and redirects the call at the real repository.",
		},
		messages: {
			ambientGit:
				"This spawns `git` from a test with the ambient environment. GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE all outrank `cwd`, and a git hook exports them — under `pre-push` this runs against the real checkout, not the scratch repo. It has already left junk commits on a branch and set core.bare on the primary checkout. Use `git()` / `initRepo()` from `@proteus/test-utils`, which remove those variables (removing, not blanking: an empty GIT_DIR is still a GIT_DIR).",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (!TEST_FILE.test(context.filename)) return;
				if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
				const spawner = spawnerName(node.callee);
				if (spawner === null || !GIT_SPAWNERS.has(spawner)) return;
				const program = spawnedProgram(node);
				if (program === null || !isGit(program)) return;
				if (passesEnv(node)) return;
				context.report({ node, messageId: "ambientGit" });
			},
		};
	},
});
