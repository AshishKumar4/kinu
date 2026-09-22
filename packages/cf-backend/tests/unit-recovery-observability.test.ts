/**
 * Every recovery settlement is one typed record asserted on its dimensions. `Agent.sql` is
 * synchronous, so an unwritable activity row throws on the caller's stack: `logActivity` must
 * contain it.
 */
import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import {
  KinuError, createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import type { AgentSignal, JsonValue, SendOutcome } from '@kinu.run/core';
import {
  SANDBOX_LIFECYCLE_ENVELOPE_VERSION, acceptSandboxLifecycleFailure,
  initSandboxLifecycleTable, type SandboxLifecycleDeps,
} from '../src/sandbox-lifecycle';
import {
  deliverIncidents, recordIncident, type IncidentRow, type IncidentStore,
} from '@kinu.run/devbox/incidents';
import type { RecoveryRowInput } from '@kinu.run/core/analytics';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** Everything but the caller's own workspace, the one dimension the module cannot know. */
type Settlement = Omit<RecoveryRowInput, 'workspace'>;

interface LedgerScript {
  readonly deliver: () => Promise<SendOutcome>;
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

/** A real ledger over bun:sqlite: the dedupe really reads and writes SQL. */
function ledger(script: Partial<LedgerScript> = {}): Ledger {
  const { deliver, logActivity } = { ...ANNOUNCES, ...script };
  const { sql, execRaw } = createTestSql();
  initSandboxLifecycleTable(execRaw);
  const settlements: Settlement[] = [];
  const delivered: AgentSignal[] = [];

  return {
    deps: {
      sql,
      inbox: {
        send: async (signal: AgentSignal) => {
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

/** A JSON object: the seam is the parse boundary, so the fields are the caller's claim. */
type Envelope = Readonly<Record<string, JsonValue>>;

const SENT = {
  version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
  incidentId: 'inc-1',
  stage: 'checkpoint',
  reason: 'mksquashfs exited 1',
  attempts: 1,
} satisfies Envelope;

function envelope(over: Envelope = {}): JsonValue {
  return { ...SENT, ...over };
}

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
    expect(settlements).toEqual([{
      stage: 'checkpoint', outcome: 'ok', code: '', attempts: 1, durationMs: 0,
    }]);
  });

  test('an undelivered announcement is a failed recovery, with no invented cause', async () => {
    const { deps, settlements } = ledger({ deliver: async () => 'undelivered' });

    await acceptSandboxLifecycleFailure(deps, envelope(), 1_000);

    // `code` empty: the signal seam answers an outcome and holds no cause.
    expect(settlements).toEqual([{
      stage: 'checkpoint', outcome: 'failed', code: '', attempts: 1, durationMs: 0,
    }]);
  });

  test('an incident the agent already has is still a successful recovery', async () => {
    const { deps, settlements, delivered } = ledger();

    await acceptSandboxLifecycleFailure(deps, envelope(), 1_000);
    const repeat = await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 2 }), 1_400);

    expect(repeat).toMatchObject({ status: 'queued', duplicate: true });
    // The repeat is the container's conservative retry: the agent has been told, so it is `ok`.
    expect(delivered).toHaveLength(1);
    expect(settlements[1]).toEqual({
      stage: 'checkpoint', outcome: 'ok', code: '', attempts: 2, durationMs: 400,
    });
  });

  test('the attempt count is the PRODUCER\'s, transported rather than recounted', async () => {
    const { deps, settlements } = ledger();

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
    // `first_seen_at` is written once, so this is the span the agent went untold, not the last hop.
    await acceptSandboxLifecycleFailure(deps, envelope({ attempts: 2 }), 9_500);

    expect(settlements.map((row) => [row.outcome, row.durationMs]))
      .toEqual([['failed', 0], ['ok', 8_500]]);
  });

  test('a refused envelope claims no dimensions it was not given', async () => {
    const { deps, settlements, delivered } = ledger();

    const answer = await acceptSandboxLifecycleFailure(
      deps, envelope({ r2Key: 'backups/abc/data.sqsh' }), 1_000,
    );

    expect(answer.status).toBe('rejected');
    expect(delivered).toEqual([]);
    // `refused`, not `failed`: `bad_input` is a refusal in core's vocabulary. Unnamed dimensions
    // stay
    // empty: a fabricated dimension is worse than an absent one.
    expect(settlements).toEqual([{
      stage: '', outcome: 'refused', code: 'bad_input', attempts: 0, durationMs: 0,
    }]);
  });

  test('a delivery that throws is recorded with its class, and still throws', async () => {
    const { deps, settlements } = ledger({
      deliver: async () => { throw new KinuError('timeout', 'the signal seam did not answer'); },
    });

    await expect(acceptSandboxLifecycleFailure(deps, envelope(), 1_000)).rejects.toThrow();

    // The class is read from the failure, not defaulted: `timeout` and `io` imply opposite
    // responses.
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

    // Not a duplicate: nothing had been announced, so the retry is the first announcement.
    expect(retried).toMatchObject({ status: 'queued', duplicate: false });
    expect(delivered).toHaveLength(2);
    expect(settlements[1]).toEqual({
      stage: 'checkpoint', outcome: 'ok', code: '', attempts: 2, durationMs: 5_000,
    });
  });
});

