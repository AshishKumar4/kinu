// An agent's database a release left behind is reset at its first open, before anything reads it: its retired tables
// dropped and its changed ones dropped and made anew empty, then stamped (core state/schema-repair.ts). The
// workspace's walk opens it the same way, and reads back what the repair did.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { SCHEMA_STAMPS, WORKSPACE_ROOT } from '@kinu.run/core';
import { AgentFacet, type AgentFacetEnv } from '../src/agent-facet/agent-facet';
import { openAgentDatabase, repairAgentDatabase } from '../src/agent-facet/agent-database';
import { kvOf, makeCtx } from './helpers/platform-context';

function unreachable(): never {
  throw new Error('the stamp test reached the workspace');
}

const WORKSPACE = {
  agent: unreachable, home: WORKSPACE_ROOT, state: unreachable, enqueueTurn: unreachable, admitDelivery: unreachable, broadcast: unreachable,
  turnInFlight: () => false, memory: unreachable, program: unreachable, sayToParent: unreachable, receipts: unreachable, logActivity: unreachable,
};

/** An agent database as a build before this one left it: a table this release removed, a column it dropped, and
 *  another stamp. */
function leftBehind(): Database {
  const db = new Database(':memory:');

  openAgentDatabase(makeCtx(db, 'stamp-agent').storage, null, WORKSPACE);
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.agent);
  kvOf(db).set('kinu.schema_stamp', 0);
  db.exec("CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY); INSERT INTO device_consent_requests VALUES ('c-1')");
  db.exec('ALTER TABLE lessons ADD COLUMN status TEXT');

  return db;
}

test('an agent database behind this build is reset at its first open, and opens', () => {
  const db = leftBehind();
  const { storage } = makeCtx(db, 'stamp-agent');
  const repair = repairAgentDatabase(storage, 'stamp-agent');

  expect({ dropped: repair?.dropped, retired: repair?.retired, refused: repair?.refused }).toEqual({ dropped: ['lessons'], retired: ['device_consent_requests'], refused: null });
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.agent);
  openAgentDatabase(storage, repair, WORKSPACE);
});

test('the workspace\'s walk opens an agent\'s database so it repairs itself, reaching no workspace', async () => {
  const db = leftBehind();
  // SAFETY: constructed here with every member answering `unreachable`, which throws: a call into it fails the test.
  const workspace = new Proxy({}, { get: () => unreachable }) as AgentFacetEnv['WORKSPACE'];
  const env: AgentFacetEnv = { WORKSPACE: workspace, WORKSPACE_NAME: 'stamp-workspace', HOME: WORKSPACE_ROOT };
  const answer = await new AgentFacet(makeCtx(db, 'stamp-agent'), env).opsTables();

  expect({ retired: answer.repair?.retired, refused: answer.refused }).toEqual({ retired: ['device_consent_requests'], refused: null });
  expect(answer.census.some(({ table }) => table === 'device_consent_requests')).toBe(false);
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.agent);
});
