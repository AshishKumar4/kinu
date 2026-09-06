import { Database } from 'bun:sqlite';
import { agentHomeNodeProvisioner, facetHomeProvisioner, type AgentRuntime } from '@kinu.run/core';
import { createCLIRuntime } from '../packages/cli-backend/src/runtime';

const database = new Database(':memory:');
const config = {
  dbPath: '/tmp/workspace-planes-probe.db',
  llm: { name: 'probe', baseURL: 'http://localhost:0', headers: {}, model: 'unused' },
  hostRoot: null,
};
try {
  for (const generation of [1, 2]) {
    const runtime = createCLIRuntime(database, config);
    const host = runtime.nodeHome;
    const nodeRuntime = runtime.nodeRuntime;
    if (!host || !nodeRuntime) throw new Error('local workspace has no node plane');
    const provision = facetHomeProvisioner(host());
    const node = await agentHomeNodeProvisioner(host())({ nodeId: 'probe', rootId: 'probe', depth: 1 });
    const identities = [
      { name: 'node', workspace: node },
      { name: 'head', workspace: await provision('head-probe') },
      { name: 'subordinate', workspace: await provision('sub-probe') },
    ];
    if (generation === 1) await runtime.storage.vfs.writeFile('/home/user/shared.txt', 'one workspace');
    const planes: { name: string; runtime: AgentRuntime }[] = [{ name: 'main', runtime }];
    for (const identity of identities) planes.push({ name: identity.name, runtime: await nodeRuntime(identity.workspace) });
    for (const plane of planes) {
      const shell = plane.runtime.shell;
      if (!shell) throw new Error(`${plane.name} has no shell`);
      if (generation === 1) {
        const written = await shell.exec(`echo ${plane.name} > /tmp/private.txt`);
        if (written.exitCode !== 0) throw new Error(written.stderr);
      }
      const result = await shell.exec('echo HOME=$HOME TMPDIR=$TMPDIR; cat /tmp/private.txt; cat /home/user/shared.txt');
      if (result.exitCode !== 0) throw new Error(result.stderr);
      const shared = await plane.runtime.storage.vfs.readFile('/home/user/shared.txt', { encoding: 'utf8' });
      if (shared !== 'one workspace' || !result.stdout.includes(`\n${plane.name}\n`)) throw new Error('workspace planes diverged');
      console.log(`generation=${generation} kind=${plane.name} ${result.stdout.trim().replaceAll('\n', ' | ')}`);
    }
  }
} finally {
  database.close();
}
