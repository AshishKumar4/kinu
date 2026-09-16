// A child killed on a clock rather than left to its own exit.
import { execFileSync } from 'node:child_process';

export function probe(image: string): string {
  return execFileSync('docker', ['run', '--rm', image], { encoding: 'utf8', timeout: 60_000 });
}
