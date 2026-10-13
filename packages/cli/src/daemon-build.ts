/**
 * The device daemon as it installs: each of its files bundled with the core modules it requires, its siblings left as
 * siblings, so the installed files are the release's own names (scripts/build-cli-dist.sh) and the daemon loads with
 * nothing beside it but them. The release builds them once; a source-tree `kinu connect` builds them the same way.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Effect } from 'effect';
import { attempt, KinuError } from '@kinu.run/core/obs';

export interface DaemonFiles {
  /** The daemon, which installs as `pc-agent.js`. */
  readonly daemon: string;
  /** Every file the daemon requires beside itself. */
  readonly siblings: readonly { readonly name: string; readonly source: string }[];
}

/** `./<name>.js` or `./<name>.json`: a daemon file requiring a sibling. */
const SIBLING = /^\.\/[^/]+\.(?:js|json)$/u;

/** The line Bun writes above each bundled module: its path from the building process's directory. */
const MODULE_LINE = /^\/\/ (\S+\.(?:js|ts))$/gmu;

/** `text` with each module line naming its path from the repository, so a build reads alike from any directory. */
function fromRepository(text: string, source: string): string {
  const repository = join(source, '..', '..', '..');

  return text.replace(MODULE_LINE, (_line, path: string) => `// ${relative(repository, resolve(path))}`);
}

/** Builds every daemon file in `source` (this tree's daemon by default), `index.js` the daemon. */
export function buildDaemonFiles(source: string = join(import.meta.dir, '..', '..', 'pc-agent', 'src')): Effect.Effect<DaemonFiles, KinuError> {
  const names = readdirSync(source).filter((name) => name.endsWith('.js') || name.endsWith('.json')).sort();

  return Effect.gen(function* () {
    const built = yield* attempt({ doing: 'building the device daemon', otherwise: 'io' }, () => Bun.build({
      entrypoints: names.filter((name) => name.endsWith('.js')).map((name) => join(source, name)),
      target: 'bun',
      format: 'cjs',
      plugins: [{
        name: 'daemon-siblings',
        setup(build) {
          // A sibling stays its own file, landed beside the daemon; what a core module imports is bundled in.
          build.onResolve({ filter: SIBLING }, (args) => (args.importer.startsWith(`${source}/`) ? { path: args.path, external: true } : undefined));
        },
      }],
    }));

    if (!built.success) return yield* Effect.fail(new KinuError('io', `the device daemon does not build: ${built.logs.map(String).join('; ')}`));

    const texts = new Map(yield* attempt({ doing: 'reading the built device daemon', otherwise: 'io' }, () => Promise.all(
      built.outputs.map(async (output) => [output.path.slice(output.path.lastIndexOf('/') + 1), fromRepository(await output.text(), source)] as const),
    )));

    const file = (name: string): Effect.Effect<{ readonly name: string; readonly source: string }, KinuError> => {
      const text = name.endsWith('.json') ? readFileSync(join(source, name), 'utf8') : texts.get(name);

      return text === undefined ? Effect.fail(new KinuError('io', `the device daemon's build wrote no ${name}`)) : Effect.succeed({ name, source: text });
    };

    const daemon = yield* file('index.js');
    const siblings = yield* Effect.forEach(names.filter((name) => name !== 'index.js'), file);

    return { daemon: daemon.source, siblings };
  });
}
