/**
 * Refinement of `Sharing/Model.lean — permits` by the room's caretaker: each trace in `lean/fixtures/sharing-traces.json`
 * is a run of model events on one slate, and each is replayed against `RoomCaretaker` on SQLite, which must let through
 * exactly the steps the model permits, and render exactly what the model's `flows` shows. The model numbers people,
 * sources, functions and code revisions; here they are emails, MCP servers, function names and images. Its generations
 * and ids are the counter it ran at; the caretaker's are its own, and each is matched to the model's as it is issued.
 * `bash scripts/verify-lean.sh` regenerates the fixture from the model.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { KinuError } from '../src/obs';
import { initSlateRoomTables, RoomCaretaker, type Access, type Session, type ToolVerdict } from '../src/slates/room/caretaker';
import type { Audience } from '../src/slates/room/labels';
import { makeExecRaw, makeSqlExec } from './helpers';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/sharing-traces.json');

const AudSchema = v.union([v.literal('anyone'), v.array(v.number())]);

const AccSchema = v.variant('kind', [
  v.object({ kind: v.literal('owner') }),
  v.object({ kind: v.literal('member'), gen: v.number() }),
  v.object({ kind: v.literal('link'), gen: v.number() }),
]);

const TagSchema = v.object({ holder: v.number(), src: v.number() });

const EventSchema = v.variant('ev', [
  v.object({ ev: v.literal('share'), actor: v.number(), on: v.boolean() }),
  v.object({ ev: v.literal('collaborate'), actor: v.number(), q: v.number(), role: v.picklist(['edit', 'use']) }),
  v.object({ ev: v.literal('remove'), actor: v.number(), q: v.number() }),
  v.object({
    ev: v.literal('mint'), actor: v.number(), personal: v.boolean(), src: v.number(), fn: v.number(), dom: v.array(v.number()),
    effect: v.boolean(), sink: AudSchema,
  }),
  v.object({ ev: v.literal('setCap'), actor: v.number(), cap: v.number(), on: v.literal(false) }),
  v.object({
    ev: v.literal('declassify'), actor: v.number(), tag: TagSchema,
    scope: v.nullable(v.object({ fn: v.number(), revs: v.array(v.number()) })), aud: AudSchema,
  }),
  v.object({ ev: v.literal('undeclassify'), actor: v.number(), decl: v.number() }),
  v.object({
    ev: v.literal('admit'), req: v.nullable(v.object({ q: v.number(), acc: AccSchema })), fn: v.number(), arg: v.number(),
    caps: v.array(v.number()), inputs: v.array(v.number()),
  }),
  v.object({ ev: v.literal('toolStep'), run: v.number(), cap: v.number() }),
  v.object({ ev: v.literal('observe'), run: v.number(), cell: v.number() }),
  v.object({ ev: v.literal('write'), run: v.number() }),
  v.object({ ev: v.literal('post'), run: v.number() }),
  v.object({ ev: v.literal('release'), run: v.number(), q: v.number(), acc: AccSchema }),
  v.object({ ev: v.literal('render'), cell: v.number(), q: v.number(), acc: AccSchema }),
  v.object({ ev: v.literal('finish'), run: v.number() }),
  v.object({ ev: v.literal('editCode'), actor: v.number(), fn: v.number(), rev: v.number() }),
  v.object({ ev: v.literal('fork'), actor: v.number() }),
  v.object({ ev: v.literal('publish'), actor: v.number() }),
  v.object({ ev: v.literal('readerCheck'), q: v.number(), tag: TagSchema, ok: v.boolean() }),
]);

type Event = v.InferOutput<typeof EventSchema>;

const StepSchema = v.object({ at: v.number(), event: EventSchema, ok: v.boolean(), shown: v.optional(v.boolean()) });

type Step = v.InferOutput<typeof StepSchema>;

const FixtureSchema = v.object({
  fixture: v.literal('sharing-traces'),
  cases: v.array(v.object({ steps: v.array(StepSchema) })),
});

const { cases } = v.parse(FixtureSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

const email = (pid: number): string => `p${String(pid)}@model.test`;

const server = (src: number): string => `https://src${String(src)}.model.test/mcp`;

const fnName = (fn: number): string => `f${String(fn)}`;

const image = (rev: number): string => `img-${String(rev)}`;

const cellKey = (cell: number): string => `cell:${String(cell)}`;

/** Every grant reads its source whole: the model's sources have no parts. */
const ROOT = '{}';

