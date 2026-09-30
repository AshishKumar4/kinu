import { describe, expect, test } from 'bun:test';

import { present } from '@kinu.run/test-utils';

import { readSources } from './sources';
import { audit, auditConstructors, auditFile, MODEL_SINKS } from './do-init-gate';

/**
 * The fixture is not invented. This is `SubordinateAgent.onStart` exactly as it
 * stood before `RpcTimeout`'s fix, recovered from the diff:
 *
 *   async onStart(): Promise<void> {
 *     this.ensureSchema();
 *     if (this.identity.read()) {
 *       if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
 *     }
 *   }
 *
 * `this.rt.identity.scaffold.exists()` reaches `env.NIMBUS_SESSION` — a second
 * Durable Object — through four hops of injected values. This is the shipped
 * defect, at full size, in its own words.
 */
const SHIPPED = `
export class SubordinateAgent extends ActorAgent {
  async onStart(): Promise<void> {
    this.ensureSchema();
    if (this.identity.read()) {
      if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
    }
  }
}
`;

/** The landed fix. */
const FIXED = `
export class SubordinateAgent extends ActorAgent {
  onStart(): void {
    this.ensureSchema();
  }
}
`;

const reasons = (src: string): string[] =>
  auditFile('subordinate-agent.ts', src).violations.map((v) => v.reason);

describe('DO init-gate purity', () => {
  test('the shipped defect is reported: both scaffold awaits fail by name', () => {
    // Under the admitted-await rule the refusal is SHARPER than the old
    // three-ground report: each await that is not the pinned workspace boot is
    // named individually, so the fix is legible from the finding alone.
    const found = reasons(SHIPPED);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('not on the admitted init-await list');
    expect(found[0]).toContain('scaffold.exists');
    expect(found[1]).toContain('bootstrapScaffold');
  });
  test('the landed fix is clean', () => {
    expect(reasons(FIXED)).toEqual([]);
  });

  // ── Each escape route from the invariant, closed ──────────────────────

  test('a missing return annotation is a violation even with no await today', () => {
    // `onStart() {}` infers `void` now and `Promise<void>` the instant someone
    // adds `async`. The base accepts `void | Promise<void>`, so tsc never
    // objects and the widening is invisible in a diff. The explicit annotation
    // is the thing `orchestrator.ts:1522` calls "the enforcement".
    expect(reasons('export class A extends Agent { onStart() { this.ensureSchema(); } }'))
      .toEqual([expect.stringContaining('must annotate `: void`')]);
  });

  test('`: Promise<void>` without `async` is still a violation', () => {
    expect(reasons('export class A extends Agent { onStart(): Promise<void> { return this.init(); } }'))
      .toEqual([expect.stringContaining('must annotate `: void`')]);
  });

  test('a nested blockConcurrencyWhile is the same gate by another name', () => {
    const sneaky = `export class A extends Agent {
      onStart(): void {
        this.ctx.blockConcurrencyWhile(async () => { await this.rt.identity.scaffold.exists(); });
      }
    }`;

    expect(reasons(sneaky)).toEqual([expect.stringContaining('nested `blockConcurrencyWhile`')]);
  });

  test('a detached async task is NOT a violation — it is the prescribed fix', () => {
    // The fix for recovery work that must reach the model is to detach it. An
    // await inside a nested async function has its own scope and cannot extend
    // the gate, so flagging it would flag the remedy.
    const detached = `export class A extends Agent {
      onStart(): void {
        this.ensureSchema();
        void (async () => { await reconcileInterruptedForks(this.rt); })();
      }
    }`;

    expect(reasons(detached)).toEqual([]);
  });

  test('a method that is not onStart is out of scope', () => {
    expect(reasons('export class A extends Agent { async beforeTurn(): Promise<void> { await this.x(); } }'))
      .toEqual([]);
  });
});


