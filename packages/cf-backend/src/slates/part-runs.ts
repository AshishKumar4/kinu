import { exports } from 'cloudflare:workers';
import { Effect } from 'effect';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  codecAdmits, PartOutputSchema, ROOT_SLATE_CALLER, sealedPartDocument, slateAnswer, slateRevision, UNDECLARED,
  type PartAiAnswer, type PartConnectionAnswer, type PartRunAnswer, type PartRunRequest, type PartShowRequest, type SlateAppCall, type SlateController,
} from '@kinu.run/core/slates';
import {
  JsonValueSchema, routeSlateCall, slateAuthority, SLATE_HOST_BINDING, SLATE_STORAGE_BINDING, slateTitle,
  type JsonValue, type SlateCallResult, type SlateRoute, type SlateSurfaceResult,
} from '@kinu.run/core';
import { attempt, KinuError, renderCauseChain, settle } from '@kinu.run/core/obs';
import type { ResidentSlateProcess, ResidentSlateProcesses } from './resident';
import type { SlateSource } from './sources';
import { slateBatchStub } from './rpc-transport';

/** Who a personal part runs for: the signed-in person the app's route names, never anything the request says. */
export interface PartViewer {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
}

/** The viewer's own account, where every call of their part runs: their consents, connections and AI. */
export interface PartConnections {
  tool(viewer: PartViewer, call: {
    readonly workspace: string; readonly slate: string; readonly revision: string; readonly server: string; readonly tool: string; readonly args: JsonValue[];
  }): Promise<PartConnectionAnswer<JsonValue>>;
  ai(viewer: PartViewer, call: {
    readonly workspace: string; readonly slate: string; readonly revision: string; readonly route: Extract<SlateRoute, { kind: 'ai' }>;
  }): Promise<PartAiAnswer>;
}

export interface PersonalPartsDeps {
  readonly workspace: string;
  readonly controller: SlateController<SlateSource, ResidentSlateProcess>;
  readonly resident: ResidentSlateProcesses;
  readonly ownerUserId?: () => string | null;
  readonly ownerTitle?: () => Promise<string>;
  readonly connections?: PartConnections;
  /** A method of the slate's own server, called as its shares allow (`SlateHost.call`). */
  call(request: SlateAppCall): Promise<SlateCallResult>;
}

/** A part's run while it runs: whose it is, at which revision, and what it was refused for want of. */
interface PartRun {
  readonly slate: string;
  readonly viewer: PartViewer;
  readonly revision: string;
  needed: Extract<PartRunAnswer, { kind: 'needs-consent' | 'needs-approval' }> | null;
}

/** The surface a run's process is given: its `workspace`, and the reserved names its runner reaches. */
const PART_SURFACES = ['workspace', SLATE_STORAGE_BINDING, SLATE_HOST_BINDING] as const;

/**
 * Personal parts (docs/SLATE-SHARING-NIMBUS.md §3): each run is a fresh private process of the slate's image, holding
 * one binding per surface that reaches only this host, which answers its calls with the viewer's own connections while
 * the run lasts. No network, no storage, no owner's namespace; its answer is cut and goes to the viewer alone.
 */
export class PersonalParts {
  private readonly runs = new Map<string, PartRun>();

  constructor(private readonly deps: PersonalPartsDeps) {}

  /** Whether `viewer` may use the slate: its owner, or someone a live share of it admits now. */
  admitted(viewer: PartViewer, slate: string): boolean {
    if (viewer.userId === this.deps.ownerUserId?.()) return true;

    return this.deps.controller.live.list().some((share) => share.slate === slate && share.revokedAt === null
      && (share.visibility === 'public' || this.deps.controller.live.hasUser(share.id, viewer.userId)));
  }

