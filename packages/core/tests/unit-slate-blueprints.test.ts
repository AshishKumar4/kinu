import { expect, test } from 'bun:test';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlatePublicationId } from '@agent-core/core/slates';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateFiles, slateDirectory } from '../src/slates/files';
import { WorkspaceSlateContentStore } from '../src/slates/content';
import { SqliteSlateStore } from '../src/slates/store';
import { SlateShareStore } from '../src/slates/shares';
import { WorkspaceSlates } from '../src/slates/runtime';
import { WorkspaceBlueprints } from '../src/slates/blueprints';
import { createTestWorkspace, createWorkspaceBundle, makeSqlExec } from './helpers';

/** One workspace's whole slate plane, on its own database. */
async function slatePlane(name: string) {
  const ws = createTestWorkspace();
  const session = await createWorkspaceBundle(ws.db).session();
  const vfs = session.vfs.as(CRED_SESSION_USER);
  const exec = makeSqlExec(ws.db);
  const atomic = <Result,>(body: () => Result) => ws.db.transaction(body)();
  const store = new SqliteSlateStore(exec, atomic);
  const content = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));

  const slates = new WorkspaceSlates({
    workspaceId: new WorkspaceId(name), store, files: new SlateFiles(vfs, content, (body) => session.vfs.withTransaction(body)),
    mutations: { mutate: async (_request, mutation) => session.vfs.withTransaction(mutation) },
  });

  let now = 1_000;
  const shares = new SlateShareStore(exec, () => now++);

  return { ws, vfs, store, content, slates, shares, blueprints: new WorkspaceBlueprints({ slates, content, shares }) };
}

test('a blueprint carries the included tree and its requirements, and admits with every requirement unsatisfied', async () => {
  const owner = await slatePlane('owner');
  const forker = await slatePlane('forker');

  try {
    const id = new SlateId('issues');
    const root = slateDirectory(id);
    owner.vfs.mkdir(root + '/data', { recursive: true });
    owner.vfs.mkdir(root + '/src', { recursive: true });
    owner.vfs.writeFile(root + '/package.json', JSON.stringify({
      name: 'issues', description: 'Triage issues', main: 'src/server.ts',
      slate: { title: 'Issue triage', bindings: { GITHUB: { kind: 'mcp', server: 'github' }, my_files: { kind: 'namespace', namespace: 'workspace' }, PEER: { kind: 'app', id: 'other' } } },
    }));
    owner.vfs.writeFile(root + '/src/server.ts', 'export default { fetch() { return new Response("issues"); } };');
    owner.vfs.writeFile(root + '/data/cache.json', '{"stale":true}');
    const version = await owner.slates.commit(id);

    const inspection = owner.blueprints.inspect('issues', version.id.value, ['src']);
    expect(inspection.entries).toEqual([
      { path: 'data', kind: 'directory', included: false },
      { path: 'data/cache.json', kind: 'file', included: false },
      { path: 'package.json', kind: 'file', included: true },
      { path: 'src', kind: 'directory', included: true },
      { path: 'src/server.ts', kind: 'file', included: true },
    ]);
    expect(inspection.title).toBe('Issue triage');
    expect(inspection.warnings).toEqual([]);
    expect(inspection.bindings.map((binding) => [binding.name, binding.kind, binding.credentialed])).toEqual([
      ['GITHUB', 'mcp', true], ['my_files', 'namespace', true], ['PEER', 'app', false],
    ]);

    const published = await owner.blueprints.publish('issues', version.id.value, ['src']);
    expect(published.share).toMatchObject({ slate: 'issues', kind: 'blueprint', included: ['package.json', 'src'], revokedAt: null, users: [] });
    const publication = owner.slates.publication(new SlatePublicationId(published.share.publication));
    // A subset ships as its own bundle; the version's source is untouched.
    expect(publication.materialization.value).not.toBe(version.source.value);
    expect(owner.slates.skeleton(publication.id).sourceDigest.value).toBe(publication.materialization.digest.value);

    const bundle = owner.blueprints.bundle(published.share.id);
    owner.vfs.writeFile(root + '/src/server.ts', 'later authored edits');
    expect(owner.blueprints.bundle(published.share.id)).toEqual(bundle);
    expect(Object.keys(bundle.blobs).length).toBe(2);
    expect(bundle.tree).not.toContain('cache.json');
    expect(bundle.skeleton.bindings.map((requirement) => requirement.name + '@' + requirement.facet)).toEqual([
      'github@kinu.slate.mcp', 'my-files@kinu.slate.namespace', 'peer@kinu.slate.app',
    ]);

    const fork = await forker.blueprints.admit('forker', bundle);
    expect(fork.requirements).toEqual([
      { name: 'github', facet: 'kinu.slate.mcp' }, { name: 'my-files', facet: 'kinu.slate.namespace' }, { name: 'peer', facet: 'kinu.slate.app' },
    ]);
    expect(fork.bindings.map((binding) => binding.name)).toEqual(['GITHUB', 'my_files', 'PEER']);
    const landed = slateDirectory(new SlateId(fork.slate));
    expect(forker.vfs.readFileString(landed + '/src/server.ts')).toContain('"issues"');
    expect(forker.vfs.exists(landed + '/data')).toBe(false);
    expect(forker.store.getSlate(new SlateId(fork.slate))?.workspaceId.value).toBe('forker');

    // Tampered bytes are refused before anything lands.
    const forged = { ...bundle, blobs: Object.fromEntries(Object.entries(bundle.blobs).map(([digest]) => [digest, btoa('stolen')])) };
    await expect(forker.blueprints.admit('forker', forged)).rejects.toMatchObject({ code: 'bad_input' });

    // Revocation refuses the next read and the next bundle.
    owner.blueprints.unshare(published.share.id);
    expect(() => owner.blueprints.read(published.share.id)).toThrow('no longer shared');
    expect(() => owner.blueprints.bundle(published.share.id)).toThrow('no longer shared');
    expect(owner.blueprints.list()[0]?.revokedAt).toBe(1_001);
  } finally {
    owner.ws.db.close();
    forker.ws.db.close();
  }
});

