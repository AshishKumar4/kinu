import * as v from 'valibot';
import { DurableObject, WorkerEntrypoint, exports } from 'cloudflare:workers';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { probeDurableApps, probeFacetManager } from './facet-manager';
import { newWebSocketRpcSession } from 'capnweb';
import {
  initSlateStateTable, parseSlateProject, issuedSlateInvocation, routeSlateBindingCall, routeSlateStorageCall,
  type JsonValue, type SlateCallResult, type SlateInvocation,
} from '@kinu.run/core';
import { SqliteSlateStateStore, type SlateStorageOp } from '@kinu.run/core/slates';
import { KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateProcess } from '../../src/slates/resident';
import { slateBatchStub } from '../../src/slates/rpc-transport';
import { codemodeEgress } from '../../src/codemode-egress';

/**
 * Stands in for the host's binding entrypoint, using the host's OWN resolution
 * so this probe cannot pass while `SlateHost` would refuse: it holds the same
 * `invocation -> { id, chain }` record and calls `issuedSlateInvocation`.
 */
export class SlateChainProbe extends WorkerEntrypoint {
  async call(member: string, args: JsonValue[], invocation: string | null): Promise<SlateCallResult> {
    const project = parseSlateProject({ main: 'server.ts', slate: { bindings: { PEER: { kind: 'app', id: 'peer' } } } });

    try {
      const chain = issuedSlateInvocation({ invocations: SlateProcessProbeDO.invocations, id: 'probe', invocation })?.chain ?? [];
      const route = routeSlateBindingCall({ id: 'probe', project, name: 'PEER', request: { member, args, invocation }, chain });

      if (route.kind !== 'app') throw new Error('Expected app route');

      return { ok: true, value: { chain: [...route.chain], args: [...route.args] } };
    } catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { ok: false, reason: cause.code, error: cause.message };
    }
  }
}

export class SlateProcessProbeDO extends DurableObject<Cloudflare.Env> {
  /** The live app invocations, exactly as `SlateHost` keeps them. Static
   *  because `SlateChainProbe` answers outside this object. */
  static readonly invocations = new Map<string, SlateInvocation>();

  /** The probe DO's own `slate_state` rows — the same table the workspace
   *  object's schema carries, so the KV path is real. */
  private readonly state = new SqliteSlateStateStore(this.ctx.storage.sql);

  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly processes = new SessionProcessSupervisor();
  private readonly ports = new PortRegistry();
  private readonly facets = probeFacetManager({
    ctx: this.ctx, env: this.env, processes: this.processes, portRegistry: this.ports, vfs: this.vfs,
  });

  private readonly resident = new ResidentSlateProcesses({
    session: async () => ({ vfs: this.vfs, processes: this.processes }),
    facetManager: async () => this.facets,
  });

