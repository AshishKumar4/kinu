/**
 * The gadget host — how the workspace object runs `server.js` and answers for it.
 *
 * ONE FACET PER GADGET. `server.js` is loaded through the Worker Loader as a
 * dynamic Worker with `globalOutbound: null`, so `fetch()` and `connect()`
 * throw inside it, and its `Gadget` class is instantiated as a facet of this
 * object (`ctx.facets.get`): a child Durable Object with a SQLite database of
 * its own that this object cannot read and that cannot read this object's.
 * That is the model Cloudflare OS runs every gadget under, and the `dynamic`
 * domain of agent-core SPEC §10.2.
 *
 * WHAT THE ISOLATE HOLDS. Its `env` is the manifest's bindings, each a
 * loopback stub minted here with the workspace, the gadget and the binding
 * name as props (`gadgets/bindings.ts`), and nothing else: no namespace, no
 * secret, no `LOADER`. A name the manifest did not declare resolves to
 * `undefined` in the isolate, never to something ambient. The load carries a
 * CPU and subrequest bound (`GADGET_LIMITS_PER_CALL`), because a load that
 * omits one gets the account's whole compute budget, which is a capability
 * nobody delegated.
 *
 * IDENTITY. A warm isolate is reused under the loader id, so the id covers
 * every input the load fixes: the workspace, the gadget, the digest of
 * `server.js` and the digest of the manifest whose bindings became `env`. A
 * changed byte in either is a new id and a new isolate. The facet is restarted
 * for a new id by `ctx.facets.abort` (storage kept), which is the code-update
 * path the platform documents — and it happens on the write, from the file
 * plane's own event bus, so the next call after an edit runs the new code.
 *
 * BINDING CALLS come back here (`bindingCall`), re-read the manifest — the
 * plane is agent-writable and the isolate was built from an earlier read —
 * and decide with the pure half in `@kinu.run/core` (`gadgets/bindings.ts`):
 * a file path under the root or refused, a read model on the list or refused,
 * an MCP tool through the same approval ladder the shell answers to.
 */

import * as v from 'valibot';
import { exports } from 'cloudflare:workers';
import {
  GADGET_DIR, GADGET_SERVER_CLASS, GADGETS_CHANGED_EVENT, GADGET_LIMITS, JsonObjectSchema, JsonValueSchema, WORKSPACE_ROOT,
  decideApproval, ensureDir, gadgetBindings, gadgetFilesRoot, gadgetSummary, isGadgetMethodName, isGadgetSlug,
  listGadgets, readGadget, readGadgetClient, readGadgetServer, resolveGadgetDataSource, resolveGadgetFilePath,
  reviewGadgetMcpCall, sha256Hex,
  type ApprovalSpend, type GadgetBinding, type GadgetBindingKind, type GadgetCallResult, type GadgetDataSource,
  type GadgetManifest, type GadgetMcpTool, type GadgetProblem, type GadgetRecord, type GadgetSummary, type JsonObject,
  type JsonValue, type ShellApprovalPolicy, type VFS,
} from '@kinu.run/core';
import { KinuError, refusalOf, renderThrownChain, toKinuError, tolerateAsync } from '@kinu.run/core/obs';
import type {
  GadgetBindingProps, GadgetBindingRequest, GadgetFilesBinding, GadgetMcpBinding, GadgetWorkspaceBinding,
} from './bindings';

/** The runtime a gadget's isolate is pinned to. The same date the Worker
 *  deploys under (wrangler.jsonc `compatibility_date`), so a gadget meets the
 *  platform its host measured. */
const GADGET_COMPATIBILITY_DATE = '2025-12-01';

/**
 * The bound one call into a gadget carries. CPU is what a runaway loop costs
 * and subrequests are what a binding-call storm costs; both throw at the
 * boundary the moment they are reached (Dynamic Workers docs, usage/limits).
 * Two seconds is beyond any dashboard read and short of a mining loop; 64 is
 * enough binding calls to draw a page and few enough that a loop announces
 * itself.
 */
const GADGET_LIMITS_PER_CALL = { cpuMs: 2_000, subRequests: 64 } as const;

/** What `env.<NAME>` is inside the isolate: the loopback stub of the binding
 *  kind's entrypoint class, so `server.js` reaches that class's methods and
 *  nothing else. */
type GadgetBindingStub = Fetcher<GadgetFilesBinding | GadgetWorkspaceBinding | GadgetMcpBinding>;

