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
   * The shipped defect: `ActorAgent.onFiberRecovered` as the audit found it, awaiting a lane's re-drive (model calls,
   * a job wake that resolves when its turn ENDS, SMTP) inside `blockConcurrencyWhile`. Its fix classified
   * synchronously; the hook itself is now gone, because the SDK bounds it with a timeout, which is no bound.
   */
  test('overriding a hook the SDK awaits in the gate is refused, however little it does', () => {
    for (const hook of ['onFiberRecovered', '_handleInternalFiberRecovery']) {
      const found = reasons(`export class ActorAgent extends Think {
        override ${hook}(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
          return Promise.resolve({ status: 'completed', snapshot: null });
        }
      }`);

      expect(found).toEqual([expect.stringContaining('Kinu owns no SDK fiber lane')]);
    }
  });
});

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
    expect(found[0]).toContain('owed work is started, never awaited');
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
});

describe('DO init-gate purity, against the real tree', () => {
  const SOURCES = readSources();

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


  test('cut the wire: restoring a fiber recovery hook on the real ActorAgent goes red', () => {
    const file = 'packages/cf-backend/src/actor-agent.ts';
    const real = present(SOURCES.get(file), `the ${file} source`);

    const restored = real.replace(
      'export abstract class ActorAgent extends Agent<Env> {',
      `export abstract class ActorAgent extends Agent<Env> {
  override onFiberRecovered(_ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
    return Promise.resolve({ status: 'completed', snapshot: null });
  }`,
    );

    expect(restored).not.toBe(real);
    const { violations } = auditFile(file, restored);
    expect(violations.map((v) => `${v.owner}.${v.member}`)).toEqual(['ActorAgent.onFiberRecovered']);
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
    const anchor = '    this.devices._inflight.releaseAbandonedClaims();\n';
    expect(real).toContain(anchor);
    const planted = real.replace(anchor, `${anchor}    for (const row of this.ctx.storage.sql.exec('SELECT id FROM user_devices')) this.ctx.storage.sql.exec('DELETE FROM user_devices WHERE id = ?', row.id);\n`);
    const found = auditConstructors(new Map([...SOURCES, [file, planted]]), ['UserDO']).violations;
    expect(found.map((v) => `${v.owner}.${v.member}`)).toEqual(['UserDO.initTables']);
  });
});
