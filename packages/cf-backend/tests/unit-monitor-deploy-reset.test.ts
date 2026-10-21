// The monitor and a deploy run hold tables no class held until 2026-10-20 (monitor_incidents, monitor_signal_streaks,
// deploy_step), so a release reshaping one reached neither object. Each is now a class of its own, reset as its object
// starts like every other (core state/schema-repair.ts): a changed table dropped and made anew empty, and stamped.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { SCHEMA_STAMPS } from '@kinu.run/core';
import { DeployRunDO } from '../src/deploy/deploy-do';
import { MonitorDO } from '../src/monitor/monitor-do';
import { workerEnv } from './helpers/bindings';
import { kvOf, makeCtx } from './helpers/platform-context';

const env = workerEnv({ CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(64) });

const columns = (db: Database, table: string) => db.query(`SELECT name FROM pragma_table_info('${table}')`).all();

test('a monitor whose incidents a release reshaped resets them as it starts, and is stamped', () => {
  const db = new Database(':memory:');

  db.exec("CREATE TABLE monitor_incidents (probe TEXT PRIMARY KEY, detail TEXT); INSERT INTO monitor_incidents VALUES ('p', 'old')");
  new MonitorDO(makeCtx(db, 'site'), env);

  expect(db.query('SELECT COUNT(*) AS n FROM monitor_incidents').all()).toEqual([{ n: 0 }]);
  expect(columns(db, 'monitor_incidents')).toContainEqual({ name: 'opened_at' });
  expect(columns(db, 'monitor_signal_streaks')).toContainEqual({ name: 'crossed' });
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.monitor);
});

test('a monitor nothing made yet is made and stamped, and one at this build is left as it is', () => {
  const db = new Database(':memory:');

  new MonitorDO(makeCtx(db, 'site'), env);
  db.exec("INSERT INTO monitor_incidents (probe, detail, opened_at, alerted_at, failures) VALUES ('p', 'kept', 1, NULL, 1)");
  new MonitorDO(makeCtx(db, 'site'), env);

  expect(db.query('SELECT probe, detail FROM monitor_incidents').all()).toEqual([{ probe: 'p', detail: 'kept' }]);
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.monitor);
});

test('a deploy run whose ledger a release reshaped resets it as it starts, and is stamped', () => {
  const db = new Database(':memory:');

  db.exec("CREATE TABLE deploy_step (id TEXT PRIMARY KEY, state TEXT); INSERT INTO deploy_step VALUES ('account', 'done')");
  new DeployRunDO(makeCtx(db, 'run'), env);

  expect(db.query('SELECT COUNT(*) AS n FROM deploy_step').all()).toEqual([{ n: 0 }]);
  expect(columns(db, 'deploy_step')).toContainEqual({ name: 'attempt' });
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.deploy);
});
