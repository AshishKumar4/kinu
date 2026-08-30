import { describe, expect, test } from 'bun:test';
import {
  applyMctsProgress,
  createLiveRefreshAdmission,
  createMctsProgressState,
  formatWorkspaceError,
  loadWorkspaceSnapshot,
  refreshLiveResource,
  resolvePendingConsent,
  type LiveRefreshAdmission,
  type LiveRefreshErrors,
  type LiveRefreshSource,
  type MctsProgress,
} from '../src/hooks/use-kinu';

const TEST_ACTOR = 'actor';

function activeAdmission(): LiveRefreshAdmission {
  const admission = createLiveRefreshAdmission();
  admission.activateActor(TEST_ACTOR);
  return admission;
}

function reporter(initial: LiveRefreshErrors = {}) {
  let errors = initial;
  return {
    get errors() { return errors; },
    report(source: LiveRefreshSource, message: string | null) {
      const next = { ...errors };
      if (message === null) delete next[source];
      else next[source] = message;
      errors = next;
    },
  };
}

function consentReporter(initial: ReadonlyMap<string, string> = new Map()) {
  let errors = new Map(initial);
  return {
    get errors() { return errors; },
    report(consentId: string, message: string | null) {
      const next = new Map(errors);
      if (message === null) next.delete(consentId);
      else next.set(consentId, message);
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

  test('an actor switch clears progress ordering for the next actor', () => {
    const previousActor = applyMctsProgress(
      createMctsProgressState(),
      mctsProgress('root', 7, 80, 'the previous actor'),
    );
    const nextActor = applyMctsProgress(
      createMctsProgressState(),
      mctsProgress('root', 1, 1, 'the next actor'),
    );

    expect(previousActor.lastPush.get('root')).toEqual({ isolateGen: 7, pushSeq: 80 });
    expect(nextActor.lastPush.get('root')).toEqual({ isolateGen: 1, pushSeq: 1 });
    expect(nextActor.trees.get('root')?.observation).toBe('the next actor');
  });
});

describe('workspace live refresh failures', () => {
  test('an older completion cannot replace data from a newer refresh', async () => {
    const admission = activeAdmission();
    const older = Promise.withResolvers<string>();
    const newer = Promise.withResolvers<string>();
    let visible = 'stale';
    const errors = reporter();
    const olderRefresh = refreshLiveResource(
      'jobs',
      () => older.promise,
      (value) => { visible = value; },
      errors.report,
      admission.admit(TEST_ACTOR, 'jobs'),
    );
    const newerRefresh = refreshLiveResource(
      'jobs',
      () => newer.promise,
      (value) => { visible = value; },
      errors.report,
      admission.admit(TEST_ACTOR, 'jobs'),
    );

    newer.resolve('newer');
    await newerRefresh;
    older.resolve('older');
    await olderRefresh;

    expect(visible).toBe('newer');
  });

  test('an older failure cannot replace the successful state of a newer refresh', async () => {
    const admission = activeAdmission();
    const older = Promise.withResolvers<string>();
    const newer = Promise.withResolvers<string>();
    let visible = 'stale';
    const errors = reporter({ jobs: 'prior failure' });
    const olderRefresh = refreshLiveResource(
      'jobs',
      () => older.promise,
      (value) => { visible = value; },
      errors.report,
      admission.admit(TEST_ACTOR, 'jobs'),
    );
    const newerRefresh = refreshLiveResource(
      'jobs',
      () => newer.promise,
      (value) => { visible = value; },
      errors.report,
      admission.admit(TEST_ACTOR, 'jobs'),
    );

    newer.resolve('newer');
    await newerRefresh;
    older.reject(new Error('older request failed'));
    await olderRefresh;

    expect(visible).toBe('newer');
    expect(errors.errors.jobs).toBeUndefined();
  });

  test('a completion admitted for the prior actor cannot repopulate the next actor', async () => {
    const admission = createLiveRefreshAdmission();
    admission.activateActor('prior-actor');
    const priorActor = Promise.withResolvers<string>();
    const nextActor = Promise.withResolvers<string>();
    let visible = 'stale';
    const errors = reporter();
    const priorRefresh = refreshLiveResource(
      'jobs',
      () => priorActor.promise,
      (value) => { visible = value; },
      errors.report,
      admission.admit('prior-actor', 'jobs'),
    );

    admission.activateActor('next-actor');
    visible = 'cleared';
    const nextRefresh = refreshLiveResource(
      'jobs',
      () => nextActor.promise,
      (value) => { visible = value; },
      errors.report,
      admission.admit('next-actor', 'jobs'),
    );
    nextActor.resolve('next actor');
    await nextRefresh;
    priorActor.resolve('prior actor');
    await priorRefresh;

    expect(visible).toBe('next actor');
    expect(formatWorkspaceError(errors.errors, true)).toBeNull();
  });

  test('a retained callback from the prior actor cannot admit a new request', async () => {
    const admission = createLiveRefreshAdmission();
    admission.activateActor('actor-a');
    let visible = 'actor-a';
    let requested = false;
    const errors = reporter();
    const refreshFromActorA = () => refreshLiveResource(
      'jobs',
      () => {
        requested = true;
        return Promise.resolve('late actor-a result');
      },
      (value) => { visible = value; },
      errors.report,
      admission.admit('actor-a', 'jobs'),
    );

    admission.activateActor('actor-b');
    visible = 'actor-b';
    await refreshFromActorA();

    expect(visible).toBe('actor-b');
    expect(requested).toBeFalse();
    expect(formatWorkspaceError(errors.errors, true)).toBeNull();
  });

  test('all polled surfaces share one stable, non-spammy failure message', () => {
    expect(formatWorkspaceError({
      jobs: 'offline',
      pendingActions: 'offline',
      mcts: 'offline',
      memoryContent: 'offline',
      tools: 'offline',
      executors: 'offline',
      views: 'offline',
      consents: 'offline',
      plan: 'offline',
    }, true)).toBe(
      "Couldn't refresh background jobs, pending actions, MCTS, memory content, tools, executors, agent views, device consents, and active plan. Showing last known data. offline",
    );
  });

  test('a failed refresh retains stale data and reports one actionable error', async () => {
    let jobs = ['already visible'];
    const admission = activeAdmission();
    const errors = reporter();

    await refreshLiveResource(
      'jobs',
      () => Promise.reject(new Error('jobs RPC unavailable')),
      (next: string[]) => { jobs = next; },
      errors.report,
      admission.admit(TEST_ACTOR, 'jobs'),
    );

    expect(jobs).toEqual(['already visible']);
    expect(formatWorkspaceError(errors.errors, true)).toBe(
      "Couldn't refresh background jobs. Showing last known data. jobs RPC unavailable",
    );
  });

  test('failures consolidate, and each successful retry clears only its source', async () => {
    const admission = activeAdmission();
    const errors = reporter();
    const keep = () => {};
    await Promise.all([
      refreshLiveResource(
        'tools',
        () => Promise.reject('catalog offline'),
        keep,
        errors.report,
        admission.admit(TEST_ACTOR, 'tools'),
      ),
      refreshLiveResource(
        'views',
        () => Promise.reject('catalog offline'),
        keep,
        errors.report,
        admission.admit(TEST_ACTOR, 'views'),
      ),
    ]);
    expect(formatWorkspaceError(errors.errors, true)).toBe(
      "Couldn't refresh tools and agent views. Showing last known data. catalog offline",
    );

    await refreshLiveResource(
      'tools',
      () => Promise.resolve(['ready']),
      keep,
      errors.report,
      admission.admit(TEST_ACTOR, 'tools'),
    );
    expect(formatWorkspaceError(errors.errors, true)).toBe(
      "Couldn't refresh agent views. Showing last known data. catalog offline",
    );

    await refreshLiveResource(
      'views',
      () => Promise.resolve(['ready']),
      keep,
      errors.report,
      admission.admit(TEST_ACTOR, 'views'),
    );
    expect(formatWorkspaceError(errors.errors, true)).toBeNull();
  });
});

/** The reason a dropped cross-object call surfaces as, verbatim. */
const CONNECTION_LOST = 'Network connection lost.';

/** The surfaces `loadAllData` re-seeds, as the hook passes them. */
const SEEDED: readonly LiveRefreshSource[] = ['memoryContent', 'tools', 'executors', 'presence', 'plan'];

describe('the workspace banner', () => {
  test('one dropped connection is one reason, printed once', () => {
    // The line an owner reported, verbatim:
    //   Workspace snapshot failed: Network connection lost. Couldn't refresh
    //   live data for memory content. Showing last known data. Network
    //   connection lost.
    const line = formatWorkspaceError(
      { snapshot: CONNECTION_LOST, memoryContent: CONNECTION_LOST },
      true,
    );

    // The snapshot re-reads memory content itself, so one dropped round trip
    // is one surface with one reason — not the workspace plus each thing in it.
    expect(line).toBe("Couldn't refresh this workspace. Showing last known data. Network connection lost.");
    expect(line?.split(CONNECTION_LOST).length).toBe(2);
  });

  test('a surface that failed for a reason of its own keeps its name beside the workspace', () => {
    expect(formatWorkspaceError(
      { snapshot: CONNECTION_LOST, memoryContent: 'MEMORY.md is unreadable' },
      true,
    )).toBe(
      "Couldn't refresh this workspace and memory content. Showing last known data."
      + ' Network connection lost. MEMORY.md is unreadable',
    );
  });

  test('a workspace with nothing on screen says it could not open, never that it is showing stale data', () => {
    const line = formatWorkspaceError(
      { snapshot: CONNECTION_LOST, memoryContent: CONNECTION_LOST },
      false,
    );

    expect(line).toBe("Couldn't open this workspace. Network connection lost.");
    expect(line).not.toContain('last known data');
  });

  test('an initial failure and a refresh failure are different claims about the same reason', () => {
    const errors = { snapshot: 'the workspace is asleep' };

    expect(formatWorkspaceError(errors, false)).not.toBe(formatWorkspaceError(errors, true));
  });

  test('a failed action the user asked for keeps its own sentence', () => {
    expect(formatWorkspaceError({ model: "Couldn't switch model: rejected" }, true))
      .toBe("Couldn't switch model: rejected");
    expect(formatWorkspaceError({ model: "Couldn't switch model: rejected", jobs: 'offline' }, true))
      .toBe(
        "Couldn't switch model: rejected"
        + " Couldn't refresh background jobs. Showing last known data. offline",
      );
  });

  test('a healthy workspace says nothing at all', () => {
    expect(formatWorkspaceError({}, true)).toBeNull();
    expect(formatWorkspaceError({}, false)).toBeNull();
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
    // What a reconnect settles: the socket dropped, the 5s poll failed on the
    // way down, then the reload succeeded. The banner must not keep reporting
    // stale memory content the same round trip just refreshed.
    const errors = reporter({
      snapshot: CONNECTION_LOST,
      memoryContent: CONNECTION_LOST,
      tools: CONNECTION_LOST,
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
    expect(formatWorkspaceError(errors.errors, true)).toBe(
      "Couldn't refresh background jobs. Showing last known data."
      + ' the jobs table is still unreachable',
    );
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
    await refreshLiveResource(
      'memoryContent',
      () => Promise.reject(new Error('MEMORY.md is unreadable')),
      () => {},
      errors.report,
      admission.admit(TEST_ACTOR, 'memoryContent'),
    );
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
    await refreshLiveResource(
      'memoryContent',
      () => Promise.resolve('current memory'),
      (value) => { memoryContent = value; },
      errors.report,
      admission.admit(TEST_ACTOR, 'memoryContent'),
    );
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

describe('device consent resolution', () => {
  test('a rejected resolution keeps the consent visible and reports the failure', async () => {
    const pending = ['consent-1'];
    const admission = activeAdmission();
    const resolutionErrors = consentReporter();
    const refreshErrors = reporter();

    await resolvePendingConsent(
      'consent-1',
      'once',
      () => Promise.reject(new Error('device hub unavailable')),
      (id) => pending.splice(pending.indexOf(id), 1),
      resolutionErrors.report,
      admission.admit(TEST_ACTOR, 'consentResolution:consent-1'),
    );

    expect(pending).toEqual(['consent-1']);
    expect(resolutionErrors.errors.get('consent-1')).toBe('device hub unavailable');

    await refreshLiveResource(
      'consents',
      () => Promise.resolve(['consent-1']),
      () => {},
      refreshErrors.report,
      admission.admit(TEST_ACTOR, 'consents'),
    );
    expect(resolutionErrors.errors.get('consent-1')).toBe('device hub unavailable');
  });

  test('a successful resolution removes the card and clears its prior error', async () => {
    const pending = ['consent-1'];
    const admission = activeAdmission();
    const errors = consentReporter(new Map([['consent-1', 'previous failure']]));

    await resolvePendingConsent(
      'consent-1',
      'always',
      () => Promise.resolve(),
      (id) => pending.splice(pending.indexOf(id), 1),
      errors.report,
      admission.admit(TEST_ACTOR, 'consentResolution:consent-1'),
    );

    expect(pending).toEqual([]);
    expect(errors.errors.get('consent-1')).toBeUndefined();
  });

  test('simultaneous decisions for different consent ids remain independent', async () => {
    const pending = ['consent-1', 'consent-2'];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const admission = activeAdmission();
    const errors = consentReporter();
    const remove = (id: string) => pending.splice(pending.indexOf(id), 1);
    const firstResolution = resolvePendingConsent(
      'consent-1',
      'once',
      () => first.promise,
      remove,
      errors.report,
      admission.admit(TEST_ACTOR, 'consentResolution:consent-1'),
    );
    const secondResolution = resolvePendingConsent(
      'consent-2',
      'deny',
      () => second.promise,
      remove,
      errors.report,
      admission.admit(TEST_ACTOR, 'consentResolution:consent-2'),
    );

    first.reject(new Error('consent-1 unavailable'));
    await firstResolution;
    second.resolve(undefined);
    await secondResolution;

    expect(pending).toEqual(['consent-1']);
    expect(errors.errors.get('consent-1')).toBe('consent-1 unavailable');
  });
});
