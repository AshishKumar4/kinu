import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateFiles, SqliteSlateContentStore, SqliteSlateStore, WorkspaceSlates, slateDirectory, parseSlateProject,
  SlateBindingRequestSchema, SlateOperationSchema, routeSlateBindingCall, JsonValueSchema, projectJsonValue, isSlateMethodName, answeredRefusal,
  type JsonValue, type SlateProject,
  type SlateBindingRoute, type SlateCallResult, type SlateSummary, type SlateProblem,
} from '@kinu.run/core';
import { ERROR_CODES, KinuError, refusalOf, toKinuError } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateCallerKey, type SlateBinding, type SlateBindingProps, type SlateCaller } from './bindings';

const Failure = v.object({ reason: v.picklist(ERROR_CODES), error: v.string() });

/** A binding route the calling actor answers with its own capability set. */
export type SlateCapabilityRoute = Exclude<SlateBindingRoute, { kind: 'app' }>;

export interface SlateHostDeps extends Omit<ResidentSlateDeps, 'content'> {
  /** Run a capability route as the caller: its own providers, its own role reach, its own read models, its own gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute): Promise<JsonValue>;
  expose(port: number): Promise<{ url?: string }>;
}

interface RunningSlate {
  readonly key: string;
  readonly caller: SlateCaller;
  readonly id: string;
  readonly process: ResidentSlateProcess;
}

/** One isolate-lifetime process per authored tree PER CALLER. No running state is durable. */
export class SlateHost {
  private readonly content: SqliteSlateContentStore;
  private readonly resident: ResidentSlateProcesses;
  private readonly store: SqliteSlateStore;
  private readonly sourceRuntimes = new Map<string, WorkspaceSlates>();
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

  private async project(cred: VfsCred, id: string): Promise<SlateProject> {
    const session = await this.deps.session();
    const path = `${slateDirectory(new SlateId(id))}/package.json`;
    return parseSlateProject(JSON.parse(session.vfs.as(cred).readFileString(path)));
  }

