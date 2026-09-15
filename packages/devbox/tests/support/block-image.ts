import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Build the same native probe and lower the deployed image contains. */
export function buildBlockImage(image: string): void {
  const result = spawnSync('docker', ['build', '-t', image, join(import.meta.dir, '../../block-lower')],
    { encoding: 'utf8' });

  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

export function copyBlockProbe(image: string, destination: string): void {
  const result = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/cat', image, '/usr/local/bin/devbox-block-lower'],
    { maxBuffer: 16 * 1024 * 1024 });

  if (result.status !== 0) throw new Error(result.stderr.toString());
  writeFileSync(destination, result.stdout, { mode: 0o755 });
}

export function removeBlockImage(image: string): void {
  const result = spawnSync('docker', ['rmi', image], { encoding: 'utf8' });

  if (result.status !== 0) throw new Error(result.stderr);
}
