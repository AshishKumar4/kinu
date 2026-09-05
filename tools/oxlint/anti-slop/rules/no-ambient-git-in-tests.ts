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
 * commits named `seed` on the branch being pushed, overwrote `user.name`
 * repo-wide, and set `core.bare=true` alongside `core.worktree`, which made the
 * primary checkout answer `fatal: unable to set up work tree using invalid
 * config` to every command. Ten commits reached main under the wrong author
 * before anyone noticed, and the suite passed every time it was run directly.
 *
 * Two fixes repaired the two known sites. Neither makes a third impossible, and
 * a safeguard that only covers the instances already found is the shape this
 * repository has shipped repeatedly. Hence a rule.
 *
 * The remedy is `git()` / `gitEnv()` / `initRepo()` from `@kinu.run/test-utils`,
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

/** The basename arm: a `.test.` / `.eval.` / `.spec.` segment. What a test
 *  RUNNER selects, which is strictly less than what this rule governs. */
export const TEST_SUFFIX = /\.(test|eval|spec)\.[cm]?[jt]sx?$/;

/** The directory arm: a whole `tests/`, `test/` or `__tests__/` path component,
 *  so `src/contests/run.ts` and `src/latest/x.ts` are not tests. */
export const TEST_DIRECTORY = /(^|\/)(tests?|__tests__)\//;

/**
 * What counts as test code. Both arms, because either alone leaves a hole, and
 * COMPOSED from the two above rather than spelled a third time.
 *
 * `.eval.` is here before a single eval file exists, on report from two peers
 * building that tier: `vitest-evals` suites are conventionally `*.eval.ts` under
 * their own config so they do not run on every `bun test`, and agent evals copy
 * fixtures into an isolated worktree PER TASK — which is a git spawn, in a file
 * a `.test.` pattern would never have looked at. The directory arm matters on
 * its own: a package's own `tests/helpers/` holds repo-building code with no test
 * suffix at all.
 *
 * The first version of this rule matched `.test.` only, and its gate scanned
 * `packages` while `bun run lint` scanned the repo. That gap held three real
 * sites. The durable form of that lesson is not "check your denominator" but:
 * THE SET A GATE MEASURES AND THE SET IT GOVERNS MUST BE THE SAME SET, AND THAT
 * EQUALITY HAS TO BE THE ASSERTION. Widening here, widening the gate's live scan
 * to `.`, and naming the arms so a narrower consumer imports one instead of
 * copying it, are all that same equality. `scripts/gate-set-equality.ts` is what
 * now enforces it across every gate rather than in this file alone.
 */
export const TEST_FILE = new RegExp(`${TEST_DIRECTORY.source}|${TEST_SUFFIX.source}`);

/** The first argument's literal program name, for the three shapes a spawn takes
 *  it in: `spawn("git", […])`, `spawn(["git", …])` and Bun's single-object
 *  `Bun.spawnSync({ cmd: ["git", …] })`.
 *
 *  The object form was missing until an adversarial pass found the only live site
 *  in the tree that this rule could not see — `packages/cli/tests/cc-corpus.test.ts`
 *  asking `git check-ignore` whether the owner's mined sessions are ignored, with
 *  `cwd` and nothing else. `cwd` did not protect it: with GIT_DIR pointed at
 *  another repository the same question answers NOT-IGNORED. A matcher that knows
 *  two of a runtime's three spellings certifies zero over the third. */
function spawnedProgram(node: ESTree.CallExpression): string | null {
	const [first] = node.arguments;
	if (first === undefined) return null;
	if (first.type === "Literal") return typeof first.value === "string" ? first.value : null;
	if (first.type === "TemplateLiteral") return first.quasis[0]?.value.cooked ?? null;
	const list = first.type === "ObjectExpression" ? commandArray(first) : first;
	if (list === null || list.type !== "ArrayExpression") return null;
	const [head] = list.elements;
	if (head === null || head === undefined || head.type !== "Literal") return null;
	return typeof head.value === "string" ? head.value : null;
}

/** Bun's `cmd` array, which carries the program in the same first position. */
function commandArray(options: ESTree.ObjectExpression): ESTree.Node | null {
	for (const entry of options.properties) {
		if (entry.type !== "Property" || entry.computed) continue;
		const named =
			(entry.key.type === "Identifier" && entry.key.name === "cmd") ||
			(entry.key.type === "Literal" && entry.key.value === "cmd");
		if (named) return entry.value;
	}
	return null;
}

/** `git`, however it is spelled as a program name. A path form still runs the
 *  same binary against the same environment, and `exec`/`execSync` take a whole
 *  command line rather than a program, so the program is the first token. Without
 *  that, `execSync("git status")` — the natural spelling of the shell family, and
 *  the same call with `shell: true` — read as a program literally named
 *  "git status" and were certified clean. */
function isGit(program: string): boolean {
	const name = program.trim().split(/\s+/u)[0]?.split("/").at(-1);
	return name === "git" || name === "git.exe";
}

