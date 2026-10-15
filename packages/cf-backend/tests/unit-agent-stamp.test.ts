// An agent's database a release's tables step has not reached is refused at its first open, with why, and the step's
// own call through its workspace brings it to this build and stamps it (identity/schema-stamp.ts).
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { SCHEMA_STAMPS, WORKSPACE_ROOT } from '@kinu.run/core';
import { AgentFacet, type AgentFacetEnv } from '../src/agent-facet/agent-facet';
import { openAgentDatabase } from '../src/agent-facet/agent-database';
import { kvOf, makeCtx } from './helpers/platform-context';

function unreachable(): never {
  throw new Error('the stamp test reached the workspace');
}

const WORKSPACE = {
  agent: unreachable, home: WORKSPACE_ROOT, state: unreachable, enqueueTurn: unreachable, admitDelivery: unreachable, broadcast: unreachable,
  turnInFlight: () => false, memory: unreachable, program: unreachable, sayToParent: unreachable, receipts: unreachable, logActivity: unreachable,
};

test('an agent database behind this build is refused at its first open, and its workspace\'s step brings it up', async () => {
  const db = new Database(':memory:');

  openAgentDatabase(makeCtx(db, 'stamp-agent').storage, WORKSPACE);
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.agent);
  // As a build before this one left it, with a table this release removed.
  kvOf(db).set('kinu.schema_stamp', 0);
  db.exec('CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO device_consent_requests VALUES ('c-1')");

  expect(() => openAgentDatabase(makeCtx(db, 'stamp-agent').storage, WORKSPACE)).toThrow("This agent's storage was made before this release changed its tables");

  // The step's call reaches no workspace: it reads and repairs the agent's own SQLite alone.
  // SAFETY: constructed here with every member answering `unreachable`, which throws: a call into it fails the test.
  const workspace = new Proxy({}, { get: () => unreachable }) as AgentFacetEnv['WORKSPACE'];
  const env: AgentFacetEnv = { WORKSPACE: workspace, WORKSPACE_NAME: 'stamp-workspace', HOME: WORKSPACE_ROOT };
  const facet = new AgentFacet(makeCtx(db, 'stamp-agent'), env);
  const answer = await facet.opsTables({ tables: [{ table: 'device_consent_requests', change: 'removed' }], drop: true });

  expect({ stamp: answer.stamp, dropped: answer.dropped }).toEqual({ stamp: 'behind', dropped: ['device_consent_requests'] });
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.agent);
  openAgentDatabase(makeCtx(db, 'stamp-agent').storage, WORKSPACE);
});