  private process: ResidentSlateProcess | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    initSlateStateTable((ddl: string) => ctx.storage.sql.exec(ddl));
  }

  /** The reserved `__storage` arm. A WorkerEntrypoint runs in the CALLER's
   *  request context, where this DO's `ctx.storage` is not usable — the exact
   *  I/O-context error the real binding path never sees because `SlateHost`
   *  answers inside the workspace object's own call. So `__storage` binds this
   *  DO's own stub and `call` routes by member name, validated by the same
   *  `routeSlateStorageCall`. */
  private storageCall(member: string, args: JsonValue[]): SlateCallResult {
    try {
      const operation: SlateStorageOp = routeSlateStorageCall({ member, args, invocation: null });

      switch (operation.op) {
        case 'get': return { ok: true, value: this.state.get('probe', operation.key) };
        case 'put': {
          this.state.put('probe', operation.key, operation.value);

          return { ok: true, value: null };
        }

        case 'delete': return { ok: true, value: this.state.delete('probe', operation.key) };
        case 'list': return { ok: true, value: this.state.list('probe', { prefix: operation.prefix, limit: operation.limit }) };
      }
    } catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { ok: false, reason: cause.code, error: cause.message };
    }
  }

  /** `__storage`'s stub calls `call(member, args, invocation)`; the tests call
   *  `call(method, args, chain)` — the third parameter tells them apart. */
  async call(member: string, args: JsonValue[], invocation: string | null): Promise<SlateCallResult>;
  async call(method: string, args?: JsonValue[], chain?: string[]): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
  async call(member: string, args: JsonValue[] = [], third: string | null | string[] = []) {
    if (Array.isArray(third)) return this.appCall(member, args, third);

    return this.storageCall(member, args);
  }

  /**
   * `start()` takes the authored server source, compiles it into the resident
   * facet's application bundle, and boots the process. The `bindChain` arm is
   * what a slate the user previewed runs: it gets the SAME binding map the
   * host mints — the declared `PEER` plus the reserved `__storage` every slate
   * carries whether it declares one or not, bound to this DO's own stub.
   */
  async start(source = [
    'import { SlateObject } from "kinu:slate";',
    'export class Slate extends SlateObject {',
    '  envKeys() { return Object.keys(this.env); }',
    '  async greet(name: string) {',
    '    const count = (await this.storage.get("count")) ?? 0;',
    '    await this.storage.put("count", count + 1);',
    '    const echo = await this.env.PEER.echo(name);',
    '    return `hello ${name} #${count + 1} [${echo.chain.join(">")}]`;',
    '  }',
    '  async fetch() { return new Response("not found", { status: 404 }); }',
    '}',
  ].join('\n'), bindChain = true, cred: VfsCred = CRED_SESSION_USER,
  browser?: string, project: Record<string, JsonValue> = { main: 'server.ts' },
  app: { port: number } | null = { port: 8789 }): Promise<void> {
    await this.stop();
    const root = '/home/user/slates/notes';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/${project.main ?? 'server.ts'}`, source);

    if (browser !== undefined) files.writeFile(`${root}/${project.browser ?? 'browser.ts'}`, browser);

    const storageStub = this.env.SLATE_PROCESS_PROBE.get(this.ctx.id);

    const owner = JSON.stringify([this.ctx.id.toString(), root, cred]);

    // A durable spawn starts only under a reservation its owner holds — the
    // slate host reserves before it launches, and so does the probe.
    if (app !== null) await probeDurableApps(this.facets).ensure({ owner, preferredPort: app.port });

    const boot = {
      key: crypto.randomUUID(), owner, root, app, cred,
      globalOutbound: codemodeEgress(),
      project: parseSlateProject(project),
    };

    this.process = await this.resident.start(bindChain
      ? { ...boot, bindings: { __storage: storageStub, PEER: exports.SlateChainProbe({}) } }
      : { ...boot, bindings: { __storage: storageStub } });
  }

  async seedPrivateSource(): Promise<void> {
    const kernel = this.vfs.as(CRED_KERNEL);
    kernel.mkdir('/root', { mode: 0o700 });
    kernel.writeFile('/root/private.ts', 'export default "kernel-private-source";', { mode: 0o600 });
  }

  async seedGroupSource(): Promise<void> {
    const kernel = this.vfs.as(CRED_KERNEL);
    kernel.mkdir('/shared', { recursive: true });
    kernel.writeFile('/shared/group.ts', 'export default "group-protected-source";', { mode: 0o640 });
    kernel.chown('/shared/group.ts', 0, 3000);
  }

  async readPrivateSourceAsAgent() {
    try { return { content: this.vfs.as(CRED_SESSION_USER).readFileString('/root/private.ts') }; }
    catch (cause) { return { error: renderThrownChain({ cause }) }; }
  }

  async compileProbe(source: string, cred: VfsCred = CRED_SESSION_USER) {
    try { await this.start(source, false, cred); }
    catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { code: cause.code, detail: renderThrownChain({ cause }) };
    }

    return { ok: true };
  }

  /** One app call: mint the invocation id the host would, refuse names the
   *  class never published exactly as `SlateHost.call` does, then open the
   *  batch RPC session the runner exposes at `/__rpc` and retire the id when
   *  it settles — the same lifetime `SlateHost.call` gives it. The value
   *  crosses this RPC boundary as a string: the `JsonValue` union would send
   *  `Rpc.Result`'s `Serializable` check into unbounded recursion (TS2589). */
  private async appCall(method: string, args: JsonValue[], chain: string[]): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const invocation = crypto.randomUUID();
    SlateProcessProbeDO.invocations.set(invocation, { id: 'probe', chain });

    try {
      const process = this.started();

      if (!process.methods.includes(method)) {
        throw new KinuError('bad_input', `Slate probe has no method ${method}; its class exports ${process.methods.join(', ')}`);
      }

      const stub = slateBatchStub<Record<string, (...input: JsonValue[]) => Promise<JsonValue>>>(process, invocation);

      try {
        const raw = await stub[method](...args);
        const value = v.is(v.string(), raw) ? raw : JSON.stringify(raw);

        return { ok: true, value };
      } finally {
        // Shut the session down once the call settles: disposing the main stub
        // aborts the read-loop, and doing it here — not at transport end — is
        // the difference between a rejection capnweb observes and one workerd
        // reports as unhandled.
        // SAFETY: `RpcStub` always carries a `Symbol.dispose` hook for its
        // session (capnweb's RpcStub constructor sets it) — the interface
        // merely doesn't declare it.
        (stub as { [Symbol.dispose](): void })[Symbol.dispose]();
      }
    } catch (cause) {
      return { ok: false, error: renderThrownChain({ cause }) };
    } finally {
      SlateProcessProbeDO.invocations.delete(invocation);
    }
  }

  /** The bundle texts this boot produced, for assertions on real bytes. */
  artifacts() {
    return this.started().artifacts;
  }

  /** What the agent's own file view sees: absence of tooling inside the slate
   *  root, and the kernel-owned generated entries under the runtime dir. */
  paths() {
    return {
      kinuInSlateRoot: this.vfs.as(CRED_SESSION_USER).exists('/home/user/slates/notes/.kinu'),
      entries: this.vfs.as(CRED_SESSION_USER).readdir('/usr/lib/kinu/slate/entries/notes').map((entry) => entry.name),
    };
  }

  /** The browser arm of `call`: the same method over a WebSocket session routed
   *  through the port registry — the path a real browser takes — with the
   *  `x-slate-call` header stamped as the host would stamp it. The minted id
   *  retires when the socket closes: session lineage never outlives its call. */
  async socket(method: string, args: JsonValue[] = []): Promise<{ ok?: boolean; value?: string; error?: string }> {
    const process = this.started();
    const invocation = crypto.randomUUID();
    SlateProcessProbeDO.invocations.set(invocation, { id: 'probe', chain: [] });

    try {
      const request = new Request('https://slate.invalid/__rpc', { headers: { Upgrade: 'websocket', 'x-slate-call': invocation } });

      if (process.port === null) throw new KinuError('unavailable', 'a private slate process has no port');
      const response = await this.ports.routeRequest(process.port, request, '/__rpc');

      if (response === null) return { error: 'no process listening' };
      const socket = response.webSocket;

      if (socket === null || socket === undefined) return { error: `upgrade refused: ${response.status}` };
      socket.accept();
      const stub = newWebSocketRpcSession<Record<string, (...input: JsonValue[]) => Promise<JsonValue>>>(socket);

      try {
        const raw = await stub[method](...args);

        return { ok: true, value: v.is(v.string(), raw) ? raw : JSON.stringify(raw) };
      } catch (cause) { return { ok: false, error: renderThrownChain({ cause }) }; }
      finally { socket.close(); }
    } finally {
      SlateProcessProbeDO.invocations.delete(invocation);
    }
  }

  /** HTTP through the port registry, exactly as a caller's fetch arrives: the
   *  minted id is retired when the response is read, so a replayed header names
   *  a dead invocation. */
  async route(path = '/', chain: string[] = []) {
    const process = this.started();
    const invocation = crypto.randomUUID();
    SlateProcessProbeDO.invocations.set(invocation, { id: 'probe', chain });

    try {
      if (process.port === null) throw new KinuError('unavailable', 'a private slate process has no port');

      const response = await this.ports.routeRequest(process.port,
        new Request(`https://slate.invalid${path}`, { headers: { 'x-slate-call': invocation } }),
        path);

      if (response === null) return { status: 404, body: 'no process listening', contentType: null };

      return { status: response.status, body: await response.text(), contentType: response.headers.get('content-type') };
    } finally {
      SlateProcessProbeDO.invocations.delete(invocation);
    }
  }

  async stop(): Promise<void> {
    await this.process?.stop();
    this.process = undefined;
  }

  private started(): ResidentSlateProcess {
    const process = this.process;

    if (process === undefined) throw new KinuError('unavailable', 'start() has not produced a resident process');

    return process;
  }
}
