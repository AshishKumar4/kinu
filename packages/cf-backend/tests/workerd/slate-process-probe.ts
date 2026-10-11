import * as v from 'valibot';
import { DurableObject, WorkerEntrypoint, exports } from 'cloudflare:workers';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { FACET_IMAGE_DIR } from '@nimbus-sh/fabric/process-fabric.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { supervisorEsbuildService } from '@nimbus-sh/worker/facet-host';
import { probeDurableApps, probeFacetManager } from './facet-manager';
import { newWebSocketRpcSession } from 'capnweb';
import {
  initSlateStateTable, parseSlateProject, slateAuthority, issuedSlateInvocation, routeSlateCall, slateStorageCall,
  type JsonValue, type SlateCallResult, type SlateInvocation,
} from '@kinu.run/core';
import { SlateBuilds, SqliteSlateStateStore, initSlateBuildTable, slateImage } from '@kinu.run/core/slates';
import { KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateProcess } from '../../src/slates/resident';
import { slateBatchStub } from '../../src/slates/rpc-transport';
import { codemodeEgress } from '../../src/codemode-egress';

/** Uses the host's own `issuedSlateInvocation`, so this probe cannot pass while `SlateHost`
 *  would refuse. */
export class SlateChainProbe extends WorkerEntrypoint {
  async call(path: string[], args: JsonValue[], invocation: string | null): Promise<SlateCallResult> {
    try {
      const chain = issuedSlateInvocation({ invocations: SlateProcessProbeDO.invocations, id: 'probe', invocation })?.chain ?? [];
      const { route } = routeSlateCall({ id: 'probe', request: { path, args, invocation }, chain });

      if (route.kind !== 'app') throw new Error('Expected app route');

      return { ok: true, value: { chain: [...route.chain], args: [...route.args] } };
    } catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { ok: false, success: false, reason: cause.code, error: cause.message };
    }
  }
}

const DEFAULT_SLATE_SOURCE = [
  'import { SlateObject } from "kinu:slate";',
  'export class Slate extends SlateObject {',
  '  envKeys() { return Object.keys(this.env); }',
  '  async greet(name: string) {',
  '    const count = (await this.storage.get("count")) ?? 0;',
  '    await this.storage.put("count", count + 1);',
  '    const echo = await this.env.workspace.slates.peer.echo(name);',
  '    return `hello ${name} #${count + 1} [${echo.chain.join(">")}]`;',
  '  }',
  '  async fetch() { return new Response("not found", { status: 404 }); }',
  '}',
].join('\n');

interface SlateStart {
  /** The module at `project.main`; null writes none. */
  readonly source?: string | null;
  readonly bindChain?: boolean;
  readonly cred?: VfsCred;
  readonly browser?: string;
  readonly project?: Record<string, JsonValue>;
  readonly app?: { port: number } | null;
}

export class SlateProcessProbeDO extends DurableObject<Cloudflare.Env> {
  /** Static because `SlateChainProbe` answers outside this object. */
  static readonly invocations = new Map<string, SlateInvocation>();

  private readonly state = new SqliteSlateStateStore(this.ctx.storage.sql);

  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly processes = new SessionProcessSupervisor();
  private readonly ports = new PortRegistry();
  private readonly filesystem = new ProcessFiles(this.vfs);
  private readonly facets = probeFacetManager({
    ctx: this.ctx, env: this.env, processes: this.processes, portRegistry: this.ports, vfs: this.vfs, filesystem: this.filesystem,
  });

  private readonly bundlers: EsbuildService[] = [];

  private readonly resident = new ResidentSlateProcesses({
    session: async () => ({ vfs: this.vfs, processes: this.processes, filesystem: this.filesystem }),
    facetManager: async () => this.facets,
    retained: () => [],
    // What OrchestratorAgent hands its slates; kept to ask where esbuild ran.
    bundler: (vfs) => {
      const bundler = supervisorEsbuildService(this.ctx, this.env, vfs);

      this.bundlers.push(bundler);

      return bundler;
    },
  });

  /** Whether a slate bundler instantiated esbuild-wasm in this object's own isolate. */
  async esbuildInThisIsolate(): Promise<boolean> {
    return this.bundlers.some((bundler) => bundler.isInitialized || bundler.transformsInIsolate);
  }

