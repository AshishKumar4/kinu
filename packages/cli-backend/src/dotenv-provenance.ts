import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { tolerate } from '@kinu.run/core/obs';

export function dotenvLoadedNames(dir: string, source: Readonly<Record<string, string | undefined>>): Set<string> {
  const mode = source.NODE_ENV ?? 'development';
  const files = ['.env', `.env.${mode}`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}.local`, '.dev.vars'];
  const names = new Set<string>();

  for (const file of files) {
    const text = tolerate(() => readFileSync(join(dir, file), 'utf8'), 'enoent');

    for (const [name, value] of Object.entries(text === undefined ? {} : parseEnv(text))) {
      if (source[name] === value) names.add(name);
    }
  }

  return names;
}
