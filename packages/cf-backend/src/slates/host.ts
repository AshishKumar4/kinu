import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { facetImagePath } from '@nimbus-sh/fabric/process-fabric.js';
import {
  SlateController, slateAnswer, heldSlateKey, initEphemeralSlateTable, initSlateUsageTable, slateStorageCall,
  type SlateAppCall, type SlateApps, type SlateBuilds, type SlateCaller, type SlateLaunch,
} from '@kinu.run/core/slates';
import {
  slateTitle, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateCallRequestSchema, workModeRefusal, routeSlateCall, issuedSlateInvocation,
  isJsonAnswer, JsonValueSchema, isSlateMethodName, answeredRefusal,
  type JsonValue, type SlateRoute, type SlateCallRequest, type SlateCallResult, type SlateSurfaceResult, type SlateSurfaceValue, type SlateInvocation,
  type SlateSurfaceCatalog, type EphemeralSlateAddress,
} from '@kinu.run/core';
import { attempt, inItsWords, KinuError, refusalOf, settle, toKinuError } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { secretSightings, sha256Hex, stableStringify, type SlateAnswer } from '@kinu.run/core';
import type { RoomCallOutcome } from './room';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { SlateSources, type MessageBlock, type SlateSource } from './sources';

type SlateCapabilityRoute = Exclude<SlateRoute, { kind: 'app' }>;

/** What the host decided about a call, carried into the actor that runs it. */
export interface SlateDispatchContext {
  /** Check that the call may run, and run nothing: the class runs it, where its browser socket lives. */
  readonly authorizeOnly?: true;
  /** Each member a call reaches inside itself, as a crafted tool's program does, before it runs: recorded for its slate. */
  readonly nested: (namespace: string, member: string) => void;
}

export interface SlateHostDeps extends Omit<ResidentSlateDeps, 'retained'> {
  readonly ctx: DurableObjectState;
  readonly workspace: string;
  /** The object's slate build records, which its owner reads and moves on a file change before any host is loaded. */
  readonly builds: SlateBuilds;
  /** Runs as the caller: its own providers, role reach, read models and gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute, context: SlateDispatchContext): Promise<SlateSurfaceValue>;
  /** The actor whose browser sessions the caller's slate drives, as that actor's eval programs do. */
  browserActor(caller: SlateCaller): Promise<string | null>;
  readonly apps: SlateApps;
  catalog(): Promise<SlateSurfaceCatalog>;
  forgetPicture?(slate: string): Promise<void>;
  forgetRoom?(slate: string): Promise<void>;
  previewed?(slate: string): void;
  /** The block an ephemeral slate's id names, and the author whose authority its page runs with; refused when no stored
   *  answer holds it. */
  messageBlock?(address: EphemeralSlateAddress): Promise<MessageBlock>;
  /** The slate's room, made on its first need by `owner`: every slate runs in its room (docs/SLATE-SHARING-SECURITY.md §2.7). */
  slateRoom(id: string, title: string, owner: string): Promise<SlateRoomStub>;
  /** The workspace owner's email, as rooms name people; null where the workspace has no owner with one. */
  ownerEmail(): Promise<string | null>;
}

/** What the host asks of a slate's room. */
export interface SlateRoomStub {
  publish(input: {
    readonly author: string; readonly image: string; readonly modules: Readonly<Record<string, string>>; readonly title: string;
    readonly secret: { readonly file: string; readonly line: number; readonly kind: string } | null;
  }): Promise<{ readonly methods: readonly string[] }>;
  callAs(email: string | null, fn: string, args: JsonValue[]): Promise<SlateAnswer<RoomCallOutcome>>;
  ownerFrame(): Promise<string>;
}




/**
 * One process per authored tree per caller, and one durable application per slate. The application's port and capability
 * persist in this object's storage, run as the workspace root and keep one facet SQLite until `remove`; other callers' processes are private and portless.
 */