/** The isolate's `env`: one stub per declared binding, and nothing else. */
interface GadgetIsolateEnv {
  [name: string]: GadgetBindingStub;
}

export interface GadgetMcpPort {
  /** The connection's tools as the owner's UserDO describes them. */
  tools(server: string): Promise<GadgetMcpTool[]>;
  call(server: string, tool: string, args: JsonObject): Promise<JsonValue>;
}

export interface GadgetHostDeps {
  /** The workspace's name — the Durable Object's, which is what a binding's
   *  props carry back to find this object. */
  readonly workspace: string;
  /** The workspace file plane under the agent's own credential. A thunk: the
   *  plane boots lazily and this host must not force it at construction. */
  readonly vfs: () => VFS;
  readonly loader: WorkerLoader;
  readonly facets: DurableObjectFacets;
  readonly broadcast: (event: { type: typeof GADGETS_CHANGED_EVENT; slugs: string[] }) => void;
  /** One read model by name. The name has already passed `resolveGadgetDataSource`. */
  readonly data: (source: GadgetDataSource) => Promise<JsonValue>;
  readonly mcp: GadgetMcpPort;
  /** The same ladder the shell answers to — mode, standing grants, channel, queue. */
  readonly approval: ShellApprovalPolicy;
}

/** The facet's class as the bridge calls it: any method, JSON in, JSON out. */
interface GadgetServer extends Rpc.DurableObjectBranded {
  [method: string]: (...args: JsonValue[]) => Promise<JsonValue>;
}

const ArgsSchema = v.array(JsonValueSchema);

/** The file plane's event paths are bare (`home/user/gadgets/x/server.js`);
 *  this is the prefix a gadget's files carry. */
const EVENT_PREFIX = `${WORKSPACE_ROOT.slice(1)}/${GADGET_DIR}/`;

export class GadgetHost {
  /** The load each running facet was started from, by slug — what `abort`
   *  compares against so a facet started under one digest never answers for
   *  another, even when the event bus did not carry the write. */
  readonly #running = new Map<string, string>();

  constructor(private readonly deps: GadgetHostDeps) {}

  async list(): Promise<{ gadgets: GadgetSummary[]; problems: GadgetProblem[] }> {
    const listing = await listGadgets(this.deps.vfs());
    return { gadgets: listing.gadgets.map(gadgetSummary), problems: listing.problems };
  }

  async client(slug: string): Promise<GadgetCallResult> {
    const read = await readGadgetClient(this.deps.vfs(), slug);
    return read.ok ? { ok: true, value: { js: read.js, css: read.css } } : read;
  }

