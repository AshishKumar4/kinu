// 2026-10-09, workerd 2026-09-30: debugger jobs 20261009183355-6c5db02f and 20261009183400-d64f3c13.
// The Tail must close before Miniflare disposal; a loader Durable Object facet is the RPC consumer.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildSync } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'kinu-relay-rejected-'));

const plain = process.argv.includes('--plain');

const modes = process.argv.slice(2).filter(argument => !argument.startsWith('--'));

const cases = modes.length ? modes : ['rejection', 'factory-rejection', 'refusal', 'session-factory-rejection', 'session-method-rejection', 'fulfilled-stream'];

const tails = [];

let arrived = Promise.withResolvers();

let released = Promise.withResolvers();

let relayEnded = Promise.withResolvers();

const client = `
import { DurableObject } from 'cloudflare:workers';
${plain ? '' : `import { workspaceClient } from ${JSON.stringify(join(root, 'packages/cf-backend/src/agent-facet/workspace-rpc.ts'))};`}
export class Client extends DurableObject {
  async call(mode) {
    const workspace = ${plain ? 'this.env.WORKSPACE' : 'workspaceClient(this.env.WORKSPACE)'};
    if (mode === 'session-method-rejection') {
      const session = workspace.session();
      let failure;
      try { await session._rpcReady(); }
      catch (error) { failure = { code: error.code, name: error.name, message: error.message }; }
      const kept = await session._rpcReadFile('/kept');
      return { failure, kept };
    }
    try {
      if (mode === 'session-factory-rejection') return { answer: await workspace.session()._rpcReady() };
      if (mode === 'fulfilled-stream') return { answer: await (await workspace.relayModelCall('', '', new Request('http://probe/'))).text() };
      return { answer: await workspace.prepareChat({ mode }) };
    } catch (error) {
      return { failure: { code: error.code, name: error.name, message: error.message } };
    }
  }
}
`;

writeFileSync(join(dir, 'client.js'), client);

buildSync({ entryPoints: [join(dir, 'client.js')], outfile: join(dir, 'client-bundle.js'), bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'], nodePaths: [join(root, 'node_modules')], logLevel: 'error' });

const clientModule = readFileSync(join(dir, 'client-bundle.js'), 'utf8');

const worker = `
import { DurableObject, RpcTarget, exports } from 'cloudflare:workers';
import { AgentWorkspaceRPC, AgentWorkspaceHost } from ${JSON.stringify(join(root, 'packages/cf-backend/src/agent-facets.ts'))};
import { KinuError } from ${JSON.stringify(join(root, 'packages/core/src/obs/index.ts'))};
export { AgentWorkspaceRPC };
class Session extends RpcTarget {
  _rpcReady() { throw new KinuError('missing', 'original session refusal'); }
  _rpcReadFile() { return 'kept session'; }
}
export class Workspace extends DurableObject {
  closed = new AbortController();
  facet(mode) {
    const binding = exports.AgentWorkspaceRPC({ props: { workspace: this.ctx.id.toString(), actorId: mode } });
    const worker = this.env.LOADER.get(mode, () => ({
      compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'], mainModule: 'client.js',
      modules: { 'client.js': ${JSON.stringify(clientModule)} }, env: { WORKSPACE: binding },
    }));
    return this.ctx.facets.get(mode, () => ({ class: worker.getDurableObjectClass('Client') }));
  }
  async run(mode) { return await this.facet(mode).call(mode); }
  close() { this.closed.abort(new KinuError('missing', 'original workspace refusal')); }
  agentWorkspace(mode) {
    if (mode === 'factory-rejection') throw new KinuError('missing', 'original factory refusal');
    return new AgentWorkspaceHost({
      prepareChat: async () => {
        if (mode === 'rejection') throw new KinuError('missing', 'original chat refusal');
        await fetch('http://held.invalid/');
        return { kept: true };
      },
      session: async () => {
        if (mode === 'session-factory-rejection') throw new KinuError('missing', 'original session refusal');
        return new Session();
      },
      relayModelCall: async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('kept stream'));
        controller.close();
      } })),
    }, this.closed.signal);
  }
}
export default { async fetch(request, env) {
  const [action, mode] = new URL(request.url).pathname.slice(1).split('/');
  const workspace = env.OrchestratorAgent.getByName(mode);
  if (action === 'close') { await workspace.close(); return Response.json({ closed: true }); }
  return Response.json(await workspace.run(mode));
} };
`;

writeFileSync(join(dir, 'worker.js'), worker);

buildSync({ entryPoints: [join(dir, 'worker.js')], outfile: join(dir, 'bundle.js'), bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'], nodePaths: [join(root, 'node_modules')], logLevel: 'error' });

const options = convertV4MiniflareOptions({ workers: [{
  name: 'probe', modulesRoot: dir, modules: [{ type: 'ESModule', path: join(dir, 'bundle.js'), contents: readFileSync(join(dir, 'bundle.js'), 'utf8') }],
  compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat', 'new_module_registry'], durableObjects: { OrchestratorAgent: 'Workspace' }, workerLoaders: { LOADER: {} },
  outboundService: async () => {
    arrived.resolve();
    await released.promise;

    return new Response('released');
  },
}, {
  name: 'collector', modulesRoot: dir, compatibilityDate: '2026-09-30',
  modules: [{ type: 'ESModule', path: join(dir, 'collector.js'), contents: `export default { async tail(events, env) {
    for (const event of events) await env.SINK.fetch('http://tail/', { method: 'POST', body: JSON.stringify({ outcome: event.outcome, rpc: event.event?.rpcMethod, exceptions: event.exceptions.map(error => ({ name: error.name, message: error.message })) }) });
  } };` }],
  serviceBindings: { SINK: async request => {
    const tail = await request.json();

    if (['prepareChat', 'session', 'relayModelCall'].includes(tail.rpc)) { tails.push(tail); relayEnded.resolve(tail); }

    return new Response('kept');
  } },
}] });

options.workers[0].config.tailConsumers = [{ worker: 'collector' }];

const mf = new Miniflare(options);

const observed = [];

try {
  await mf.ready;

  for (const mode of cases) {
    arrived = Promise.withResolvers();
    released = Promise.withResolvers();
    relayEnded = Promise.withResolvers();
    const pending = mf.dispatchFetch('http://probe/run/' + mode);

    if (mode === 'refusal') {
      await arrived.promise;
      await (await mf.dispatchFetch('http://probe/close/' + mode)).json();
      released.resolve();
    }

    const answer = await (await pending).json();
    const ended = await relayEnded.promise;
    observed.push({ mode, answer, tail: ended });
    console.log('OBSERVED', JSON.stringify(observed.at(-1)));
  }
} finally {
  try { await mf.dispose(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

assert.equal(observed.length, cases.length);

assert(observed.every(item => item.tail.outcome === 'ok'), 'every answered relay must close before runtime disposal');

const expectedFailures = {
  'factory-rejection': 'original factory refusal', 'refusal': 'original workspace refusal', 'rejection': 'original chat refusal',
  'session-factory-rejection': 'original session refusal', 'session-method-rejection': 'original session refusal',
};

for (const item of observed) {
  if (item.mode === 'fulfilled-stream') assert.equal(item.answer.answer, 'kept stream');
  else {
    assert.equal(item.answer.failure?.code, 'missing');
    assert.equal(item.answer.failure?.name, 'KinuError[missing]');

    assert.equal(item.answer.failure?.message, expectedFailures[item.mode]);

    if (item.mode === 'session-method-rejection') assert.equal(item.answer.kept, 'kept session');
  }
}

console.log('SUMMARY', JSON.stringify(observed));
