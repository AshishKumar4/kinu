/** Replay the model's interleavings against the real SQLite store and lineage checker.
 * This checks the launch inputs/fences, not Nimbus process teardown or asynchronous launch restart. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { initSlateLiveShareTables, SlateLiveShareStore, type ShareAuthority } from '../src/slates/live-shares';
import { SharedServers, type SlateLineage } from '../src/slates/shared-server';
import { ShareGrantSchema } from '../src/slates/sharing';
import { makeExecRaw, makeSqlExec } from './helpers';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/share-fence-cases.json');

const Mode = v.picklist(['own', 'owner']);

const Lineage = v.object({ incarnation: v.string(), generation: v.number() });

const Snapshot = v.array(v.object({
  slate: v.string(), generation: v.number(), shared: v.boolean(), rows: v.record(v.string(), v.object({ mode: Mode, live: v.boolean() })),
}));

const After = { after: Snapshot };

const Authority = { mode: Mode, grantRevision: v.nullable(v.string()), grant: ShareGrantSchema };

const Fixture = v.object({
  fixture: v.literal('share-fence-cases'), model: v.literal('Kinu.SharingNimbus.Fence'), seed: v.string(),
  cases: v.array(v.object({
    steps: v.array(v.variant('op', [
      v.object({ op: v.literal('add'), slate: v.string(), id: v.string(), ...Authority, ...After }),
      v.object({ op: v.literal('revoke'), slate: v.string(), id: v.string(), missing: v.boolean(), ...After }),
      v.object({ op: v.literal('setAuthority'), slate: v.string(), id: v.string(), ...Authority, ...After }),
      v.object({
        op: v.literal('launch'), slate: v.string(), slot: v.number(), incarnation: v.string(), expected: Lineage, ...After,
      }),
      v.object({
        op: v.literal('call'), slot: v.number(), expected: v.boolean(),
        record: v.nullable(v.object({ incarnation: v.string(), generations: v.record(v.string(), v.number()) })), ...After,
      }),
      v.object({ op: v.literal('listing'), slate: v.string(), id: v.string(), on: v.boolean(), ...After }),
      v.object({ op: v.literal('users'), slate: v.string(), id: v.string(), ...After }),
      v.object({ op: v.literal('preapprove'), slate: v.string(), ...After }),
      v.object({ op: v.literal('withdrawPreapproval'), slate: v.string(), ...After }),
      v.object({ op: v.literal('observe'), ...After }),
    ])),
  })),
});

const { cases } = v.parse(Fixture, JSON.parse(readFileSync(FIXTURE, 'utf8')));

function authorityOf(step: { mode: 'own' | 'owner'; grantRevision: string | null }): ShareAuthority {
  if (step.mode === 'own') return { mode: 'own', grantRevision: null };

  if (step.grantRevision === null) throw new Error('An owner-mode fixture must name its approved revision');

  return { mode: 'owner', grantRevision: step.grantRevision };
}

describe('sharing fences refine the atomic store and SharedServers.lineage', () => {
  test('the corpus interleaves current and stale calls with every store mutation', () => {
    expect(new Set(cases.flatMap((c) => c.steps.map((s) => s.op))))
      .toEqual(new Set(['add', 'revoke', 'setAuthority', 'launch', 'call', 'listing', 'users', 'preapprove', 'withdrawPreapproval', 'observe']));
    expect(new Set(cases.flatMap((c) => c.steps.flatMap((s) => (s.op === 'call' ? [s.expected] : [])))))
      .toEqual(new Set([true, false]));
  });

  test.each(cases.map((c, i) => [i, c] as const))('Lean interleaving %d', (_i, c) => {
    const db = new Database(':memory:');
    initSlateLiveShareTables(makeExecRaw(db));
    let clock = 0;
    const live = new SlateLiveShareStore(makeSqlExec(db), () => ++clock);

    const servers = new SharedServers({
      authoritiesOf: (slate) => live.authoritiesOf(slate), revision: () => 'r1', generation: (slate) => live.generation(slate),
    });

    const launches: { slate: string; lineage: SlateLineage }[] = [];

    try {
      for (const step of c.steps) {
        if (step.op === 'add' || step.op === 'setAuthority') {
          const authority = authorityOf(step);

          if (step.op === 'add') {
            live.add({ id: step.id, slate: step.slate, visibility: 'users', handle: step.id, grant: step.grant, authority });
          } else {
            live.setAuthority(step.id, authority, step.grant);
          }
        } else if (step.op === 'revoke') {
          if (step.missing) expect(() => live.revoke(step.id)).toThrow(expect.objectContaining({ code: 'missing' }));
          else live.revoke(step.id);
        } else if (step.op === 'launch') {
          const lineage = { incarnation: step.incarnation, generation: live.generation(step.slate) };

          expect(lineage).toEqual(step.expected);
          launches[step.slot] = { slate: step.slate, lineage };
        } else if (step.op === 'call') {
          const launch = launches[step.slot];

          if (launch === undefined) throw new Error(`Fixture names missing launch ${step.slot}`);
          const record = step.record === null ? null : { id: 'host-issued-request', chain: Object.keys(step.record.generations), ...step.record };
          const refusal = servers.lineage(launch.slate, launch.lineage, record);

          expect(refusal === null).toBe(step.expected);

          if (refusal !== null) expect(refusal.code).toBe('denied');
        } else if (step.op === 'listing') {
          live.setListing(step.id, step.on ? { line: 'Fixture listing', category: 'developer' } : null);
        } else if (step.op === 'users') {
          live.addUsers(step.id, [{ userId: 'fixture-viewer', email: 'fixture@example.test' }]);
        } else if (step.op === 'preapprove') {
          live.preapprove(step.slate, { slate: step.slate, namespace: 'mcp.GitHub', member: 'read', root: {}, revision: 'r1' });
        } else if (step.op === 'withdrawPreapproval') {
          live.withdrawPreapproval(step.slate, { slate: step.slate, namespace: 'mcp.GitHub', member: 'read', root: {} });
        }

        // This projection deliberately excludes grant/revision changes: those
        // are re-weighed at send, whereas launch-time egress/browser choices are fenced.
        const rows = live.list();

        for (const expected of step.after) {
          expect({
            slate: expected.slate, generation: live.generation(expected.slate), shared: live.isShared(expected.slate),
            rows: Object.fromEntries(rows.filter((row) => row.slate === expected.slate)
              .map((row) => [row.id, { mode: row.mode, live: row.revokedAt === null }])),
          }).toEqual(expected);
        }
      }
    } finally {
      db.close();
    }
  });
});
