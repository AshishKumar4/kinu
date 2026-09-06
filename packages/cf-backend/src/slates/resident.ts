import { ContentRef } from '@agent-core/core';
import type { ContentStore } from '@agent-core/core/content';
import { processes, type ResidentFacetEnv } from '@nimbus-sh/fabric/workerd-facet-host.js';
import { facetImagePath, facetImagePathDigest, type ResidentBootSpec } from '@nimbus-sh/fabric/process-fabric.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { RouteableFacetTarget } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { WorkspaceSession } from '@kinu.run/core/workspace';
import type { JsonValue, SlateProcess, SlateProject } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';

export interface SlateBindingCapability {
  call(member: string, args: JsonValue[]): Promise<JsonValue>;
}
export interface ResidentSlateDeps {
  readonly ctx: DurableObjectState;
  readonly env: ResidentFacetEnv;
  readonly workspace: string;
  readonly content: ContentStore;
  session(): Promise<Pick<WorkspaceSession, 'vfs' | 'processes'>>;
  registerPort(pid: number, port: number, target: RouteableFacetTarget): Promise<void>;
  unregisterPorts(pid: number): void;
}
export interface ResidentSlateBoot {
  readonly key: string;
  readonly root: string;
  readonly project: SlateProject;
  readonly port: number;
  readonly bindings: Readonly<Record<string, SlateBindingCapability>>;
}

function runner(assets: readonly { readonly path: string; readonly contents: string }[]): string {
  const files: Record<string, string> = {};
  for (const asset of assets) files[asset.path] = asset.contents;
  return [
    'import { DurableObject } from "cloudflare:workers";',
    'import application from "./application.js";',
    `const assets = Object.freeze(${JSON.stringify(files)});`,
    'function bindings(env) {',
    '  return Object.freeze(Object.fromEntries(Object.entries(env).map(([name, stub]) => [name, new Proxy(Object.create(null), {',
    '    get(_target, member) {',
    '      if (typeof member !== "string" || member === "then") return undefined;',
    '      return (...args) => stub.call(member, args);',
    '    }',
    '  })])));',
    '}',
    'export class NimbusProcess extends DurableObject {',
    '  constructor(ctx, env) { super(ctx, env); this.bindings = bindings(env); }',
    '  async startProcess() {',
    '    if (typeof application?.fetch !== "function") throw new TypeError("package.json main must export a default fetch handler");',
    '    return { ok: true };',
    '  }',
    '  async fetch(request) { return this.handleHttpRequest(request); }',
    '  async handleHttpRequest(request) {',
    '    const path = new URL(request.url).pathname;',
    '    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;',
    '    if (asset !== undefined && (request.method === "GET" || request.method === "HEAD")) {',
    '      return new Response(request.method === "HEAD" ? null : asset, { headers: {',
    '        "content-type": path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",',
    '        "cache-control": "no-store"',
    '      }});',
    '    }',
    '    return application.fetch(request, this.bindings, { waitUntil: (work) => this.ctx.waitUntil(work) });',
    '  }',
    '}',
  ].join('\n');
}

export class ResidentSlateProcesses {
  private bundler: EsbuildService | undefined;

  constructor(private readonly deps: ResidentSlateDeps) {}

  async start(input: ResidentSlateBoot): Promise<SlateProcess> {
    const session = await this.deps.session();
    const main = input.project.main;
    if (main === undefined) throw new KinuError('bad_input', 'package.json main must name the Worker module');
    const bundler = this.bundler ??= new EsbuildService(session.vfs);
    const server = await bundler.build([`${input.root}/${main}`], {
      bundle: true, format: 'esm', platform: 'neutral', outfile: '/application.js', external: ['cloudflare:*', 'node:*'],
    });
    if (server.errors.length !== 0) throw new KinuError('bad_input', server.errors.map((error) => error.text).join('\n'));
    const application = server.outputFiles.find((file) => file.path === '/application.js');
    if (application === undefined) throw new KinuError('io', 'Slate compiler did not produce the server module');
    let assets: typeof server.outputFiles = [];
    if (input.project.browser !== undefined) {
      const browser = input.project.browser;
      const client = await bundler.build([`${input.root}/${browser}`], {
        bundle: true, format: 'esm', platform: 'browser', outfile: new URL(browser, 'https://slate.invalid/').pathname,
      });
      if (client.errors.length !== 0) throw new KinuError('bad_input', client.errors.map((error) => error.text).join('\n'));
      assets = client.outputFiles;
    }
    const applicationRef = (await this.deps.content.put(new TextEncoder().encode(application.contents))).ref;
    const runnerRef = (await this.deps.content.put(new TextEncoder().encode(runner(assets)))).ref;
    const entry = session.processes.spawn(main, [], input.root, { longRunning: true });
    const writerId = crypto.randomUUID();
    const boot: ResidentBootSpec = {
      kind: 'code',
      code: {
        compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'], mainModule: 'runner.js', modules: {},
        vfsTextModules: { 'runner.js': facetImagePath(runnerRef.digest.value), 'application.js': facetImagePath(applicationRef.digest.value) },
        env: input.bindings,
      },
    };
    const process = processes(this.deps.ctx, this.deps.env).spawn(
      () => ({ readFile: async (path) => {
        const digest = facetImagePathDigest(path);
        if (digest === null) throw new KinuError('bad_input', `Invalid facet image path: ${path}`);
        return this.deps.content.get(new ContentRef(`sha256:${digest}`));
      } }),
      { doId: this.deps.workspace, pid: entry.pid, writerId },
      { pid: entry.pid, workerKey: input.key, boot, writerId, startArgs: {} },
    );
    try {
      await process.started;
      await this.deps.registerPort(entry.pid, input.port, process);
    } catch (cause) {
      session.processes.exit(entry.pid, 1);
      this.deps.unregisterPorts(entry.pid);
      try { await process.release(); }
      catch (releaseCause) { throw new AggregateError([cause, releaseCause], 'Slate boot and process release failed', { cause: releaseCause }); }
      throw cause;
    }
    session.processes.setTerminator(entry.pid, () => {
      this.deps.unregisterPorts(entry.pid);
      this.deps.ctx.waitUntil(process.release());
    });
    return {
      id: String(entry.pid), port: input.port,
      isRunning: async () => session.processes.get(entry.pid)?.state === 'running',
      stop: async () => {
        await process.release();
        this.deps.unregisterPorts(entry.pid);
        session.processes.exit(entry.pid, 0);
      },
    };
  }
}
