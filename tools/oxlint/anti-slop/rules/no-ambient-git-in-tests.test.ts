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
    // A computed member cannot be resolved to a spawner name without types; reporting it would be a
    // guess, and the gate test asserts the live tree has none.
    { code: "child[method]('git', ['log'], { cwd: repo });", filename: test },
  ],
  invalid: [
    // The five calls that actually damaged the repository, one per shape.
    { code: "execFileSync('git', ['init', '-q'], { cwd: repo });", filename: test, errors: [error] },
    {
      code: "execFileSync('git', ['config', 'user.name', 'Proteus Test'], { cwd: repo });",
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
    // A computed `env` key is not an `env` option the reader can see.
    { code: "execFileSync('git', ['log'], { [key]: gitEnv() });", filename: test, errors: [error] },
  ],
});
