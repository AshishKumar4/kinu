/**
 * What a settled turn owed is no one's concern once its actor is dismissed or retired: every owed effect stands down,
 * whatever its kind, logged as ended and never as a failure. Staging c595a3e6b failed a dismissed agent's auto_title
 * ("The actor identity is no longer present"), and d763adae4 its turn_report ("Agent stand-one-question is retired"),
 * each refused by the workspace that had retired the agent while the effect ran.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createRecordingLogger, createTestActors } from '@kinu.run/test-utils';
import {
  initTerminalEffectTable, terminalEffect, TerminalEffectLedger, type OwedEffect, type TerminalEffectName,
} from '../src/orchestrator/terminal-effects';
import { actorEnded, endedStandingOf, type ActorStanding } from '../src/identity/workspace-actors';
import { initActorDdl } from '../src/identity/schema';
import { KinuError, setDiagnosticsSink, toKinuError } from '../src/obs/index';
import { makeExecRaw, makeSql } from './helpers';

const NOW = 1_700_000_000_000;

/** What the workspace answers a call it refuses for a retired agent, per effect, as the effect's body passes it on. */
const REFUSED: Readonly<Record<'turn_report' | 'auto_title', KinuError>> = {
  turn_report: toKinuError({
    doing: 'relaying the turn report', otherwise: 'unavailable',
    cause: actorEnded('denied', 'retired', 'Agent stand-one-question is retired and no longer acts in this workspace.'),
  }),
  auto_title: actorEnded('missing', 'retired', 'The actor identity is no longer present.'),
};

const OWED: readonly OwedEffect[] = [
  { name: 'turn_report', scope: '', input: {}, lane: 'detached' },
  { name: 'auto_title', scope: 'm-1', input: {}, lane: 'detached' },
];

/**
 * A ledger owing `turn_report` and `auto_title`, whose actor's standing is `standing()`. Each body runs `during` and
 * then throws the workspace's refusal for a retired agent.
 */
function owing(standing: (failure: { readonly cause: unknown }) => Promise<ActorStanding>, during: () => void = () => {}) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  const ran: TerminalEffectName[] = [];

  initTerminalEffectTable(execRaw);
  initActorDdl(execRaw);

  const refusing = (name: 'turn_report' | 'auto_title') => terminalEffect({
    input: v.object({}),
    run: async () => {
      ran.push(name);
      during();

      throw REFUSED[name];
    },
  });

  const ledger = new TerminalEffectLedger({
    sql, actor, now: () => NOW, standing,
    transaction: (body) => db.transaction(body)(),
    effects: { turn_report: refusing('turn_report'), auto_title: refusing('auto_title') },
    scheduleRetry: async () => {},
  });

  const rows = () => sql<{ effect_name: string }>`SELECT effect_name FROM terminal_effects ORDER BY effect_name`.map((row) => row.effect_name);

  return { ledger, ran, rows };
}

/** The ledger's pass over `OWED`, and what it logged of each effect. */
async function settled(ledger: TerminalEffectLedger) {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);

  try {
    await (await ledger.run('turn-1', OWED)).reported;
  } finally {
    restore();
  }

  const of = (event: string) => logger.emitted.filter((line) => line.event === event).map((line) => line.fields).sort((a, b) => String(a.effect).localeCompare(String(b.effect)));

  return { ended: of('turn.terminal_effect_ended'), failed: of('turn.terminal_effect_failed') };
}

test('an agent retired while its effects ran: each refused effect stands down, ended, never failed, whatever its kind', async () => {
  let standing: ActorStanding = 'live';
  // The dismissal lands as the first effect runs: every call after it is refused.
  const { ledger, ran, rows } = owing(async () => standing, () => { standing = 'retired'; });
  const { ended, failed } = await settled(ledger);

  expect(ran.sort()).toEqual(['auto_title', 'turn_report']);
  expect(failed).toEqual([]);
  expect(ended).toEqual([
    { sequence: 'turn-1', effect: 'v1:auto_title:m-1', standing: 'retired' },
    { sequence: 'turn-1', effect: 'v1:turn_report', standing: 'retired' },
  ]);
  expect(rows()).toEqual([]);
});

test('an agent dismissed before its effects ran owes them to no one: each the workspace refuses ends, unfailed', async () => {
  const asked: ActorStanding[] = [];

  const { ledger, ran, rows } = owing(async () => {
    asked.push('retiring');

    return 'retiring';
  });

  const { ended, failed } = await settled(ledger);

  expect(ran.sort()).toEqual(['auto_title', 'turn_report']);
  expect(failed).toEqual([]);
  // Asked of each refusal, never before the pass: a settled turn's close crosses to it for no effect that ran.
  expect(asked).toHaveLength(2);
  expect(ended.map((fields) => [fields.effect, fields.standing])).toEqual([['v1:auto_title:m-1', 'retiring'], ['v1:turn_report', 'retiring']]);
  expect(rows()).toEqual([]);
});

test("a live agent's refused effect is still a failure, and still owed", async () => {
  const { ledger, ran, rows } = owing(async () => 'live');
  const { ended, failed } = await settled(ledger);

  expect(ran.sort()).toEqual(['auto_title', 'turn_report']);
  expect(ended).toEqual([]);
  expect(failed.map((fields) => fields.effect)).toEqual(['v1:auto_title:m-1', 'v1:turn_report']);
  // `missing` ends the title unrun; `denied` is owed again.
  expect(rows()).toEqual(['turn_report']);
});

test('a standing that cannot be read is no sign the agent ended: its effects answer for themselves', async () => {
  const { ledger, ran } = owing(async () => { throw new KinuError('unavailable', 'the workspace is unreachable'); });
  const { ended, failed } = await settled(ledger);

  expect(ran.sort()).toEqual(['auto_title', 'turn_report']);
  expect(ended).toEqual([]);
  expect(failed).toHaveLength(2);
});

test("an agent's isolate reads the standing off the workspace's refusal, with no call to ask", async () => {
  // As agent-chat's ledger reads it: the refusal says the agent ended, however the effect's body wrapped it.
  const { ledger, ran, rows } = owing(async (failure) => endedStandingOf(failure) ?? 'live');
  const { ended, failed } = await settled(ledger);

  expect(ran.sort()).toEqual(['auto_title', 'turn_report']);
  expect(failed).toEqual([]);
  expect(ended.map((fields) => [fields.effect, fields.standing])).toEqual([['v1:auto_title:m-1', 'retired'], ['v1:turn_report', 'retired']]);
  expect(rows()).toEqual([]);
  expect(endedStandingOf({ cause: new KinuError('denied', 'Agent stand-one-question is not the hirer.') })).toBeNull();
});
