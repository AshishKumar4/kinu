/**
 * The devbox tools tarball, built on armada (D78): `bun scripts/devbox-tools.ts build` runs this task and checks what it
 * hands back against the pin in packages/devbox/block-lower/upstream.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recipe, sh, task } from 'armada';
import { gitEnv } from '../packages/test-utils/src/git-env';

const BLOCK_LOWER = join(import.meta.dirname, '..', 'packages/devbox/block-lower');

/** Where the recipe's install leaves the tarball, in the environment its tasks start from. */
const BUILD_DIR = '/home/ci/devbox-tools';

/** The block lower's own sources in this tree, as release-config.test.ts's A8 pins them (what scripts/sources.ts
 *  enumerates, which this file does not import: each container loads it): the install unpacks them, so the
 *  environment's key covers them. */
function blockLowerSources(): readonly string[] {
  const listed = execFileSync('git', ['-C', BLOCK_LOWER, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env: gitEnv(), encoding: 'utf8' });

  return [...new Set(listed.split('\0'))].filter(file => existsSync(join(BLOCK_LOWER, file)))
    .filter(file => ['Cargo.toml', 'Cargo.lock'].includes(file) || /^src\/[^/]+\.rs$/u.test(file))
    .sort((left, right) => (left < right ? -1 : 1));
}

/**
 * cloudflare/debian-trixie with every package from one day of the archive (tools-setup.sh, as root, once per
 * environment), then this tree's block lower compiled and everything packed (tools-build.sh, as the user). It reads
 * this tree, so only the machine that starts the build makes it.
 */
function toolsRecipe() {
  const unpack = blockLowerSources().map(file => `mkdir -p block-lower/${dirname(file)} && `
    + `printf %s ${readFileSync(join(BLOCK_LOWER, file)).toString('base64')} | base64 -d > block-lower/${file}`);

  return recipe.debian().size('medium')
    .setup(readFileSync(join(BLOCK_LOWER, 'tools-setup.sh'), 'utf8'))
    .install(['set -eu', `rm -rf ${BUILD_DIR} && mkdir -p ${BUILD_DIR} && cd ${BUILD_DIR}`, ...unpack, readFileSync(join(BLOCK_LOWER, 'tools-build.sh'), 'utf8')].join('\n'));
}

/** The whole tarball, as one output. */
export const devboxTools = task({
  id: 'devbox-tools',
  recipe: toolsRecipe,
  output: 'bytes',
  timeout: 900,
  run: (_: null, { out }) => sh`cp ${BUILD_DIR}/tools.tgz ${out}`,
});