describe('DO init-gate purity — the SDK-awaited recovery hook', () => {
  /**
   * The shipped defect, recovered from the diff and not invented. This is
   * `ActorAgent.onFiberRecovered` exactly as the audit found it:
   *
   *   override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
   *     return recoverLaneFiber(this.fiberLanes, ctx);
   *   }
   *
   * Nothing about it looks expensive. `recoverLaneFiber` was `async` and its arms
   * awaited `reviewAdvisorSnapshot` (a model call), `runDueSessionEvolution`
   * (model calls and tool loops), a settled job's wake (which resolves when the
   * turn it queues ENDS) and `replayOwedTerminalSequences` (SMTP round trips and
   * waits on another agent's live head) — all inside `blockConcurrencyWhile`.
   */
  const SHIPPED_RECOVERY = `export class ActorAgent extends Think {
    override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
      return recoverLaneFiber(this.fiberLanes, ctx);
    }
  }`;

  const LANDED = `export class ActorAgent extends Think {
    override onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
      return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx));
    }
  }`;

  test('the shipped defect is reported, on both of its independent grounds', () => {
    const found = reasons(SHIPPED_RECOVERY);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('async');
    // The one that matters, and the one no `await` check could reach: the awaits
    // were a module away, in the roster this hook handed the gate.
    expect(found[1]).toContain('must hand its work to `classifyRecoveredFiber`');
  });

  test('a hook that awaits the model call itself is reported too', () => {
    const inGateLlm = `export class ActorAgent extends Think {
      override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
        const disposition = await this.runAdvisorReview(advisorSnapshotOf(ctx));
        return { status: 'completed', snapshot: { disposition } };
      }
    }`;

    expect(reasons(inGateLlm)).toEqual([
      expect.stringContaining('async'),
      expect.stringContaining('awaits in its own scope'),
    ]);
  });

  test('the landed shape is clean', () => {
    expect(reasons(LANDED)).toEqual([]);
  });

  /**
   * The escape the `async`/`await` checks cannot see, and the reason this
   * population needs a hand-off rule at all: a method that is neither `async`
   * nor contains an `await` can still hand the gate a promise that resolves when
   * a model call, an SMTP round trip or a whole queued turn finishes. The SDK
   * awaits exactly that.
   */
  test('returning the unbounded promise is a violation even with no async and no await', () => {
    const handedOff = `export class ActorAgent extends Think {
      override onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
        return this.terminal.replayOwedAndRearm();
      }
    }`;

    expect(reasons(handedOff))
      .toEqual([expect.stringContaining('must hand its work to `classifyRecoveredFiber`')]);
  });

  test('a decision resolved inline is clean — there is nothing to await', () => {
    // The warn-and-release shape a non-actor DO legitimately has. It reaches no
    // lane, so requiring the roster here would be a rule about style.
    const inline = `export class MonitorDO extends Agent {
      override onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
        return Promise.resolve({ status: 'error', error: 'no lane owns ' + ctx.name });
      }
    }`;

    expect(reasons(inline)).toEqual([]);
  });

  test('a missing return annotation is a violation — a `void` result strands a managed row', () => {
    const unannotated = `export class ActorAgent extends Think {
      override onFiberRecovered(ctx) { return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx)); }
    }`;

    expect(reasons(unannotated))
      .toEqual([expect.stringContaining('must annotate what its promise resolves to')]);
  });

  test('every name the vendored init chain awaits is held to the same rule', () => {
    const internal = `export class ActorAgent extends Agent {
      override async _handleInternalFiberRecovery(ctx: FiberRecoveryContext): Promise<boolean> {
        await this.replayChatTurn(ctx);
        return true;
      }
    }`;

    const found = auditFile('actor-agent.ts', internal);
    expect(found.inspected.map((i) => `${i.member}:${i.hook}`)).toEqual([
      '_handleInternalFiberRecovery:recovery',
    ]);
    expect(found.violations.filter((v) => v.reason.includes('async'))).toHaveLength(1);
  });

  test('the classifier itself may not be async — that is the replacement bound', () => {
    // The other half of the rule. With an async classifier the hook shape above
    // is unchanged and the gate would still be reporting on it, while the promise
    // it hands back is once again the work.
    const seam = `export async function classifyRecoveredFiber(
      transports: FiberLaneTransports, ctx: FiberRecoveryContext,
    ): Promise<FiberRecoveryResult> {
      await transports.reviewAdvisorSnapshot(snapshot);
      return { status: 'completed' };
    }`;

    const found = auditFile('fiber-recovery.ts', seam);
    expect(found.classifier).toMatchObject({ file: 'fiber-recovery.ts', async: true });
    expect(found.violations).toEqual([expect.objectContaining({
      member: 'classifyRecoveredFiber',
      reason: expect.stringContaining('declared `async`'),
    })]);
  });

  test('a synchronous classifier is what the rule is satisfied by', () => {
    const seam = `export function classifyRecoveredFiber(
      transports: FiberLaneTransports, ctx: FiberRecoveryContext,
    ): FiberRecoveryResult {
      transports.redrive(ctx.name, ctx.snapshot, () => transports.runDueSessionEvolution());
      return { status: 'completed' };
    }`;

    const found = auditFile('fiber-recovery.ts', seam);
    expect(found.classifier).toMatchObject({ async: false });
    expect(found.violations).toEqual([]);
  });
});

