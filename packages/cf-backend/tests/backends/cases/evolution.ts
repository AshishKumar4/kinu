/** How the agent changes itself, as the owner sees and overrules it. */
import { expect } from 'bun:test';
import {
  CHAT_SESSION_ID, PlanReviewStore, bundledArtifact, drawArm, recordBranchTakeSet, sectionArtifact, startTrial, writeCandidate,
} from '@kinu.run/core';
import type { SharedBackend } from '../backend';
import { until } from '../../helpers/actor-harness';
import type { SharedCase } from '../cases';

/** A scaffold proposal waiting for the owner, as the proposer leaves one. */
function pendingScaffold({ sql, actor }: SharedBackend, rationale: string): void {
  void sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${actor.actorId}, 1, ${Date.now()}, ${rationale}, 'pending')`;
}

export const EVOLUTION_CASES: readonly SharedCase[] = [
  {
    title: 'a live trial\'s turn reads its arm from its cache segment by the one seeded rule, and records it',
    covers: ['getEvolutionStatus'],
    async run({ surface, sql, actor }) {
      const artifactId = sectionArtifact('guidance/operating');
      const body = `${bundledArtifact(artifactId)?.trimEnd() ?? ''} Be brief.`;
      writeCandidate(sql, actor, { artifactId, body, rationale: 'r', evidence: { turns: ['t'], reason: 'verbose_or_slow' } });
      const trial = startTrial(sql, actor);

      if (trial === null) throw new Error('the waiting candidate did not start a trial');
      expect((await surface.getEvolutionStatus()).trial).toMatchObject({ trialId: trial.trialId, artifactId, version: 1 });

      const rows = () => sql<{ turn_id: string; segment_id: string; arm: string }>`SELECT turn_id, segment_id, arm FROM trial_turns
        WHERE actor_id = ${actor.actorId} AND trial_id = ${trial.trialId} ORDER BY at`;

      // cf admits a send and runs its turn after it returns; the CLI runs it inside.
      await surface.send('first');
      await until(() => rows().length === 1, 'the turn reads its arm');

      for (const row of rows()) expect(row.arm).toBe(drawArm(trial.trialId, row.segment_id));
    },
  },
  {
    title: 'a proposed scaffold waits for the owner, who can roll it back',
    covers: ['getEvolutionStatus', 'applyScaffoldDecision'],
    async run(backend) {
      const { surface } = backend;
      pendingScaffold(backend, 'answer in the owner language');

      expect(await surface.getEvolutionStatus()).toMatchObject({
        pendingScaffold: { version: 1, rationale: 'answer in the owner language' }, trial: null, waiting: [],
      });
      expect(await surface.applyScaffoldDecision('rollback')).toEqual({ action: 'rollback', fromVersion: 1, newCurrentVersion: 0 });

      // cf writes v0 as a precondition of its first turn, the CLI at session start: the candidate is the case's.
      const status = await surface.getEvolutionStatus();

      expect(status.pendingScaffold).toBeNull();
      expect(status.versions.find((row) => row.version === 1)?.status).toBe('rolled_back');
      await expect(surface.applyScaffoldDecision('rollback')).rejects.toThrow('no pending scaffold');
    },
  },
  {
    title: 'the changelog tells the owner of a change, undoes it on request, and a look clears the badge',
    covers: ['getEvolutionChangelog', 'revertChangelogEntry', 'markChangelogSeen'],
    async run(backend) {
      const { surface } = backend;
      pendingScaffold(backend, 'answer in the owner language');

      const proposed = await surface.getEvolutionChangelog(10);
      expect(proposed).toMatchObject({ unseenCount: 1, seenAt: 0 });
      expect(proposed.entries.map((entry) => [entry.id, entry.kind, entry.revert])).toEqual([
        ['scaffold:v1:pending', 'scaffold', { type: 'scaffold_rollback', target: '1' }],
      ]);

      expect(await surface.revertChangelogEntry('scaffold:v1:pending')).toEqual({
        ok: true, detail: 'discarded pending v1; current stays v0',
      });
      expect(await surface.revertChangelogEntry('scaffold:v9:pending')).toEqual({
        ok: false, error: 'changelog entry scaffold:v9:pending not found',
      });
      expect((await surface.getEvolutionChangelog(10)).entries.map((entry) => entry.id)).toEqual(['scaffold:v1:rolled_back']);

      const seen = await surface.markChangelogSeen();
      expect(seen).toEqual({ ok: true, seenAt: expect.any(Number) });
      expect(await surface.getEvolutionChangelog(10)).toMatchObject({ unseenCount: 0, seenAt: seen.seenAt });
    },
  },
  {
    title: 'picking the answer given rates it high; picking the other take rates it low and queues a continuation',
    covers: ['latestAlternateTakes', 'pickAlternateTake'],
    async run({ surface, sql, actor }) {
      expect(await surface.latestAlternateTakes()).toBeNull();

      const set = recordBranchTakeSet(sql, actor, {
        task: 'name the release', turnId: 'turn-1', sessionId: CHAT_SESSION_ID,
        liveText: 'Call it Aurora.', branchText: 'Call it Borealis.',
      });

      if (set === null) throw new Error('two different answers make a take set');
      expect(await surface.latestAlternateTakes()).toMatchObject({
        id: set.id, winnerNodeId: `${set.id}-live`, chosenNodeId: null,
        candidates: [{ text: 'Call it Aurora.', origin: 'live' }, { text: 'Call it Borealis.', origin: 'branch' }],
      });

      expect(await surface.pickAlternateTake(set.id, `${set.id}-live`)).toMatchObject({
        changedAnswer: false, continuationQueued: false,
      });
      expect(await surface.pickAlternateTake(set.id, `${set.id}-branch`)).toMatchObject({
        changedAnswer: true, continuationQueued: true, chosen: { text: 'Call it Borealis.' },
      });
      // The picks on a fresh activation were recorded: the turn's effective rating is the low one.
      expect((await surface.listRefinements(5)).debt.turnIds).toEqual(['turn-1']);
      expect(await surface.latestAlternateTakes()).toMatchObject({ chosenNodeId: `${set.id}-branch` });
      await expect(surface.pickAlternateTake(set.id, '')).rejects.toThrow('pickAlternateTake requires takeId and nodeId');
    },
  },
  {
    title: 'a plan under review takes checked annotations, and a verdict hands the next turn off once',
    covers: ['getActivePlanReview', 'savePlanReviewAnnotations', 'decidePlanReview'],
    async run({ surface, sql, actor }) {
      expect(await surface.getActivePlanReview()).toBeNull();
      const submitted = new PlanReviewStore(sql, actor).submit(CHAT_SESSION_ID, [{ start: 1, content: '# Plan\n\n1. Ship it.\n' }]);

      if (!submitted.ok) throw new Error(submitted.error);
      const { id, revision } = submitted.plan;
      expect(await surface.getActivePlanReview()).toMatchObject({ id, revision, status: 'pending', annotations: [] });

      // Annotations are owner input over the wire: a malformed one is refused, not stored.
      const malformed = JSON.parse('[{"id":"a-1","blockId":"b-1","startOffset":0,"endOffset":4,"type":"COMMENT"}]');
      expect(await surface.savePlanReviewAnnotations(id, revision, malformed)).toMatchObject({
        ok: false, error: 'annotation 0 has invalid text or author fields',
      });

      expect(await surface.decidePlanReview(id, revision, 'request_changes', 'smaller steps')).toMatchObject({
        ok: true, queued: true, plan: { status: 'changes_requested', feedback: 'smaller steps', handoffAccepted: true },
      });
      // The handoff was accepted: repeating the verdict does not submit a second turn.
      expect(await surface.decidePlanReview(id, revision, 'request_changes', 'smaller steps')).toMatchObject({
        ok: true, queued: true,
      });
      expect(await surface.decidePlanReview(id, revision + 1, 'approve')).toMatchObject({
        ok: false, error: `stale or unknown plan revision ${id}/${String(revision + 1)}`,
      });
    },
  },
  {
    title: 'a dismissed plan stops awaiting a decision and takes no later verdict',
    covers: ['dismissPlanReview'],
    async run({ surface, sql, actor }) {
      const submitted = new PlanReviewStore(sql, actor).submit(CHAT_SESSION_ID, [{ start: 1, content: '# Plan\n\n1. Ship it.\n' }]);

      if (!submitted.ok) throw new Error(submitted.error);
      const { id, revision } = submitted.plan;
      expect(await surface.dismissPlanReview(id, revision)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
      expect(await surface.getActivePlanReview()).toMatchObject({ id, status: 'dismissed' });
      expect(await surface.decidePlanReview(id, revision, 'approve')).toMatchObject({ ok: false, error: 'plan revision is already dismissed' });
    },
  },
  {
    title: 'a refinement with no rated turns is refused on the record, and an unknown one decides nothing',
    covers: ['requestRefinement', 'listRefinements', 'showRefinement', 'decideRefinement'],
    async run({ surface }) {
      expect(await surface.listRefinements(5)).toMatchObject({
        requests: [], debt: { owed: false, summary: 'no unresolved low-rated turns: nothing is owed a refinement' },
      });

      const request = await surface.requestRefinement({ turnIds: ['turn-1'] });
      expect(request).toMatchObject({
        stage: 'refused', trigger: 'explicit', scope: 'workspace', routes: [],
        detail: 'no outcome-labeled turns yet: chat with the agent first; none of the 1 named turns carries an outcome',
      });
      expect((await surface.listRefinements(5)).requests.map((listed) => [listed.id, listed.stage]))
        .toEqual([[request.id, 'refused']]);

      expect(await surface.showRefinement('refine-nope', 0)).toEqual({ ok: false, error: 'no refinement refine-nope' });
      expect(await surface.decideRefinement({
        requestId: 'refine-nope', routeIndex: 0, expectedDigest: 'digest-nobody-showed', decision: 'reject',
      })).toEqual({ ok: false, error: 'no refinement refine-nope' });
    },
  },
];
