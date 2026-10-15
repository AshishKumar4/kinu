/**
 * Refinement of `Sharing/Model.lean — permits` by the room's caretaker: each trace in `lean/fixtures/sharing-traces.json`
 * is a run of model events on a slate and its forks, and each is replayed against one `RoomCaretaker` per slate on
 * SQLite, which must let through exactly the steps the model permits, render exactly what the model's `flows` shows,
 * and let an effect go ahead exactly when the model's `effectOk` does. The model numbers people, sources, functions and
 * code revisions; here they are emails, MCP servers, function names and images, and its signed-out visitor is a session
 * with no email. Its generations and ids are the counter it ran at; the caretaker's are its own, and each is matched to
 * the model's as it is issued, in the room that issued it.
 * `bash scripts/verify-lean.sh` regenerates the fixture from the model.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { KinuError } from '../src/obs';
import { initSlateRoomTables, RoomCaretaker, type Access, type Session, type ToolVerdict } from '../src/slates/room/caretaker';
import { audienceFlows, observers, type Audience } from '../src/slates/room/labels';
import { makeExecRaw, makeSqlExec } from './helpers';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/sharing-traces.json');

const AudSchema = v.union([v.literal('anyone'), v.array(v.number())]);

const AccSchema = v.variant('kind', [
  v.object({ kind: v.literal('owner') }),
  v.object({ kind: v.literal('member'), gen: v.number() }),
  v.object({ kind: v.literal('link'), gen: v.number() }),
]);

const TagSchema = v.object({ holder: v.number(), src: v.number() });

const SlateField = { slate: v.number() };

const EventSchema = v.variant('ev', [
  v.object({ ev: v.literal('share'), ...SlateField, actor: v.number(), on: v.boolean() }),
  v.object({ ev: v.literal('collaborate'), ...SlateField, actor: v.number(), q: v.number(), role: v.picklist(['edit', 'use']) }),
  v.object({ ev: v.literal('remove'), ...SlateField, actor: v.number(), q: v.number() }),
  v.object({
    ev: v.literal('mint'), ...SlateField, actor: v.number(), personal: v.boolean(), src: v.number(), fn: v.number(), dom: v.array(v.number()),
    effect: v.boolean(), sink: AudSchema,
  }),
  v.object({ ev: v.literal('setCap'), actor: v.number(), cap: v.number(), on: v.literal(false) }),
  v.object({
    ev: v.literal('declassify'), ...SlateField, actor: v.number(), tag: TagSchema,
    scope: v.nullable(v.object({ fn: v.number(), revs: v.array(v.number()) })), aud: AudSchema,
  }),
  v.object({ ev: v.literal('undeclassify'), actor: v.number(), decl: v.number() }),
  v.object({
    ev: v.literal('admit'), ...SlateField, req: v.nullable(v.object({ q: v.number(), acc: AccSchema })), fn: v.number(), arg: v.number(),
    caps: v.array(v.number()), inputs: v.array(v.number()),
  }),
  v.object({ ev: v.literal('toolStep'), run: v.number(), cap: v.number() }),
  v.object({ ev: v.literal('approve'), actor: v.number(), cap: v.number(), run: v.number(), arg: v.number(), seq: v.number() }),
  v.object({ ev: v.literal('observe'), run: v.number(), cell: v.number() }),
  v.object({ ev: v.literal('write'), run: v.number() }),
  v.object({ ev: v.literal('post'), run: v.number() }),
  v.object({ ev: v.literal('release'), run: v.number(), q: v.number(), acc: AccSchema }),
  v.object({ ev: v.literal('render'), cell: v.number(), q: v.number(), acc: AccSchema }),
  v.object({ ev: v.literal('finish'), run: v.number() }),
  v.object({ ev: v.literal('editCode'), ...SlateField, actor: v.number(), fn: v.number(), rev: v.number() }),
  v.object({ ev: v.literal('fork'), ...SlateField, actor: v.number() }),
  v.object({ ev: v.literal('publish'), ...SlateField, actor: v.number() }),
  v.object({ ev: v.literal('readerCheck'), q: v.number(), tag: TagSchema, ok: v.boolean() }),
]);

type Event = v.InferOutput<typeof EventSchema>;

const StepSchema = v.object({
  at: v.number(), event: EventSchema, ok: v.boolean(), shown: v.optional(v.boolean()), effect: v.optional(v.picklist(['none', 'waits', 'goes'])),
});

type Step = v.InferOutput<typeof StepSchema>;

const FixtureSchema = v.object({
  fixture: v.literal('sharing-traces'),
  cases: v.array(v.object({ steps: v.array(StepSchema) })),
});

const { cases } = v.parse(FixtureSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

/** The model's visitor who has not signed in: a session with no email, and no address to add or remove. */
const SIGNED_OUT = 3;

