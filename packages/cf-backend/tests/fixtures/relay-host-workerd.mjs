// 2026-10-09, workerd 2026-09-30: staging 44b13e946 trace and jobs 20261009231941-bb19d0db (red), 20261009232038-710968da
// (green, host disposed): a fulfilled AgentWorkspaceHost stub the relay never disposed kept a callback-bearing codemode
// program's capability until context shutdown once a collection ran inside it, so its Tail read as hung.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'kinu-relay-host-'));

const cases = process.argv.slice(2).filter(argument => !argument.startsWith('--'));

const { buildSlateVendor } = await import(join(root, 'packages/cf-backend/slate-vendor.ts'));

writeFileSync(join(dir, 'slate-vendor.js'), `export default ${JSON.stringify(buildSlateVendor())};`);

const bundle = path => buildSync({
  entryPoints: [path], bundle: true, format: 'esm', platform: 'neutral', write: false,
  conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'],
  alias: { 'virtual:kinu-slate-vendor': join(dir, 'slate-vendor.js') },
  external: ['node:*', 'cloudflare:*'], nodePaths: [join(root, 'node_modules')], logLevel: 'error',
}).outputFiles[0].text;

// The agent's isolate: it calls a program with callbacks through the shipped client, as a turn's codemode does.
writeFileSync(join(dir, 'client.js'), `
import { DurableObject } from 'cloudflare:workers';
import { workspaceClient } from ${JSON.stringify(join(root, 'packages/cf-backend/src/agent-facet/workspace-rpc.ts'))};
export class Client extends DurableObject {
  async run(mode) {
    const callbacks = { fns: { read: async () => 7, unused: async () => 8 } };

    return await workspaceClient(this.env.WORKSPACE).program('turn', 'code', callbacks);
  }
}
`);

const client = bundle(join(dir, 'client.js'));

// The workspace: the shipped relay in front of a host whose program runs codemode over the callbacks, under a
// collection the probe holds it for.
writeFileSync(join(dir, 'worker.js'), `
import { DurableObject, exports } from 'cloudflare:workers';
import { AgentWorkspaceRPC, AgentWorkspaceHost } from ${JSON.stringify(join(root, 'packages/cf-backend/src/agent-facets.ts'))};
import { CodemodeLauncher, codemodeLauncher, createRuntimeExecutor } from ${JSON.stringify(join(root, 'packages/cf-backend/src/codemode-sandbox.ts'))};
export { AgentWorkspaceRPC, CodemodeLauncher };
function pressure() {
  for (let pass = 0; pass < 6; pass++) {
    const values = [];
    for (let i = 0; i < 300000; i++) values.push({ i, pass, nested: { i } });
  }
}
const clientModule = ${JSON.stringify(client)};
export class Workspace extends DurableObject {
  async run(mode) {
    const workspace = this.ctx.id.toString();
    const worker = this.env.LOADER.get(mode, () => ({
      compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
      mainModule: 'client.js', modules: { 'client.js': clientModule },
      env: { WORKSPACE: exports.AgentWorkspaceRPC({ props: { workspace, actorId: mode } }) },
    }));

    return await this.ctx.facets.get(mode, () => ({ class: worker.getDurableObjectClass('Client') })).run(mode);
  }
  agentWorkspace() {
    return new AgentWorkspaceHost({
      program: async (turnId, code, providers) => {
        await fetch('http://held.invalid/');
        pressure();
        const executor = createRuntimeExecutor(codemodeLauncher({ kinuNode: false, egress: null }));

        return await executor.execute('async () => await codemode.read()', [{ name: 'codemode', fns: providers.fns }]);
      },
    }, new AbortController().signal);
  }
}
export default {
  async fetch(request, env) {
    const mode = new URL(request.url).pathname.slice(1);

    return Response.json(await env.OrchestratorAgent.getByName(mode).run(mode));
  }
};
`);

let ended = Promise.withResolvers();

let arrived = Promise.withResolvers();

let released = Promise.withResolvers();

const options = convertV4MiniflareOptions({
  workers: [{
    name: 'probe', modulesRoot: dir,
    modules: [{ type: 'ESModule', path: join(dir, 'bundle.js'), contents: bundle(join(dir, 'worker.js')) }],
    compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat', 'new_module_registry'],
    durableObjects: { OrchestratorAgent: 'Workspace' }, workerLoaders: { LOADER: {} },
    outboundService: async () => {
      arrived.resolve();
      await released.promise;

      return new Response('ready');
    },
  }, {
    name: 'collector', modulesRoot: dir, compatibilityDate: '2026-09-30',
    modules: [{ type: 'ESModule', path: join(dir, 'collector.js'), contents: `export default { async tail(events, env) {
      for (const event of events) await env.SINK.fetch('http://tail/', { method: 'POST', body: JSON.stringify({ outcome: event.outcome, rpc: event.event?.rpcMethod }) });
    } };` }],
    serviceBindings: { SINK: async request => {
      const tail = await request.json();

      if (tail.rpc === 'program') ended.resolve(tail);

      return new Response('kept');
    } },
  }],
});

options.workers[0].config.tailConsumers = [{ worker: 'collector' }];

const mf = new Miniflare(options);

const observed = [];

try {
  await mf.ready;

  for (const mode of cases) {
    ended = Promise.withResolvers();
    arrived = Promise.withResolvers();
    released = Promise.withResolvers();
    const pending = mf.dispatchFetch('http://probe/' + mode);

    await arrived.promise;
    released.resolve();
    const answer = await (await pending).json();

    observed.push({ mode, answer, tail: await ended.promise });
    console.log('OBSERVED', JSON.stringify(observed.at(-1)));
  }
} finally {
  try { await mf.dispose(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

assert.equal(observed.length, cases.length);

console.log('SUMMARY', JSON.stringify(observed));
