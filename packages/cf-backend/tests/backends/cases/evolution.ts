/** How the agent changes itself, as the owner sees and overrules it. */
import { expect, setSystemTime } from 'bun:test';
import * as v from 'valibot';
import { exists, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import {
  CHAT_SESSION_ID, PlanReviewStore, createRefinementStore, instructionDigest, recordBranchTakeSet, refinementStagingPath,
  sectionArtifact, stageArtifact, workspaceSkillPath,
} from '@kinu.run/core';
import type { SharedBackend } from '../backend';
import { PROMPT_SECTIONS } from '../../../../core/src/prompting/section-templates';
import type { SharedCase } from '../cases';

/** A scaffold proposal waiting for the owner, as the proposer leaves one. */
function pendingScaffold({ sql, actor }: SharedBackend, rationale: string): void {
  void sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${actor.actorId}, 1, ${Date.now()}, ${rationale}, 'pending')`;
}

export const EVOLUTION_CASES: readonly SharedCase[] = [
  {
    title: 'the agent\'s learning setting is the one switch: off, a turn records nothing; back on, the next one is recorded',
    async run({ surface, sql, actor }) {
      const recorded = () => sql<{ turn: string }>`SELECT turn FROM completed_turns WHERE actor_id = ${actor.actorId}`
        .map((row) => v.parse(v.object({ userMessage: v.string() }), JSON.parse(row.turn)).userMessage);

      // Both backends read the setting where a turn opens, and a send resolves once its turn has run.
      actor.config.setLearning(false);
      await surface.send('first');
      actor.config.setLearning(true);
      await surface.send('second');

      // A turn is recorded inline as it settles: the first had its chance, and the second was taken.
      expect(recorded()).toEqual(['second']);
    },
  },
  {
    title: 'an edit staged meanwhile moves the prompt prefix only at a turn whose cache is cold; the owner\'s revert, at once',
    async run({ surface, sql, actor, requests }) {
      const artifactId = sectionArtifact('guidance/operating');
      const edited = `${PROMPT_SECTIONS.find((section) => section.id === 'guidance/operating')?.source.trimEnd() ?? ''} Be brief.`;

      // What the provider caches: the system prompt and the tools, by the turn whose words close the request.
      const prefixOf = (text: string): string => {
        const request = requests().find((asked) => JSON.stringify(asked.prompt.at(-1)?.content).includes(`"${text}"`));

        if (request === undefined) throw new Error(`no request answered '${text}'`);

        return JSON.stringify({ system: request.prompt.filter((message) => message.role === 'system'), tools: request.tools });
      };

      // Past every cache lifetime and any warming: the next turn opens cold.
      const pause = () => { setSystemTime(new Date(Date.now() + 3 * 60 * 60_000)); };

      try {
        await surface.send('first');
        stageArtifact(sql, actor, { artifactId, body: edited, rationale: 'r', evidence: { turns: ['t'], reason: 'verbose_or_slow' } });
        await surface.send('second');
        pause();
        await surface.send('third');
        await surface.send('fourth');
        const changelog = await surface.getEvolutionChangelog(10);
        const current = changelog.entries.find((entry) => entry.kind === 'artifact' && entry.revert !== undefined);

        if (current === undefined) throw new Error('the activated edit has no revertable changelog entry');
        expect(await surface.revertChangelogEntry(current.id)).toMatchObject({ ok: true });
        await surface.send('fifth');
      } finally {
        setSystemTime();
      }

      // A warm turn's prefix is its segment's, byte for byte, whatever was staged; the cold one takes the edit.
      expect(prefixOf('second')).toBe(prefixOf('first'));
      expect(prefixOf('third')).not.toBe(prefixOf('first'));
      expect(prefixOf('third')).toContain('Be brief.');
      expect(prefixOf('fourth')).toBe(prefixOf('third'));
      // The owner's revert is the one move that does not wait.
      expect(prefixOf('fifth')).toBe(prefixOf('first'));
    },
  },
  {
    title: 'a dream\'s skill joins the skills index only at a turn whose cache is cold; the owner\'s revert removes it at once',
    async run({ surface, sql, actor, files, requests }) {
      const skill = '---\nname: terse-replies\ndescription: Answer in one short line when the owner asks a yes-or-no question.\n---\nOne line.\n';
      const target = workspaceSkillPath('terse-replies');
      const store = createRefinementStore(sql, actor);

      const prefixOf = (text: string): string => {
        const request = requests().find((asked) => JSON.stringify(asked.prompt.at(-1)?.content).includes(`"${text}"`));

        if (request === undefined) throw new Error(`no request answered '${text}'`);

        return JSON.stringify(request.prompt.filter((message) => message.role === 'system'));
      };

      const pause = () => { setSystemTime(new Date(Date.now() + 3 * 60 * 60_000)); };

      try {
        await surface.send('first');
        // A dream's accepted skill, as its route leaves it: staged where no prompt reads it.
        const { request } = store.open({ trigger: 'explicit', scope: 'workspace', turnIds: ['turn-dreamt'] });
        await writeText(files, refinementStagingPath(request.id, 'terse-replies'), skill);
        store.advance(request.id, 'requested', 'evaluating', {
          routes: [{ kind: 'skill', owner: 'instruction_approvals', target, disposition: 'staged', digest: instructionDigest(skill), reason: 'r' }],
        });
        await surface.send('second');
        pause();
        await surface.send('third');
        await surface.send('fourth');
        expect(await surface.revertChangelogEntry(`refinement:${request.id}:0`)).toEqual({ ok: true, detail: `removed ${target} and revoked its trust` });
        await surface.send('fifth');
      } finally {
        setSystemTime();
      }

      expect(prefixOf('second')).toBe(prefixOf('first'));
      expect(prefixOf('second')).not.toContain('**terse-replies**');
      expect(prefixOf('third')).toContain('**terse-replies**');
      expect(prefixOf('fourth')).toBe(prefixOf('third'));
      expect(prefixOf('fifth')).not.toContain('**terse-replies**');
      expect(await exists(files, target)).toBe(false);
    },
  },
  {
    title: 'a proposed scaffold waits for the owner, who can roll it back',
    async run(backend) {
      const { surface } = backend;
      pendingScaffold(backend, 'answer in the owner language');

      expect(await surface.getEvolutionStatus()).toMatchObject({
        pendingScaffold: { version: 1, rationale: 'answer in the owner language' }, waiting: [],
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
    async run({ surface, chat }) {
      expect(await surface.getActivePlanReview()).toBeNull();
      const submitted = new PlanReviewStore(chat.sql, chat.actor).submit(CHAT_SESSION_ID, [{ start: 1, content: '# Plan\n\n1. Ship it.\n' }]);

      if (!submitted.ok) throw new Error(submitted.error);
      const { id, revision } = submitted.plan;
      expect(await surface.getActivePlanReview()).toMatchObject({ id, revision, status: 'pending', annotations: [] });

      // Annotations are owner input over the wire: a malformed one is refused, not stored.
      const malformed = JSON.parse('[{"id":"a-1","blockId":"b-1","startOffset":0,"endOffset":4,"type":"COMMENT"}]');
      expect(await surface.savePlanReviewAnnotations(id, revision, malformed)).toMatchObject({
        ok: false, error: expect.stringContaining('annotation 0: '),
      });

      // A comment on a passage and one on the whole plan, which has no block to sit on, are both sent.
      expect(await surface.savePlanReviewAnnotations(id, revision, [
        { id: 'a-1', type: 'COMMENT', blockId: 'b-1', startOffset: 3, endOffset: 7, originalText: 'Ship', text: 'Which branch?', createdA: 1 },
        { id: 'a-2', type: 'GLOBAL_COMMENT', text: 'smaller steps', createdA: 2 },
      ])).toMatchObject({ ok: true });

      const decided = await surface.decidePlanReview(id, revision, 'request_changes');

      expect(decided).toMatchObject({ ok: true, queued: true, plan: { status: 'changes_requested', handoffAccepted: true } });

      for (const said of ['a-1', 'Which branch?', 'a-2', 'smaller steps']) expect('plan' in decided ? decided.plan?.feedback : null).toContain(said);

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
    async run({ surface, chat }) {
      const submitted = new PlanReviewStore(chat.sql, chat.actor).submit(CHAT_SESSION_ID, [{ start: 1, content: '# Plan\n\n1. Ship it.\n' }]);

      if (!submitted.ok) throw new Error(submitted.error);
      const { id, revision } = submitted.plan;
      expect(await surface.dismissPlanReview(id, revision)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
      expect(await surface.getActivePlanReview()).toMatchObject({ id, status: 'dismissed' });
      expect(await surface.decidePlanReview(id, revision, 'approve')).toMatchObject({ ok: false, error: 'plan revision is already dismissed' });
    },
  },
  {
    title: 'a refinement with no rated turns is refused on the record',
    async run({ surface }) {
      expect(await surface.listRefinements(5)).toMatchObject({
        requests: [], debt: { owed: false, summary: 'no new rated turns since the last dream' },
      });

      const request = await surface.requestRefinement({ turnIds: ['turn-1'] });
      expect(request).toMatchObject({
        stage: 'refused', trigger: 'explicit', scope: 'workspace', routes: [],
        detail: 'no outcome-labeled turns yet: chat with the agent first; none of the 1 named turns carries an outcome',
      });
      expect((await surface.listRefinements(5)).requests.map((listed) => [listed.id, listed.stage]))
        .toEqual([[request.id, 'refused']]);
    },
  },
];
