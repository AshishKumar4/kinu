import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolsInstallCommand } from '../../src/tools';
import { dockerBuild } from './docker-build';

/** The managed base a golden installs the tools on (D66). */
export const TRIXIE = 'docker.io/library/debian@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c';

/** Build the same native probe and lower the deployed image contains. */
export function buildBlockImage(image: string): void {
  const result = dockerBuild(image, join(import.meta.dir, '../../block-lower'));

  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

/** The `tools` stage's tarball, written to `destination/tools.tgz` (D65). */
export function buildToolsArchive(destination: string): void {
  const result = spawnSync('docker', ['build', '--network=host', '--target', 'tools', '--output', `type=local,dest=${destination}`, join(import.meta.dir, '../../block-lower')],
    { encoding: 'utf8' });

  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

/**
 * Trixie with the tools tarball installed with no network, tagged `image`; returns the tarball's hash. The
 * install is a build step, so BuildKit runs it once per tarball and every later or concurrent build reuses it:
 * alone it takes 82 s, and six at once on this host's Docker disk took 560 to 590 s each (2026-10-04).
 */
export function buildToolsImage(image: string, scratch: string): string {
  buildToolsArchive(scratch);
  const hash = createHash('sha256').update(readFileSync(join(scratch, 'tools.tgz'))).digest('hex');
  writeFileSync(join(scratch, 'install.sh'), toolsInstallCommand('/tmp/tools.tgz', hash));

  const result = spawnSync('docker', ['build', '--network=none', '--tag', image, '--file', '-', scratch], {
    input: `FROM ${TRIXIE}\nCOPY tools.tgz install.sh /tmp/\nRUN bash /tmp/install.sh\n`, encoding: 'utf8',
  });

  if (result.status !== 0) throw new Error(result.stdout + result.stderr);

  return hash;
}

/** Opens `url` in the desktop's browser, as root, and ends once its window is on screen, or fails when it exits first. */
export const BROWSER_WINDOW = (url: string): string => `DISPLAY=:0 setsid x-www-browser --kiosk ${url} >/tmp/browser.log 2>&1 </dev/null & pid=$!; `
  + 'until DISPLAY=:0 xdotool search --class chromium >/dev/null 2>&1; do kill -0 "$pid" 2>/dev/null || { cat /tmp/browser.log >&2; exit 1; }; sleep 0.1; done';

export function copyBlockProbe(image: string, destination: string): void {
  const result = spawnSync('docker', ['run', '--rm', '--network=none', '--entrypoint', '/bin/cat', image, '/usr/local/bin/devbox-block-lower'],
    { maxBuffer: 16 * 1024 * 1024 });

  if (result.status !== 0) throw new Error(result.stderr.toString());
  writeFileSync(destination, result.stdout, { mode: 0o755 });
}

export function removeBlockImage(image: string): void {
  const result = spawnSync('docker', ['rmi', image], { encoding: 'utf8' });

  if (result.status !== 0) throw new Error(result.stderr);
}
