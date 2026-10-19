import { exports } from 'cloudflare:workers';
import { Effect } from 'effect';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  codecAdmits, PartOutputSchema, plainData, ROOT_SLATE_CALLER, sealedPartDocument, slateAnswer, slateRevision, UNDECLARED,
  type PartAiAnswer, type PartConnectionAnswer, type PartRunAnswer, type PartRunRequest, type PartShowRequest, type SlateAppCall, type SlateController,
} from '@kinu.run/core/slates';
import {
  JsonValueSchema, routeSlateCall, slateAuthority, SLATE_HOST_BINDING, SLATE_STORAGE_BINDING, slateTitle,
  type JsonValue, type SlateCallResult, type SlateRoute, type SlateSurfaceResult, type SlateSurfaceValue,
} from '@kinu.run/core';
import { attempt, KinuError, renderCauseChain, settle, settleSync } from '@kinu.run/core/obs';
import type { ResidentSlateProcess, ResidentSlateProcesses } from './resident';
import type { SlateSource } from './sources';
import { slateBatchStub } from './rpc-transport';

/** Who a personal part runs for: the signed-in person the app's route names, never anything the request says. */
export interface PartViewer {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
}

/** A call of a part's run with its viewer's connection, as their account answers or checks it. */
export interface PartToolCall {
  readonly workspace: string;
  readonly slate: string;
  readonly revision: string;
  readonly server: string;
  readonly tool: string;
  readonly args: JsonValue[];
}

/**
 * The viewer's own account, where every call of their part runs: their consents, connections and AI. `admit` is the
 * run's word read again where the account is called, with nothing awaited between: it throws when the run, or its
 * viewer's access, ended meanwhile.
 */
export interface PartConnections {
  tool(viewer: PartViewer, call: PartToolCall, admit: () => void): Promise<PartConnectionAnswer<JsonValue>>;
  ai(viewer: PartViewer, call: {
    readonly workspace: string; readonly slate: string; readonly revision: string; readonly route: Extract<SlateRoute, { kind: 'ai' }>;
  }, admit: () => void): Promise<PartAiAnswer>;
  /** Whether each call is still within its viewer's consent at the revision (none is run): what a resumed run replays. */
  consented(viewer: PartViewer, calls: readonly PartToolCall[]): Promise<readonly boolean[]>;
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

/**
 * One call a part's run made with its viewer's connection, and what it was answered, as data: a stream (their own
 * model's text) is kept as the bytes it carried, so a resumed run is answered exactly that again, never a new reply.
 */
interface PartStep {
  readonly key: string;
  readonly call: PartToolCall | null;
  readonly answer: { readonly kind: 'data'; readonly value: JsonValue } | { readonly kind: 'stream'; readonly bytes: ArrayBuffer };
}

/** A part's run while it runs: whose it is, at which revision, and what it was refused for want of. */
interface PartRun {
  readonly slate: string;
  readonly viewer: PartViewer;
  readonly revision: string;
  needed: Exclude<PartConnectionAnswer<JsonValue>, { kind: 'ran' | 'missing' }> | null;
  /**
   * Each call it made and was answered, at the slot of the order it was made in (not the order it was answered in): what
   * a run resumed after a decision is answered from. A slot still unanswered when the run paused is a hole.
   */
  readonly steps: (PartStep | undefined)[];
  /** What an earlier run of the same calls answered, by slot. */
  readonly replay: Journal;
  /** How many calls it has made: the next call's slot. */
  issued: number;
  /** The first slot whose call differed from the earlier run's: from it on, nothing is answered from the journal. */
  diverged: number | null;
  /** Each call it sent and has not yet journaled: a paused run's journal is read only once every one of them is. */
  readonly inFlight: Set<Promise<void>>;
}

/** A run's answered calls by the slot of the order they were made in; a hole where a call was not answered. */
type Journal = readonly (PartStep | undefined)[];

/** What a run of a part's function is given: its arguments, the journal it is answered from first, and its revision. */
interface PartInput {
  readonly args: readonly JsonValue[];
  readonly replay: Journal;
  /** A resumed run's: the revision it began at, which it runs at or not at all. */
  readonly revision: string | null;
}

/**
 * A run that stopped for its viewer's decision (a consent or an approval): whose, which part, at which revision, what it
 * was given and what it was answered so far. The run resumed on it (`PartRunRequest.continuation`, taken once) is
 * answered the same up to where it stopped, at that revision only, while their consent to each call still holds.
 */
interface Continuation {
  readonly viewer: string;
  readonly slate: string;
  readonly part: string;
  readonly revision: string;
  readonly args: readonly JsonValue[];
  /** Its journal, read only once `settled`: every call it had sent when it paused is journaled by then. */
  readonly steps: Journal;
  readonly settled: Promise<unknown>;
}

/**
 * A run stopped for its viewer's decision: what it asks, its journal and when every call it had already sent is in it,
 * and the revision it ran at. Its viewer is asked at once; its journal is read on resume, once settled.
 */
interface PausedAnswer {
  readonly kind: 'paused';
  readonly needed: Exclude<PartConnectionAnswer<JsonValue>, { kind: 'ran' | 'missing' }>;
  readonly steps: Journal;
  readonly settled: Promise<unknown>;
  readonly revision: string;
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
  /** Runs stopped for their viewer's decision, by an unguessable token of their own; each resumed once (`run`). */
  private readonly continuations = new Map<string, Continuation>();

