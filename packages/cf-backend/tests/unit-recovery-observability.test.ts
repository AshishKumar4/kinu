/**
 * What a durable recovery leaves behind, and what an auxiliary log may not cost.
 *
 * ## Why the recovery record is asserted at all
 *
 * A container lifecycle failure is made durable by the box before anyone is
 * told, and the box re-delivers it until this Worker accepts it. That seam used
 * to produce no fleet signal: an incident the agent acted on and an incident
 * that reached nobody were both silence, and silence is also what a deleted
 * instrument looks like. So every settlement is now ONE typed record, and the
 * cases below are the settlements that exist — announced, already announced,
 * undelivered, refused envelope, and a delivery that threw. Each is asserted on
 * the record's own dimensions rather than on whether a row appeared, because
 * "successful recovery" is a VALUE of the outcome dimension and the whole defect
 * was that it had nowhere to be.
 *
 * ## Why the log failure is a negative control and not a unit test
 *
 * `logActivity` is best-effort tracing whose failures must not reach a caller.
 * `Agent.sql` is synchronous — `sql(...): T[]` — so an unwritable activity row
 * is a THROW on the caller's own stack, not a floating rejection, and the
 * lifecycle seam logs before it answers the container. One full or missing table
 * therefore turned an announcement the agent had ALREADY been given into a
 * rejected RPC, and the container then retried an incident that was permanently
 * on record, being refused by a log line every time. The containment is at the
 * sink, where all of its call sites are covered at once, so it is measured
 * through a REAL actor with a real broken table rather than through an injected
 * double that could only prove the double was called.
 */