  private async sources(cred: VfsCred): Promise<WorkspaceSlates> {
    const session = await this.deps.session();
    const key = `${cred.uid}:${cred.gid}`;
    let runtime = this.sourceRuntimes.get(key);
    if (runtime === undefined) {
      runtime = new WorkspaceSlates({
        workspaceId: new WorkspaceId(this.deps.workspace), store: this.store,
        files: new SlateFiles(session.vfs.as(cred), this.content),
        mutations: { mutate: async (request, mutation) => {
          if (request.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate mutation belongs to another workspace');
          return session.vfs.withTransaction(mutation);
        } },
      });
      this.sourceRuntimes.set(key, runtime);
    }
    return runtime;
  }

  async operation<Input>(caller: SlateCaller, input: Input): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateOperationSchema, input);
      if (!parsed.success) throw new KinuError('bad_input', 'Slate operation does not match its declared fields', { cause: new v.ValiError(parsed.issues) });
      const operation = parsed.output;
      switch (operation.op) {
        case 'list': {
          const listing = await this.list(caller);
          return { ok: true, value: { slates: listing.slates.map((slate) => ({ ...slate, bindings: [...slate.bindings] })), problems: listing.problems.map((problem) => ({ ...problem })) } };
        }
        case 'preview': return await this.preview(caller, operation.id);
        case 'call': return await this.call(caller, operation.id, operation.method, operation.args ?? []);
        case 'history': {
          await this.deps.session();
          const id = new SlateId(operation.id);
          const slate = this.store.getSlate(id);
          if (slate === undefined) throw new KinuError('missing', 'No durable slate record; commit source or open a preview first');
          if (slate.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate belongs to another workspace');
          return { ok: true, value: projectJsonValue({ value: { slate: slate.toData(), versions: this.store.listVersions(id).map((version) => version.toData()) } }) };
        }
        case 'commit': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).commit(new SlateId(operation.id))).toData() }) };
        case 'fork': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).fork(new SlateVersionId(operation.version))).toData() }) };
        case 'restore': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).restore(new SlateId(operation.id), new SlateVersionId(operation.version))).toData() }) };
      }
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate operation', cause, otherwise: 'io' })) };
    }
  }

  async list(caller: SlateCaller): Promise<{ slates: SlateSummary[]; problems: SlateProblem[] }> {
    const session = await this.deps.session();
    const vfs = session.vfs.as(caller.cred);
    const slates: SlateSummary[] = [];
    const problems: SlateProblem[] = [];
    if (!vfs.exists('/home/user/slates')) return { slates, problems };
    for (const entry of vfs.readdir('/home/user/slates')) {
      if (entry.type !== 'directory') continue;
      try {
        const project = await this.project(caller.cred, entry.name);
        slates.push({ id: entry.name, title: project.slate.title ?? project.name ?? entry.name, bindings: Object.keys(project.slate.bindings) });
      } catch (cause) {
        problems.push({ id: entry.name, ...refusalOf(toKinuError({ doing: 'slate ' + entry.name, cause, otherwise: 'io' })) });
      }
    }
    return { slates, problems };
  }

  async preview(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    try {
      const process = await this.ensure(caller, id);
      const preview = await this.deps.expose(process.port);
      if (preview.url === undefined) throw new KinuError('unavailable', 'This deployment cannot mint a slate preview URL');
      return { ok: true, value: { url: preview.url, port: process.port } };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' preview', cause, otherwise: 'io' })) };
    }
  }

  async refreshPreview(port: number): Promise<void> {
    for (const running of this.running.values()) {
      if (running.process.port === port) { await this.ensure(running.caller, running.id); return; }
    }
  }

  /** Re-read the slate field on every call: a held stub proves its name, not today's reach. */
  async bindingCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateBindingRequestSchema, request);
      if (!parsed.success) throw new KinuError('bad_input', 'A binding call is { member, args: JSON[], depth }', { cause: new v.ValiError(parsed.issues) });
      const project = await this.project(caller.cred, id);
      return await this.run(caller, routeSlateBindingCall({ id, project, name, request: parsed.output }));
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} binding ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private async run(caller: SlateCaller, route: SlateBindingRoute): Promise<SlateCallResult> {
    switch (route.kind) {
      case 'namespace':
      case 'mcp':
      case 'rpc': {
        const value = await this.deps.dispatch(caller, route);
        // A member that ANSWERED a refusal refused; authored code sees the class.
        const refused = answeredRefusal(value);
        return refused === null ? { ok: true, value } : { ok: false, ...refused };
      }
      // The hop keeps the CALLER's authority: the callee runs for whoever asked, never as its author.
      case 'app': return this.call(caller, route.id, route.method, [...route.args], route.depth + 1);
    }
  }

  /** App members are POST routes on the same authored fetch handler that serves the preview. */
  async call(caller: SlateCaller, id: string, method: string, args: JsonValue[], depth = 0): Promise<SlateCallResult> {
    try {
      if (!isSlateMethodName(method)) throw new KinuError('bad_input', `"${method}" is not an app method name`);
      const parsed = v.safeParse(v.array(JsonValueSchema), args);
      if (!parsed.success) throw new KinuError('bad_input', 'Slate arguments must be JSON values', { cause: new v.ValiError(parsed.issues) });
      const process = await this.ensure(caller, id);
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

  ensure(caller: SlateCaller, id: string): Promise<ResidentSlateProcess> {
    const held = `${slateCallerKey(caller)}#${id}`;
    const starting = this.starting.get(held);
    if (starting !== undefined) return starting;
    const boot = this.boot(caller, id, held).finally(() => { this.starting.delete(held); });
    this.starting.set(held, boot);
    return boot;
  }

  private async boot(caller: SlateCaller, id: string, held: string): Promise<ResidentSlateProcess> {
    const root = slateDirectory(new SlateId(id));
    const sources = await this.sources(caller.cred);
    for (;;) {
      const revision = this.revisions.get(id) ?? 0;
      const project = await this.project(caller.cred, id);
      if (project.slate.runtime !== 'worker') throw new KinuError('unsupported', 'Resident slate previews require slate.runtime worker; run node projects through the sandbox executor');
      const source = (await sources.synchronize(new SlateId(id))).source;
      const key = `slate:${this.deps.workspace}:${held}:${source.digest.value}`;
      const running = this.running.get(held);
      if (running?.key === key && await running.process.isRunning()) return running.process;
      if (running !== undefined) {
        this.running.delete(held);
        await running.process.stop();
      }
      const bindings: Record<string, Fetcher<SlateBinding>> = {};
      for (const name of Object.keys(project.slate.bindings)) {
        const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller };
        bindings[name] = exports.SlateBinding({ props });
      }
      const port = project.slate.port ?? this.ports.get(held) ?? this.nextPort++;
      this.ports.set(held, port);
      const process = await this.resident.start({ key, root, project, port, cred: caller.cred, bindings });
      if ((this.revisions.get(id) ?? 0) !== revision) { await process.stop(); continue; }
      this.running.set(held, { key, caller, id, process });
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