const email = (pid: number): string | null => pid === SIGNED_OUT ? null : `p${String(pid)}@model.test`;

/** The address an owner types to add or remove someone; the signed-out visitor has none, and types as no address. */
const address = (pid: number): string => email(pid) ?? 'signed-out';

const server = (src: number): string => `https://src${String(src)}.model.test/mcp`;

const fnName = (fn: number): string => `f${String(fn)}`;

const image = (rev: number): string => `img-${String(rev)}`;

const cellKey = (cell: number): string => `cell:${String(cell)}`;

/** Every grant reads its source whole: the model's sources have no parts. */
const ROOT = '{}';

const TOOL = 'call';

const audience = (aud: v.InferOutput<typeof AudSchema>): Audience => aud === 'anyone' ? 'anyone' : aud.map(address);

/** The caretaker's answer to one step: through, or refused with the caretaker's own refusal. */
function through(act: () => void): boolean {
  try {
    act();

    return true;
  } catch (error) {
    if (error instanceof KinuError) return false;
    throw error;
  }
}

/** The caretaker's answer to one step: through or not, what a render showed, and a tool step's verdict. */
interface Seen {
  readonly ok: boolean;
  readonly shown?: boolean;
  readonly verdict?: ToolVerdict;
  /** The model asks this step of another slate's state, which the room it runs in cannot name at all. */
  readonly elsewhere?: true;
}

/** Where a model id was issued: the slate whose room holds it, and the room's own id for it. */
interface Issued {
  readonly slate: number;
  readonly id: number;
}

function newRoom(owner: string | null, parent: string | null, rev: number): RoomCaretaker {
  const db = new Database(':memory:');
  const room = new RoomCaretaker({ db: makeSqlExec(db) });

  initSlateRoomTables(makeExecRaw(db));
  room.create({ workspace: 'model', slate: 'slate', title: 'Slate', owner: owner ?? 'nobody', parent });
  // The model's slate runs its code from the start; the room's runs once it is published, by its owner.
  room.publish(owner ?? 'nobody', { image: image(rev), modules: {}, title: 'Slate', secret: null });

  return room;
}

/** One trace replayed: a room per slate, and the model's numbers matched to each room's as they are issued. */
class Replay {
  private readonly rooms = new Map<number, RoomCaretaker>([[0, newRoom(email(0), null, 0)]]);
  private readonly revs = new Map<number, number>([[0, 0]]);
  private readonly gens = new Map<string, number>([['0:0', 0]]);
  private readonly caps = new Map<number, Issued>();
  private readonly shows = new Map<number, Issued>();
  private readonly runs = new Map<number, Issued>();
  private readonly cells = new Map<number, number>();

  private room(slate: number): RoomCaretaker {
    const room = this.rooms.get(slate);

    if (room === undefined) throw new Error(`the trace names slate ${String(slate)}, which no event made`);

    return room;
  }

  /** A generation the model never issued in this slate names nothing in its room either. */
  private gen(slate: number, gen: number): number {
    return this.gens.get(`${String(slate)}:${String(gen)}`) ?? -1 - gen;
  }

  private session(slate: number, q: number, acc: v.InferOutput<typeof AccSchema>): Session {
    const access: Access = acc.kind === 'owner' ? { kind: 'owner' } : { kind: acc.kind, gen: this.gen(slate, acc.gen) };

    return { email: email(q), access };
  }

  /** A model id as the room of `slate` knows it: an id issued in another room names nothing here. */
  private local(issued: Issued | undefined, slate: number, model: number): number {
    return issued?.slate === slate ? issued.id : -1 - model;
  }