import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import {
  KinuError, createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import type { AgentSignal, JsonValue, SignalOutcome } from '@kinu.run/core';
import {
  SANDBOX_LIFECYCLE_ENVELOPE_VERSION, acceptSandboxLifecycleFailure,
  initSandboxLifecycleTable, type SandboxLifecycleDeps,
} from '../src/sandbox-lifecycle';
import {
  deliverIncidents, recordIncident, type IncidentRow, type IncidentStore,
} from '@kinu.run/devbox/incidents';
import type { RecoveryRowInput } from '../src/analytics/record';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** The record as the lifecycle module produces it: everything but the caller's
 *  own workspace, which is the one dimension it cannot know. */
type Settlement = Omit<RecoveryRowInput, 'workspace'>;

/** What one case scripts. Every member is supplied — the defaults are here, not
 *  spread in conditionally — so the deps below are one shape rather than two. */
interface LedgerScript {
  /** What the signal seam answers, or throws. */
  readonly deliver: () => Promise<SignalOutcome>;
  /** The auxiliary log. A no-op unless a case is about its failure. */
  readonly logActivity: (event: string, detail?: string) => void;
}

const ANNOUNCES = {
  deliver: async () => 'queued',
  logActivity: () => {},
} satisfies LedgerScript;

interface Ledger {
  readonly deps: SandboxLifecycleDeps;
  readonly settlements: readonly Settlement[];
  readonly delivered: readonly AgentSignal[];
}

/** A real ledger over bun:sqlite, a scripted signal seam, and the recovery sink
 *  as a list. Nothing is mocked that this module owns: the dedupe really reads
 *  and writes SQL, which is what makes the duplicate and re-delivery arms
 *  measurable rather than asserted against a stub's memory. */
function ledger(script: Partial<LedgerScript> = {}): Ledger {
  const { deliver, logActivity } = { ...ANNOUNCES, ...script };
  const { sql, execRaw } = createTestSql();
  initSandboxLifecycleTable(execRaw);
  const settlements: Settlement[] = [];
  const delivered: AgentSignal[] = [];
  return {
    deps: {
      sql,
      signals: {
        deliver: async (signal: AgentSignal) => {
          delivered.push(signal);
          return await deliver();
        },
      },
      recordRecovery: (row) => { settlements.push(row); },
      logActivity,
    },
    settlements,
    delivered,
  };
}

/** The envelope shape the container's host sends. A JSON object, because the
 *  seam it crosses IS the parse boundary — the fields are the caller's claim,
 *  not a checked type, which is the whole reason the schema exists. */
type Envelope = Readonly<Record<string, JsonValue>>;

const SENT = {
  version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
  incidentId: 'inc-1',
  stage: 'checkpoint',
  reason: 'mksquashfs exited 1',
  attempts: 1,
} satisfies Envelope;

/** The envelope with a case's own fields on top, so what each test changes is
 *  the only thing it changes. */
function envelope(over: Envelope = {}): JsonValue {
  return { ...SENT, ...over };
}

/** The envelope an older producer sends: the named field is simply not there.
 *  Stated by name rather than destructured off a widened copy, so a reader sees
 *  WHICH field is missing at the call site. */
function envelopeWithout(field: 'version' | 'attempts'): JsonValue {
  return Object.fromEntries(
    Object.entries(SENT).filter(([key]) => key !== field),
  );
}

describe('a durable recovery settlement', () => {
  test('a successful announcement is a row, not a silence', async () => {
    const { deps, settlements, delivered } = ledger();

    const answer = await acceptSandboxLifecycleFailure(deps, envelope(), 1_000);

    expect(answer).toMatchObject({ status: 'queued', duplicate: false });
    expect(delivered).toHaveLength(1);
    // The whole finding, in one assertion: recovery that WORKED has dimensions.
    expect(settlements).toEqual([{
      stage: 'checkpoint', outcome: 'ok', code: '', attempts: 1, durationMs: 0,
    }]);
  });

  test('an undelivered announcement is a failed recovery, with no invented cause', async () => {
    const { deps, settlements } = ledger({ deliver: async () => 'undelivered' });

    await acceptSandboxLifecycleFailure(deps, envelope(), 1_000);

    // `failed`, and `code` deliberately empty: the signal seam answers with an
    // OUTCOME and holds no cause, so a classification here would be the one
    // unmeasured value on the row.
    expect(settlements).toEqual([{
      stage: 'checkpoint', outcome: 'failed', code: '', attempts: 1, durationMs: 0,
    }]);
  });

  test('an incident the agent already has is still a successful recovery', async () => {
    const { deps, settlements, delivered } = ledger();

    await acceptSandboxLifecycleFailure(deps, envelope(), 1_000);
    const repeat = await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 2 }), 1_400);

    expect(repeat).toMatchObject({ status: 'queued', duplicate: true });
    // One announcement, two settlements. The repeat is the container's retry loop
    // being conservative about an answer it may not have received, so it is `ok`:
    // the agent HAS been told, which is what the seam is for.
    expect(delivered).toHaveLength(1);
    expect(settlements[1]).toEqual({
      stage: 'checkpoint', outcome: 'ok', code: '', attempts: 2, durationMs: 400,
    });
  });

  test('the attempt count is the PRODUCER\'s, transported rather than recounted', async () => {
    const { deps, settlements } = ledger();

    // The box has tried four times; three of those failures never reached this
    // Worker at all, and an evicted Worker could not have counted them.
    await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 4 }), 1_000);

    expect(settlements[0]?.attempts).toBe(4);
  });

  test('the duration is measured from the FIRST report, not from this attempt', async () => {
    let landed = false;
    const { deps, settlements } = ledger({
      deliver: async () => (landed ? 'queued' : 'undelivered'),
    });

    await acceptSandboxLifecycleFailure(deps, envelope(), 1_000);
    landed = true;
    // The same incident, re-delivered much later. `first_seen_at` is written
    // once and never moved, so this is the span the agent went without being
    // told rather than the length of the last hop, which is the only version of
    // the number worth reading.
    await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 2 }), 9_500);

    expect(settlements.map((row) => [row.outcome, row.durationMs]))
      .toEqual([['failed', 0], ['ok', 8_500]]);
  });

  test('a refused envelope claims no dimensions it was not given', async () => {
    const { deps, settlements, delivered } = ledger();

    // The shape a caller reaches for when it wants to pass something the
    // contract has no field for.
    const answer = await acceptSandboxLifecycleFailure(
      deps, envelope({ r2Key: 'backups/abc/data.sqsh' }), 1_000,
    );

    expect(answer.status).toBe('rejected');
    expect(delivered).toEqual([]);
    // `refused`, not `failed`: `bad_input` IS a refusal in core's own vocabulary,
    // and a rate that pooled a caller's bad envelope with a delivery that broke
    // would answer neither question. Stage and attempts are empty because the
    // envelope named neither, and a fabricated dimension is worse than an absent
    // one.
    expect(settlements).toEqual([{
      stage: '', outcome: 'refused', code: 'bad_input', attempts: 0, durationMs: 0,
    }]);
  });

  test('a delivery that throws is recorded with its class, and still throws', async () => {
    const { deps, settlements } = ledger({
      deliver: async () => { throw new KinuError('timeout', 'the signal seam did not answer'); },
    });

    await expect(acceptSandboxLifecycleFailure(deps, envelope(), 1_000)).rejects.toThrow();

    // The one arm on this path where a cause exists to classify, and the class is
    // read from the failure rather than defaulted: `timeout` and `io` imply
    // opposite responses.
    expect(settlements).toEqual([{
      stage: 'checkpoint', outcome: 'failed', code: 'timeout', attempts: 1, durationMs: 0,
    }]);
  });

  test('an unclassifiable delivery failure falls back rather than guessing a class', async () => {
    const { deps, settlements } = ledger({
      deliver: async () => { throw new Error('socket hang up'); },
    });

    await expect(acceptSandboxLifecycleFailure(deps, envelope(), 1_000)).rejects.toThrow();

    expect(settlements[0]?.code).toBe('io');
  });

  test('a thrown delivery leaves the incident re-deliverable, so the retry is still the recovery', async () => {
    let fail = true;
    const { deps, settlements, delivered } = ledger({
      deliver: async () => {
        if (fail) throw new KinuError('io', 'the signal seam broke');
        return 'queued';
      },
    });

    await expect(acceptSandboxLifecycleFailure(deps, envelope(), 1_000)).rejects.toThrow();
    fail = false;
    const retried = await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 2 }), 6_000);

    // NOT a duplicate: nothing had been announced, so the retry is the first
    // announcement. The row the failed attempt left behind is what makes that
    // safe, and recording the failure did not consume it.
    expect(retried).toMatchObject({ status: 'queued', duplicate: false });
    expect(delivered).toHaveLength(2);
    expect(settlements[1]).toEqual({
      stage: 'checkpoint', outcome: 'ok', code: '', attempts: 2, durationMs: 5_000,
    });
  });
});

