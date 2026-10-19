/**
 * One checkpoint engine, one set of rules: the CLI's checkpoints and the device daemon's are both core's
 * `checkpoints/engine.ts`, each over its own host. Each rule the two once kept differently is asserted here on both.
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { createHostCheckpoints } from '../src/checkpoints';

const require = createRequire(import.meta.url);

const rawDaemonModule: unknown = require('../../pc-agent/src/index.js');

const daemon = v.parse(v.object({ createCheckpoints: v.function() }), rawDaemonModule);

const AGENT = 'rules-agent';

/** The two engines over one shadow store, each through its own host's surface. */
function engines(root: string, gitBin = 'git') {
  const base = join(root, 'shadow');
  const host = createHostCheckpoints({ agent: AGENT, base, gitBin });

  const raw = v.parse(v.object({
    ensure: v.function(), mutate: v.function(), list: v.function(), workdirForPath: v.function(),
  }), daemon.createCheckpoints({ base, gitBin }));

  // A raw view, as the host engine runs: one set of rules, not the sandbox around a device's git.
  const view = { raw: true };

  const device = {
    ensure: async (dir: string, turnId: string) => v.parse(v.nullable(v.string()), await raw.ensure(view, { agent: AGENT, dir, turnId, sessionId: 's' })),
    mutate: async (dir: string, turnId: string, apply: () => string) => v.parse(v.string(), await raw.mutate(view, { agent: AGENT, dir, turnId, sessionId: 's' }, undefined, apply)),
    workdirForPath: (path: string) => v.parse(v.string(), raw.workdirForPath(path)),
  };

  return { host, device };
}

/** git behind a wrapper whose `git add` fails the first time it runs, as a held index lock does. */
function addFailsOnce(root: string): string {
  const failed = join(root, 'failed-once');
  const wrapper = join(root, 'git-wrapper.sh');

  writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = add ] && [ ! -e '${failed}' ]; then touch '${failed}'; echo 'fatal: index.lock exists' >&2; exit 128; fi\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);

  return wrapper;
}

describe('one engine, one set of rules, on both hosts', () => {
  test('a link to a directory is a file of the directory holding it, never the directory it points at', () => {
    const root = scratchDir('engine-rules');
    const project = join(root, 'project');
    const elsewhere = join(root, 'elsewhere');

    mkdirSync(project, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    symlinkSync(elsewhere, join(project, 'linked'));
    const { host, device } = engines(root);

    expect([host.workdirForPath(join(project, 'linked')), device.workdirForPath(join(project, 'linked'))]).toEqual([project, project]);
  });

  test('a project marker at the temp directory claims no write beneath it', () => {
    // A scratch directory sits directly in the temp directory: the walk climbs `deep`, then the scratch, then stops.
    const nested = join(scratchDir('engine-rules', tmpdir()), 'deep');

    mkdirSync(nested, { recursive: true });
    const { host, device } = engines(scratchDir('engine-rules'));

    expect([host.workdirForPath(join(nested, 'x.js')), device.workdirForPath(join(nested, 'x.js'))]).toEqual([nested, nested]);
  });

  test('a snapshot that fails never refuses the mutation it precedes, and the turn\'s next mutation takes it', async () => {
    const hostRoot = scratchDir('engine-rules');
    const hostWork = join(hostRoot, 'project');

    mkdirSync(hostWork, { recursive: true });
    writeFileSync(join(hostWork, 'a.txt'), 'before');
    const { host } = engines(hostRoot, addFailsOnce(hostRoot));

    host.beginTurn({ turnId: 't', sessionId: 's' });
    expect(await host.ensureCheckpoint(hostWork)).toBeNull();
    expect(await host.ensureCheckpoint(hostWork)).toBeTruthy();

    const deviceRoot = scratchDir('engine-rules');
    const deviceWork = join(deviceRoot, 'project');

    mkdirSync(deviceWork, { recursive: true });
    writeFileSync(join(deviceWork, 'a.txt'), 'before');
    const { device } = engines(deviceRoot, addFailsOnce(deviceRoot));

    expect(await device.mutate(deviceWork, 't', () => 'the mutation ran')).toBe('the mutation ran');
    expect(await device.ensure(deviceWork, 't')).toBeTruthy();
  });
});
