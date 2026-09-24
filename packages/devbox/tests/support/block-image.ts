import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Build the same native probe and lower the deployed image contains, and the sync this tree
 *  bundles, which the Dockerfile copies (D30). */
export function buildBlockImage(image: string): void {
  const context = join(import.meta.dir, '../../block-lower');
  const bundled = spawnSync(process.execPath, [join(context, 'bundle-sync.ts')], { encoding: 'utf8' });

  if (bundled.status !== 0) throw new Error(bundled.stdout + bundled.stderr);
  const result = spawnSync('docker', ['build', '-t', image, context], { encoding: 'utf8' });

  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

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