  /**
   * A part's run for its viewer: what its function drew, what it needs of them first, or its own failure, for them
   * alone. Null for anyone the slate is not shared with, who learns nothing of it.
   */
  run(viewer: PartViewer | null, slate: string, part: string, request: PartRunRequest): Promise<PartRunAnswer | null> {
    return settle(Effect.gen({ self: this }, function* () {
      if (viewer !== null && !this.admitted(viewer, slate)) return null;
      const project = yield* attempt({ doing: `reading slate ${slate}`, otherwise: 'missing' }, async () => this.deps.controller.project(CRED_SESSION_USER, slate));
      const title = slateTitle(project, slate);

      if (viewer === null) return { kind: 'stub', reason: 'signed-out', message: `Sign in to see your own part of ${title}.` } satisfies PartRunAnswer;
      const declared = project.slate.parts?.[part];

      if (declared === undefined) return { kind: 'stub', reason: 'no-part', message: `${title} has no part named ${part}.` } satisfies PartRunAnswer;

      if (!codecAdmits(declared.input ?? UNDECLARED, request.args.length === 1 ? request.args[0] ?? null : request.args)) {
        return { kind: 'failed', message: `What the page passed ${title}'s part ${part} is not what it declares it takes` } satisfies PartRunAnswer;
      }

      return yield* this.runOnce(viewer, slate, declared.fn, request.action === null ? request.args : [...request.args, request.action]);
    }));
  }

  private runOnce(viewer: PartViewer, slate: string, fn: string, args: readonly JsonValue[]): Effect.Effect<PartRunAnswer, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { controller, resident, workspace } = this.deps;
      const running = yield* attempt({ doing: `building slate ${slate}`, otherwise: 'io' }, async () => controller.processes.booted(ROOT_SLATE_CALLER, slate));
      const revision = slateRevision(controller.builds, slate);
      const good = controller.builds.good(slate, slateAuthority(ROOT_SLATE_CALLER.cred));

      if (revision === null || good === null) return { kind: 'failed', message: `Slate ${slate} has not built yet` } satisfies PartRunAnswer;
      const id = crypto.randomUUID();
      const run: PartRun = { slate, viewer, revision, needed: null };
      const bindings = Object.fromEntries(PART_SURFACES.map((name) => [name, exports.PartBinding({ props: { workspace, slate, run: id, name } })]));

      this.runs.set(id, run);

      // A fresh private process, its network none: its isolate, its storage and anything it kept end with the run, and
      // a call it makes after is refused (`call`).
      const drawn = yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
        const process = yield* attempt({ doing: `starting ${slate}'s part`, otherwise: 'io' },
          async () => resident.launch({ owner: slate, root: running.source.root, bindings, globalOutbound: null, app: null }, good.image));