  /**
   * One call into a gadget's server, exactly as its client would make it.
   *
   * Reads the server and the manifest fresh, so an edit since the facet was
   * started restarts it under the new load before the call lands.
   */
  async call(slug: string, method: string, args: JsonValue[]): Promise<GadgetCallResult> {
    if (!isGadgetSlug(slug)) {
      return { ok: false, ...refusalOf(new KinuError('bad_input', `"${slug}" is not a gadget slug`)) };
    }
    if (!isGadgetMethodName(method)) {
      return { ok: false, ...refusalOf(new KinuError('bad_input', `"${method}" is not a method name the bridge forwards`)) };
    }
    const parsedArgs = v.safeParse(ArgsSchema, args);
    if (!parsedArgs.success) {
      return { ok: false, ...refusalOf(new KinuError('bad_input', 'gadget arguments must be an array of JSON values')) };
    }
    const vfs = this.deps.vfs();
    const gadget = await readGadget(vfs, slug);
    if (!gadget.ok) return gadget;
    const server = await readGadgetServer(vfs, slug);
    if (!server.ok) return server;
    const facet = this.facet(gadget.record, server.js, server.digest);
    let value: unknown;
    try {
      value = await facet[method](...parsedArgs.output);
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `gadget ${slug}.${method}`, cause, otherwise: 'io' })) };
    }
    const parsedValue = v.safeParse(JsonValueSchema, value === undefined ? null : value);
    if (!parsedValue.success) {
      return { ok: false, ...refusalOf(new KinuError('bad_input',
        `gadget ${slug}.${method} answered a value that is not JSON: ${renderThrownChain({ cause: new v.ValiError(parsedValue.issues) })}`)) };
    }
    return { ok: true, value: parsedValue.output };
  }

  /**
   * A call through one of the gadget's bindings, back from its isolate.
   *
   * The manifest is re-read here rather than trusted from the load: the stub
   * proves the isolate was built with this binding name, and the manifest as
   * it stands now decides what the name reaches.
   */
  async bindingCall(slug: string, name: string, request: GadgetBindingRequest): Promise<GadgetCallResult> {
    const gadget = await readGadget(this.deps.vfs(), slug);
    if (!gadget.ok) return gadget;
    const binding = gadgetBindings(gadget.record.manifest).find(([bound]) => bound === name)?.[1];
    if (!binding || binding.kind !== request.kind) {
      return { ok: false, ...refusalOf(new KinuError('denied',
        `gadget "${slug}" no longer declares a ${request.kind} binding named ${name}`)) };
    }
    try {
      switch (request.kind) {
        case 'files':
          return await this.filesCall(slug, binding, request);
        case 'workspace':
          return await this.workspaceCall(request);
        case 'mcp':
          return await this.mcpCall(slug, binding, request);
      }
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `gadget ${slug} binding ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private async filesCall(
    slug: string,
    binding: GadgetBinding,
    request: Extract<GadgetBindingRequest, { kind: 'files' }>,
  ): Promise<GadgetCallResult> {
    if (binding.kind !== 'files') throw new Error('unreachable: a files request on a non-files binding');
    const resolved = resolveGadgetFilePath(gadgetFilesRoot(slug, binding), request.path);
    if (!resolved.ok) return resolved;
    const vfs = this.deps.vfs();
    switch (request.op) {
      case 'read': {
        const raw = await tolerateAsync(() => vfs.readFile(resolved.path, { encoding: 'utf8' }), 'enoent');
        if (raw === undefined) {
          return { ok: false, ...refusalOf(new KinuError('missing', `no file at ${resolved.path}`)) };
        }
        return { ok: true, value: raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw };
      }
      case 'write': {
        if (request.text.length > GADGET_LIMITS.clientBytes) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            `a gadget write is at most ${GADGET_LIMITS.clientBytes} characters`)) };
        }
        const parent = resolved.path.slice(0, resolved.path.lastIndexOf('/'));
        if (parent) await ensureDir(vfs, parent);
        await vfs.writeFile(resolved.path, request.text);
        return { ok: true, value: { path: resolved.path, bytes: request.text.length } };
      }
      case 'list': {
        const names = await tolerateAsync(() => vfs.readdir(resolved.path), 'enoent');
        return { ok: true, value: names ?? [] };
      }
      case 'remove': {
        await tolerateAsync(() => vfs.unlink(resolved.path), 'enoent');
        return { ok: true, value: { path: resolved.path } };
      }
    }
  }

  private async workspaceCall(request: Extract<GadgetBindingRequest, { kind: 'workspace' }>): Promise<GadgetCallResult> {
    const resolved = resolveGadgetDataSource(request.source);
    if (!resolved.ok) return resolved;
    return { ok: true, value: await this.deps.data(resolved.source) };
  }

  private async mcpCall(
    slug: string,
    binding: GadgetBinding,
    request: Extract<GadgetBindingRequest, { kind: 'mcp' }>,
  ): Promise<GadgetCallResult> {
    if (binding.kind !== 'mcp') throw new Error('unreachable: an mcp request on a non-mcp binding');
    const tools = await this.deps.mcp.tools(binding.server);
    if (request.op === 'tools') {
      const offered = binding.tools === undefined ? tools : tools.filter((tool) => binding.tools?.includes(tool.name));
      return { ok: true, value: offered.map((tool) => ({ name: tool.name, readOnly: tool.readOnly })) };
    }
    const args = v.safeParse(JsonObjectSchema, request.args);
    if (!args.success) {
      return { ok: false, ...refusalOf(new KinuError('bad_input', 'mcp arguments must be a JSON object')) };
    }
    const reviewed = reviewGadgetMcpCall({ slug, binding, tool: request.tool, args: args.output, tools });
    if (!reviewed.ok) return reviewed;
    const decision = await decideApproval(reviewed.review.subject, reviewed.review.review, this.deps.approval);
    if (!decision.run) {
      return { ok: false, ...refusalOf(new KinuError('denied', decision.message)) };
    }
    const spent: ApprovalSpend | undefined = decision.spent;
    try {
      const value = await this.deps.mcp.call(binding.server, request.tool, args.output);
      // The call reached the connection: the grant is consumed whatever the
      // tool answered, which is the safe reading `gateExec` takes too.
      if (spent) this.deps.approval.deferrals?.settle(spent, 'spent');
      return { ok: true, value };
    } catch (cause) {
      if (spent) this.deps.approval.deferrals?.settle(spent, 'spent');
      throw cause;
    }
  }

  /**
   * React to writes under `gadgets/`: a changed server or manifest restarts
   * its facet on the next call, and the UI is told which tabs to remount.
   * Fed by the file plane's own event bus; paths arrive bare.
   */
  filesChanged(paths: readonly string[]): void {
    const slugs = new Set<string>();
    for (const path of paths) {
      if (!path.startsWith(EVENT_PREFIX)) continue;
      const slug = path.slice(EVENT_PREFIX.length).split('/')[0];
      if (slug && isGadgetSlug(slug)) slugs.add(slug);
    }
    if (slugs.size === 0) return;
    for (const slug of slugs) this.stop(slug, 'the gadget\'s files changed');
    this.deps.broadcast({ type: GADGETS_CHANGED_EVENT, slugs: [...slugs] });
  }

  /** Stop a gadget's facet, keeping its storage. The next call restarts it
   *  from the files as they stand then. */
  stop(slug: string, reason: string): void {
    if (!this.#running.has(slug)) return;
    this.#running.delete(slug);
    this.deps.facets.abort(facetName(slug), new Error(`gadget ${slug} restarted: ${reason}`));
  }

  private facet(record: GadgetRecord, serverJs: string, serverDigest: string): GadgetServer {
    const loadId = this.loadId(record, serverDigest);
    const running = this.#running.get(record.slug);
    if (running !== undefined && running !== loadId) {
      this.stop(record.slug, 'its load changed');
    }
    this.#running.set(record.slug, loadId);
    const stub = this.deps.facets.get<GadgetServer>(facetName(record.slug), () => ({
      class: this.loadServer(record, serverJs, loadId).getDurableObjectClass<GadgetServer>(GADGET_SERVER_CLASS),
      id: facetName(record.slug),
    }));
    // SAFETY: the loader constructed this facet from the digest-pinned load of
    // the gadget's own `server.js`, whose `Gadget` class answers JSON methods.
    // The stub parks in `unknown` because indexing its mapped stub type makes
    // type instantiation excessively deep (TS2589); the value the methods
    // answer is verified by the JsonValueSchema parse at the call site instead.
    const untyped = stub as unknown;
    // SAFETY: the same facet the loader constructed for hop 1, re-read here as
    // the narrow view it guarantees: any method name, JSON arguments in, a JSON
    // value out.
    return untyped as GadgetServer;
  }

  private loadId(record: GadgetRecord, serverDigest: string): string {
    return `gadget:${this.deps.workspace}:${record.slug}:${serverDigest}:${sha256Hex(JSON.stringify(record.manifest), 16)}`;
  }

  private loadServer(record: GadgetRecord, serverJs: string, loadId: string): WorkerStub {
    return this.deps.loader.get(loadId, () => ({
      compatibilityDate: GADGET_COMPATIBILITY_DATE,
      mainModule: 'server.js',
      modules: { 'server.js': serverJs },
      env: this.mintEnv(record.slug, record.manifest),
      globalOutbound: null,
      limits: { ...GADGET_LIMITS_PER_CALL },
    }));
  }

  /** Mint one stub per declared binding: the whole of the isolate's reach. */
  private mintEnv(slug: string, manifest: GadgetManifest): GadgetIsolateEnv {
    const env: GadgetIsolateEnv = {};
    for (const [name, binding] of gadgetBindings(manifest)) {
      env[name] = mintGadgetBinding(binding.kind, { workspace: this.deps.workspace, slug, name });
    }
    return env;
  }
}

/**
 * The stub for one binding: the loopback form of its kind's entrypoint class,
 * read by name from this Worker's own exports so the class the isolate reaches
 * is the one `server.ts` publishes under it, carrying props only this Worker
 * can write.
 */
function mintGadgetBinding(kind: GadgetBindingKind, props: GadgetBindingProps): GadgetBindingStub {
  switch (kind) {
    case 'files': return exports.GadgetFilesBinding({ props });
    case 'workspace': return exports.GadgetWorkspaceBinding({ props });
    case 'mcp': return exports.GadgetMcpBinding({ props });
  }
}

function facetName(slug: string): string {
  return `gadget:${slug}`;
}
