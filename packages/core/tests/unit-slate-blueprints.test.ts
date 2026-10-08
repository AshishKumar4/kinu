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
import type { SlateUsage } from '../src/slates/capability-graph';
import { createTestWorkspace, createWorkspaceBundle, makeSqlExec } from './helpers';

async function slatePlane(name: string) {
  const ws = createTestWorkspace();
  const session = await createWorkspaceBundle(ws.db).session();
  const vfs = session.vfs.as(CRED_SESSION_USER);
  const exec = makeSqlExec(ws.db);
  const atomic = <Result,>(body: () => Result) => ws.db.transaction(body)();
  const store = new SqliteSlateStore(exec, atomic);
  const content = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));

  const slates = new WorkspaceSlates({
    workspaceId: new WorkspaceId(name), store, files: new SlateFiles(vfs, content, exec, (body) => session.vfs.withTransaction(body)),
    mutations: { mutate: async (_request, mutation) => session.vfs.withTransaction(mutation) },
  });

  let now = 1_000;
  const shares = new SlateShareStore(exec, () => now++);
  // What each slate called as its owner ran it, as the host records it.
  const usage = new Map<string, SlateUsage[]>();

  return { ws, vfs, store, content, slates, shares, usage, blueprints: new WorkspaceBlueprints({ slates, content, shares, usage: (slate) => usage.get(slate) ?? [] }) };
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
      slate: { title: 'Issue triage' },
    }));
    owner.usage.set('issues', [
      { namespace: 'mcp.github', member: 'read_issue' }, { namespace: 'mcp.github', member: 'create_issue' },
      { namespace: 'slates.other', member: 'count' }, { namespace: 'workspace', member: 'readFile' },
    ]);
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
    expect(inspection.reaches).toEqual(['mcp.github', 'slates.other', 'workspace']);

    const published = await owner.blueprints.publish('issues', version.id.value, ['src']);
    expect(published.share).toMatchObject({ slate: 'issues', included: ['package.json', 'src'], revokedAt: null, users: [] });
    const publication = owner.slates.publication(new SlatePublicationId(published.share.publication));
    expect(publication.materialization.value).not.toBe(version.source.value);
    expect(owner.slates.skeleton(publication.id).sourceDigest.value).toBe(publication.materialization.digest.value);

    const bundle = owner.blueprints.bundle(published.share.id);
    owner.vfs.writeFile(root + '/src/server.ts', 'later authored edits');
    expect(owner.blueprints.bundle(published.share.id)).toEqual(bundle);
    expect(Object.keys(bundle.blobs).length).toBe(2);
    expect(bundle.tree).not.toContain('cache.json');
    expect(bundle.skeleton.bindings.map((requirement) => requirement.name + '@' + requirement.facet)).toEqual([
      'mcp.github@kinu.slate.mcp', 'slates.other@kinu.slate.slates', 'workspace@kinu.slate.workspace',
    ]);
    // The publication fixed what it requires: later calls of the slate's do not change it.
    owner.usage.set('issues', [{ namespace: 'memory', member: 'recall' }]);
    expect(owner.blueprints.read(published.share.id).view.reaches).toEqual(['mcp.github', 'slates.other', 'workspace']);

    const fork = await forker.blueprints.admit('forker', bundle);
    expect(fork.requirements).toEqual([
      { name: 'mcp.github', facet: 'kinu.slate.mcp' }, { name: 'slates.other', facet: 'kinu.slate.slates' }, { name: 'workspace', facet: 'kinu.slate.workspace' },
    ]);
    const landed = slateDirectory(new SlateId(fork.slate));
    expect(forker.vfs.readFileString(landed + '/src/server.ts')).toContain('"issues"');
    expect(forker.vfs.exists(landed + '/data')).toBe(false);
    expect(forker.store.getSlate(new SlateId(fork.slate))?.workspaceId.value).toBe('forker');

    const forged = { ...bundle, blobs: Object.fromEntries(Object.entries(bundle.blobs).map(([digest]) => [digest, btoa('stolen')])) };
    await expect(forker.blueprints.admit('forker', forged)).rejects.toMatchObject({ code: 'bad_input' });

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

test('a requirement reads back as its namespace verbatim, as the slate\'s code calls it', async () => {
  const owner = await slatePlane('owner');
  const root = slateDirectory(new SlateId('mixed'));
  const reaches = ['mcp.My_Files', 'slates.budget.board', 'mcp.my files', 'mcp.files-2'];
  owner.vfs.mkdir(root, { recursive: true });
  owner.vfs.writeFile(root + '/package.json', JSON.stringify({ main: 'a.js' }));
  owner.vfs.writeFile(root + '/a.js', '');
  owner.usage.set('mixed', reaches.map((namespace) => ({ namespace, member: 'read' })));

  try {
    const published = await owner.blueprints.publish('mixed', (await owner.slates.commit(new SlateId('mixed'))).id.value);

    expect(owner.blueprints.read(published.share.id).view.reaches).toEqual(reaches);
    expect(owner.blueprints.bundle(published.share.id).skeleton.bindings.map((requirement) => requirement.facet))
      .toEqual(['kinu.slate.mcp', 'kinu.slate.slates', 'kinu.slate.mcp', 'kinu.slate.mcp']);
  } finally {
    owner.ws.db.close();
  }
});
