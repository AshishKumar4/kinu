import { describe, expect, test } from 'bun:test';

import { readSources } from './sources';
import { audit, auditFile, MODEL_SINKS } from './do-init-gate';

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

// ── The container-start hook: the same name, the opposite requirement ────────
//
// `@cloudflare/containers`' Container.onStart is awaited inside
// blockConcurrencyWhile too, but only on the container start path — never on DO
// construction and never per request. There, returning the promise is what gives
// the restore its ordering guarantee, and detaching it loses the work outright.
// So the rule inverts, and the protection is replaced rather than removed: the
// method still cannot await (it is not async), and what it returns must be
// bounded.
describe('DO init-gate purity — container-start hook', () => {
  const CORRECT = `export class KinuSandbox extends Sandbox<Env> {
    onStart(): Promise<void> {
      return withContainerStartDeadline('x', 25_000, () => this.start(), () => {});
    }
  }`;

  test('the correct shape is clean', () => {
    expect(reasons(CORRECT)).toEqual([]);
  });

  test('`: void` is the violation here — it detaches the work the gate must hold', () => {
    const detached = `export class KinuSandbox extends Sandbox<Env> {
      onStart(): void {
        void withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(detached))
      .toEqual([expect.stringContaining('must annotate `: Promise<void>`')]);
  });

  test('unbounded work is a violation even with the right annotation', () => {
    const unbounded = `export class KinuSandbox extends Sandbox<Env> {
      onStart(): Promise<void> {
        return this.restoreWorkspace();
      }
    }`;
    expect(reasons(unbounded))
      .toEqual([expect.stringContaining('must route its work through `withContainerStartDeadline`')]);
  });

  test('`async` is still a violation — it is how an unbounded await gets in', () => {
    const widened = `export class KinuSandbox extends Sandbox<Env> {
      async onStart(): Promise<void> {
        await withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(widened)).toEqual([
      expect.stringContaining('declared `async`'),
      expect.stringContaining('awaits in its own scope'),
    ]);
  });

  test('the narrowing is keyed on the base class, not on the file or the name', () => {
    // Same method body, a different `extends`: held to the per-request rule.
    const impostor = `export class KinuSandbox extends ActorAgent {
      onStart(): Promise<void> {
        return withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(impostor))
      .toEqual([expect.stringContaining('must annotate `: void`')]);
  });

  test('the plainly-bounded marker is the one alternative to the wrapper', () => {
    // Storage-only work the hook returns needs no deadline: the timer cannot
    // fire inside the gate, so the wrapper would claim a bound that does not
    // exist. The marker says so visibly, and the gate accepts it.
    const marked = `export class KinuSandbox extends Sandbox<Env> {
      onStart(): Promise<void> {
        void BOUNDED_STORAGE_ONLY;
        return this.armSchedules();
      }
    }`;
    expect(reasons(marked)).toEqual([]);
  });

  test('the marker forbids the wrapper it replaces, and off-object work is still unbounded', () => {
    const both = `export class KinuSandbox extends Sandbox<Env> {
      onStart(): Promise<void> {
        void BOUNDED_STORAGE_ONLY;
        return withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(both))
      .toEqual([expect.stringContaining('yet routes through `withContainerStartDeadline`')]);
  });

  test('the Sandbox lineage holds indirect subclasses to the container rule', () => {
    const sources = new Map([
      ['devbox.ts', 'export class Devbox extends Sandbox {}'],
      ['kinu-sandbox.ts', `export class KinuSandbox extends Devbox {
        onStart(): Promise<void> { return this.restoreWorkspace(); }
      }`],
    ]);
    const result = audit(sources);
    expect(result.inspected).toEqual([
      {
        file: 'kinu-sandbox.ts', owner: 'KinuSandbox', member: 'onStart',
        hook: 'container-start',
      },
    ]);
    expect(result.violations[0]?.reason)
      .toContain('must route its work through `withContainerStartDeadline`');
  });
});

// ── The hook that is not `onStart` ───────────────────────────────────────────
//
// `startAgent` awaits `_checkRunFibers` before it calls `onStart`, and that scan
// awaits the subclass's `onFiberRecovered` per interrupted row with no timeout.
// So the recovery hook holds the same gate — and this gate, which read `onStart`
// bodies only, printed `ok` over a hook that awaited an advisor model call, a
// session-evolution pass, a settled job's turn-awaiting wake and a terminal
// replay of SMTP round trips.
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
  const SHIPPED = `export class ActorAgent extends Think {
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
    const found = reasons(SHIPPED);
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
    const inline = `export class ExplorationAgent extends Agent {
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
    // `_handleInternalFiberRecovery` is the framework's own half of the same
    // hook, and `onChatRecovery` is invoked from it while the gate is held. No
    // Kinu class overrides either today, which is exactly why the names are
    // pinned: the first one that does must not arrive ungoverned.
    const internal = `export class ActorAgent extends Think {
      override async _handleInternalFiberRecovery(ctx: FiberRecoveryContext): Promise<boolean> {
        await this.replayChatTurn(ctx);
        return true;
      }
      override async onChatRecovery(ctx: ChatRecoveryContext): Promise<void> {
        await this.resumeStream(ctx);
      }
    }`;
    const found = auditFile('actor-agent.ts', internal);
    expect(found.inspected.map((i) => `${i.member}:${i.hook}`)).toEqual([
      '_handleInternalFiberRecovery:recovery', 'onChatRecovery:recovery',
    ]);
    expect(found.violations.filter((v) => v.reason.includes('async'))).toHaveLength(2);
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
// `hydrateTitle` → `readSoul` → `maybeAutoTitle` → `suggestTitle` → `generateText`.
// An LLM call on the init path of every cold start of every claimed workspace,
// against an activation whose gate is still open, cancelled on eviction with its
// rejection swallowed. Detaching work takes it out of the wait, not off the path.
describe('DO init-gate purity — model work spawned from the init gate', () => {
  /**
   * The shipped defect, recovered from the diff and not invented. This is the
   * last block of `OrchestratorAgent.onStart` exactly as it stood, before the
   * work moved to the workspace-open `@callable` (`getWorkspaceSnapshot`).
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
            await this.maybeAutoTitle(summarizeSoul(soul ?? ''));
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
    expect(found).toEqual([expect.stringContaining('reaches `maybeAutoTitle`')]);
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
              signals: this.orch.signals,
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

  test('the container-start hook is held to the same reach rule', () => {
    // Same name, opposite wait requirement — and the same answer about REACH: a
    // container start is not a licence to open a provider connection either.
    const container = `export class Devbox extends Sandbox {
      override onStart(): Promise<void> {
        void BOUNDED_STORAGE_ONLY;
        void (async () => { await streamText(this.describeBoot()); })();
        return this.armContainerSchedules();
      }
    }`;
    expect(reasons(container)).toEqual([expect.stringContaining('reaches `streamText`')]);
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

  test('it inspects every governed hook the backend declares, in all three populations', () => {
    // The denominator. `violations: []` is only good news over a non-empty
    // `inspected`; a matcher that stopped matching would pass forever. And the
    // split matters as much as the total: the two narrow rules are the ones an
    // exemption would hide behind, so an empty container-start or recovery
    // population would mean a narrowing had quietly become an exemption over
    // nothing.
    const { inspected } = audit(SOURCES);
    expect(inspected.map((i) => `${i.owner}.${i.member}:${i.hook}`).sort()).toEqual([
      'ActorAgent.onFiberRecovered:recovery',
      'Devbox.onStart:container-start',
      'ExplorationAgent.onStart:per-request',
      'OrchestratorAgent.onStart:per-request',
      'SubordinateAgent.onStart:per-request',
    ]);
  });

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

  test('an admitted await inside a LOOP is not one admitted await', () => {
    // The admission is "bounded work owed once at the start of the object's
    // life". A loop spells the admitted text exactly and holds the gate N
    // times, so the spelling check alone would license unbounded work.
    const found = reasons(`
export class A extends Agent {
  async onStart(): Promise<void> {
    for (const _ of this.pending()) {
      await this.hostedWorkspace().bundle.session();
    }
  }
}
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('inside a loop');
  });

  test('`for await` holds the gate with no AwaitExpression to find', () => {
    // `for await (… of …)` is a ForOfStatement carrying `await: true`: it awaits
    // once per iteration and contains no AwaitExpression node at all, so an
    // await scan reads the body as await-free. Same family as the adopted
    // return — a gate hold the spelling rule cannot see.
    const found = reasons(`
export class A extends Agent {
  async onStart(): Promise<void> {
    await this.hostedWorkspace().bundle.session();
    for await (const row of this.remoteRows()) { void row; }
  }
}
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('for await');
  });

  test('`await using` holds the gate with no AwaitExpression either', () => {
    // The other node that carries its await in a `kind` rather than an
    // expression: `await using res = …` awaits the disposal protocol.
    const found = reasons(`
export class A extends Agent {
  async onStart(): Promise<void> {
    await this.hostedWorkspace().bundle.session();
    await using lease = this.remoteLease();
  }
}
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('await using lease');
  });

  test('`async` with nothing admitted to hold is refused outright', () => {
    // The shape that satisfies every other rule: no await, no return, and a
    // detached `.then` chain doing the work — `async` paid for, the synchronous
    // population's rules (`: void`, no own-scope await) opted out of, and
    // nothing admitted held.
    const found = reasons(`
export class A extends Agent {
  async onStart(): Promise<void> {
    void this.hostedWorkspace().bundle.session().then(() => { this.ready = true; });
  }
}
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('holding no admitted init await');
  });

  test('cut the wire: an UNADMITTED await in the real async gate goes red', () => {
    // Against the real file, not a fixture — one await added in memory. The
    // gate is legitimately async now (the admitted workspace boot), so the
    // wire to cut is an await that is NOT on the pinned list.
    const file = 'packages/cf-backend/src/orchestrator.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const widened = real!.replace(
      '      await this.hostedWorkspace().bundle.session();',
      '      await this.hostedWorkspace().bundle.session();\n      await this.runDueSessionEvolution();',
    );
    expect(widened).not.toBe(real);
    const { violations } = auditFile(file, widened);
    expect(violations.map((v) => v.owner)).toContain('OrchestratorAgent');
    expect(violations[0]!.reason).toContain('not on the admitted init-await list');
  });

  test('cut the wire: unbounding the real container hook goes red', () => {
    // The per-start arming is plainly bounded storage work, so the hook carries
    // the marker instead of a wrapper. Strip the marker against the real file
    // and the gate must demand one of the two bounds.
    const file = 'packages/devbox/src/devbox.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const unmarked = real!.replace('    void BOUNDED_STORAGE_ONLY;\n', '');
    expect(unmarked).not.toBe(real);
    const { violations } = auditFile(file, unmarked);
    expect(violations.map((v) => v.owner)).toEqual(['Devbox']);
    expect(violations[0]!.reason).toContain('must route its work through');
  });

  test('cut the wire: wrapping the real container hook goes red from the marker side', () => {
    // The marker is not a licence to skip the wrapper — it is the REASON the
    // wrapper is wrong. A wrapper around work the marker vouches for claims a
    // bound whose timer cannot fire inside the gate, which is the paper bound
    // this gate exists to prevent, and the gate says so.
    const file = 'packages/devbox/src/devbox.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const wrapped = real!.replace(
      '    return this.#armContainerSchedules();',
      '    return withContainerStartDeadline(\'x\', 1, () => this.#armContainerSchedules(), () => {});',
    );
    expect(wrapped).not.toBe(real);
    const { violations } = auditFile(file, wrapped);
    expect(violations.map((v) => v.owner)).toEqual(['Devbox']);
    expect(violations[0]!.reason).toContain('yet routes through');
  });

  test('cut the wire: detaching the real container hook goes red', () => {
    const file = 'packages/devbox/src/devbox.ts';
    const real = SOURCES.get(file);
    const detached = real!.replace('onStart(): Promise<void> {', 'onStart(): void {');
    expect(detached).not.toBe(real);
    const { violations } = auditFile(file, detached);
    expect(violations.map((v) => v.reason))
      .toEqual([expect.stringContaining('must annotate `: Promise<void>`')]);
  });

  test('cut the wire: re-inlining the real terminal replay in the recovery hook goes red', () => {
    // The P1 defect, restored against the real file: the hook hands the gate the
    // replay's own promise instead of the classification. It is not `async` and
    // contains no `await`, so only the hand-off rule can see it.
    const file = 'packages/cf-backend/src/actor-agent.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const inlined = real!.replace(
      'return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx));',
      'return this.terminal.replayOwedAndRearm();',
    );
    expect(inlined).not.toBe(real);
    const { violations } = auditFile(file, inlined);
    expect(violations.map((v) => `${v.owner}.${v.member}`)).toEqual(['ActorAgent.onFiberRecovered']);
    expect(violations[0]!.reason).toContain('must hand its work to `classifyRecoveredFiber`');
  });

  test('cut the wire: making the real classifier async goes red', () => {
    const file = 'packages/cf-backend/src/fiber-recovery.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const widened = real!.replace(
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
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const anchor = '    const sweepsTruncated = this.maintenanceSweeps();\n';
    expect(real).toContain(anchor);
    const respawned = real!.replace(anchor, `${anchor}    if (this.getOwnerUserId()) {
      this.detachOwned(async () => {
        await this.hydrateTitle();
        const soul = await readSoul(this.rt.storage.vfs);
        await this.maybeAutoTitle(summarizeSoul(soul ?? ''));
      });
    }
`);
    expect(respawned).not.toBe(real);
    const { violations } = auditFile(file, respawned);
    expect(violations.map((v) => `${v.owner}.${v.member}`)).toEqual(['OrchestratorAgent.onStart']);
    expect(violations[0]!.reason).toContain('reaches `maybeAutoTitle`');
  });
});