  constructor(private readonly deps: PersonalPartsDeps) {}

  /**
   * Whether `viewer` may run the slate's personal parts now: its owner, in their own preview; or someone a live share
   * of it on each person's own access admits. A share on the owner's access runs no one's personal parts.
   */
  admitted(viewer: PartViewer, slate: string): boolean {
    if (viewer.userId === this.deps.ownerUserId?.()) return true;

    return this.deps.controller.live.list().some((share) => share.slate === slate && share.revokedAt === null && share.mode === 'own'
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

      // A fresh run's input is held to what the part declares; a resumed run's was, when it began.
      if (request.continuation === null && !codecAdmits(declared.input ?? UNDECLARED, request.args.length === 1 ? request.args[0] ?? null : request.args)) {
        return { kind: 'failed', message: `What the page passed ${title}'s part ${part} is not what it declares it takes` } satisfies PartRunAnswer;
      }

      const resumed = yield* this.resumed(viewer, { slate, part, title }, request);

      if ('kind' in resumed) return resumed;
      const answer = yield* this.runOnce(viewer, slate, { fn: declared.fn, args: resumed.args, replay: resumed.replay, revision: resumed.revision });

      // Delivered only to someone the slate is still shared with: removed meanwhile, they are answered nothing.
      if (!this.admitted(viewer, slate)) return null;

      if (answer.kind !== 'paused') return answer;
      const continuation = crypto.randomUUID();

      this.continuations.set(continuation, { viewer: viewer.userId, slate, part, revision: answer.revision, args: resumed.args, steps: answer.steps, settled: answer.settled });

      return answer.needed.kind === 'needs-consent'
        ? { kind: 'needs-consent', ask: answer.needed.ask, continuation } satisfies PartRunAnswer
        : { kind: 'needs-approval', ask: answer.needed.ask, continuation } satisfies PartRunAnswer;
    }));
  }

  /**
   * What a run is given. Resumed (`request.continuation`, taken once): the run it continues, answered the same up to
   * where it stopped, if the slate is still at that revision and its viewer's consent still holds for each call it
   * replays; else answered so, to run afresh.
   */
  private resumed(viewer: PartViewer, { slate, part, title }: { readonly slate: string; readonly part: string; readonly title: string }, request: PartRunRequest)
    : Effect.Effect<PartInput | Extract<PartRunAnswer, { kind: 'failed' }>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (request.continuation === null) return { args: request.action === null ? request.args : [...request.args, request.action], replay: [], revision: null };

      const held = this.continuations.get(request.continuation);

      this.continuations.delete(request.continuation);
      const stale = { kind: 'failed', message: `${title} changed, or what you let it use did, since this ran: run it again` } as const;

      if (held?.viewer !== viewer.userId || held.slate !== slate || held.part !== part) return stale;

      if (slateRevision(this.deps.controller.builds, slate) !== held.revision) return stale;

      // Every call the run had sent when it paused is journaled first: a call it already made is answered as it was,
      // never made again.
      yield* Effect.promise(async () => held.settled);
      const calls = held.steps.flatMap((step) => (step === undefined || step.call === null ? [] : [step.call]));

      const still = calls.length === 0 || this.deps.connections === undefined ? [] : yield* attempt(
        { doing: `reading ${viewer.email}'s consents`, otherwise: 'unavailable' }, async () => this.deps.connections?.consented(viewer, calls) ?? [],
      );

      return still.every(Boolean) ? { args: held.args, replay: [...held.steps], revision: held.revision } : stale;
    });
  }

  private runOnce(viewer: PartViewer, slate: string, { fn, args, replay, revision: pinned }: PartInput & { readonly fn: string })
    : Effect.Effect<Exclude<PartRunAnswer, { kind: 'needs-approval' | 'needs-consent' }> | PausedAnswer, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { controller, resident, workspace } = this.deps;
      const running = yield* attempt({ doing: `building slate ${slate}`, otherwise: 'io' }, async () => controller.processes.booted(ROOT_SLATE_CALLER, slate));
      const revision = slateRevision(controller.builds, slate);
      const good = controller.builds.good(slate, slateAuthority(ROOT_SLATE_CALLER.cred));

      if (revision === null || good === null) return { kind: 'failed', message: `Slate ${slate} has not built yet` } satisfies PartRunAnswer;

      // A resumed run runs at the revision it began at, or not at all: its journal was answered to that code.
      if (pinned !== null && pinned !== revision) return { kind: 'failed', message: `${slate} changed since this ran: run it again` } satisfies PartRunAnswer;

      // A shared slate's parts run only an image built from its own tree, as its server does (`SlateHost.launch`).
      if (controller.live.isShared(slate) && good.image.scope !== 'tree') {
        return { kind: 'failed', message: `${slate} is shared, so it runs only as its own files build; they do not build alone yet` } satisfies PartRunAnswer;
      }

      const id = crypto.randomUUID();
      const run: PartRun = { slate, viewer, revision, needed: null, steps: [], replay: [...replay], issued: 0, diverged: null, inFlight: new Set() };
      const bindings = Object.fromEntries(PART_SURFACES.map((name) => [name, exports.PartBinding({ props: { workspace, slate, run: id, name } })]));

      this.runs.set(id, run);

      // A fresh private process, its network none: its isolate, its storage and anything it kept end with the run, and
      // a call it makes after is refused (`call`).
      const drawn = yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
        const process = yield* attempt({ doing: `starting ${slate}'s part`, otherwise: 'io' },
          async () => resident.launch({ owner: slate, root: running.source.root, bindings, secrets: {}, globalOutbound: null, app: null }, good.image));

        return yield* Effect.ensuring(this.called(process, fn, args), Effect.promise(async () => { await process.stop(); }));
      }), Effect.sync(() => { this.runs.delete(id); }));

      // Its journal goes with it as it stands, and goes on filling as the calls it already sent come back.
      if (run.needed !== null) return { kind: 'paused', needed: run.needed, steps: run.steps, settled: Promise.all(run.inFlight), revision };

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

  /** The run `runId` still running, for someone still admitted to `slate`: where it is read, it throws to refuse. */
  stillRunning(runId: string, slate: string): void {
    const run = this.runs.get(runId);

    return settleSync(run !== undefined && this.admitted(run.viewer, slate)
      ? Effect.void : Effect.fail(new KinuError('denied', `Slate ${slate}'s part ended before its call was sent`)));
  }

  /** `viewer` still admitted to `slate`'s personal parts: where it is read, it throws to refuse. */
  stillAdmitted(viewer: PartViewer, slate: string): void {
    return settleSync(this.admitted(viewer, slate) ? Effect.void : Effect.fail(new KinuError('missing', `Slate ${slate} is not shared with ${viewer.email}`)));
  }

  /** A continuation its viewer let go (they declined what it asked): forgotten. Only its own viewer's. */
  release(viewer: PartViewer, continuation: string): boolean {
    const held = this.continuations.get(continuation);

    if (held?.viewer !== viewer.userId) return false;
    this.continuations.delete(continuation);

    return true;
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
      // Plain data, read once: what is replayed, consented, approved and sent is this one form.
      const args = v.parse(v.array(JsonValueSchema), plainData([...call.args]));
      const key = JSON.stringify([call.path, args]);
      // Its slot is the order it was made in, taken as it arrives: concurrent calls answered in another order keep theirs.
      const slot = run.issued;

      run.issued += 1;
      const replayed = run.diverged === null || slot < run.diverged ? run.replay[slot] : undefined;

      // The same call an earlier run made at this slot before it stopped: answered as then, run no second time. A
      // different one ends the replay there, and every call from it on runs, and asks, afresh.
      if (replayed?.key === key) {
        run.steps[slot] = replayed;

        return answerOf(replayed);
      }

      if (replayed !== undefined) run.diverged = slot;
      // The run's word read again where the viewer's account is called: ended, or its viewer removed, it sends nothing.
      const admit = (): void => { this.stillRunning(runId, slate); };

      const answer = yield* this.sent(run, Effect.gen({ self: this }, function* () {
        const answered = yield* this.connected(run, { path: call.path, args }, admit);

        if (answered.kind !== 'ran') return answered;
        // Journaled once it came back, the run paused or not: a resumed run is answered it, and never sends it again.
        const step = yield* Effect.promise(async () => journaled(key, this.consentFor(run, call.path, args), answered.value));

        run.steps[slot] = step;

        return { kind: 'kept', step } as const;
      }));

      // Answered to a run still running for someone still admitted: else the run, or its viewer's access, ended meanwhile.
      if (this.runs.get(runId) !== run || !this.admitted(run.viewer, slate)) return yield* new KinuError('denied', `Slate ${slate}'s part ended for ${run.viewer.email} while it ran`);

      if (answer.kind === 'kept') return answerOf(answer.step);

      if (answer.kind === 'missing') return yield* new KinuError('missing', answer.message);

      run.needed = answer;

      return yield* new KinuError('denied', answer.kind === 'needs-consent'
        ? `${run.viewer.email} has not let this slate use ${answer.ask.server} this way yet`
        : `${run.viewer.email} has not approved ${answer.ask.server}.${answer.ask.tool} with this payload yet`);
    })));
  }

  /** A call sent for `run`, counted in flight until it is answered and journaled (or refused). */
  private sent<A>(run: PartRun, call: Effect.Effect<A, KinuError>): Effect.Effect<A, KinuError> {
    return Effect.suspend(() => {
      const done = Promise.withResolvers<undefined>();

      run.inFlight.add(done.promise);

      return Effect.ensuring(call, Effect.sync(() => {
        run.inFlight.delete(done.promise);
        done.resolve(undefined);
      }));
    });
  }

  /** A call as the viewer's account names it: an MCP tool's; null for anything else. */
  private toolCall(run: PartRun, path: readonly string[], args: JsonValue[]): PartToolCall | null {
    const [namespace, server, tool] = path;

    return namespace === 'mcp' && server !== undefined && tool !== undefined && path.length === 3
      ? { workspace: this.deps.workspace, slate: run.slate, revision: run.revision, server: `mcp.${server}`, tool, args }
      : null;
  }

  /** What the viewer consented to for a call, as their account checks it again on resume: its tool, or their AI's. */
  private consentFor(run: PartRun, path: readonly string[], args: JsonValue[]): PartToolCall | null {
    const tool = this.toolCall(run, path, args);

    if (tool !== null) return tool;
    const routed = routeSlateCall({ id: run.slate, request: { path: [...path], args, invocation: null }, chain: [], hosted: false });

    return routed.route.kind === 'ai'
      ? { workspace: this.deps.workspace, slate: run.slate, revision: run.revision, server: 'ai', tool: routed.route.stream === true ? 'stream' : 'run', args: [] }
      : null;
  }

  private connected(run: PartRun, call: { readonly path: readonly string[]; readonly args: JsonValue[] }, admit: () => void): Effect.Effect<PartConnectionAnswer, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { connections, workspace } = this.deps;
      const tool = this.toolCall(run, call.path, call.args);

      if (connections === undefined) return yield* new KinuError('unavailable', 'This deployment runs no personal parts');

      if (tool !== null) {
        return yield* attempt({ doing: `${tool.server}.${tool.tool} for ${run.viewer.email}`, otherwise: 'unavailable' }, async () => connections.tool(run.viewer, tool, admit));
      }

      const routed = routeSlateCall({ id: run.slate, request: { path: [...call.path], args: [...call.args], invocation: null }, chain: [], hosted: false });

      if (routed.route.kind === 'ai') {
        const { route } = routed;

        return yield* attempt({ doing: `${run.viewer.email}'s own AI`, otherwise: 'unavailable' }, async () => connections.ai(run.viewer, {
          workspace, slate: run.slate, revision: run.revision, route,
        }, admit));
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

      // Read again where the shared method is sent, with nothing awaited between: removed meanwhile, it shows nothing.
      const admit = (): void => { this.stillAdmitted(viewer, slate); };

      const shown = yield* attempt({ doing: `showing ${part} to everyone`, otherwise: 'io' }, async () => this.deps.call({
        caller: ROOT_SLATE_CALLER, id: slate, method, args: [plainData(request.value), { email: viewer.email, name: viewer.name }], admit,
      }));

      return shown.ok ? shown.value : yield* new KinuError(shown.reason, shown.error);
    })));
  }
}

/** A connection's answer as the journal keeps it: data copied, a stream read to its end and kept as its bytes. */
async function journaled(key: string, call: PartToolCall | null, value: SlateSurfaceValue): Promise<PartStep> {
  if (value instanceof ReadableStream) return { key, call, answer: { kind: 'stream', bytes: await new Response(value).arrayBuffer() } };

  // An answer holding a stream (an agent's reply) is no part's: a part reaches its viewer's tools and model alone.
  return { key, call, answer: { kind: 'data', value: plainData(v.parse(JsonValueSchema, value)) } };
}

/** What a journaled step answers its run: the data, or a fresh stream of the very bytes it carried. */
function answerOf(step: PartStep): SlateSurfaceValue {
  if (step.answer.kind === 'data') return step.answer.value;

  // A byte stream of its own (a body's), as one sent across a binding must be.
  return new Response(step.answer.bytes).body ?? new Response('').body ?? new ReadableStream<Uint8Array>();
}

