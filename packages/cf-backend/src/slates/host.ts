import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateFiles, SqliteSlateContentStore, SqliteSlateStore, WorkspaceSlates, slateDirectory, parseSlateProject,
  SlateBindingRequestSchema, SlateOperationSchema, routeSlateBindingCall, JsonValueSchema, projectJsonValue, isSlateMethodName,
  type CodemodeProvider, type JsonValue, type JsonObject, type SlateProject,
  type SlateBindingRoute, type SlateCallResult, type SlateReadModel, type SlateSummary, type SlateProblem,
} from '@kinu.run/core';
import { ERROR_CODES, KinuError, refusalOf, toKinuError } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import type { SlateBinding, SlateBindingProps } from './bindings';

const Failure = v.object({ reason: v.picklist(ERROR_CODES), error: v.string() });

export interface SlateHostDeps extends Omit<ResidentSlateDeps, 'content'> {
  providers(): readonly CodemodeProvider[];
  data(source: SlateReadModel): Promise<JsonValue>;
  mcp(server: string, tool: string, args: JsonObject): Promise<JsonValue>;
  expose(port: number): Promise<{ url?: string }>;
}

interface RunningSlate {
  readonly key: string;
  readonly process: ResidentSlateProcess;
}

/** One isolate-lifetime process per authored tree. No running state is durable. */
export class SlateHost {
  private readonly content: SqliteSlateContentStore;
  private readonly resident: ResidentSlateProcesses;
  private readonly store: SqliteSlateStore;
  private sourceRuntime: WorkspaceSlates | undefined;
  private readonly running = new Map<string, RunningSlate>();
  private readonly starting = new Map<string, Promise<ResidentSlateProcess>>();
  private readonly ports = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private nextPort = 20000;

  constructor(private readonly deps: SlateHostDeps) {
    this.content = new SqliteSlateContentStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.resident = new ResidentSlateProcesses({ ...deps, content: this.content });
    this.store = new SqliteSlateStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
  }

  async project(id: string): Promise<SlateProject> {
    const session = await this.deps.session();
    const path = `${slateDirectory(new SlateId(id))}/package.json`;
    return parseSlateProject(JSON.parse(session.vfs.as(CRED_SESSION_USER).readFileString(path)));
  }

