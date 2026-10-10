import { describe, expect, test } from 'bun:test';
import {
  createLiveRefreshAdmission,
  formatWorkspaceError,
  loadWorkspaceSnapshot,
  refreshLiveResource,
  type LiveRefreshAdmission,
  type LiveRefreshErrors,
  type LiveRefreshSource,
} from '@kinu.run/core';
import { explorationForkTree, type MctsProgress } from '@kinu.run/core';
import { pruneSlateReloads } from '@kinu.run/core';
import type { ForkNode } from '@kinu.run/core';
import {
  activateMctsProgressActor,
  applyMctsProgress as applyMctsProgressOrder,
  createMctsProgressState as createProgressState,
  type MctsProgressState,
} from '@kinu.run/core';

test('a fresh Slate list retains reload versions only for listed ids', () => {
  const previous = new Map([['removed', 4], ['kept', 2]]);
  const slates = [{ id: 'kept', title: 'Kept', bindings: [] }];
  const pruned = pruneSlateReloads(previous, slates);
  expect([...pruned]).toEqual([['kept', 2]]);
  expect([...previous]).toEqual([['removed', 4], ['kept', 2]]);
  expect(pruneSlateReloads(pruned, slates)).toBe(pruned);
  expect([...pruneSlateReloads(pruned, [])]).toEqual([]);
});

const TEST_ACTOR = 'actor';

const NEXT_ACTOR = 'next-actor';

function createMctsProgressState(): MctsProgressState<ForkNode> {
  return createProgressState<ForkNode>(TEST_ACTOR);
}

function applyMctsProgress(
  state: MctsProgressState<ForkNode>,
  progress: MctsProgress,
  actorKey = TEST_ACTOR,
): MctsProgressState<ForkNode> {
  return applyMctsProgressOrder(
    state,
    actorKey,
    progress,
    explorationForkTree({ tree: progress.nodes, head: progress.head }),
  );
}

function activeAdmission(): LiveRefreshAdmission {
  const admission = createLiveRefreshAdmission();
  admission.activateActor(TEST_ACTOR);

  return admission;
}

/** A notice as behaviour: how severe, the reason it carries, and whether it offers a retry; never its copy. */
function facts(notice: ReturnType<typeof formatWorkspaceError>): { severity: string; detail: string; retry: boolean } | null {
  return notice === null ? null : { severity: notice.severity, detail: notice.detail, retry: notice.retry !== null };
}

function reporter(initial: LiveRefreshErrors = {}) {
  let errors = initial;

  return {
    get errors() { return errors; },
    report: (source: LiveRefreshSource, message: string | null) => {
      const next = { ...errors };

      if (message === null) delete next[source];
      else next[source] = message;
      errors = next;
    },
  };
}

function mctsProgress(
  rootId: string,
  isolateGen: number,
  pushSeq: number,
  observation: string,
): MctsProgress {
  return {
    type: 'mcts-progress',
    rootId,
    isolateGen,
    pushSeq,
    nodes: [{
      id: rootId,
      parent_id: null,
      root_id: rootId,
      depth: 0,
      visits: 1,
      value: 0.5,
      own_score: 0.5,
      status: 'open',
      action: 'investigate',
      task: `Task for ${rootId}`,
      observation,
    }],
    head: null,
  };
}