// ── The class of work, not the shape of the wait ─────────────────────────────
//
// The three rules above all ask what the GATE WAITS ON. `OrchestratorAgent.onStart`
// satisfied every one of them — not async, annotated `: void`, no own-scope await,
// no nested gate — while spawning a fire-and-forget task whose chain ran
// `hydrateTitle` → `readSoul` → `applyAutoTitle` → `suggestTitle` → `generateText`.
// An LLM call on the init path of every cold start of every claimed workspace,
// against an activation whose gate is still open, cancelled on eviction with its
// rejection swallowed. Detaching work takes it out of the wait, not off the path.
describe('DO init-gate purity — model work spawned from the init gate', () => {
  /**
   * The shipped defect, recovered from the diff and not invented. This is the
   * last block of `OrchestratorAgent.onStart` as it stood, before the work
   * moved to the workspace-open `@callable` (`getWorkspaceSnapshot`), with one
   * rename: the `maybeAutoTitle` wrapper it called is gone, so it calls the
   * `applyAutoTitle` that wrapper ran.
   */
  const SPAWNED = `export class OrchestratorAgent extends ActorAgent {
    onStart(): void {
      this.ensureSchema();
      if (this.getOwnerUserId()) {
        const autoTitleTask: AsyncTaskOwner = { promise: null };
        this._backgroundTasks.add(autoTitleTask);
        autoTitleTask.promise = (async () => {
          try {
            await this.hydrateTitle();
            if (!isPlaceholderWorkspaceTitle(this.getDisplayName(), this.name)) return;
            const soul = await readSoul(this.rt.storage.vfs);
            await this.applyAutoTitle(summarizeSoul(soul ?? ''));
          } finally {
            this._backgroundTasks.delete(autoTitleTask);
          }
        })();
      }
    }
  }`;

  test('the shipped defect is reported — and only the reach rule can see it', () => {
    const found = reasons(SPAWNED);
    // ONE finding, from the one rule that descends into what the hook spawns.
    // Every wait-shaped check passes on this method, which is why it shipped.
    expect(found).toEqual([expect.stringContaining('reaches `applyAutoTitle`')]);
    expect(found[0]).toContain('Detaching it does not move it off that path');
    expect(found.some((reason) => reason.includes('async')
      || reason.includes('awaits in its own scope')
      || reason.includes('nested `blockConcurrencyWhile`')
      || reason.includes('must annotate'))).toBe(false);
  });

  test('every pinned sink refuses, in both call shapes the tree uses', () => {
    // No name on the list is decoration. Both shapes, because both exist: a lane
    // reached on `this`, and a provider entry point called as a free function.
    expect(MODEL_SINKS.length).toBeGreaterThan(0);

    for (const sink of MODEL_SINKS) {
      for (const call of [`this.${sink}(input)`, `${sink}(input)`]) {
        const spawned = `export class A extends Agent {
          onStart(): void {
            void (async () => { await ${call}; })();
          }
        }`;

        expect(reasons(spawned)).toEqual([expect.stringContaining(`reaches \`${sink}\``)]);
      }
    }
  });

  test('a sink called straight from the hook is refused too', () => {
    // The spawn is what made the defect invisible, not what made it wrong.
    const direct = `export class A extends Agent {
      onStart(): void { void this.applyAutoTitle(this.ownMission()); }
    }`;

    expect(reasons(direct)).toEqual([expect.stringContaining('reaches `applyAutoTitle`')]);
  });

  test('the fork-journal reconcile spawn stays legal — bounded SQL is not model work', () => {
    // The shape three lines above the defect in the same method, and the reason
    // this rule is a name list rather than "detached work is banned": the
    // reconcile marks stale heads `interrupted` and offers their roots to the job
    // sweep. Indexed writes, no provider, and it MUST be allowed to stay.
    const bounded = `export class OrchestratorAgent extends ActorAgent {
      onStart(): void {
        this.ensureSchema();
        const forkJournalReconcileTask: AsyncTaskOwner = { promise: null };
        this._backgroundTasks.add(forkJournalReconcileTask);
        forkJournalReconcileTask.promise = (async () => {
          try {
            await reconcileInterruptedForks({
              journal: this.headJournal,
              inbox: this.orch.inbox,
              resume: jobRedriveResumeGate({ recoverOrphans: () => this.jobRunner.recoverOrphans() }),
            });
            await this.reclaimSettledExplorationFacets();
          } finally {
            this._backgroundTasks.delete(forkJournalReconcileTask);
          }
        })();
      }
    }`;

    expect(reasons(bounded)).toEqual([]);
  });


  test('a recovery hook is exempt — the re-drive it detaches may reach the model', () => {
    // Deliberate, and printed on the success path rather than left to be
    // discovered: this population's sanctioned answer is to hand each re-drive
    // to a detached durable carrier, and a re-drive is allowed to reach a model.
    // Holding it to the sink list would refuse the prescribed fix.
    const recovery = `export class ActorAgent extends Think {
      override onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
        this.redriveRecoveredLane(ctx.name, ctx.snapshot, () => this.runDueSessionEvolution());
        return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx));
      }
    }`;

    expect(reasons(recovery)).toEqual([]);
  });
});

