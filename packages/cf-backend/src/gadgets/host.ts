/**
 * The gadget host — how the workspace object runs `server.js` and answers for it.
 *
 * ONE RESIDENT PROCESS PER GADGET. `server.js` exports `class Gadget extends RpcTarget`
 * with `constructor(env)`. The host boots it through the fabric's own
 * `processes(ctx, env).spawn` with an `env` that holds exactly the manifest's
 * bindings. That is the one loader path agent-written code
 * takes: a workspace `node` server and a gadget server boot through the same `spawn`.
 *
 * WHAT THE PROCESS HOLDS. Its `env` is the manifest's bindings, each a loopback stub
 * minted here with the workspace, the gadget and the binding name as props
 * (`gadgets/bindings.ts`), and nothing else: no namespace, no secret, no `SUPERVISOR`,
 * no `LOADER`. A name the manifest did not declare resolves to `undefined` in the
 * process, never to something ambient. Network and compute are the workspace's own:
 * the process inherits the parent's outbound like every other resident process, and
 * the platform's limits are the only ones on it.
 *
 * HOW A CALL TRAVELS. The host validates the method name and the JSON args, then opens
 * a Cap'n Web session over a transport that POSTs the framed batch to the process
 * (`handleHttpRequest`) and reads the framed answer back. The process serves the bytes
 * with `newHttpBatchRpcResponse` onto its own `Gadget` instance. The answer parses as
 * JSON, or the call is a refusal with its class first.
 *
 * IDENTITY. The worker key covers every input the boot fixes: the workspace, the gadget,
 * the digest of `server.js` and the digest of the manifest whose bindings became `env`.
 * A changed byte in either boots a new process, and the old one is released. A write
 * under `gadgets/<slug>/` retires the process through the file plane's own event bus,
 * so the next call after an edit boots the new code. A failed call retires it too: a
 * dead process never answers for a later call.
 *
 * RELEASE IS LAZY. The file event arrives on a sync listener, and a release is async,
 * so a write only retires: the next call drains the retired set before it spawns. A
 * process retired with no later call lingers until the object evicts, which reclaims
 * the isolate with it. Gadget edits are human-scale, and a retired process holds no
 * gadget state (see below), so the bound is the edit count, not traffic.
 *
 * STATE. The process keeps no SQLite and receives no `ctx`. State that must last lives
 * in the `files` binding, by default `gadgets/<slug>/data` (`gadgetFilesRoot`).
 *
 * BINDING CALLS come back here (`bindingCall`), re-read the manifest — the plane is
 * agent-writable and the process was built from an earlier read — and decide with the
 * pure half in `@kinu.run/core` (`gadgets/bindings.ts`): a file path under the root or
 * refused, a read model on the list or refused, an MCP tool through the same approval
 * ladder the shell answers to.
 */