test('a whole-tree publication exports the vendored skeleton and a secret shape warns without its value', async () => {
  const owner = await slatePlane('owner');

  try {
    const id = new SlateId('leaky');
    const root = slateDirectory(id);
    owner.vfs.mkdir(root, { recursive: true });
    owner.vfs.writeFile(root + '/package.json', JSON.stringify({ main: 'server.ts' }));
    const pasted = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    owner.vfs.writeFile(root + '/server.ts', `const key = "${pasted}";\nexport default { fetch() { return new Response(key); } };`);
    owner.vfs.writeFile(root + '/logo.bin', new Uint8Array([0, 65, 75, 73, 65]));
    const version = await owner.slates.commit(id);
    const published = await owner.blueprints.publish('leaky', version.id.value);

    expect(published.inspection.warnings).toEqual([{ path: 'server.ts', line: 1, pattern: 'aws-access-key', message: 'AWS access key id' }]);
    expect(JSON.stringify(published.inspection)).not.toContain(pasted);
    const publication = owner.slates.publication(new SlatePublicationId(published.share.publication));
    expect(publication.materialization.value).toBe(version.source.value);
    expect(owner.slates.skeleton(publication.id).sourceDigest.value).toBe(version.source.digest.value);
    expect(owner.blueprints.read(published.share.id).view.warnings.length).toBe(1);
  } finally {
    owner.ws.db.close();
  }
});

test('requirement names are canonical and collisions refuse to publish', async () => {
  const owner = await slatePlane('owner');

  const commit = async (id: string, bindings: Record<string, { kind: 'memory' | 'tasks' }>) => {
    const root = slateDirectory(new SlateId(id));
    owner.vfs.mkdir(root, { recursive: true });
    owner.vfs.writeFile(root + '/package.json', JSON.stringify({ main: 'a.js', slate: { bindings } }));
    owner.vfs.writeFile(root + '/a.js', '');

    return (await owner.slates.commit(new SlateId(id))).id.value;
  };

  try {
    const fine = await owner.blueprints.publish('fine', await commit('fine', { My_Files: { kind: 'memory' } }));
    expect(owner.blueprints.bundle(fine.share.id).skeleton.bindings.map((requirement) => requirement.name)).toEqual(['my-files']);
    await expect(owner.blueprints.publish('clash', await commit('clash', { FILES: { kind: 'memory' }, files: { kind: 'tasks' } }))).rejects.toThrow('same requirement');
    await expect(owner.blueprints.publish('digit', await commit('digit', { '1st': { kind: 'memory' } }))).rejects.toThrow('cannot be published');
  } finally {
    owner.ws.db.close();
  }
});