describe('DO init-gate purity, against the real tree', () => {
  const SOURCES = readSources();


  test('it found the classification seam, and that seam is synchronous', () => {
    // The recovery rule's other half, over the real tree: pinned to a name
    // nothing declared, the hand-off check would pass for every hook — which
    // reads exactly like every hook obeying it.
    expect(audit(SOURCES).classifier).toEqual({
      file: 'packages/cf-backend/src/fiber-recovery.ts',
      line: expect.any(Number),
      async: false,
    });
  });

  test('the real tree passes', () => {
    expect(audit(SOURCES).violations).toEqual([]);
  });

  test('an adopted returned promise cannot slip the admitted-async gate', () => {
    // `async onStart(): Promise<void> { return this.slowThing(); }` carries
    // ZERO AwaitExpression — the async function ADOPTS the returned promise
    // and the SDK awaits it all the same. The gate rejects any value-carrying
    // return in an admitted-async gate by spelling.
    const found = reasons(`
export class A extends Agent {
  async onStart(): Promise<void> {
    this.ensureSchema();
    return this.unboundedRemoteThing();
  }
}
`);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('return this.unboundedRemoteThing()');
    expect(found[0]).toContain('not on the admitted init-await list');
  });

  // Each body below is a legal `async onStart` under every spelling check, and
  // each holds the gate anyway — one hold per entry, named by the refusal it owes.
  const UNSEEN_HOLDS = [
    {
      name: 'an admitted await inside a LOOP is not one admitted await',
      // The admission is "bounded work owed once at the start of the object's
      // life". A loop spells the admitted text exactly and holds the gate N
      // times, so the spelling check alone would license unbounded work.
      body: `    for (const _ of this.pending()) {
      await this.hostedWorkspace().bundle.session();
    }`,
      reason: 'inside a loop',
    },
    {
      name: '`for await` holds the gate with no AwaitExpression to find',
      // `for await (… of …)` is a ForOfStatement carrying `await: true`: it awaits
      // once per iteration and contains no AwaitExpression node at all, so an
      // await scan reads the body as await-free. Same family as the adopted
      // return — a gate hold the spelling rule cannot see.
      body: `    await this.hostedWorkspace().bundle.session();
    for await (const row of this.remoteRows()) { void row; }`,
      reason: 'for await',
    },
    {
      name: '`await using` holds the gate with no AwaitExpression either',
      // The other node that carries its await in a `kind` rather than an
      // expression: `await using res = …` awaits the disposal protocol.
      body: `    await this.hostedWorkspace().bundle.session();
    await using lease = this.remoteLease();`,
      reason: 'await using lease',
    },
    {
      name: '`async` with nothing admitted to hold is refused outright',
      // The shape that satisfies every other rule: no await, no return, and a
      // detached `.then` chain doing the work — `async` paid for, the synchronous
      // population's rules (`: void`, no own-scope await) opted out of, and
      // nothing admitted held.
      body: '    void this.hostedWorkspace().bundle.session().then(() => { this.ready = true; });',
      reason: 'holding no admitted init await',
    },
  ] as const;

  for (const hold of UNSEEN_HOLDS) {
    test(hold.name, () => {
      const found = reasons(`
export class A extends Agent {
  async onStart(): Promise<void> {
${hold.body}
  }
}
`);

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(hold.reason);
    });
  }

  test('cut the wire: an UNADMITTED await in the real async gate goes red', () => {
    // Against the real file, not a fixture — one await added in memory. The
    // gate is legitimately async now (the admitted workspace boot), so the
    // wire to cut is an await that is NOT on the pinned list.
    const file = 'packages/cf-backend/src/orchestrator.ts';
    const real = present(SOURCES.get(file), `the ${file} source`);

    const widened = real.replace(
      '    await this.hostedWorkspace().bundle.session();',
      '    await this.hostedWorkspace().bundle.session();\n    await this.runDueSessionEvolution();',
    );

    expect(widened).not.toBe(real);
    const { violations } = auditFile(file, widened);
    expect(violations.map((v) => v.owner)).toContain('OrchestratorAgent');
    expect(violations[0].reason).toContain('not on the admitted init-await list');
  });


  test('cut the wire: re-inlining the real terminal replay in the recovery hook goes red', () => {
    // The P1 defect, restored against the real file: the hook hands the gate the
    // replay's own promise instead of the classification. It is not `async` and
    // contains no `await`, so only the hand-off rule can see it.
    const file = 'packages/cf-backend/src/actor-agent.ts';
    const real = present(SOURCES.get(file), `the ${file} source`);

    const inlined = real.replace(
      'return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx));',
      'return this.terminal.replayOwedAndRearm();',
    );

    expect(inlined).not.toBe(real);
    const { violations } = auditFile(file, inlined);
    expect(violations.map((v) => `${v.owner}.${v.member}`)).toEqual(['ActorAgent.onFiberRecovered']);
    expect(violations[0].reason).toContain('must hand its work to `classifyRecoveredFiber`');
  });

  test('cut the wire: making the real classifier async goes red', () => {
    const file = 'packages/cf-backend/src/fiber-recovery.ts';
    const real = present(SOURCES.get(file), `the ${file} source`);

    const widened = real.replace(
      'export function classifyRecoveredFiber(', 'export async function classifyRecoveredFiber(',
    );

    expect(widened).not.toBe(real);
    const { violations, classifier } = auditFile(file, widened);
    expect(classifier).toMatchObject({ async: true });
    expect(violations.map((v) => v.reason)).toEqual([expect.stringContaining('declared `async`')]);
  });

  test('cut the wire: re-spawning the auto-title task from the real onStart goes red', () => {
    // The defect this rule exists for, restored against the real file. The block
    // was deleted from `onStart` and its work now runs from the workspace-open
    // @callable; put it back and the gate must refuse it — while the wake arm
    // detached immediately above it stays legal, which is the discrimination
    // the whole rule rests on.
    const file = 'packages/cf-backend/src/orchestrator.ts';
    const real = present(SOURCES.get(file), `the ${file} source`);

    const opening = '  async onStart(): Promise<void> {\n';
    expect(real).toContain(opening);

    const respawned = real.replace(opening, `${opening}    if (this.getOwnerUserId()) {
      this.detachOwned(async () => {
        await this.hydrateTitle();
        const soul = await readSoul(this.rt.storage.vfs);
        await this.applyAutoTitle(summarizeSoul(soul ?? ''));
      });
    }
`);

    expect(respawned).not.toBe(real);
    const { violations } = auditFile(file, respawned);
    expect(violations.map((v) => `${v.owner}.${v.member}`)).toEqual(['OrchestratorAgent.onStart']);
    expect(violations[0].reason).toContain('reaches `applyAutoTitle`');
  });
});