describe('the versioned envelope', () => {
  test('an envelope with no version is refused rather than read as the old shape', async () => {
    const { deps, delivered, settlements } = ledger();

    const answer = await acceptSandboxLifecycleFailure(deps, envelopeWithout('version'), 1_000);

    expect(answer.status).toBe('rejected');
    expect(delivered).toEqual([]);
    expect(settlements[0]?.outcome).toBe('refused');
  });

  test('an envelope stamped with a shape this build does not speak is refused BY NAME', async () => {
    const { deps, delivered } = ledger();

    const answer = await acceptSandboxLifecycleFailure(deps, envelope({ version: 1 }), 1_000);

    expect(answer.status).toBe('rejected');
    expect(delivered).toEqual([]);
    // The field, not just the values. A version mismatch is the one refusal a
    // caller most needs to read, and valibot's own message for it is "Expected 2
    // but received 1" — true, and about nothing in particular. Every issue now
    // carries its path, which is what this seam has always promised.
    expect(answer.status === 'rejected' ? answer.reason : '').toContain('version');
  });

  test('an absent or impossible attempt count is refused, never defaulted', async () => {
    const { deps, delivered } = ledger();

    // A guessed attempt number would put a value in the dataset that nothing
    // measured, which is the one failure a dataset cannot recover from later.
    expect((await acceptSandboxLifecycleFailure(deps, envelopeWithout('attempts'), 1_000)).status)
      .toBe('rejected');
    expect((await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 0 }), 1_000)).status)
      .toBe('rejected');
    expect((await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 1.5 }), 1_000)).status)
      .toBe('rejected');
    expect(delivered).toEqual([]);
  });
});

/**
 * The box's ledger, in memory, with the exact four operations it owns.
 *
 * Real `deliverIncidents` over it, driving the real `acceptSandboxLifecycleFailure`
 * through the same envelope `kinu-sandbox.ts` mints — because the defect this
 * pair exists to pin lived in NEITHER half. Each side was self-consistent: this
 * side kept the row re-deliverable and waited to be asked again, the box wrote
 * the incident off, and the only thing wrong was the word that crossed between
 * them. A test of either half alone reports nothing.
 */
function incidentLedger(): IncidentStore & { rows(): readonly IncidentRow[] } {
  const rows = new Map<string, IncidentRow>();
  return {
    get: async (key) => rows.get(key),
    put: async (key, value) => { rows.set(key, value); },
    delete: async (key) => rows.delete(key),
    list: async ({ prefix }) => new Map(
      [...rows].filter(([key]) => key.startsWith(prefix)),
    ),
    rows: () => [...rows.values()],
  };
}