describe('MCTS progress admission', () => {
  test('a fresh isolate supersedes its predecessor without admitting either replay', () => {
    const oldIsolate = applyMctsProgress(
      createMctsProgressState(),
      mctsProgress('root', 7, 80, 'the prior isolate observation'),
    );

    const freshIsolate = applyMctsProgress(
      oldIsolate,
      mctsProgress('root', 8, 1, 'the new isolate observation'),
    );

    const delayedPriorIsolate = applyMctsProgress(
      freshIsolate,
      mctsProgress('root', 7, 81, 'a delayed prior-isolate observation'),
    );

    const replay = applyMctsProgress(
      freshIsolate,
      mctsProgress('root', 8, 1, 'the replayed new-isolate observation'),
    );

    expect(freshIsolate.trees.get('root')?.observation).toBe('the new isolate observation');
    expect(freshIsolate.lastPush.get('root')).toEqual({ isolateGen: 8, pushSeq: 1 });
    expect(delayedPriorIsolate).toBe(freshIsolate);
    expect(replay).toBe(freshIsolate);
  });

  test('folds a running journal node and its text into the pushed tree', () => {
    const progress: MctsProgress = {
      ...mctsProgress('root', 1, 1, 'the root observation'),
      head: {
        rootId: 'root',
        task: 'Root investigation',
        rationale: 'Compare the active branches.',
        status: 'running',
        spawnedAt: 1,
        heads: [{
          id: 'running-node',
          parentId: 'root',
          depth: 1,
          task: 'Inspect the slow query',
          rationale: 'It is the only branch with an unexplained wait.',
          status: 'running',
          summary: 'The query is still collecting its observation.',
          errorMessage: null,
          usage: {},
          wallClockMs: 0,
          spawnedAt: 2,
          lastStepAt: null,
          decisions: [],
        }],
        merge: null,
      },
    };

    const state = applyMctsProgress(createMctsProgressState(), progress);

    expect(state.trees.get('root')?.children).toMatchObject([{
      id: 'running-node',
      task: 'Inspect the slow query',
      observation: 'The query is still collecting its observation.',
      status: 'running',
    }]);
  });

  test('two roots admit and reject progress independently', () => {
    const a = applyMctsProgress(createMctsProgressState(), mctsProgress('a', 7, 2, 'a current'));
    const both = applyMctsProgress(a, mctsProgress('b', 7, 1, 'b first'));
    const replayedA = applyMctsProgress(both, mctsProgress('a', 7, 1, 'a stale'));

    expect(replayedA).toBe(both);
    expect([...both.trees].map(([rootId, tree]) => [rootId, tree.observation])).toEqual([
      ['a', 'a current'],
      ['b', 'b first'],
    ]);
  });

  test('an actor switch clears progress ordering and rejects the old actor', () => {
    const previousActor = applyMctsProgress(
      createMctsProgressState(),
      mctsProgress('root', 7, 80, 'the previous actor'),
    );

    const activated = activateMctsProgressActor(previousActor, NEXT_ACTOR);

    const nextActor = applyMctsProgress(
      activated,
      mctsProgress('root', 1, 1, 'the next actor'),
      NEXT_ACTOR,
    );

    const delayedPrevious = applyMctsProgress(
      nextActor,
      mctsProgress('root', 7, 81, 'the delayed previous actor'),
      TEST_ACTOR,
    );

    expect(previousActor.lastPush.get('root')).toEqual({ isolateGen: 7, pushSeq: 80 });
    expect(nextActor.lastPush.get('root')).toEqual({ isolateGen: 1, pushSeq: 1 });
    expect(nextActor.trees.get('root')?.observation).toBe('the next actor');
    expect(delayedPrevious).toBe(nextActor);
  });
});