  private process: ResidentSlateProcess | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    initSlateStateTable((ddl: string) => ctx.storage.sql.exec(ddl));
  }

  /** A WorkerEntrypoint runs in the caller's request context, where this DO's `ctx.storage` is
   *  unusable: `__storage` binds this DO's own stub and answers through `slateStorageCall`. */
  private storageCall(member: string, args: JsonValue[]): SlateCallResult {
    try {
      return slateStorageCall(this.state, { workMode: 'build' }, 'probe', { member, args });
    } catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { ok: false, success: false, reason: cause.code, error: cause.message };
    }
  }

  /** The third parameter tells `__storage`'s stub calls apart from the tests' calls. */
  async call(path: string[], args: JsonValue[], invocation: string | null): Promise<SlateCallResult>;
  async call(method: string, args?: JsonValue[], chain?: string[]): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
  async call(first: string | string[], args: JsonValue[] = [], third: string | null | string[] = []) {
    // The runner's `__storage` calls name a path; a test's call names a method and a chain.
    if (Array.isArray(first)) return this.storageCall(first.join('.'), args);

    return this.appCall(first, args, Array.isArray(third) ? third : []);
  }

  async start({
    source = DEFAULT_SLATE_SOURCE, bindChain = true, cred = CRED_SESSION_USER,
    browser, project = { main: 'server.ts' }, app = { port: 8789 },
  }: SlateStart = {}): Promise<void> {
    await this.stop();
    const root = '/slates/notes';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });

    if (source !== null) files.writeFile(`${root}/${v.parse(v.string(), project.main ?? 'server.ts')}`, source);

    if (browser !== undefined) files.writeFile(`${root}/${v.parse(v.string(), project.browser ?? 'browser.ts')}`, browser);

    const storageStub = this.env.SLATE_PROCESS_PROBE.get(this.ctx.id);

    const owner = JSON.stringify([this.ctx.id.toString(), root, cred]);

    // A durable spawn starts only under a reservation its owner holds.
    if (app !== null) await probeDurableApps(this.facets).ensure({ owner, preferredPort: app.port });

    // The caller's own view, as the host reads it: a file the caller cannot see is one the slate does not hold.
    const authored = this.vfs.as(cred);
    const read = (entry: string) => (authored.exists(`${root}/${entry}`) ? authored.readFileString(`${root}/${entry}`) : null);

    const boot = {
      key: crypto.randomUUID(), owner, root, read, app, cred,
      globalOutbound: codemodeEgress({ workspace: null, actor: null }),
      project: parseSlateProject(project),
    };

    this.process = await this.resident.start(bindChain
      ? { ...boot, bindings: { __storage: storageStub, workspace: exports.SlateChainProbe({}) } }
      : { ...boot, bindings: { __storage: storageStub } });
  }

  /**
   * The paths a build of `/slates/linked` looked at outside its tree, where its `lib.ts` is a link to `/home/linked/lib.ts`
   * and its class imports `./lib.ts`.
   */
  async linkedBuildInputs(): Promise<string[]> {
    const files = this.vfs.as(CRED_KERNEL);

    files.mkdir('/home/linked', { recursive: true });
    files.writeFile('/home/linked/lib.ts', 'export const word = "linked";\n');
    files.mkdir('/slates/linked', { recursive: true });
    files.writeFile('/slates/linked/server.ts', 'import { SlateObject } from "kinu:slate";\nimport { word } from "./lib.ts";\nexport class Slate extends SlateObject { word() { return word; } }\n');
    files.symlink('/home/linked/lib.ts', '/slates/linked/lib.ts');
    const authored = this.vfs.as(CRED_SESSION_USER);

    const built = await this.resident.build({
      owner: 'linked', root: '/slates/linked', project: parseSlateProject({ main: 'server.ts' }), cred: CRED_SESSION_USER,
      read: (entry) => (authored.exists(`/slates/linked/${entry}`) ? authored.readFileString(`/slates/linked/${entry}`) : null),
    });

    return (built.inputs ?? []).filter((input) => !input.missing).map((input) => input.path);
  }

  /**
   * A build of `/slates/dangling`, whose `lib.ts` links to `/home/dangling/lib.ts` before that file is written: whether
   * it was refused, and the paths it found missing outside its tree.
   */
  async danglingBuildInputs(): Promise<{ readonly refused: boolean; readonly missing: string[] }> {
    const files = this.vfs.as(CRED_KERNEL);

    files.mkdir('/slates/dangling', { recursive: true });
    files.writeFile('/slates/dangling/server.ts', 'import { SlateObject } from "kinu:slate";\nimport { word } from "./lib.ts";\nexport class Slate extends SlateObject { word() { return word; } }\n');
    files.symlink('/home/dangling/lib.ts', '/slates/dangling/lib.ts');
    const authored = this.vfs.as(CRED_SESSION_USER);

    const built = await this.resident.build({
      owner: 'dangling', root: '/slates/dangling', project: parseSlateProject({ main: 'server.ts' }), cred: CRED_SESSION_USER,
      read: (entry) => (authored.exists(`/slates/dangling/${entry}`) ? authored.readFileString(`/slates/dangling/${entry}`) : null),
    });

    return { refused: 'failed' in built, missing: (built.inputs ?? []).filter((input) => input.missing).map((input) => input.path) };
  }

  /**
   * `/slates/chained/lib.ts` links to `/home/chained/alias.ts`, which links to `/home/chained/future/lib.ts`, written
   * only after a first build is refused. The refusal is stored as the host stores it; writing the final target names
   * the slate stale, and its next build compiles.
   */
  async chainedBuild(): Promise<{ readonly first: string; readonly missing: string[]; readonly stale: string[]; readonly second: string }> {
    const files = this.vfs.as(CRED_KERNEL);

    files.mkdir('/slates/chained', { recursive: true });
    files.writeFile('/slates/chained/server.ts', 'import { SlateObject } from "kinu:slate";\nimport { word } from "./lib.ts";\nexport class Slate extends SlateObject { word() { return word; } }\n');
    files.mkdir('/home/chained', { recursive: true });
    files.symlink('/home/chained/alias.ts', '/slates/chained/lib.ts');
    files.symlink('/home/chained/future/lib.ts', '/home/chained/alias.ts');
    const sql = this.ctx.storage.sql;

    initSlateBuildTable((ddl) => { sql.exec(ddl); });
    const builds = new SlateBuilds(sql);
    const authored = this.vfs.as(CRED_SESSION_USER);

    const build = () => this.resident.build({
      owner: 'chained', root: '/slates/chained', project: parseSlateProject({ main: 'server.ts' }), cred: CRED_SESSION_USER,
      read: (entry) => (authored.exists(`/slates/chained/${entry}`) ? authored.readFileString(`/slates/chained/${entry}`) : null),
    });

    const first = await build();

    if ('failed' in first) builds.failed('chained', slateAuthority(CRED_SESSION_USER), 'v1', first);
    files.mkdir('/home/chained/future', { recursive: true });
    files.writeFile('/home/chained/future/lib.ts', 'export const word = "chained";\n');
    const stale = builds.moved(['/home/chained/future/lib.ts']);
    const second = await build();

    return {
      first: 'failed' in first ? 'refused' : 'built',
      missing: (first.inputs ?? []).filter((input) => input.missing).map((input) => input.path),
      stale,
      second: 'failed' in second ? second.failed : 'built',
    };
  }

  /**
   * A slate whose `lib.ts` reaches outside its tree through a resolution that cannot build yet, refused through the
   * build cache as the host asks it; then the resolution is repaired outside the tree, the host is told what was
   * written, and the cache is asked again. `alias`: lib.ts links to alias.ts, which links to a file not written, and
   * alias.ts is replaced by a link to a written library. `obstruction`: lib.ts links under a regular file, which is
   * replaced by a directory holding the library. `loop`: lib.ts links under a pair of links that point at each other,
   * one replaced by a directory holding the library. Answers each attempt's outcome and how long the second took.
   */
  async repairedRefusal(repair: 'alias' | 'obstruction' | 'loop'): Promise<{ readonly first: string; readonly second: string; readonly ms: number }> {
    const files = this.vfs.as(CRED_KERNEL);
    const root = `/slates/repair-${repair}`;
    const outside = `/home/repair-${repair}`;
    const library = 'export const word = "repaired";\n';

    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/server.ts`, 'import { SlateObject } from "kinu:slate";\nimport { word } from "./lib.ts";\nexport class Slate extends SlateObject { word() { return word; } }\n');
    files.mkdir(outside, { recursive: true });

    // A directory where the obstruction or the loop stood, holding the library.
    const replaceWithLibrary = (at: string) => () => {
      files.unlink(at);
      files.mkdir(at);
      files.writeFile(`${at}/lib.ts`, library);

      return [at, `${at}/lib.ts`];
    };

    const written = ((): () => string[] => {
      switch (repair) {
        case 'alias': {
          files.symlink(`${outside}/alias.ts`, `${root}/lib.ts`);
          files.symlink(`${outside}/future.ts`, `${outside}/alias.ts`);

          return () => {
            files.writeFile(`${outside}/real.ts`, library);
            files.unlink(`${outside}/alias.ts`);
            files.symlink(`${outside}/real.ts`, `${outside}/alias.ts`);

            return [`${outside}/real.ts`, `${outside}/alias.ts`];
          };
        }

        case 'obstruction': {
          files.writeFile(`${outside}/block`, 'a file where a directory belongs\n');
          files.symlink(`${outside}/block/lib.ts`, `${root}/lib.ts`);

          return replaceWithLibrary(`${outside}/block`);
        }

        case 'loop': {
          files.symlink(`${outside}/b`, `${outside}/a`);
          files.symlink(`${outside}/a`, `${outside}/b`);
          files.symlink(`${outside}/a/lib.ts`, `${root}/lib.ts`);

          return replaceWithLibrary(`${outside}/a`);
        }
      }
    })();

    const sql = this.ctx.storage.sql;

    initSlateBuildTable((ddl) => { sql.exec(ddl); });
    const builds = new SlateBuilds(sql);
    const authored = this.vfs.as(CRED_SESSION_USER);
    const slate = `repair-${repair}`;

    const attempt = async () => (await Promise.allSettled([slateImage({
      builds, slate, key: 'v1', cred: CRED_SESSION_USER,
      build: () => this.resident.build({
        owner: slate, root, project: parseSlateProject({ main: 'server.ts' }), cred: CRED_SESSION_USER,
        read: (entry) => (authored.exists(`${root}/${entry}`) ? authored.readFileString(`${root}/${entry}`) : null),
      }),
    })]))[0].status === 'fulfilled' ? 'built' : 'refused';

    const first = await attempt();

    builds.moved(written());
    const started = performance.now();
    const second = await attempt();

    return { first, second, ms: performance.now() - started };
  }

  async facetImages(): Promise<string[]> {
    const kernel = this.vfs.as(CRED_KERNEL);

    return kernel.exists(`/${FACET_IMAGE_DIR}`) ? kernel.readdir(`/${FACET_IMAGE_DIR}`).map((entry) => entry.name).sort() : [];
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

  async compileProbe(source: string | null, cred: VfsCred = CRED_SESSION_USER, project?: Record<string, JsonValue>) {
    try { await this.start(project === undefined ? { source, bindChain: false, cred } : { source, bindChain: false, cred, project }); }
    catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { code: cause.code, detail: renderThrownChain({ cause }) };
    }

    return { ok: true };
  }

  /** The value crosses as a string: `JsonValue` sends `Rpc.Result`'s `Serializable` check into
   *  unbounded recursion (TS2589). */
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
        // Dispose here, not at transport end: otherwise workerd reports the rejection as unhandled.
        stub[Symbol.dispose]();
      }
    } catch (cause) {
      return { ok: false, error: renderThrownChain({ cause }) };
    } finally {
      SlateProcessProbeDO.invocations.delete(invocation);
    }
  }

  artifacts() {
    return this.started().artifacts;
  }

  paths() {
    return {
      kinuInSlateRoot: this.vfs.as(CRED_SESSION_USER).exists('/slates/notes/.kinu'),
      entries: this.vfs.as(CRED_SESSION_USER).readdir('/usr/lib/kinu/slate/entries/notes').map((entry) => entry.name),
    };
  }

  /** The minted id retires when the socket closes: session lineage never outlives its call. */
  /** `surface` is a path on the surface a slate with no class serves on its socket; absent, `method` is the class's. */
  async socket(method: string, args: JsonValue[] = [], surface?: string[]): Promise<{ ok?: boolean; value?: string; error?: string }> {
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

      try {
        const raw = surface === undefined
          ? await newWebSocketRpcSession<Record<string, (...input: JsonValue[]) => Promise<JsonValue>>>(socket)[method](...args)
          : await newWebSocketRpcSession<{ $workspace(path: string[], input: JsonValue[]): Promise<JsonValue> }>(socket).$workspace(surface, args);

        return { ok: true, value: v.is(v.string(), raw) ? raw : JSON.stringify(raw) };
      } catch (cause) { return { ok: false, error: renderThrownChain({ cause }) }; }
      finally { socket.close(); }
    } finally {
      SlateProcessProbeDO.invocations.delete(invocation);
    }
  }

  /** The minted id retires when the response is read, so a replayed header names a dead
   *  invocation. */
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
