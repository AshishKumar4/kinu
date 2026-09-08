import { Database } from 'bun:sqlite';
import { facetHomeProvisioner, nodeAgentName, headAgentName, subordinateAgentName, type AgentRuntime } from '@kinu.run/core';
import { createCLIRuntime } from '../packages/cli-backend/src/runtime';
import { registerLocalActorState } from '../packages/cli-backend/src/actor-identity';

const database = new Database(':memory:');
const config = {
  dbPath: database.filename,
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
    const node = registerLocalActorState(runtime.actor, { name: 'exp:node-probe', creationId: 'node-probe', kind: 'node', lifetime: 'task' });
    const head = registerLocalActorState(runtime.actor, { name: 'exp:head-probe', creationId: 'head-probe', kind: 'head', lifetime: 'task' });
    const subordinate = registerLocalActorState(runtime.actor, { name: 'sub-probe', creationId: 'sub-probe', kind: 'subordinate', lifetime: 'durable' });
    const identities = [
      { name: 'node', actor: node, workspace: await provision(nodeAgentName(node.storageKey)) },
      { name: 'head', actor: head, workspace: await provision(headAgentName(head.storageKey)) },
      { name: 'subordinate', actor: subordinate, workspace: await provision(subordinateAgentName(subordinate.storageKey)) },
    ];
    if (generation === 1) await runtime.storage.vfs.writeFile('/home/user/shared.txt', 'one workspace');
    const planes: { name: string; runtime: AgentRuntime }[] = [{ name: 'main', runtime }];
    for (const identity of identities) planes.push({ name: identity.name, runtime: await nodeRuntime(identity.workspace, identity.actor, runtime) });
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