describe('workspace live refresh failures', () => {

  test('a retained callback from the prior actor cannot admit a new request', async () => {
    const admission = createLiveRefreshAdmission();
    admission.activateActor('actor-a');
    let visible = 'actor-a';
    let requested = false;
    const errors = reporter();

    const refreshFromActorA = () => refreshLiveResource({
      source: 'jobs',
      read: () => {
        requested = true;

        return Promise.resolve('late actor-a result');
      },
      apply: (value) => { visible = value; },
      report: errors.report,
      isCurrent: admission.admit('actor-a', 'jobs'),
    });

    admission.activateActor('actor-b');
    visible = 'actor-b';
    await refreshFromActorA();

    expect(visible).toBe('actor-b');
    expect(requested).toBeFalse();
    expect(formatWorkspaceError(errors.errors, true)).toBeNull();
  });

  test('failures consolidate, and each successful retry clears only its source', async () => {
    const admission = activeAdmission();
    const errors = reporter();
    const keep = () => {};

    await Promise.all([
      refreshLiveResource({
        source: 'executors',
        read: () => Promise.reject('catalog offline'),
        apply: keep,
        report: errors.report,
        isCurrent: admission.admit(TEST_ACTOR, 'executors'),
      }),
      refreshLiveResource({
        source: 'slates',
        read: () => Promise.reject('catalog offline'),
        apply: keep,
        report: errors.report,
        isCurrent: admission.admit(TEST_ACTOR, 'slates'),
      }),
    ]);
    expect(errors.errors).toEqual({ executors: 'catalog offline', slates: 'catalog offline' });
    expect(facts(formatWorkspaceError(errors.errors, true))).toEqual({ severity: 'partial', detail: 'catalog offline', retry: true });
    await refreshLiveResource({
      source: 'executors',
      read: () => Promise.resolve(['ready']),
      apply: keep,
      report: errors.report,
      isCurrent: admission.admit(TEST_ACTOR, 'executors'),
    });
    expect(errors.errors).toEqual({ slates: 'catalog offline' });
    expect(facts(formatWorkspaceError(errors.errors, true))).toEqual({ severity: 'partial', detail: 'catalog offline', retry: true });
    await refreshLiveResource({
      source: 'slates',
      read: () => Promise.resolve(['ready']),
      apply: keep,
      report: errors.report,
      isCurrent: admission.admit(TEST_ACTOR, 'slates'),
    });
    expect(formatWorkspaceError(errors.errors, true)).toBeNull();
  });
});

const CONNECTION_LOST = 'Network connection lost.';

const SEEDED: readonly LiveRefreshSource[] = ['memoryContent', 'executors', 'presence', 'plan'];

describe('resource-scoped workspace notices', () => {
  test('a healthy workspace says nothing at all', () => {
    expect(formatWorkspaceError({}, true)).toBeNull();
    expect(formatWorkspaceError({}, false)).toBeNull();
  });

  test('a failed essential read blocks, with its reason and a retry', () => {
    expect(facts(formatWorkspaceError({ snapshot: CONNECTION_LOST }, false))).toEqual({ severity: 'blocking', detail: CONNECTION_LOST, retry: true });
  });

  test('a failed optional read is partial and never blocks the composer', () => {
    expect(facts(formatWorkspaceError({ executors: 'catalog offline' }, true))).toEqual({ severity: 'partial', detail: 'catalog offline', retry: true });
  });

  test('the essential read wins when both fail', () => {
    expect(facts(formatWorkspaceError({ snapshot: CONNECTION_LOST, executors: 'catalog offline' }, false)))
      .toMatchObject({ severity: 'blocking', retry: true });
  });

  test('inline credentials never reach the technical detail', () => {
    const notice = formatWorkspaceError({ executors: 'provider answered 401 with api_key=sk-live-abc123' }, true);
    expect(notice?.detail).not.toContain('sk-live-abc123');
    expect(notice?.detail).toContain('api_key=<redacted>');
  });
});