  private async sources(): Promise<WorkspaceSlates> {
    const session = await this.deps.session();
    this.sourceRuntime ??= new WorkspaceSlates({
      workspaceId: new WorkspaceId(this.deps.workspace), store: this.store,
      files: new SlateFiles(session.vfs.as(CRED_SESSION_USER), this.content),
      mutations: { mutate: async (request, mutation) => {
        if (request.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate mutation belongs to another workspace');
        return session.vfs.withTransaction(mutation);
      } },
    });
    return this.sourceRuntime;
  }

  async operation<Input>(input: Input): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateOperationSchema, input);
      if (!parsed.success) throw new KinuError('bad_input', 'Slate operation does not match its declared fields', { cause: new v.ValiError(parsed.issues) });
      const operation = parsed.output;
      switch (operation.op) {
        case 'list': {
          const listing = await this.list();
          return { ok: true, value: { slates: listing.slates.map((slate) => ({ ...slate, bindings: [...slate.bindings] })), problems: listing.problems.map((problem) => ({ ...problem })) } };
        }
        case 'preview': return await this.preview(operation.id);
        case 'call': return await this.call(operation.id, operation.method, operation.args ?? []);
        case 'history': {
          await this.deps.session();
          const id = new SlateId(operation.id);
          const slate = this.store.getSlate(id);
          if (slate === undefined) throw new KinuError('missing', 'No durable slate record; commit source or open a preview first');
          if (slate.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate belongs to another workspace');
          return { ok: true, value: projectJsonValue({ value: { slate: slate.toData(), versions: this.store.listVersions(id).map((version) => version.toData()) } }) };
        }
        case 'commit': return { ok: true, value: projectJsonValue({ value: (await (await this.sources()).commit(new SlateId(operation.id))).toData() }) };
        case 'fork': return { ok: true, value: projectJsonValue({ value: (await (await this.sources()).fork(new SlateVersionId(operation.version))).toData() }) };
        case 'restore': return { ok: true, value: projectJsonValue({ value: (await (await this.sources()).restore(new SlateId(operation.id), new SlateVersionId(operation.version))).toData() }) };
      }
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate operation', cause, otherwise: 'io' })) };
    }
  }

  async list(): Promise<{ slates: SlateSummary[]; problems: SlateProblem[] }> {
    const session = await this.deps.session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    const slates: SlateSummary[] = [];
    const problems: SlateProblem[] = [];
    if (!vfs.exists('/home/user/slates')) return { slates, problems };
    for (const entry of vfs.readdir('/home/user/slates')) {
      if (entry.type !== 'directory') continue;
      try {
        const project = await this.project(entry.name);
        slates.push({ id: entry.name, title: project.slate.title ?? project.name ?? entry.name, bindings: Object.keys(project.slate.bindings) });
      } catch (cause) {
        problems.push({ id: entry.name, ...refusalOf(toKinuError({ doing: 'slate ' + entry.name, cause, otherwise: 'io' })) });
      }
    }
    return { slates, problems };
  }

  async preview(id: string): Promise<SlateCallResult> {
    try {
      const process = await this.ensure(id);
      const preview = await this.deps.expose(process.port);
      if (preview.url === undefined) throw new KinuError('unavailable', 'This deployment cannot mint a slate preview URL');
      return { ok: true, value: { url: preview.url, port: process.port } };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' preview', cause, otherwise: 'io' })) };
    }
  }

  async refreshPreview(port: number): Promise<void> {
    for (const [id, running] of this.running) {
      if (running.process.port === port) { await this.ensure(id); return; }
    }
  }

  /** Re-read the slate field on every call: a held stub proves its name, not today's reach. */
  async bindingCall(id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateBindingRequestSchema, request);
      if (!parsed.success) throw new KinuError('bad_input', 'A binding call is { member, args: JSON[], depth }', { cause: new v.ValiError(parsed.issues) });
      const project = await this.project(id);
      return await this.run(routeSlateBindingCall({ id, project, name, request: parsed.output }));
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} binding ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private async run(route: SlateBindingRoute): Promise<SlateCallResult> {
    switch (route.kind) {
      case 'namespace': {
        const provider = this.deps.providers().find((candidate) => candidate.name === route.namespace);
        if (!provider) return { ok: false, ...refusalOf(new KinuError('unavailable', `namespace ${route.namespace} is not available in this workspace right now`)) };
        if (!Object.hasOwn(provider.tools, route.member)) {
          return { ok: false, ...refusalOf(new KinuError('missing', `${route.namespace} has no member ${route.member}; it offers ${Object.keys(provider.tools).join(', ')}`)) };
        }
        const answered = await provider.tools[route.member]?.execute(...route.args);
        const value = v.safeParse(JsonValueSchema, answered === undefined ? null : answered);
        if (!value.success) throw new KinuError('bad_input', `${route.namespace}.${route.member} answered a value that is not JSON`, { cause: new v.ValiError(value.issues) });
        return { ok: true, value: value.output };
      }
      case 'rpc': return { ok: true, value: await this.deps.data(route.method) };
      case 'mcp': return { ok: true, value: await this.deps.mcp(route.server, route.tool, route.args) };
      case 'app': return this.call(route.id, route.method, [...route.args], route.depth + 1);
    }
  }

  /** App members are POST routes on the same authored fetch handler that serves the preview. */
  async call(id: string, method: string, args: JsonValue[], depth = 0): Promise<SlateCallResult> {
    try {
      if (!isSlateMethodName(method)) throw new KinuError('bad_input', `"${method}" is not an app method name`);
      const parsed = v.safeParse(v.array(JsonValueSchema), args);
      if (!parsed.success) throw new KinuError('bad_input', 'Slate arguments must be JSON values', { cause: new v.ValiError(parsed.issues) });
      const process = await this.ensure(id);
      const response = await process.request(new Request(`https://slate.invalid/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-slate-depth': String(depth) }, body: JSON.stringify(parsed.output),
      }));
      if (!response.ok) {
        const body = await response.text();
        if (response.headers.get('content-type')?.includes('application/json')) {
          const failure = v.safeParse(Failure, JSON.parse(body));
          if (failure.success) return { ok: false, ...failure.output };
        }
        throw new KinuError('io', 'Slate ' + id + '.' + method + ': HTTP ' + response.status + ': ' + body);
      }
      const value = v.safeParse(JsonValueSchema, await response.json());
      if (!value.success) throw new KinuError('bad_input', 'Slate response must be JSON', { cause: new v.ValiError(value.issues) });
      return { ok: true, value: value.output };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id}.${method}`, cause, otherwise: 'io' })) };
    }
  }

  ensure(id: string): Promise<ResidentSlateProcess> {
    const starting = this.starting.get(id);
    if (starting !== undefined) return starting;
    const boot = this.boot(id).finally(() => { this.starting.delete(id); });
    this.starting.set(id, boot);
    return boot;
  }

  private async boot(id: string): Promise<ResidentSlateProcess> {
    const root = slateDirectory(new SlateId(id));
    const sources = await this.sources();
    for (;;) {
      const revision = this.revisions.get(id) ?? 0;
      const project = await this.project(id);
      if (project.slate.runtime !== 'worker') throw new KinuError('unsupported', 'Resident slate previews require slate.runtime worker; run node projects through the sandbox executor');
      const source = (await sources.synchronize(new SlateId(id))).source;
      const key = `slate:${this.deps.workspace}:${id}:${source.digest.value}`;
      const held = this.running.get(id);
      if (held?.key === key && await held.process.isRunning()) return held.process;
      if (held !== undefined) {
        this.running.delete(id);
        await held.process.stop();
      }
      const bindings: Record<string, Fetcher<SlateBinding>> = {};
      for (const name of Object.keys(project.slate.bindings)) {
        const props: SlateBindingProps = { workspace: this.deps.workspace, id, name };
        bindings[name] = exports.SlateBinding({ props });
      }
      const port = project.slate.port ?? this.ports.get(id) ?? this.nextPort++;
      this.ports.set(id, port);
      const process = await this.resident.start({ key, root, project, port, bindings });
      if ((this.revisions.get(id) ?? 0) !== revision) { await process.stop(); continue; }
      this.running.set(id, { key, process });
      return process;
    }
  }

  filesChanged(paths: readonly string[]): string[] {
    const ids = new Set<string>();
    for (const path of paths) {
      const match = /^\/?home\/user\/slates\/([^/]+)(?:\/|$)/.exec(path);
      const id = match?.[1];
      if (id !== undefined) ids.add(id);
    }
    for (const id of ids) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    return [...ids];
  }
}
