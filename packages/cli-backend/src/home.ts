/**
 * The single source of truth for where local Kinu state lives.
 *
 * PROTEUS_HOME is the isolation boundary: point it somewhere else and NOTHING
 * a local run writes may land in the real home. It lives here rather than in
 * @kinu/cli because cli-backend cannot import cli, and the checkpoint engine
 * needs the same answer the CLI config does.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function proteusHome(): string {
  return resolve(process.env.PROTEUS_HOME?.trim() || join(homedir(), '.proteus'));
}