export class SlateHost {
  readonly controller: SlateController<SlateSource, ResidentSlateProcess>;
  private readonly resident: ResidentSlateProcesses;
  private readonly slateSources: SlateSources;

  constructor(private readonly deps: SlateHostDeps) {
    const sql = deps.ctx.storage.sql;

    initEphemeralSlateTable((ddl) => { sql.exec(ddl); });
    initSlateUsageTable((ddl) => { sql.exec(ddl); });
    this.controller = new SlateController({
      workspace: deps.workspace, sql, builds: deps.builds, transaction: (body) => deps.ctx.storage.transactionSync(body),
      session: deps.session, apps: deps.apps,
      resolve: (cred, id) => this.slateSources.resolve(cred, id),
      digest: (cred, id, source) => this.slateSources.digest(cred, id, source),
      build: async (caller, id, source) => this.resident.build({
        owner: id, root: source.root, project: source.project, read: await this.slateSources.reader(caller.cred, source), cred: caller.cred,
      }),
      launch: (launch) => this.launch(launch),
      // A socket-held invocation dies with the process that held it.
      ended: (held) => {
        for (const [invocationId, issued] of this.invocations) {
          if (issued.held === held) this.invocations.delete(invocationId);
        }
      },
      call: (request) => this.call(request),
      frame: (id) => this.ownerFrame(id),
      catalog: () => deps.catalog(),
      ...(deps.forgetPicture !== undefined && { forgetPicture: deps.forgetPicture.bind(deps) }),
      ...(deps.forgetRoom !== undefined && { forgetRoom: deps.forgetRoom.bind(deps) }),
      ...(deps.previewed !== undefined && { previewed: deps.previewed.bind(deps) }),
    });
    this.resident = new ResidentSlateProcesses({
      session: deps.session, facetManager: deps.facetManager, bundler: deps.bundler, retained: () => this.controller.builds.retained(),
    });
    this.slateSources = new SlateSources({
      project: (cred, id) => this.controller.project(cred, id), trees: (cred) => this.controller.slates(cred), host: deps,
    });
  }

  private readonly invocations = new Map<string, SlateInvocation & { readonly held?: string }>();

  /**
   * A named root invocation for a request this host did not originate; unnamed, a slate could replay a preview's calls
   * from inside a hop. A socket's invocation is released by its close listener via `__host`.
   */
  slateInvocation(port: number, socket: boolean): { readonly value: string; release: () => void } | null {
    const running = this.controller.processes.onPort(port);

    if (running === null) return null;
    const value = crypto.randomUUID();
    this.invocations.set(value, socket ? { id: running.id, chain: [], held: running.held } : { id: running.id, chain: [] });

    return { value, release: () => { this.invocations.delete(value); } };
  }

