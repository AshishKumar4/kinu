import { expect, test } from 'bun:test';
import { containerAppTeardown, type ContainerAppPorts } from './bench-devbox-fixture';
import { createManifest } from './fixtures/storage-matrix/cleanup';

/** The platform and registry a container application's teardown reaches, recording what each was asked in order. */
function appPlatform(listed: string[][], sweeps: ('refuse' | 'ok')[]) {
  const asked: string[] = [];

  const ports: ContainerAppPorts = {
    listed: (name) => {
      const now = listed.shift() ?? [];

      asked.push(`list ${name}: ${now.join(',')}`);

      return now;
    },
    remove: async (name) => {
      asked.push(`remove ${name}`);

      return undefined;
    },
    sweep: async (applicationId) => {
      asked.push(`sweep ${applicationId}`);

      return sweeps.shift() === 'refuse' ? { kind: 'refused', reason: 'the registry answered 503' } : { kind: 'swept', deleted: 2, left: [] };
    },
  };

  return { asked, ports };
}

// 2026-10-09 review: the arm's Worker step deleted the container application first, so this step listed nothing, called
// it absent, and swept no snapshot; a retry after "deleted, sweep refused" lost the ids the same way.
test('an application already deleted is still swept, by the ids its entry recorded before anything was deleted', async () => {
  const [entry] = createManifest('r1', [{ kind: 'container-app', name: 'arm-box' }]).entries;

  if (entry === undefined) throw new Error('no entry');

  entry.ids.push('app-1');
  const { asked, ports } = appPlatform([[]], ['ok']);
  const outcome = await containerAppTeardown(entry, () => { asked.push('persist'); }, ports);

  expect({ outcome, asked }).toEqual({ outcome: { ok: true }, asked: ['list arm-box: ', 'sweep app-1'] });
});

test('a retry after the application went and its sweep was refused still has the ids, written before the deletion', async () => {
  const [entry] = createManifest('r1', [{ kind: 'container-app', name: 'arm-box' }]).entries;

  if (entry === undefined) throw new Error('no entry');
  const { asked, ports } = appPlatform([['app-2'], []], ['refuse', 'ok']);
  const persist = () => { asked.push(`persist ${entry.ids.join(',')}`); };

  const first = await containerAppTeardown(entry, persist, ports);
  const retry = await containerAppTeardown(entry, persist, ports);

  expect({ first, retry, asked }).toEqual({
    first: { ok: false, error: 'arm-box\'s snapshots were not deleted: the registry answered 503' },
    retry: { ok: true },
    asked: ['list arm-box: app-2', 'persist app-2', 'remove arm-box', 'sweep app-2', 'list arm-box: ', 'sweep app-2'],
  });
});