  /** The caretaker's verdict on one step, and what it rendered when it was a render. */
  apply(step: Step): Seen {
    const { at, event } = step;

    switch (event.ev) {
      case 'share': return this.issuing(event.slate, at, () => { this.room(event.slate).setLink(email(event.actor), event.on); }, (room) => room.room().linkGen);
      case 'collaborate': return this.issuing(event.slate, at, () => { this.room(event.slate).invite(email(event.actor), address(event.q), event.role); },
        (room) => room.members().find((member) => member.email === address(event.q))?.gen ?? null);
      case 'remove': return this.issuing(event.slate, at, () => { this.room(event.slate).remove(email(event.actor), address(event.q)); },
        (room) => email(event.actor) === room.owner() ? room.room().linkGen : null);
      case 'mint': return this.minting(at, event);
      case 'setCap': {
        const cap = this.caps.get(event.cap);

        return { ok: cap !== undefined && through(() => { this.room(cap.slate).revoke(email(event.actor), cap.id); }) };
      }

      case 'declassify': return this.declassifying(at, event);
      case 'undeclassify': {
        const shown = this.shows.get(event.decl);

        return { ok: shown !== undefined && through(() => { this.room(shown.slate).unshow(email(event.actor), shown.id); }) };
      }

      case 'admit': return this.admitting(at, event);
      case 'toolStep': return this.stepping(step, event);
      case 'approve': return { ok: step.ok };
      case 'observe': return this.onRun(event.run, (room, run) => {
        // A cell of another slate is not in this room at all: the model refuses it, and the room has no way to ask.
        if (this.cells.get(event.cell) !== this.runs.get(event.run)?.slate) return { ok: false, elsewhere: true };

        return { ok: through(() => room.observe(run, cellKey(event.cell))) };
      });
      case 'write': return this.onRun(event.run, (room, run) => ({ ok: through(() => { room.write(run, 1); }) }));
      case 'post': return this.onRun(event.run, (room, run) => {
        const ok = through(() => { room.post(run, cellKey(at), 1); });

        if (ok) this.cells.set(at, this.runs.get(event.run)?.slate ?? -1);

        return { ok };
      });
      case 'release': return this.onRun(event.run, (room, run, slate) => {
        let flows = false;
        const ok = through(() => { flows = room.release(run, this.session(slate, event.q, event.acc)); });

        return { ok: ok && flows };
      });
      case 'render': {
        const slate = this.cells.get(event.cell);

        if (slate === undefined) return { ok: false };
        let shown = false;
        const ok = through(() => { shown = this.room(slate).render(cellKey(event.cell), this.session(slate, event.q, event.acc)).shown; });

        return ok ? { ok, shown } : { ok };
      }

      case 'finish': return this.onRun(event.run, (room, run) => ({ ok: through(() => { room.finish(run); }) }));
      case 'editCode': {
        const ok = through(() => {
          this.room(event.slate).publish(address(event.actor), { image: image(event.rev), modules: {}, title: 'Slate', secret: null });
        });

        if (ok) this.revs.set(event.slate, event.rev);

        return { ok };
      }

      case 'fork': return this.forking(at, event);
      case 'publish': return { ok: through(() => { this.room(event.slate).list(email(event.actor), { line: 'A slate', category: 'fun' }, 0); }) };
      case 'readerCheck': {
        // A reader check is the source's word about a person, not any one slate's: every room hears it.
        const tag = { holder: address(event.tag.holder), server: server(event.tag.src), root: ROOT };

        for (const room of this.rooms.values()) room.checked(address(event.q), tag, event.ok);

        return { ok: true };
      }
    }
  }

  private onRun(model: number, act: (room: RoomCaretaker, run: number, slate: number) => Seen): Seen {
    const run = this.runs.get(model);

    return run === undefined ? { ok: false } : act(this.room(run.slate), run.id, run.slate);
  }

  /** A step that issues a generation the model numbers `at`, in the room of `slate`. */
  private issuing(slate: number, at: number, act: () => void, issued: (room: RoomCaretaker) => number | null): Seen {
    const ok = through(act);
    const gen = ok ? issued(this.room(slate)) : null;

    if (gen !== null) this.gens.set(`${String(slate)}:${String(at)}`, gen);

    return { ok };
  }