  private releaseInvocation(caller: SlateCaller, id: string, request: SlateCallRequest): SlateCallResult {
    const target = request.args[0];

    if (request.path.join('.') !== 'release' || !v.is(v.string(), target)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('bad_input', 'The host binding answers only release(invocation)'), otherwise: 'io' })) };
    }

    const issued = this.invocations.get(target);
    // Only the invocation this process holds, so it cannot retire another's lineage.

    if (issued === undefined || issued.id !== id || issued.held !== heldSlateKey(caller, id)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('denied', `Slate ${id} named app invocation ${target}, which this host is not running`), otherwise: 'io' })) };
    }

    this.invocations.delete(target);

    return { ok: true, value: null };
  }

  /** Every call a slate makes, routed and held to its caller's reach as of now: a held stub proves its slate, nothing more. */
  async surfaceCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateSurfaceResult> {
    try {
      const parsed = v.safeParse(SlateCallRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A slate call is { path: string[], args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });

      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);

      // Answered here, not dispatched: it carries no actor capability.
      if (name === SLATE_STORAGE_BINDING) return slateStorageCall(this.controller.state, caller, id, { member: parsed.output.path.join('.'), args: parsed.output.args });
      const issued = issuedSlateInvocation({ invocations: this.invocations, id, invocation: parsed.output.invocation });
      const chain = issued?.chain ?? [];

      const source = await this.slateSources.resolve(caller.cred, id);

      if (source.kind === 'message' && !source.bound) {
        throw new KinuError('denied', `Slate ${id} is a hired agent's page, drawn with no authority lent to it: its calls would not run where that agent's stores are`);
      }

      // An answer's page calls as its author as of now, in the mode the author's next turn runs in.
      const callsAs = source.kind === 'message' ? source.author : caller;
      // Only the owner's own slate, calling as the owner, hires or messages helpers; a hosted actor's slate never does.
      const call = routeSlateCall({ id, request: parsed.output, chain, hosted: callsAs.path.length > 0 });

      // An answer's page is never shared or published, so what it calls is no slate's graph.
      const record = (namespace: string, member: string) => { if (source.kind !== 'message') this.controller.usage.record(id, { namespace, member }); };

      record(call.address.namespace, call.address.member);

      return await this.run(callsAs, call.route, { nested: record, ...(parsed.output.authorize && { authorizeOnly: true }) });
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private async run(caller: SlateCaller, route: SlateRoute, context: SlateDispatchContext): Promise<SlateSurfaceResult> {
    switch (route.kind) {
      case 'namespace': {
        const value = await this.deps.dispatch(caller, route, context);
        const refused = isJsonAnswer(value) ? answeredRefusal(value) : null;

        return refused === null ? { ok: true, value } : { ok: false, ...refused };
      }

      // MCP owns CallToolResult.isError; read models are application data.
      // Neither producer declares the internal namespace refusal vocabulary.
      case 'mcp':
      case 'rpc':
      case 'tool':
      case 'agent':
      case 'ai': return { ok: true, value: await this.deps.dispatch(caller, route, context) };
      // The hop keeps the caller's authority, never the author's.
      case 'app': return this.call({ caller, id: route.id, method: route.method, args: [...route.args], chain: route.chain });
    }
  }

  /**
   * A method of a slate, called by the workspace's own work (an agent's hop): in the slate's room, for the workspace's
   * owner, as the room admits it. What a call needed and the owner has not allowed is the room's part, not an answer.
   */
  call(request: SlateAppCall): Promise<SlateCallResult> {
    const { caller, id, method, args } = request;

    return settle(slateAnswer(`slate ${id}.${method}`, Effect.gen({ self: this }, function* () {
      const planned = workModeRefusal(caller.workMode, false, 'Calling authored slate code');

      if (planned !== null) return yield* new KinuError(planned.reason, planned.error);

      if (!isSlateMethodName(method)) return yield* new KinuError('bad_input', `"${method}" is not an app method name`);
      const parsed = v.safeParse(v.array(JsonValueSchema), args);

      if (!parsed.success) return yield* new KinuError('bad_input', 'Slate arguments must be JSON values', { cause: new v.ValiError(parsed.issues) });

      // The room needs the slate built and published first.
      yield* attempt({ doing: `slate ${id}`, otherwise: 'io' }, async () => this.ensure(caller, id));
      const email = yield* this.owner();
      const room = yield* this.room(id, email);
      const answered = yield* attempt({ doing: `slate ${id}.${method}`, otherwise: 'io' }, async () => room.callAs(email, method, parsed.output));

      if (!answered.ok) return yield* new KinuError(answered.reason, answered.error);

      if (!('value' in answered.value)) {
        return yield* new KinuError('denied', `${method} reads what only a part shows: open the slate to see it, or allow what it asks there`);
      }

      return answered.value.value;
    })));
  }

  /** The modules of one of a slate's images, by content digest, as its room loads them; refused when one was swept. */
  imageModules(slate: string, digests: readonly string[]): Promise<SlateAnswer<Readonly<Record<string, string>>>> {
    return settle(slateAnswer(`reading slate ${slate}'s image`, Effect.gen({ self: this }, function* () {
      const session = yield* attempt({ doing: 'opening the workspace', otherwise: 'unavailable' }, async () => this.deps.session());
      const vfs = session.vfs.as(CRED_KERNEL);
      const texts: Record<string, string> = {};

      for (const digest of digests) texts[digest] = yield* inItsWords('missing', Effect.sync(() => vfs.readFileString(facetImagePath(digest))));

      return texts;
    })));
  }

  /** The slate's page in its room, entered as the workspace's owner: what a preview shows. */
  ownerFrame(id: string): Promise<string> {
    return settle(Effect.gen({ self: this }, function* () {
      const room = yield* this.room(id, yield* this.owner());

      return yield* attempt({ doing: `slate ${id}'s page`, otherwise: 'unavailable' }, async () => room.ownerFrame());
    }));
  }

  private owner(): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const owner = yield* attempt({ doing: 'reading the workspace owner', otherwise: 'unavailable' }, async () => this.deps.ownerEmail());

      return owner ?? (yield* new KinuError('unavailable', 'This workspace has no owner to run its slates for'));
    });
  }

  private room(id: string, owner: string): Effect.Effect<SlateRoomStub, KinuError> {
    return attempt({ doing: `slate ${id}'s room`, otherwise: 'unavailable' }, async () => {
      const source = await this.slateSources.resolve(CRED_SESSION_USER, id);

      return await this.deps.slateRoom(id, slateTitle(source.project, id), owner);
    });
  }

  async ensure(caller: SlateCaller, id: string): Promise<ResidentSlateProcess> {
    return (await this.controller.processes.booted(caller, id)).process;
  }

  /**
   * `launch` publishes: the slate's good build becomes its room's image, written by the workspace's owner, whose own
   * agent wrote it. The room runs it; nothing of the workspace's does.
   */
  launch(launch: SlateLaunch<SlateSource>): Promise<ResidentSlateProcess> {
    const { id, source, image } = launch;

    return settle(Effect.gen({ self: this }, function* () {
      const owner = yield* this.owner();
      const room = yield* this.room(id, owner);
      const secret = yield* attempt({ doing: `scanning slate ${id} for secrets`, otherwise: 'io' }, async () => this.secretIn(source));

      const { methods } = yield* attempt({ doing: `publishing slate ${id}`, otherwise: 'unavailable' }, async () => room.publish({
        author: owner, image: sha256Hex(stableStringify(image.modules)), modules: image.modules, title: slateTitle(source.project, id), secret,
      }));

      // Nothing of the workspace's serves the slate: its URL and its socket are its room's.
      const elsewhere = async (): Promise<Response> => new Response(`Slate ${id} runs in its room`, { status: 501 });

      return { id: `room:${id}`, port: null, methods: [...methods], request: elsewhere, connect: elsewhere, isRunning: async () => true, stop: async () => {} };
    }));
  }

  /** The first secret-shaped text in the slate's files: while one is there, its room keeps its link off. */
  private async secretIn(source: SlateSource): Promise<{ readonly file: string; readonly line: number; readonly kind: string } | null> {
    if (source.kind !== 'files') return null;
    const vfs = (await this.deps.session()).vfs.as(CRED_SESSION_USER);
    const pending = [source.root];

    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      for (const entry of vfs.readdir(dir)) {
        const path = `${dir}/${entry.name}`;

        if (entry.type === 'directory' && entry.name !== 'node_modules' && !entry.name.startsWith('.')) pending.push(path);

        if (entry.type !== 'file') continue;
        const bytes = vfs.readFile(path);

        if (bytes.includes(0)) continue;
        const [found] = secretSightings(path.slice(source.root.length + 1), new TextDecoder('utf8', { fatal: false }).decode(bytes));

        if (found !== undefined) return { file: found.path, line: found.line, kind: found.message };
      }
    }

    return null;
  }
}
