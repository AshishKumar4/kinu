// Forks: a slate's code and the namespaces it reaches, as requirements its forker's own workspace answers. A fork
// carries no lend, grant, person or state (Confinement.lean: a_fork_starts_with_its_code_alone).
import { expect, test } from 'bun:test';
import { WorkspaceId } from '@agent-core/core';
import { SlateId } from '@agent-core/core/slates';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateFiles, slateDirectory } from '../src/slates/files';
import { WorkspaceSlateContentStore } from '../src/slates/content';
import { SqliteSlateStore } from '../src/slates/store';
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

  // What each slate called as its owner ran it, as the host records it.
  const usage = new Map<string, SlateUsage[]>();

  return { ws, vfs, store, slates, usage, blueprints: new WorkspaceBlueprints({ slates, content, usage: (slate) => usage.get(slate) ?? [] }) };
}

test('a fork carries the slate\'s code and its requirements, and admits with every requirement unsatisfied', async () => {
  const owner = await slatePlane('owner');
  const forker = await slatePlane('forker');

  try {
    const id = new SlateId('issues');
    const root = slateDirectory(id);

    owner.vfs.mkdir(root + '/src', { recursive: true });
    owner.vfs.writeFile(root + '/package.json', JSON.stringify({ name: 'issues', main: 'src/server.ts', slate: { title: 'Issue triage' } }));
    owner.usage.set('issues', [
      { namespace: 'mcp.github', member: 'read_issue' }, { namespace: 'mcp.github', member: 'create_issue' },
      { namespace: 'slates.other', member: 'count' }, { namespace: 'workspace', member: 'readFile' },
    ]);
    owner.vfs.writeFile(root + '/src/server.ts', 'export default { fetch() { return new Response("issues"); } };');

    const bundle = await owner.blueprints.liveBundle('issues');

    expect(bundle.skeleton.bindings.map((requirement) => requirement.name + '@' + requirement.facet)).toEqual([
      'mcp.github@kinu.slate.mcp', 'slates.other@kinu.slate.slates', 'workspace@kinu.slate.workspace',
    ]);

    const fork = await forker.blueprints.admit('forker', bundle);

    expect(fork.title).toBe('Issue triage');
    expect(fork.requirements).toEqual([
      { name: 'mcp.github', facet: 'kinu.slate.mcp' }, { name: 'slates.other', facet: 'kinu.slate.slates' }, { name: 'workspace', facet: 'kinu.slate.workspace' },
    ]);
    const landed = slateDirectory(new SlateId(fork.slate));

    expect(forker.vfs.readFileString(landed + '/src/server.ts')).toContain('"issues"');
    expect(forker.store.getSlate(new SlateId(fork.slate))?.workspaceId.value).toBe('forker');

    const forged = { ...bundle, blobs: Object.fromEntries(Object.entries(bundle.blobs).map(([digest]) => [digest, btoa('stolen')])) };

    await expect(forker.blueprints.admit('forker', forged)).rejects.toMatchObject({ code: 'bad_input' });
  } finally {
    owner.ws.db.close();
    forker.ws.db.close();
  }
});

test('a requirement reads back as its namespace verbatim, as the slate\'s code calls it', async () => {
  const owner = await slatePlane('owner');
  const forker = await slatePlane('forker');
  const root = slateDirectory(new SlateId('mixed'));
  const reaches = ['mcp.My_Files', 'slates.budget.board', 'mcp.my files', 'mcp.files-2'];

  owner.vfs.mkdir(root, { recursive: true });
  owner.vfs.writeFile(root + '/package.json', JSON.stringify({ main: 'a.js' }));
  owner.vfs.writeFile(root + '/a.js', '');
  owner.usage.set('mixed', reaches.map((namespace) => ({ namespace, member: 'read' })));

  try {
    const fork = await forker.blueprints.admit('forker', await owner.blueprints.liveBundle('mixed'));

    expect(fork.requirements.map((requirement) => requirement.name).sort()).toEqual([...reaches].sort());
  } finally {
    owner.ws.db.close();
    forker.ws.db.close();
  }
});