  private minting(at: number, event: Extract<Event, { ev: 'mint' }>): Seen {
    return {
      ok: through(() => {
        const grant = this.room(event.slate).mint(email(event.actor), {
          personal: event.personal, server: server(event.src), root: {}, tools: [TOOL], fn: fnName(event.fn),
          domain: { kind: 'enum', values: event.dom }, effect: event.effect, sink: audience(event.sink),
        });

        this.caps.set(at, { slate: event.slate, id: grant.id });
      }),
    };
  }

  private declassifying(at: number, event: Extract<Event, { ev: 'declassify' }>): Seen {
    return {
      ok: through(() => {
        const tag = { holder: address(event.tag.holder), server: server(event.tag.src), root: ROOT };
        const shown = this.room(event.slate).show(email(event.actor), tag, event.scope === null ? null : fnName(event.scope.fn), audience(event.aud));

        this.shows.set(at, { slate: event.slate, id: shown.id });
      }),
    };
  }

  private admitting(at: number, event: Extract<Event, { ev: 'admit' }>): Seen {
    return {
      ok: through(() => {
        const run = this.room(event.slate).admit({
          requester: event.req === null ? null : this.session(event.slate, event.req.q, event.req.acc), fn: fnName(event.fn), input: event.arg,
          grants: event.caps.map((cap) => this.local(this.caps.get(cap), event.slate, cap)), inputs: event.inputs.map(cellKey), out: cellKey(at + 1),
        });

        this.runs.set(at, { slate: event.slate, id: run.id });
        this.cells.set(at + 1, event.slate);
      }),
    };
  }

  /** A fork is a room of its own: its forker's, at its parent's code, with nothing else of the parent's in it. */
  private forking(at: number, event: Extract<Event, { ev: 'fork' }>): Seen {
    const ok = this.room(event.slate).mayFork(email(event.actor));

    if (ok) {
      const fork = newRoom(email(event.actor), String(event.slate), this.revs.get(event.slate) ?? 0);

      this.rooms.set(at, fork);
      this.revs.set(at, this.revs.get(event.slate) ?? 0);
      this.gens.set(`${String(at)}:${String(at)}`, fork.room().linkGen);
    }

    return { ok };
  }

  /**
   * A tool step, and its effect as the model's `effectOk` has it: one the holder need not decide goes now; one the
   * holder approved for this step goes once they decide it, and no one else's decision counts; one they did not waits.
   */
  private stepping(step: Step, event: Extract<Event, { ev: 'toolStep' }>): Seen {
    return this.onRun(event.run, (room, run, slate) => {
      let verdict: ToolVerdict | undefined;
      const input = room.run(run)?.input ?? null;
      const ok = through(() => { verdict = room.toolStep(run, this.local(this.caps.get(event.cap), slate, event.cap), TOOL, input); });

      if (!ok || verdict === undefined) return { ok };

      if (step.effect === 'goes' && verdict.kind === 'wait') {
        const pending = verdict.pending;
        const holder = room.grant(pending.grant)?.holder ?? null;
        const others = ['p0@model.test', 'p1@model.test', 'p2@model.test', null].filter((each) => each !== holder);

        const decided = others.every((each) => !through(() => { room.decide(each, pending.id, true); }))
          && through(() => { room.decide(holder, pending.id, true); })
          && through(() => { room.resume(pending.id); });

        return { ok: decided, verdict };
      }

      return { ok, verdict };
    });
  }

  /** Whether the room's verdict on a step the model permits is the effect the model says it has. */
  effectAgrees(step: Step, seen: Seen): boolean {
    if (step.effect === undefined || !step.ok) return true;

    if (step.effect === 'none') return seen.verdict?.kind === 'go';

    return seen.verdict?.kind === 'wait' && seen.verdict.pending.kind === 'effect';
  }