const TOOL = 'call';

const audience = (aud: v.InferOutput<typeof AudSchema>): Audience => aud === 'anyone' ? 'anyone' : aud.map(email);

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
}

/** One trace replayed: the caretaker, and the model's numbers matched to the caretaker's as each is issued. */
class Replay {
  readonly caretaker: RoomCaretaker;
  private readonly gens = new Map<number, number>([[0, 0]]);
  private readonly caps = new Map<number, number>();
  private readonly shows = new Map<number, number>();
  private readonly runs = new Map<number, number>();

  constructor() {
    const db = new Database(':memory:');

    initSlateRoomTables(makeExecRaw(db));
    this.caretaker = new RoomCaretaker({ db: makeSqlExec(db) });
    this.caretaker.create({ workspace: 'model', slate: 'slate', title: 'Slate', owner: email(0), parent: null });
    // The model's slate runs every function at revision 0 from the start; the room's runs once it is published.
    this.caretaker.publish(email(0), { image: image(0), modules: {}, title: 'Slate', secret: null });
  }

  /** A generation the model never issued names nothing here either. */
  private gen(gen: number): number {
    return this.gens.get(gen) ?? -1 - gen;
  }

  private session(q: number, acc: v.InferOutput<typeof AccSchema>): Session {
    const access: Access = acc.kind === 'owner' ? { kind: 'owner' } : { kind: acc.kind, gen: this.gen(acc.gen) };

    return { email: email(q), access };
  }

  private run(run: number): number {
    return this.runs.get(run) ?? -1 - run;
  }

  private cap(cap: number): number {
    return this.caps.get(cap) ?? -1 - cap;
  }

  /** The caretaker's verdict on one step, and what it rendered when it was a render. */
  apply(step: Step): Seen {
    const { at, event } = step;
    const c = this.caretaker;

    switch (event.ev) {
      case 'share': return this.issuing(at, () => { c.setLink(email(event.actor), event.on); }, () => c.room().linkGen);
      case 'collaborate': return this.issuing(at, () => { c.invite(email(event.actor), email(event.q), event.role); },
        () => c.members().find((member) => member.email === email(event.q))?.gen ?? null);
      case 'remove': return this.issuing(at, () => { c.remove(email(event.actor), email(event.q)); },
        () => event.actor === 0 ? c.room().linkGen : null);
      case 'mint': return this.minting(at, event);
      case 'setCap': return { ok: through(() => { c.revoke(email(event.actor), this.cap(event.cap)); }) };
      case 'declassify': return this.declassifying(at, event);
      case 'undeclassify': return { ok: through(() => { c.unshow(email(event.actor), this.shows.get(event.decl) ?? -1); }) };
      case 'admit': return this.admitting(at, event);
      case 'toolStep': return this.stepping(event);
      case 'observe': return { ok: through(() => c.observe(this.run(event.run), cellKey(event.cell))) };
      case 'write': return { ok: through(() => { c.write(this.run(event.run), 1); }) };
      case 'post': return { ok: through(() => { c.post(this.run(event.run), cellKey(at), 1); }) };
      case 'release': {
        let flows = false;
        const ok = through(() => { flows = c.release(this.run(event.run), this.session(event.q, event.acc)); });

        return { ok: ok && flows };
      }

      case 'render': {
        let shown = false;
        const ok = through(() => { shown = c.render(cellKey(event.cell), this.session(event.q, event.acc)).shown; });

        return ok ? { ok, shown } : { ok };
      }

      case 'finish': return { ok: through(() => { c.finish(this.run(event.run)); }) };
      case 'editCode': return { ok: through(() => { c.publish(email(event.actor), { image: image(event.rev), modules: {}, title: 'Slate', secret: null }); }) };
      case 'fork': return { ok: c.mayFork(email(event.actor)) };
      case 'publish': return { ok: through(() => { c.list(email(event.actor), { line: 'A slate', category: 'fun' }, 0); }) };
      case 'readerCheck': return { ok: through(() => { c.checked(email(event.q), { holder: email(event.tag.holder), server: server(event.tag.src), root: ROOT }, event.ok); }) };
    }
  }

  /** A step that issues a generation the model numbers `at`. */
  private issuing(at: number, act: () => void, issued: () => number | null): Seen {
    const ok = through(act);
    const gen = ok ? issued() : null;

    if (gen !== null) this.gens.set(at, gen);

    return { ok };
  }

