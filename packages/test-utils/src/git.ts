import { gitEnv } from './git-env';
import { runOk } from './spawn';

export { gitEnv, stripGitContext } from './git-env';

/** Run `git` inside `repo` and return stdout; `-C` plus the clean env both pin the repository. */
export async function git(repo: string, ...args: readonly string[]): Promise<string> {
  return runOk(['git', '-C', repo, ...args], { env: gitEnv() });
}

/** A repository with one commit at `repo`, identity set on the repo. */
export async function initRepo(repo: string): Promise<void> {
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'kinu@example.invalid');
  await git(repo, 'config', 'user.name', 'Kinu Test');
}