  /**
   * The one step the room lets through and the model refuses: a person's own data, in their own request, sent through
   * their own grant to a sink that may not see it. Every other guard of the step must hold, and only the sink's flow
   * fail; the request is their consent when the code is wholly theirs, and otherwise it waits for them as an outflow.
   */
  ownOutflow(step: Step, seen: Seen): boolean {
    if (step.event.ev !== 'toolStep' || seen.verdict === undefined) return false;
    const issued = this.runs.get(step.event.run);

    if (issued === undefined) return false;
    const room = this.room(issued.slate);
    const run = room.run(issued.id);
    const grant = room.grant(this.local(this.caps.get(step.event.cap), issued.slate, step.event.cap));

    if (run === null || grant === null) return false;
    const holds = room.runOk(run) && run.caps.some((cap) => cap.grant === grant.id) && (!grant.personal || run.requester?.email === grant.holder);
    const own = run.requester?.email === grant.holder && run.label.every((elem) => elem.holder === grant.holder);
    const sinkOnly = !audienceFlows(room.facts(), run.label, observers(grant.holder, grant.sink));
    // Wholly theirs: they published it and no one else's code, a fork's parent's included, ever entered it.
    const theirs = room.room().imageAuthor === grant.holder && !room.room().foreign;
    const waits = theirs ? seen.verdict.kind === 'go' : seen.verdict.kind === 'wait' && seen.verdict.pending.kind === 'outflow';

    return holds && own && sinkOnly && waits;
  }
}

/** Where a trace first parts from the model, or null when every step agrees. */
function divergence(steps: readonly Step[]): string | null {
  const replay = new Replay();

  for (const [index, step] of steps.entries()) {
    const seen = replay.apply(step);
    const agrees = seen.ok === step.ok && (!step.ok || step.shown === undefined || seen.shown === step.shown) && replay.effectAgrees(step, seen);

    if (!agrees && !(step.ok === false && seen.ok && replay.ownOutflow(step, seen))) {
      return `step ${String(index)} ${JSON.stringify(step)}: room ${JSON.stringify({ ok: seen.ok, shown: seen.shown, verdict: seen.verdict?.kind })}`;
    }
  }

  return null;
}

/** Every event of the fragment, each needed both permitted and refused, but the two the model never refuses. */
const FRAGMENT = [
  'share', 'collaborate', 'remove', 'mint', 'setCap', 'declassify', 'undeclassify', 'admit', 'toolStep', 'approve', 'observe', 'write', 'post',
  'release', 'render', 'finish', 'editCode', 'fork', 'publish', 'readerCheck',
] as const;

const NEVER_REFUSED: ReadonlySet<string> = new Set(['readerCheck', 'finish']);

describe('the room refines Sharing/Model.lean permits', () => {
  test('the fixture exercises every guard both ways, signed-out visitors, forks and every kind of effect', () => {
    const seen = new Map<string, { ok: number; refused: number }>();
    const effects = new Set<string>();
    let signedOut = 0;
    let forked = 0;

    for (const { steps } of cases) {
      expect(steps.length).toBeGreaterThan(0);

      for (const step of steps) {
        const count = seen.get(step.event.ev) ?? { ok: 0, refused: 0 };

        if (step.ok) count.ok += 1;
        else count.refused += 1;
        seen.set(step.event.ev, count);

        if (step.effect !== undefined) effects.add(step.effect);

        if ('req' in step.event && step.event.req?.q === SIGNED_OUT) signedOut += 1;

        if ('slate' in step.event && step.event.slate > 0 && step.ok) forked += 1;
      }
    }

    expect(cases.length).toBeGreaterThan(100);
    expect([...seen.keys()].sort()).toEqual([...FRAGMENT].sort());
    expect(FRAGMENT.filter((ev) => (seen.get(ev)?.ok ?? 0) === 0 || (!NEVER_REFUSED.has(ev) && (seen.get(ev)?.refused ?? 0) === 0))).toEqual([]);
    expect([...effects].sort()).toEqual(['goes', 'none', 'waits']);
    expect(signedOut).toBeGreaterThan(0);
    expect(forked).toBeGreaterThan(0);
  });

  test('every trace: the room lets through what the model permits, renders what it shows, and runs the effects it runs', () => {
    const parted = cases.map(({ steps }, index) => ({ index, at: divergence(steps) })).filter((trace) => trace.at !== null);

    expect(parted.slice(0, 5)).toEqual([]);
  });
});
