import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { launchDotenv, launchDotenvFiles, type LaunchDotenv } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';

/** The dotenv files this process loaded at launch from `dir`, as Bun read them; a file that is there but cannot be
 *  read stops the shell, which could otherwise pass on what it held. */
export function readLaunchDotenv(dir: string, nodeEnv: string | undefined): LaunchDotenv {
  return launchDotenv(launchDotenvFiles(nodeEnv).flatMap((file) => {
    const text = tolerate(() => readFileSync(join(dir, file), 'utf8'), 'enoent');

    return text === undefined ? [] : [parseEnv(text)];
  }));
}