describe('the answer the box acts on', () => {
  /** One delivery pass, wired the way the container's host wires it: the
   *  envelope restated field by field, and the host returns the status verbatim
   *  because both sides speak one disposition vocabulary. */
  async function pass(store: IncidentStore, deps: SandboxLifecycleDeps, now: number) {
    return await deliverIncidents(store, async (incident, attempt) => {
      const answer = await acceptSandboxLifecycleFailure(deps, {
        version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
        incidentId: incident.incidentId,
        stage: incident.stage,
        reason: incident.reason,
        attempts: attempt,
      }, now);
      return answer.status;
    });
  }

  test('an announcement that did not land leaves the incident pending, and the retry lands it', async () => {
    let landed = false;
    const { deps, delivered } = ledger({ deliver: async () => (landed ? 'queued' : 'undelivered') });
    const store = incidentLedger();
    await recordIncident(store, 'checkpoint', 'mksquashfs exited 1');

    const firstDelay = await pass(store, deps, 1_000);

    // THE DEFECT, PINNED. The box must not write the incident off: nobody has
    // been told, so `deliveredAt` stays absent and the schedule is re-armed.
    const pending = store.rows()[0];
    expect(pending?.deliveredAt).toBeUndefined();
    expect(pending?.rejectedAt).toBeUndefined();
    expect(pending?.attempts).toBe(1);
    expect(firstDelay).not.toBeNull();

    // And the retry is what ends the loop, which is the property the whole
    // re-deliverable ledger exists for.
    landed = true;
    const secondDelay = await pass(store, deps, 4_000);

    const settled = store.rows()[0];
    expect(settled?.deliveredAt).toBeDefined();
    expect(settled?.attempts).toBe(2);
    // Nothing left undelivered, so there is nothing to wake for.
    expect(secondDelay).toBeNull();
    // Announced exactly once across both passes: the first attempt never
    // reached the agent, and the second is that first announcement.
    expect(delivered).toHaveLength(2);
  });

  test('a refused SHAPE is recorded and never retried, unlike a delivery that did not land', async () => {
    const { deps, delivered } = ledger();
    const store = incidentLedger();
    await recordIncident(store, 'attach', 'archive size 0');

    // A caller defect rather than a transient: retrying the same envelope cannot
    // change the answer, so this one is stamped and dropped from the schedule.
    const delay = await deliverIncidents(store, async () =>
      (await acceptSandboxLifecycleFailure(deps, { nonsense: true }, 1_000)).status);

    const row = store.rows()[0];
    expect(row?.rejectedAt).toBeDefined();
    expect(row?.deliveredAt).toBeUndefined();
    expect(delay).toBeNull();
    expect(delivered).toEqual([]);
  });
});

/**
 * What `body` returned AND what the diagnostic sink was told while it ran.
 *
 * Both, from one seam, because a test that needs the second almost always needs
 * the first: handing the value back is what keeps a case's own result properly
 * typed instead of assigned out through a widened binding the assertion then has
 * to re-narrow.
 */
async function withDiagnostics<T>(body: () => Promise<T>): Promise<{
  readonly value: T;
  readonly logs: readonly RecordedLog[];
}> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);
  try {
    return { value: await body(), logs: logger.emitted };
  } finally {
    restore();
  }
}

/** Failures the actor's own activity log reported while a case ran. */
function activityLogFailures(logs: readonly RecordedLog[]): readonly RecordedLog[] {
  return logs.filter((log) => log.event === 'activity_log.write_failed');
}

/** The signal seam's accept, so an announcement really lands. */
function acceptSubmissions(agent: HarnessOrchestratorAgent): void {
  Object.defineProperty(agent, 'submitMessages', {
    configurable: true,
    value: async () => ({
      submissionId: 'sub-1', status: 'pending' as const, createdAt: Date.now(), accepted: true,
    }),
  });
}

describe('an auxiliary log failure', () => {
  const incident = {
    version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
    incidentId: 'inc-log',
    stage: 'attach' as const,
    reason: 'archive size 0 did not match the declared 918_224',
    attempts: 1,
  };

  test('cannot reject an announcement the agent has already been given', async () => {
    const { agent, db } = orchestratorHarness();
    acceptSubmissions(agent);
    // The real failure, not a simulated one: the insert is issued against a
    // table that is not there, which is what a migration that has not reached
    // this object looks like from inside `logActivity`.
    db.prepare('DROP TABLE activity_log').run();

    const { value, logs } = await withDiagnostics(async () => ({
      first: await agent.acceptSandboxLifecycleFailure(incident),
      repeat: await agent.acceptSandboxLifecycleFailure({ ...incident, attempts: 2 }),
    }));

    // The primary result is untouched on BOTH arms. The duplicate arm matters as
    // much as the first: it logs before it answers too, so an uncontained throw
    // there is what made the container's retry loop unable to terminate.
    expect(value.first).toMatchObject({ status: 'queued', duplicate: false });
    expect(value.repeat).toMatchObject({ status: 'queued', duplicate: true });

    // Observed, with a stable name and a cause — never silently swallowed.
    const failures = activityLogFailures(logs);
    expect(failures.length).toBeGreaterThan(0);
    // The event NAME is published and the DETAIL is not: the name is a closed
    // word from the actor, the detail is caller prose that can carry workspace
    // text and an incident reason.
    expect(failures.map((log) => log.fields?.source)).toContain('sandbox_incident_announced');
    const rendered = JSON.stringify(failures);
    expect(rendered).not.toContain('archive size 0');
    expect(rendered).not.toContain('inc-log');
  });

  test('and with the log intact the same call reports nothing, so the check is not vacuous', async () => {
    const { agent } = orchestratorHarness();
    acceptSubmissions(agent);

    const { value, logs } = await withDiagnostics(
      async () => await agent.acceptSandboxLifecycleFailure(incident),
    );

    expect(value).toMatchObject({ status: 'queued', duplicate: false });
    expect(activityLogFailures(logs)).toEqual([]);
  });
});