  private minting(at: number, event: Extract<Event, { ev: 'mint' }>): Seen {
    return {
      ok: through(() => {
        const grant = this.caretaker.mint(email(event.actor), {
          personal: event.personal, server: server(event.src), root: {}, tools: [TOOL], fn: fnName(event.fn),
          domain: { kind: 'enum', values: event.dom }, effect: event.effect, sink: audience(event.sink),
        });

        this.caps.set(at, grant.id);
      }),
    };
  }

  private declassifying(at: number, event: Extract<Event, { ev: 'declassify' }>): Seen {
    return {
      ok: through(() => {
        const tag = { holder: email(event.tag.holder), server: server(event.tag.src), root: ROOT };
        const shown = this.caretaker.show(email(event.actor), tag, event.scope === null ? null : fnName(event.scope.fn), audience(event.aud));

        this.shows.set(at, shown.id);
      }),
    };
  }

  private admitting(at: number, event: Extract<Event, { ev: 'admit' }>): Seen {
    return {
      ok: through(() => {
        const run = this.caretaker.admit({
          requester: event.req === null ? null : this.session(event.req.q, event.req.acc), fn: fnName(event.fn), input: event.arg,
          grants: event.caps.map((cap) => this.cap(cap)), inputs: event.inputs.map(cellKey), out: cellKey(at + 1),
        });

        this.runs.set(at, run.id);
      }),
    };
  }

  private stepping(event: Extract<Event, { ev: 'toolStep' }>): Seen {
    let verdict: ToolVerdict | undefined;
    const run = this.caretaker.run(this.run(event.run));
    const ok = through(() => { verdict = this.caretaker.toolStep(this.run(event.run), this.cap(event.cap), TOOL, run?.input ?? null); });

    return verdict === undefined ? { ok } : { ok, verdict };
  }

  /**
   * The one step the room lets through and the model refuses: a person's own data, in their own request, sent through
   * their own grant to a sink that may not see it. The request is their consent; code someone else wrote waits for them
   * to see where it sends their data first.
   */
  ownOutflow(step: Step, verdict: ToolVerdict | undefined): boolean {
    if (step.event.ev !== 'toolStep' || verdict === undefined) return false;
    const run = this.caretaker.run(this.run(step.event.run));
    const grant = this.caretaker.grant(this.cap(step.event.cap));

    if (run === null || grant === null) return false;
    const own = run.requester?.email === grant.holder && run.label.every((elem) => elem.holder === grant.holder);
    const waits = this.caretaker.room().imageAuthor === grant.holder ? verdict.kind === 'go' : verdict.kind === 'wait';

    return own && waits;
  }
}

/** Where a trace first parts from the model, or null when every step agrees. */
function divergence(steps: readonly Step[]): string | null {
  const replay = new Replay();

  for (const [index, step] of steps.entries()) {
    const seen = replay.apply(step);
    const agrees = seen.ok === step.ok && (!step.ok || step.shown === undefined || seen.shown === step.shown);

    if (!agrees && !(step.ok === false && seen.ok && replay.ownOutflow(step, seen.verdict))) {
      return `step ${String(index)} ${JSON.stringify(step.event)}: model ${JSON.stringify({ ok: step.ok, shown: step.shown })}, room ${JSON.stringify({ ok: seen.ok, shown: seen.shown })}`;
    }
  }

  return null;
}

describe('the room refines Sharing/Model.lean permits', () => {
  test('the fixture exercises every guard both ways', () => {
    const seen = new Map<string, { ok: number; refused: number }>();

    for (const { steps } of cases) {
      for (const step of steps) {
        const count = seen.get(step.event.ev) ?? { ok: 0, refused: 0 };

        if (step.ok) count.ok += 1;
        else count.refused += 1;
        seen.set(step.event.ev, count);
      }
    }

    const oneWay = [...seen].filter(([ev, count]) => ev !== 'readerCheck' && ev !== 'finish' && (count.ok === 0 || count.refused === 0));

    expect(cases.length).toBeGreaterThan(100);
    expect(oneWay).toEqual([]);
  });

  test('every trace: the room lets through what the model permits, and renders what it shows', () => {
    const parted = cases.map(({ steps }, index) => ({ index, at: divergence(steps) })).filter((trace) => trace.at !== null);

    expect(parted.slice(0, 5)).toEqual([]);
  });
});
