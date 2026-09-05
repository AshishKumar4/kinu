import { RuleTester } from "oxlint/plugins-dev";

import { noAmbientGitInTestsRule } from "./no-ambient-git-in-tests.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "ambientGit" };

// The rule is scoped by filename, so every case has to be given one. A case with no `filename` is
// linted as a production file and is valid by construction, which would make the whole suite
// vacuous.
const test = "packages/core/tests/thing.test.ts";
const production = "packages/core/src/thing.ts";

tester.run("anti-slop/no-ambient-git-in-tests", noAmbientGitInTestsRule, {
  valid: [
    // Production code shelling out to git runs in a workspace the user chose, where inheriting the
    // ambient repository is usually the point.
    { code: "execFileSync('git', ['status'], { cwd: repo });", filename: production },
    // `contest.ts` and `latest.ts` are not tests; the directory segment has to be
    // a whole path component.
    { code: "execFileSync('git', ['status'], { cwd: repo });", filename: "packages/core/src/contests/run.ts" },
    { code: "execFileSync('git', ['status'], { cwd: repo });", filename: "packages/core/src/evaluate.ts" },
    // The remedy.
    { code: "git(repo, 'commit', '-qm', 'seed');", filename: test },
    { code: "initRepo(repo);", filename: test },
    // An explicit env is the whole ask: the rule does not try to decide whether the env is clean,
    // because that needs types and would be guessable. Naming it means someone thought about it.
    { code: "execFileSync('git', ['add', '-A'], { cwd: repo, env: gitEnv() });", filename: test },
    { code: "Bun.spawnSync(['git', 'log'], { cwd: repo, env });", filename: test },
    { code: "spawnSync('git', ['log'], { env: {} });", filename: test },
    // Not git.
    { code: "execFileSync('bun', ['test'], { cwd: repo });", filename: test },
    { code: "spawnSync('gitk', ['--all'], { cwd: repo });", filename: test },
    // Not a spawn.
    { code: "describe('git', () => {});", filename: test },
    // A `.exec(…)` on a call result is a method on an in-process API object, never a spawn: the
    // hosted workspace shell is isomorphic-git over SQLite with no child process behind it, and its
    // `Shell` interface takes (command, stdinOrOptions) with {stdin, signal} only, so `env` cannot
    // be named at the call site.
    { code: "hosted.box('red').exec('git clone https://x');", filename: test },
    // A computed member cannot be resolved to a spawner name without types; reporting it would be a
    // guess, and the gate test asserts the live tree has none.
    { code: "child[method]('git', ['log'], { cwd: repo });", filename: test },
    // `Bun.$` names its environment through `.env()` on the chain it heads, since a tagged template
    // has no options object — behind `.nothrow()`/`.quiet()` or not.
    { code: "await Bun.$`git status`.env(gitEnv());", filename: test },
    { code: "await Bun.$`git status`.nothrow().quiet().env(gitEnv());", filename: test },
    { code: "await Bun.$`ls -la ${dir}`;", filename: test },
    // Bun's single-object form with the environment named.
    { code: "Bun.spawnSync({ cmd: ['git', 'log'], cwd: repo, env: gitEnv() });", filename: test },
    // ASSERTING about a git command line is not spawning one. This is why the `sh -c` evasion is
    // left alone: catching it means reading argument strings, and this shape is real —
    // unit-tool-call-grouping.test.ts is full of it.
    { code: "expect(describeCommand('git commit -m x')).toBe('Git commit');", filename: test },
    { code: "spawnSync('sh', ['-c', 'git commit -m seed'], { cwd: repo });", filename: test },
    // Known missed, on the record rather than rediscovered: each needs name resolution this rule
    // does not have. The gate beside this file pins the whole boundary as a CAUGHT/MISSED table.
    { code: "const bin = 'git';\nspawnSync(bin, ['status'], { cwd: repo });", filename: test },
    { code: "const execp = promisify(exec);\nawait execp('git status', { cwd: repo });", filename: test },
  ],
  invalid: [
    // The five calls that actually damaged the repository, one per shape.
    { code: "execFileSync('git', ['init', '-q'], { cwd: repo });", filename: test, errors: [error] },
    {
      code: "execFileSync('git', ['config', 'user.name', 'Kinu Test'], { cwd: repo });",
      filename: test,
      errors: [error],
    },
    { code: "execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });", filename: test, errors: [error] },
    // `cwd` alone is the defect, and so is no options object at all.
    { code: "execFileSync('git', ['status']);", filename: test, errors: [error] },
    // Array-form spawns take the program as the first element.
    { code: "Bun.spawnSync(['git', 'diff'], { cwd: repo });", filename: test, errors: [error] },
    { code: "spawnSync(['git', 'diff']);", filename: test, errors: [error] },
    // A path form runs the same binary against the same environment.
    { code: "execFileSync('/usr/bin/git', ['log'], { cwd: repo });", filename: test, errors: [error] },
    // Every spawn helper, not just the one that bit.
    { code: "execSync('git', { cwd: repo });", filename: test, errors: [error] },
    { code: "spawn('git', ['log'], { cwd: repo });", filename: test, errors: [error] },
    { code: "child_process.execFileSync('git', ['log'], { cwd: repo });", filename: test, errors: [error] },
    // `.test.tsx`, `.test.mts` and friends are test files too.
    { code: "execFileSync('git', ['log'], { cwd: repo });", filename: "a/b.test.tsx", errors: [error] },
    { code: "execFileSync('git', ['log'], { cwd: repo });", filename: "a/b.test.mts", errors: [error] },
    // The eval tier, which does not exist yet: `vitest-evals` suites are
    // conventionally `*.eval.ts` under their own config, and agent evals copy a
    // fixture into an isolated worktree per task — a git spawn in a file a
    // `.test.` pattern would never have looked at.
    { code: "execFileSync('git', ['worktree', 'add', dir], { cwd: repo });", filename: "tests/evals/agent.eval.ts", errors: [error] },
    { code: "spawnSync(['git', 'clone', url]);", filename: "a/b.spec.ts", errors: [error] },
    // A fixture under a tests/ directory, whatever it is called.
    { code: "execFileSync('git', ['init']);", filename: "packages/core/tests/helpers/repo.ts", errors: [error] },
    { code: "execFileSync('git', ['init']);", filename: "packages/cf-backend/tests/fixtures/seed.ts", errors: [error] },
    { code: "execFileSync('git', ['init']);", filename: "a/__tests__/helper.ts", errors: [error] },
    // A computed `env` key is not an `env` option the reader can see.
    { code: "execFileSync('git', ['log'], { [key]: gitEnv() });", filename: test, errors: [error] },
    // Bun's single-object form. This was the one live site in the tree the rule could not see:
    // cc-corpus.test.ts asking `git check-ignore` whether the owner's mined transcripts are
    // ignored, with `cwd` and nothing else — and `cwd` does not decide that question.
    { code: "Bun.spawnSync({ cmd: ['git', 'check-ignore', '-q', p], cwd: repoRoot });", filename: test, errors: [error] },
    { code: "Bun.spawn({ cmd: ['git', 'fetch'] });", filename: test, errors: [error] },
    // The shell family takes a command LINE, so the program is its first token. Without that,
    // `execSync('git status')` read as a program named "git status" and was certified clean.
    { code: "execSync('git status', { cwd: repo });", filename: test, errors: [error] },
    { code: "execSync(`git rev-parse HEAD`, { cwd: repo });", filename: test, errors: [error] },
    { code: "spawnSync('git status', { shell: true, cwd: repo });", filename: test, errors: [error] },
    // The carve-out is the chained receiver only: a bare `exec`, `Bun.$`, and a member spawn with
    // a plain receiver still fire.
    { code: "exec('git clone https://x');", filename: test, errors: [error] },
    { code: "await Bun.$`git clone x`;", filename: test, errors: [error] },
    { code: "child_process.execSync('git status');", filename: test, errors: [error] },
    // `Bun.$` cannot carry an options object, so a chain that never reaches `.env()` is ambient.
    { code: "await Bun.$`git commit -m seed`;", filename: test, errors: [error] },
    { code: "await Bun.$`git status`.nothrow().quiet();", filename: test, errors: [error] },
  ],
});
