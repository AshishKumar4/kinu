/**
 * The workspace's git remotes on github.com, read from each repository's own `.git/config` in the workspace's files.
 * Read off the file system, not a shell: an overview must never wait on, or ask for, a command.
 */
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import { attempt, diagnostics, settle } from '../obs/index';
import { githubRepoOfRemote } from './recognize';

/** As deep as the Changes pane looks for repositories, and no further than a bounded walk. */
const DEPTH = 4;

const FOLDER_LIMIT = 400;

/** Each distinct `owner/name` a config's `url =` lines name on github.com. */
function githubReposOfGitConfig(text: string): readonly string[] {
  const repos = text.split('\n').flatMap((line) => {
    const url = /^\s*(?:push)?url\s*=\s*(.+?)\s*$/u.exec(line)?.[1];
    const repo = url === undefined ? null : githubRepoOfRemote(url);

    return repo === null ? [] : [repo];
  });

  return [...new Set(repos)];
}

/** An unreadable folder is passed over, never hiding the rest. */
const quietly = <A>(doing: string, run: () => PromiseLike<A>, otherwise: A): Effect.Effect<A> =>
  attempt({ doing, otherwise: 'unavailable' }, run).pipe(Effect.catch((failed) => Effect.sync(() => {
    diagnostics.failure('github.remote_read_skipped', failed);

    return otherwise;
  })));

/** `root` and below, past hidden folders and node_modules, as the Changes pane looks. */
export function readGitHubRemotes(vfs: Pick<VFS, 'readdir' | 'readFile'>, root: string): Promise<readonly string[]> {
  return settle(Effect.gen(function* () {
    const repos = new Set<string>();
    let level = [root];
    let visited = 0;

    for (let depth = 0; depth <= DEPTH && level.length > 0 && visited < FOLDER_LIMIT; depth += 1) {
      const next: string[] = [];

      for (const folder of level) {
        if (visited >= FOLDER_LIMIT) break;
        visited += 1;
        const entries = yield* quietly(`listing ${folder}`, async () => vfs.readdir(folder), []);

        if (entries.some((entry) => entry.name === '.git' && entry.type === 'directory')) {
          const config = yield* quietly(`reading ${folder}/.git/config`, async () => new TextDecoder().decode(await vfs.readFile(`${folder}/.git/config`)), '');

          for (const repo of githubReposOfGitConfig(config)) repos.add(repo);
        }

        for (const entry of entries) {
          if (entry.type === 'directory' && !entry.name.startsWith('.') && entry.name !== 'node_modules') next.push(`${folder}/${entry.name}`);
        }
      }

      level = next;
    }

    return [...repos];
  }));
}