/** `Bun.$` takes no options object, so `.env()` in the chain it heads is the only
 *  place the environment can be named — possibly behind `.nothrow()`/`.quiet()`.
 *  Walking parents is safe here because oxlint hands plugin rules linked nodes. */
function chainNamesEnv(tagged: ESTree.TaggedTemplateExpression): boolean {
	let node: ESTree.Node = tagged;
	while (node.parent?.type === "MemberExpression" && node.parent.object === node) {
		const member: ESTree.MemberExpression = node.parent;
		const call: ESTree.Node | null = member.parent;
		if (call?.type !== "CallExpression" || call.callee !== member) return false;
		if (!member.computed && member.property.type === "Identifier" && member.property.name === "env") {
			return true;
		}
		node = call;
	}
	return false;
}

const spawnerName = (callee: ESTree.Expression): string | null => {
	if (callee.type === "Identifier") return callee.name;
	// `Bun.spawnSync(…)`, `child_process.execFileSync(…)`.
	if (!("property" in callee) || !("computed" in callee) || callee.computed) return null;
	return callee.property.type === "Identifier" ? callee.property.name : null;
};
/** A `.exec(…)` whose receiver is itself a call result (`hosted.box('x').exec(…)`)
 *  is a method on whatever that call returned, never one of the spawners above.
 *  The hosted workspace shell is isomorphic-git in-process over SQLite — no child
 *  process exists — and its `Shell` interface takes `(command, stdinOrOptions)`
 *  with `{stdin, signal}` only, so naming `env` at the call site is structurally
 *  inapplicable. Bare `exec(…)` and plain receivers (`child_process.exec(…)`)
 *  still reach the matcher below. */
function isChainedExec(node: ESTree.CallExpression): boolean {
	return (
		node.callee.type === "MemberExpression" &&
		!node.callee.computed &&
		node.callee.property.type === "Identifier" &&
		node.callee.property.name === "exec" &&
		node.callee.object.type === "CallExpression"
	);
}

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

/**
 * KNOWN MISSED, deliberately, so the next reader inherits the boundary instead of
 * rediscovering it. Measured by seeding each form into a linted test file and
 * reading oxlint's diagnostics, not by reasoning about the matcher:
 *
 *   `const bin = 'git'; spawnSync(bin, …)`      — program is a binding, not a literal
 *   `import { execFileSync as run }; run('git')` — spawner is a local alias
 *   `promisify(exec)('git status')`              — spawner is a returned function
 *   `spawnSync('sh', ['-c', 'git commit …'])`    — program is `sh`
 *   `hosted.box('x').exec('git clone …')`        — receiver is a call result, not a spawner
 *
 * The first three need name resolution this rule does not have, and the fourth
 * needs to read shell strings inside argument arrays — which would fire on every
 * test that merely ASSERTS about a git command line, of which this repo has
 * several (`unit-tool-call-grouping.test.ts` expects `describeCommand('git commit
 * -m "fix"')`). The fifth is the price of the chained-`.exec` carve-out above: a
 * real spawn spelled as a method on a call result is indistinguishable from the
 * hosted shell without types. Each is a narrower hole than the ones closed
 * above, and none is worth a matcher that cries wolf. The gate beside this rule
 * pins this list as a CAUGHT/MISSED table so a regression in either direction is
 * visible.
 */

export const noAmbientGitInTestsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow spawning git from a test without an explicit environment; the inherited GIT_DIR outranks cwd and redirects the call at the real repository.",
		},
		messages: {
			ambientGit:
				"This spawns `git` from a test with the ambient environment. GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE all outrank `cwd`, and a git hook exports them — under `pre-push` this runs against the real checkout, not the scratch repo. It has already left junk commits on a branch and set core.bare on the primary checkout. Use `git()` / `initRepo()` from `@kinu.run/test-utils`, which remove those variables (removing, not blanking: an empty GIT_DIR is still a GIT_DIR).",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (!TEST_FILE.test(context.filename)) return;
				if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
				if (isChainedExec(node)) return;
				const spawner = spawnerName(node.callee);
				if (spawner === null || !GIT_SPAWNERS.has(spawner)) return;
				const program = spawnedProgram(node);
				if (program === null || !isGit(program)) return;
				if (passesEnv(node)) return;
				context.report({ node, messageId: "ambientGit" });
			},
			// `Bun.$` is a tagged template with no options object at all, so it can
			// only name its environment through `.env()` on the chain it heads.
			TaggedTemplateExpression(node) {
				if (!TEST_FILE.test(context.filename)) return;
				if (spawnerName(node.tag) !== "$") return;
				const program = node.quasi.quasis[0]?.value.cooked ?? null;
				if (program === undefined || program === null || !isGit(program)) return;
				if (chainNamesEnv(node)) return;
				context.report({ node, messageId: "ambientGit" });
			},
		};
	},
});
