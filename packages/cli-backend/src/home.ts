/**
 * Where local Kinu state lives. KINU_HOME is the isolation boundary. Lives here
 * because cli-backend cannot import cli, and the checkpoint engine needs it too.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function kinuHome(): string {
  const configured = process.env.KINU_HOME?.trim();

  return resolve(configured === undefined || configured === '' ? join(homedir(), '.kinu') : configured);
}
