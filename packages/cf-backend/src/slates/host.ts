import { exports } from 'cloudflare:workers';
import { SlateId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateFiles, SqliteSlateContentStore, slateDirectory, parseSlateProject,
  SlateBindingRequestSchema, routeSlateBindingCall, JsonValueSchema, isSlateMethodName,
  type CodemodeProvider, type JsonValue, type JsonObject, type SlateProject,
  type SlateBindingRoute, type SlateCallResult, type SlateReadModel,
} from '@kinu.run/core';
import { ERROR_CODES, KinuError, refusalOf, toKinuError } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import type { SlateBindingProps } from './bindings';

const Failure = v.object({ reason: v.picklist(ERROR_CODES), error: v.string() });

export interface SlateHostDeps extends Omit<ResidentSlateDeps, 'content'> {
  providers(): readonly CodemodeProvider[];
  data(source: SlateReadModel): Promise<JsonValue>;
  mcp(server: string, tool: string, args: JsonObject): Promise<JsonValue>;
}

interface RunningSlate {
  readonly key: string;
  readonly process: ResidentSlateProcess;
}

/** One isolate-lifetime process per authored tree. No running state is durable. */
export class SlateHost {
  private readonly content: SqliteSlateContentStore;
  private readonly resident: ResidentSlateProcesses;
  private readonly running = new Map<string, RunningSlate>();
  private readonly starting = new Map<string, Promise<ResidentSlateProcess>>();
  private readonly ports = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private nextPort = 20000;

  constructor(private readonly deps: SlateHostDeps) {
    this.content = new SqliteSlateContentStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.resident = new ResidentSlateProcesses({ ...deps, content: this.content });
  }

  async project(id: string): Promise<SlateProject> {
    const session = await this.deps.session();
    const path = `${slateDirectory(new SlateId(id))}/package.json`;
    return parseSlateProject(JSON.parse(session.vfs.as(CRED_SESSION_USER).readFileString(path)));
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
    const session = await this.deps.session();
    const root = slateDirectory(new SlateId(id));
    const files = new SlateFiles(session.vfs.as(CRED_SESSION_USER), this.content);
    for (;;) {
      const revision = this.revisions.get(id) ?? 0;
      const project = await this.project(id);
      if (project.slate.runtime !== 'worker') throw new KinuError('unsupported', 'Resident slate previews require slate.runtime worker; run node projects through the sandbox executor');
      const source = session.vfs.withTransaction(() => files.capture(new SlateId(id)));
      const key = `slate:${this.deps.workspace}:${id}:${source.digest.value}`;
      const held = this.running.get(id);
      if (held?.key === key && await held.process.isRunning()) return held.process;
      if (held !== undefined) {
        this.running.delete(id);
        await held.process.stop();
      }
      const bindings: Record<string, Fetcher> = {};
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
