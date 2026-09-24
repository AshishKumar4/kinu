import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unsandboxedCommandEnvironment } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { dotenvLoadedNames } from '../src/dotenv-provenance';

describe('an unsandboxed command environment', () => {
  test('a value a dotenv file supplied is withheld; a value the shell exported over it, and the rest, pass', () => {
    const dir = scratchDir('dotenv-provenance');
    writeFileSync(join(dir, '.env'), 'FROM_FILE=file-value\nOVERRIDDEN=file-value\n');
    writeFileSync(join(dir, '.env.test.local'), 'TEST_LOCAL=t\n');
    // Bun does not load `.env.local` when NODE_ENV=test, so this value came from the shell.
    writeFileSync(join(dir, '.env.local'), 'LOCAL_ONLY=local\n');
    writeFileSync(join(dir, '.dev.vars'), 'export DEV_VAR="dev value"\n');

    const source = {
      NODE_ENV: 'test', FROM_FILE: 'file-value', OVERRIDDEN: 'shell-value', TEST_LOCAL: 't', LOCAL_ONLY: 'local',
      DEV_VAR: 'dev value', SSH_AUTH_SOCK: '/run/agent.sock', HTTPS_PROXY: 'http://proxy:3128', PATH: '/usr/bin',
    };

    const loaded = dotenvLoadedNames(dir, source);
    const passed = unsandboxedCommandEnvironment(source, new Set([...loaded, 'API_TOKEN']));

    expect([...loaded].sort()).toEqual(['DEV_VAR', 'FROM_FILE', 'TEST_LOCAL']);
    expect(Object.keys(passed).sort()).toEqual(['HTTPS_PROXY', 'LOCAL_ONLY', 'NODE_ENV', 'OVERRIDDEN', 'PATH', 'SSH_AUTH_SOCK']);
    expect(passed.OVERRIDDEN).toBe('shell-value');
  });
});
