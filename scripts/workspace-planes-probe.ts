import { Database } from 'bun:sqlite';
import { explorationActorKey, facetHomeProvisioner, headAgentName, subordinateAgentName, type AgentRuntime } from '@kinu.run/core';
import { createCLIRuntime } from '../packages/cli-backend/src/runtime';
import { bindLocalActor, registerLocalActor, registerLocalNode } from '../packages/cli-backend/src/actor-identity';

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
    const sql = runtime.storage.sql;
    // Registered exactly the way production registers each kind: a node
    // through the session's own node entry (`LocalAgentSession` builds its
    // `provisionNodeHome`/`runtimeForNodeWorkspace` handles with this), a head
    // and a hire through the directory pair every host binds them with
    // (`agent-host/host.ts` hire, `buildLocalActorRuntime` head). No probe-only
    // shortcut, so what this prints is what a real actor of each kind gets.
    const node = registerLocalNode(runtime.actor, { nodeId: 'node-probe', rootId: 'node-probe', depth: 1 });
    const head = bindLocalActor(sql, registerLocalActor(runtime.actor, { name: explorationActorKey('head-probe'), creationId: 'head-probe', kind: 'head', lifetime: 'task' }));
    const subordinate = bindLocalActor(sql, registerLocalActor(runtime.actor, { name: 'sub-probe', creationId: 'sub-probe', kind: 'subordinate', lifetime: 'durable' }));

    const identities = [
      { name: 'node', actor: node, workspace: await provision(headAgentName(node.storageKey)) },
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