describe('the versioned envelope', () => {
  test('an envelope with no version is refused, never defaulted to the current version', async () => {
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
    // Every issue carries its path: valibot's bare version-mismatch message names no field.
    expect(answer.status === 'rejected' ? answer.reason : '').toContain('version');
  });

  test('an absent or impossible attempt count is refused, never defaulted', async () => {
    const { deps, delivered } = ledger();

    // A guessed attempt number would put an unmeasured value in the dataset.
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
 * Real `deliverIncidents` driving real `acceptSandboxLifecycleFailure`: the defect lived in the
 * word crossing between the halves, so a test of either half alone reports nothing.
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
  /** The host returns the status verbatim: both sides speak one disposition vocabulary. */
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

    // Defends: the box wrote off an undelivered incident. `deliveredAt` stays absent; the schedule
    // re-arms.
    const pending = store.rows()[0];
    expect(pending?.deliveredAt).toBeUndefined();
    expect(pending?.rejectedAt).toBeUndefined();
    expect(pending?.attempts).toBe(1);
    expect(firstDelay).not.toBeNull();

    landed = true;
    const secondDelay = await pass(store, deps, 4_000);

    const settled = store.rows()[0];
    expect(settled?.deliveredAt).toBeDefined();
    expect(settled?.attempts).toBe(2);
    expect(secondDelay).toBeNull();
    expect(delivered).toHaveLength(2);
  });

  test('a refused SHAPE is recorded and never retried, unlike a delivery that did not land', async () => {
    const { deps, delivered } = ledger();
    const store = incidentLedger();
    await recordIncident(store, 'attach', 'archive size 0');

    // A caller defect: retrying cannot change the answer, so it is stamped and dropped.
    const delay = await deliverIncidents(store, async () =>
      (await acceptSandboxLifecycleFailure(deps, { nonsense: true }, 1_000)).status);

    const row = store.rows()[0];
    expect(row?.rejectedAt).toBeDefined();
    expect(row?.deliveredAt).toBeUndefined();
    expect(delay).toBeNull();
    expect(delivered).toEqual([]);
  });
});

/** What `body` returned and what the diagnostic sink was told while it ran. */
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

function activityLogFailures(logs: readonly RecordedLog[]): readonly RecordedLog[] {
  return logs.filter((log) => log.event === 'activity_log.write_failed');
}

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
    // A real failure: the insert targets a missing table, as an unmigrated object would.
    db.prepare('DROP TABLE activity_log').run();

    const { value, logs } = await withDiagnostics(async () => ({
      first: await agent.acceptSandboxLifecycleFailure(incident),
      repeat: await agent.acceptSandboxLifecycleFailure({ ...incident, attempts: 2 }),
    }));

    // The duplicate arm logs before it answers too: an uncontained throw there made the retry loop
    // endless.
    expect(value.first).toMatchObject({ status: 'queued', duplicate: false });
    expect(value.repeat).toMatchObject({ status: 'queued', duplicate: true });

    const failures = activityLogFailures(logs);
    expect(failures.length).toBeGreaterThan(0);
    // The event name is published, the detail is not: detail is caller prose that can carry
    // workspace text.
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