describe('loading the workspace snapshot', () => {
  test('a failure reports the bare reason once and hands the retry back to the caller', async () => {
    const errors = reporter();
    const admission = activeAdmission();

    const outcome = await loadWorkspaceSnapshot(
      () => Promise.reject(new Error(CONNECTION_LOST)),
      errors.report,
      (key) => admission.admit(TEST_ACTOR, key),
      SEEDED,
    );

    expect(outcome).toEqual({ failed: CONNECTION_LOST });
    expect(errors.errors.snapshot).toBe(CONNECTION_LOST);
  });

  test('a snapshot that lands clears every surface it re-read', async () => {
    // After a reconnect's reload succeeds, the banner must not report what that reload refreshed.
    const errors = reporter({
      snapshot: CONNECTION_LOST,
      memoryContent: CONNECTION_LOST,
      executors: CONNECTION_LOST,
      jobs: 'the jobs table is still unreachable',
    });

    const admission = activeAdmission();

    const outcome = await loadWorkspaceSnapshot(
      () => Promise.resolve(),
      errors.report,
      (key) => admission.admit(TEST_ACTOR, key),
      SEEDED,
    );

    expect(outcome).toBe('loaded');
    // Only the surface the snapshot did not re-read is still reported.
    expect(errors.errors).toEqual({ jobs: 'the jobs table is still unreachable' });
  });

  test('a snapshot cannot clear a failure a newer read of that surface reported', async () => {
    const errors = reporter();
    const admission = activeAdmission();
    const snapshotRead = Promise.withResolvers<void>();

    const loading = loadWorkspaceSnapshot(
      () => snapshotRead.promise,
      errors.report,
      (key) => admission.admit(TEST_ACTOR, key),
      SEEDED,
    );

    await refreshLiveResource({
      source: 'memoryContent',
      read: () => Promise.reject(new Error('MEMORY.md is unreadable')),
      apply: () => {},
      report: errors.report,
      isCurrent: admission.admit(TEST_ACTOR, 'memoryContent'),
    });
    snapshotRead.resolve(undefined);

    expect(await loading).toBe('loaded');
    expect(errors.errors.memoryContent).toBe('MEMORY.md is unreadable');
    expect(errors.errors.snapshot).toBeUndefined();
  });

  test('a slow snapshot cannot replace data from a newer surface refresh', async () => {
    const errors = reporter();
    const admission = activeAdmission();
    const snapshotRead = Promise.withResolvers<string>();
    let memoryContent = 'before either read';

    const loading = loadWorkspaceSnapshot(
      async (
        isCurrent,
        isSourceCurrent: (source: LiveRefreshSource) => boolean,
      ) => {
        const value = await snapshotRead.promise;

        if (!isCurrent()) return;

        if (isSourceCurrent('memoryContent')) memoryContent = value;
      },
      errors.report,
      (key) => admission.admit(TEST_ACTOR, key),
      SEEDED,
    );

    await refreshLiveResource({
      source: 'memoryContent',
      read: () => Promise.resolve('current memory'),
      apply: (value) => { memoryContent = value; },
      report: errors.report,
      isCurrent: admission.admit(TEST_ACTOR, 'memoryContent'),
    });
    expect(memoryContent).toBe('current memory');

    snapshotRead.resolve('stale snapshot');

    expect(await loading).toBe('loaded');
    expect(memoryContent).toBe('current memory');
  });

  test('a snapshot that failed after a newer one landed reports nothing', async () => {
    const errors = reporter();
    const admission = activeAdmission();
    const older = Promise.withResolvers<void>();
    const newer = Promise.withResolvers<void>();

    const olderLoad = loadWorkspaceSnapshot(
      () => older.promise, errors.report, (key) => admission.admit(TEST_ACTOR, key), SEEDED,
    );

    const newerLoad = loadWorkspaceSnapshot(
      () => newer.promise, errors.report, (key) => admission.admit(TEST_ACTOR, key), SEEDED,
    );

    newer.resolve(undefined);
    expect(await newerLoad).toBe('loaded');
    older.reject(new Error(CONNECTION_LOST));

    expect(await olderLoad).toBe('superseded');
    expect(errors.errors.snapshot).toBeUndefined();
  });

  test('a snapshot admitted for the workspace the reader left reports against neither', async () => {
    const errors = reporter();
    const admission = createLiveRefreshAdmission();
    admission.activateActor('left-behind');
    const read = Promise.withResolvers<void>();

    const loading = loadWorkspaceSnapshot(
      () => read.promise, errors.report, (key) => admission.admit('left-behind', key), SEEDED,
    );

    admission.activateActor('opened-next');
    read.reject(new Error(CONNECTION_LOST));

    expect(await loading).toBe('superseded');
    expect(errors.errors).toEqual({});
  });
});