        return yield* Effect.ensuring(this.called(process, fn, args), Effect.promise(async () => { await process.stop(); }));
      }), Effect.sync(() => { this.runs.delete(id); }));

      if (run.needed !== null) return run.needed;

      if (drawn.kind === 'failed') return drawn;
      const output = v.safeParse(PartOutputSchema, drawn.value);

      if (!output.success) return { kind: 'failed', message: `${fn} returned no part: it answers { html, actions?, show? }` } satisfies PartRunAnswer;
      const { html, actions, show } = output.output;

      return { kind: 'shown', revision, html: yield* Effect.promise(async () => sealedPartDocument(html)), actions, show } satisfies PartRunAnswer;
    });
  }

  /** The run's function, called once in its process: its value, or its own failure in its own words, for its viewer. */
  private called(process: ResidentSlateProcess, fn: string, args: readonly JsonValue[]): Effect.Effect<{ readonly kind: 'drawn'; readonly value: JsonValue } | Extract<PartRunAnswer, { kind: 'failed' }>> {
    if (!process.methods.includes(fn)) return Effect.succeed({ kind: 'failed', message: `This slate's class has no method ${fn}` });
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(process, crypto.randomUUID());

    return Effect.ensuring(
      Effect.match(attempt({ doing: fn, otherwise: 'io' }, async () => stub[fn]?.(...args)), {
        onFailure: (failure) => ({ kind: 'failed', message: renderCauseChain(failure) }) as const,
        onSuccess: (raw) => ({ kind: 'drawn', value: v.parse(JsonValueSchema, raw ?? null) }) as const,
      }),
      Effect.sync(() => { stub[Symbol.dispose](); }),
    );
  }

  /**
   * One call of a running part's process (`PartBinding`): its viewer's own connection or AI, while its run lasts and its
   * viewer is still admitted. Nothing else of anyone's: no shared state, no network, no namespace of the owner's.
   */
  call(slate: string, runId: string, name: string, call: { readonly path: readonly string[]; readonly args: readonly JsonValue[] }): Promise<SlateSurfaceResult> {
    return settle(slateAnswer(`a part's call of ${call.path.join('.')}`, Effect.gen({ self: this }, function* () {
      const run = this.runs.get(runId);

      if (run?.slate !== slate) return yield* new KinuError('denied', 'This part\'s run has ended: nothing it kept may call out');

      if (!this.admitted(run.viewer, slate)) return yield* new KinuError('denied', `Slate ${slate} is no longer shared with ${run.viewer.email}`);

      if (name === SLATE_HOST_BINDING) return null;

      if (name !== 'workspace') return yield* new KinuError('denied', 'A personal part keeps nothing and reads no shared state: what it shows goes only to its viewer');
      const answer = yield* this.connected(run, call);

      if (answer.kind === 'ran') return answer.value;

      if (answer.kind === 'missing') return yield* new KinuError('missing', answer.message);
      run.needed = answer;

      return yield* new KinuError('denied', answer.kind === 'needs-consent'
        ? `${run.viewer.email} has not let this slate use ${answer.ask.server} this way yet`
        : `${run.viewer.email} has not approved ${answer.ask.server}.${answer.ask.tool} with this payload yet`);
    })));
  }

  private connected(run: PartRun, call: { readonly path: readonly string[]; readonly args: readonly JsonValue[] }): Effect.Effect<PartConnectionAnswer, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { connections, workspace } = this.deps;
      const [namespace, server, tool] = call.path;

      if (connections === undefined) return yield* new KinuError('unavailable', 'This deployment runs no personal parts');

      if (namespace === 'mcp' && server !== undefined && tool !== undefined && call.path.length === 3) {
        return yield* attempt({ doing: `${server}.${tool} for ${run.viewer.email}`, otherwise: 'unavailable' }, async () => connections.tool(run.viewer, {
          workspace, slate: run.slate, revision: run.revision, server: `mcp.${server}`, tool, args: [...call.args],
        }));
      }

      const routed = routeSlateCall({ id: run.slate, request: { path: [...call.path], args: [...call.args], invocation: null }, chain: [], hosted: false });

      if (routed.route.kind === 'ai') {
        const { route } = routed;

        return yield* attempt({ doing: `${run.viewer.email}'s own AI`, otherwise: 'unavailable' }, async () => connections.ai(run.viewer, {
          workspace, slate: run.slate, revision: run.revision, route,
        }));
      }

      return yield* new KinuError('denied', `${call.path.join('.')} is the slate owner's: a personal part reaches only its viewer's own connections`);
    });
  }

  /**
   * What `viewer` confirmed in Kinu's prompt, to the slate's declared `show` method, called as the slate's server is:
   * `show(value, from)`, with exactly the value the prompt displayed.
   */
  show(viewer: PartViewer, slate: string, part: string, request: PartShowRequest): Promise<SlateCallResult> {
    return settle(slateAnswer(`showing ${part} to everyone`, Effect.gen({ self: this }, function* () {
      if (!this.admitted(viewer, slate)) return yield* new KinuError('missing', `Slate ${slate} is not shared with ${viewer.email}`);
      const project = yield* attempt({ doing: `reading slate ${slate}`, otherwise: 'missing' }, async () => this.deps.controller.project(CRED_SESSION_USER, slate));
      const method = project.slate.parts?.[part]?.show;

      if (method === undefined) return yield* new KinuError('bad_input', `${slateTitle(project, slate)}'s part ${part} shows nothing to everyone`);

      if (request.revision !== slateRevision(this.deps.controller.builds, slate)) {
        return yield* new KinuError('denied', `${slateTitle(project, slate)} changed since this was drawn: draw it again before showing it`);
      }

      const shown = yield* attempt({ doing: `showing ${part} to everyone`, otherwise: 'io' }, async () => this.deps.call({
        caller: ROOT_SLATE_CALLER, id: slate, method, args: [request.value, { email: viewer.email, name: viewer.name }],
      }));

      return shown.ok ? shown.value : yield* new KinuError(shown.reason, shown.error);
    })));
  }
}