describe('a Durable Object constructor is held to the synchronous start rule', () => {
  const SOURCES = readSources();

  const ctorViolations = (src: string, declared: readonly string[] = ['Box']): string[] =>
    auditConstructors(new Map([['box.ts', src]]), declared).violations.map((v) => `${v.member}: ${v.reason}`);

  const CLEAN = `export class Box extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.initTables();
      this.releaseAbandoned();
      this.onMessage = async (message) => { await this.handle(message); };
    }
    initTables() { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS t (id TEXT)'); }
    releaseAbandoned() { this.ctx.storage.sql.exec('UPDATE t SET claim = NULL WHERE claim IS NOT NULL'); }
    async handle(message) { await fetch(message); }
  }`;

  test('DDL, one bounded statement and a closure defined for later pass', () => {
    expect(ctorViolations(CLEAN)).toEqual([]);
  });

  test.each([
    ['an async same-class method (a planted await)', 'this.initTables();', 'this.initTables(); this.warm();\n    }\n    async warm() { await this.ctx.storage.sql.exec(\'SELECT 1\');', 'which is async'],
    ['a loop over rows read into a variable', 'releaseAbandoned() {', "releaseAbandoned() { const rows = this.ctx.storage.sql.exec('SELECT id FROM t').toArray(); for (const row of rows) this.ctx.storage.sql.exec('DELETE FROM t WHERE id = ?', row.id);", 'loops over table rows'],
    ['a loop over a read inline', 'initTables() {', "initTables() { for (const row of this.sql`SELECT id FROM t`) this.drop(row);", 'loops over table rows'],
    ['a binding call', 'this.initTables();', 'this.initTables(); this.env.UserDO.get(id);', 'calls a binding'],
    ['a schedule', 'this.initTables();', "this.initTables(); this.schedule(60, 'tick');", 'calls `schedule`'],
    ['a nested gate', 'this.initTables();', 'this.initTables(); this.ctx.blockConcurrencyWhile(() => this.handle(1));', 'calls `blockConcurrencyWhile`'],
  ])('refused: %s', (_name, from, to, reason) => {
    const planted = CLEAN.replace(from, to);
    expect(planted).not.toBe(CLEAN);
    expect(ctorViolations(planted).some((found) => found.includes(reason))).toBe(true);
  });

  test('an ancestor of a declared class is governed through it; an undeclared class is not', () => {
    const inherited = `export class Base extends DurableObject { constructor(ctx, env) { super(ctx, env); this.schedule(1, 'x'); } }
      export class Box extends Base { constructor(ctx, env) { super(ctx, env); } }`;

    expect(ctorViolations(inherited)).toEqual([expect.stringContaining('calls `schedule`')]);
    expect(ctorViolations(inherited, ['Other'])).toEqual([]);
  });


  test('cut the wire: a row loop planted in the real UserDO constructor path goes red', () => {
    const file = 'packages/cf-backend/src/user/user-do.ts';
    const real = present(SOURCES.get(file), `the ${file} source`);
    const anchor = '    this._inflight.releaseAbandonedClaims();\n';
    expect(real).toContain(anchor);
    const planted = real.replace(anchor, `${anchor}    for (const row of this.ctx.storage.sql.exec('SELECT id FROM user_devices')) this.ctx.storage.sql.exec('DELETE FROM user_devices WHERE id = ?', row.id);\n`);
    const found = auditConstructors(new Map([...SOURCES, [file, planted]]), ['UserDO']).violations;
    expect(found.map((v) => `${v.owner}.${v.member}`)).toEqual(['UserDO.initTables']);
  });
});