import * as v from 'valibot';
import { exports } from 'cloudflare:workers';
import { RpcSession } from 'capnweb';
import { processes } from '@nimbus-sh/fabric/workerd-facet-host.js';
import type { ResidentFacet, ResidentFacetEnv } from '@nimbus-sh/fabric/workerd-facet-host.js';
import type { ResidentBootSpec, ResidentDiskReader } from '@nimbus-sh/fabric/process-fabric.js';
import {
  GADGET_DIR, GADGETS_CHANGED_EVENT, GADGET_LIMITS, GADGET_SERVER_CLASS, JsonObjectSchema, JsonValueSchema, WORKSPACE_ROOT,
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

/** The runtime a gadget's process is pinned to. The same date the Worker
 *  deploys under (wrangler.jsonc `compatibility_date`), so a gadget meets the
 *  platform its host measured. */
const GADGET_COMPATIBILITY_DATE = '2025-12-01';

/** What `env.<NAME>` is inside the process: the loopback stub of the binding
 *  kind's entrypoint class, so `server.js` reaches that class's methods and
 *  nothing else. */
type GadgetBindingStub = Fetcher<GadgetFilesBinding | GadgetWorkspaceBinding | GadgetMcpBinding>;

/** The process's `env`: one stub per declared binding, and nothing else. */
interface GadgetProcessEnv {
  [name: string]: GadgetBindingStub;
}

/**
 * Gadget pids live above the workspace process table, so a gadget never takes
 * a pid the shell's supervisor hands out. The pid is stable per slug within an
 * isolate (derived from the slug, probed past collisions), which reuses the
 * fabric slot a quiet gadget already holds instead of minting facet ids.
 */
const GADGET_PID_BASE = 1_000_000;
const GADGET_PID_RANGE = 500_000;

/** The boot map's module names. `capnweb.js` carries the suffix the loader
 *  keys modules by; both sources import it by that name. */
const GADGET_RUNNER_MODULE = 'runner.js';
const GADGET_SERVER_MODULE = 'server.js';
const GADGET_CAPNWEB_MODULE = 'capnweb.js';

/** The key a boxed method failure carries. Single-keyed, so a gadget value
 *  that merely contains it is not mistaken for one. The runner below writes
 *  it by interpolation, so the isolate and the host cannot drift apart. */
const GADGET_ERROR_KEY = '__gadgetError';

/**
 * The boxed failure a method value carries, or null. Parsed, not narrowed:
 * only a value keyed exactly by the runner's envelope counts — anything else,
 * including an object that merely contains the key, is the gadget's own answer.
 */
const BoxedGadgetErrorSchema = v.strictObject({ __gadgetError: v.string() });

function boxedGadgetError(value: JsonValue): string | null {
  const parsed = v.safeParse(BoxedGadgetErrorSchema, value);
  return parsed.success ? parsed.output.__gadgetError : null;
}

/**
 * The module the fabric boots: it builds the agent's `Gadget` with the
 * process `env` and answers Cap'n Web HTTP batch on it. Plain text, so the
 * boot carries no build step: the map holds this, `server.js`, and `capnweb.js`.
 *
 * Method failures cross as VALUES, never as rejections. The server answers a
 * thrown method with a rejected batch, and a rejection on this hop surfaces
 * twice: once on the caller's await, once as an unhandled rejection in the
 * hosting isolate, which fails the test run and logs noise per gadget error
 * in production. So the runner serves a Proxy that boxes every method
 * failure — a throw, a rejected promise, a missing method — into a
 * `{__gadgetError: message}` value, and the host maps that envelope back to
 * an `io` refusal with the same message a rejection carried. `then` and
 * `constructor` pass through untouched: fabricating those would break promise
 * assimilation and construction.
 */
const GADGET_RUNNER_SOURCE = [
  'import { DurableObject } from "cloudflare:workers";',
  'import { newHttpBatchRpcResponse } from "./capnweb.js";',
  `import { ${GADGET_SERVER_CLASS} } from "./server.js";`,
  'function __gadgetBoxError(error) {',
  `  return { ${GADGET_ERROR_KEY}: error instanceof Error ? error.message : String(error) };`,
  '}',
  'const __gadgetHandler = {',
  '  get(target, prop, receiver) {',
  '    if (typeof prop !== "string" || prop === "then" || prop === "constructor") {',
  '      return Reflect.get(target, prop, receiver);',
  '    }',
  '    let found;',
  '    try {',
  '      found = Reflect.get(target, prop, receiver);',
  '    } catch (error) {',
  '      return () => __gadgetBoxError(error);',
  '    }',
  '    if (typeof found === "function") {',
  '      return (...args) => {',
  '        try {',
  '          return Promise.resolve(found.apply(target, args)).catch(__gadgetBoxError);',
  '        } catch (error) {',
  '          return __gadgetBoxError(error);',
  '        }',
  '      };',
  '    }',
  '    return () => __gadgetBoxError(new Error(`\'${prop}\' is not a function.`));',
  '  },',
  '};',
  'export class NimbusProcess extends DurableObject {',
  '  constructor(ctx, env) { super(ctx, env); this.server = null; }',
  '  async startProcess() {',
  `    if (this.server === null) this.server = new Proxy(new ${GADGET_SERVER_CLASS}(this.env), __gadgetHandler);`,
  '    return { ok: true };',
  '  }',
  '  async fetch(request) {',
  '    return this.handleHttpRequest(request);',
  '  }',
  '  async handleHttpRequest(request) {',
  `    if (this.server === null) this.server = new Proxy(new ${GADGET_SERVER_CLASS}(this.env), __gadgetHandler);`,
  '    return newHttpBatchRpcResponse(request, this.server);',
  '  }',
  '}',
].join('\n');


/** A gadget boot names no by-path modules, so the disk is never read. */
const GADGET_DISK: ResidentDiskReader = {
  readFile(_path: string): Promise<Uint8Array> {
    return Promise.reject(new Error('a gadget boot names no by-path modules'));
  },
};

/** Cap'n Web arrives as source: the isolate resolves the relative
 *  `./capnweb.js` specifier both sources import against this map entry. Read
 *  once per isolate through the same `?raw` form the document builder uses. */
let capnwebBundle: Promise<string> | null = null;

function capnwebSource(): Promise<string> {
  capnwebBundle ??= import('capnweb?raw').then(({ default: bundle }) => bundle);
  return capnwebBundle;
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
  /** The hosting object's state and its loader binding: the fabric's `spawn`
   *  reads the slot book off the state and the Worker Loader off the env. */
  readonly ctx: DurableObjectState;
  readonly env: ResidentFacetEnv;
  readonly broadcast: (event: { type: typeof GADGETS_CHANGED_EVENT; slugs: string[] }) => void;
  /** One read model by name. The name has already passed `resolveGadgetDataSource`. */
  readonly data: (source: GadgetDataSource) => Promise<JsonValue>;
  readonly mcp: GadgetMcpPort;
  /** The same ladder the shell answers to — mode, standing grants, channel, queue. */
  readonly approval: ShellApprovalPolicy;
}

/** The gadget server as the host calls it: any forwarded name, JSON in, JSON out.
 *  The contract the docs state; `call` still parses the answer, because a type
 *  does not cross the isolate and a server that answers non-JSON is refused. */
interface GadgetRpc {
  [method: string]: (...args: JsonValue[]) => Promise<JsonValue>;
}

interface RunningGadget {
  readonly process: ResidentFacet;
  readonly loadId: string;
}

const ArgsSchema = v.array(JsonValueSchema);

/** The file plane's event paths are bare (`home/user/gadgets/x/server.js`);
 *  this is the prefix a gadget's files carry. */
const EVENT_PREFIX = `${WORKSPACE_ROOT.slice(1)}/${GADGET_DIR}/`;

export class GadgetHost {
  /** The process each gadget currently answers through, by slug. */
  readonly #running = new Map<string, RunningGadget>();
  /** Spawns in flight, by slug: concurrent calls share one boot. */
  readonly #starting = new Map<string, Promise<ResidentFacet>>();
  /** Retired processes awaiting release on the next call (see `filesChanged`). */
  #retired: ResidentFacet[] = [];
  /** The pid each slug boots under, by slug. */
  readonly #pids = new Map<string, number>();

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
   * Reads the server and the manifest fresh, so an edit since the last call
   * boots the new code before this call lands.
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
    const loadId = this.loadId(gadget.record, server.digest);
    if (this.#running.get(slug)?.loadId !== loadId) this.retire(slug);
    await this.drainRetired();
    let process: ResidentFacet;
    try {
      process = await this.resident(gadget.record, server.js, loadId);
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `gadget ${slug}.${method}`, cause, otherwise: 'io' })) };
    }
    let value: unknown;
    try {
      value = await this.invoke(process, method, parsedArgs.output);
    } catch (cause) {
      this.retire(slug);
      return { ok: false, ...refusalOf(toKinuError({ doing: `gadget ${slug}.${method}`, cause, otherwise: 'io' })) };
    }
    const parsedValue = v.safeParse(JsonValueSchema, value === undefined ? null : value);
    if (!parsedValue.success) {
      return { ok: false, ...refusalOf(new KinuError('bad_input',
        `gadget ${slug}.${method} answered a value that is not JSON: ${renderThrownChain({ cause: new v.ValiError(parsedValue.issues) })}`)) };
    }
    const boxed = boxedGadgetError(parsedValue.output);
    if (boxed !== null) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `gadget ${slug}.${method}`, cause: new Error(boxed), otherwise: 'io' })) };
    }
    return { ok: true, value: parsedValue.output };
  }

  /**
   * A call through one of the gadget's bindings, back from its process.
   *
   * The manifest is re-read here rather than trusted from the boot: the stub
   * proves the process was built with this binding name, and the manifest as
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
        if (request.text.length > GADGET_LIMITS.clientChars) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            `a gadget write is at most ${GADGET_LIMITS.clientChars} characters`)) };
        }
        const parent = resolved.path.slice(0, resolved.path.lastIndexOf('/'));
        if (parent) await ensureDir(vfs, parent);
        await vfs.writeFile(resolved.path, request.text);
        return { ok: true, value: { path: resolved.path, chars: request.text.length } };
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
      return { ok: true, value: await this.deps.mcp.call(binding.server, request.tool, args.output) };
    } finally {
      // The call reached the connection: the grant is consumed whatever the
      // tool answered, which is the reading `gateExec` takes too.
      if (spent) this.deps.approval.deferrals?.settle(spent, 'spent');
    }
  }

  /**
   * React to writes under `gadgets/`: a changed server or manifest retires
   * its process, and the UI is told which tabs to remount. Fed by the file
   * plane's own event bus; paths arrive bare. The retire only moves the entry:
   * the next call releases it and boots the new code (see the class note).
   */
  filesChanged(paths: readonly string[]): void {
    const slugs = new Set<string>();
    for (const path of paths) {
      if (!path.startsWith(EVENT_PREFIX)) continue;
      const slug = path.slice(EVENT_PREFIX.length).split('/')[0];
      if (slug && isGadgetSlug(slug)) slugs.add(slug);
    }
    if (slugs.size === 0) return;
    for (const slug of slugs) this.retire(slug);
    this.deps.broadcast({ type: GADGETS_CHANGED_EVENT, slugs: [...slugs] });
  }

  /** Retire a gadget's process: the next call releases it and boots fresh. */
  private retire(slug: string): void {
    const running = this.#running.get(slug);
    if (!running) return;
    this.#running.delete(slug);
    this.#retired.push(running.process);
  }

  /** Release every retired process. Runs at the head of a call, awaited. */
  private async drainRetired(): Promise<void> {
    if (this.#retired.length === 0) return;
    const olds = this.#retired;
    this.#retired = [];
    for (const old of olds) await old.release();
  }

  /** The process a loadId answers through, spawning it on first use. */
  private resident(record: GadgetRecord, serverJs: string, loadId: string): Promise<ResidentFacet> {
    const running = this.#running.get(record.slug);
    if (running !== undefined) return Promise.resolve(running.process);
    const starting = this.#starting.get(record.slug);
    if (starting !== undefined) return starting;
    const spawn = (async (): Promise<ResidentFacet> => {
      try {
        const process = await this.spawn(record, serverJs, loadId);
        this.#running.set(record.slug, { process, loadId });
        return process;
      } finally {
        this.#starting.delete(record.slug);
      }
    })();
    this.#starting.set(record.slug, spawn);
    return spawn;
  }

  /** Boot one gadget's process and wait for its runner to hold the server. */
  private async spawn(record: GadgetRecord, serverJs: string, loadId: string): Promise<ResidentFacet> {
    const pid = this.pidFor(record.slug);
    const writerId = crypto.randomUUID();
    const boot: ResidentBootSpec = {
      kind: 'code',
      code: {
        compatibilityDate: GADGET_COMPATIBILITY_DATE,
        compatibilityFlags: [],
        mainModule: GADGET_RUNNER_MODULE,
        modules: {
          [GADGET_RUNNER_MODULE]: GADGET_RUNNER_SOURCE,
          [GADGET_SERVER_MODULE]: serverJs,
          [GADGET_CAPNWEB_MODULE]: await capnwebSource(),
        },
        env: this.mintEnv(record.slug, record.manifest),
      },
    };
    const process = processes(this.deps.ctx, this.deps.env).spawn(
      () => GADGET_DISK,
      { doId: this.deps.workspace, pid, writerId },
      { pid, workerKey: loadId, boot, writerId, startArgs: {} },
    );
    try {
      await process.started;
    } catch (cause) {
      await process.release();
      throw cause;
    }
    return process;
  }

  /**
   * Carry one method call to the process as Cap'n Web HTTP batch: the framed
   * bytes go in on one POST to `handleHttpRequest`, and the framed answer
   * comes back on its response. One batch per call; the process holds no
   * session between calls, which is what lets a retire take effect at once.
   */
  private async invoke(process: ResidentFacet, method: string, args: JsonValue[]): Promise<JsonValue> {
    // One HTTP batch per call, framed exactly as Cap'n Web's own batch client
    // frames it: sends accumulate until a macrotask, then ride one POST to
    // `handleHttpRequest`, and the response lines answer the receives. The
    // macrotask matters because the session's read loop receives before the
    // call's sends land; flushing on the first receive posts an empty batch.
    let batchToSend: string[] | null = [];
    const batchToReceive: string[] = [];
    const batchSettled = (async (): Promise<void> => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      const batch = batchToSend ?? [];
      batchToSend = null;
      const response = await process.handleHttpRequest(new Request('https://gadget/', {
        method: 'POST',
        body: batch.join('\n'),
      }));
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`the gadget answered HTTP ${String(response.status)}`);
      }
      const body = await response.text();
      if (body !== '') batchToReceive.push(...body.split('\n'));
    })();
    const transport = {
      send(message: string): void {
        batchToSend?.push(message);
      },
      receive: async (): Promise<string> => {
        const queued = batchToReceive.shift();
        if (queued !== undefined) return queued;
        await batchSettled;
        const next = batchToReceive.shift();
        if (next === undefined) throw new Error('the gadget answered no batch lines');
        return next;
      },
    };
    const session = new RpcSession(transport);
    // SAFETY: the session's remote main is the process's own `Gadget` instance,
    // built from the agent's `server.js` whose prototype methods answer JSON. The
    // stub parks in `unknown` because the session type carries no gadget shape;
    // the method name passed the bridge rule at the call site, and the value the
    // method answers is verified by the JsonValueSchema parse there instead.
    const untyped = session.getRemoteMain() as unknown;
    // SAFETY: the session guarantees the remote main is the process's own `Gadget`,
    // re-read here as the narrow view: any forwarded name, JSON arguments in, a JSON value out.
    const stub = untyped as GadgetRpc;
    return stub[method](...args);
  }

  private loadId(record: GadgetRecord, serverDigest: string): string {
    return `gadget:${this.deps.workspace}:${record.slug}:${serverDigest}:${sha256Hex(JSON.stringify(record.manifest), 16)}`;
  }

  /** The pid a slug boots under: derived from the slug, probed past the pids
   *  taken. Stable within an isolate, so a quiet gadget keeps its fabric slot. */
  private pidFor(slug: string): number {
    const known = this.#pids.get(slug);
    if (known !== undefined) return known;
    const taken = new Set(this.#pids.values());
    let pid = GADGET_PID_BASE + (parseInt(sha256Hex(slug).slice(0, 8), 16) % GADGET_PID_RANGE);
    while (taken.has(pid)) pid += 1;
    this.#pids.set(slug, pid);
    return pid;
  }

  /** Mint one stub per declared binding: the whole of the process's reach. */
  private mintEnv(slug: string, manifest: GadgetManifest): GadgetProcessEnv {
    const env: GadgetProcessEnv = {};
    for (const [name, binding] of gadgetBindings(manifest)) {
      env[name] = mintGadgetBinding(binding.kind, { workspace: this.deps.workspace, slug, name });
    }
    return env;
  }
}

/**
 * The stub for one binding: the loopback form of its kind's entrypoint class,
 * read by name from this Worker's own exports so the class the process reaches
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
