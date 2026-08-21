import { describe, expect, test } from 'bun:test';
import {
  createLiveRefreshAdmission,
  formatLiveRefreshError,
  refreshLiveResource,
  resolvePendingConsent,
  type LiveRefreshErrors,
  type LiveRefreshSource,
} from '../src/hooks/use-kinu';

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise = (_value: Value): void => { throw new Error('Deferred promise was not initialized'); };
  let rejectPromise = (_error: Error): void => { throw new Error('Deferred promise was not initialized'); };
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const TEST_ACTOR = 'actor';

function activeAdmission(): ReturnType<typeof createLiveRefreshAdmission> {
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

describe('workspace live refresh failures', () => {
  test('an older completion cannot replace data from a newer refresh', async () => {
    const admission = activeAdmission();
    const older = deferred<string>();
    const newer = deferred<string>();
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
    const older = deferred<string>();
    const newer = deferred<string>();
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
    const priorActor = deferred<string>();
    const nextActor = deferred<string>();
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
    expect(formatLiveRefreshError(errors.errors)).toBeNull();
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
    expect(formatLiveRefreshError(errors.errors)).toBeNull();
  });

  test('all polled surfaces share one stable, non-spammy failure message', () => {
    expect(formatLiveRefreshError({
      jobs: 'offline',
      pendingActions: 'offline',
      mcts: 'offline',
      memoryContent: 'offline',
      tools: 'offline',
      executors: 'offline',
      views: 'offline',
      consents: 'offline',
      plan: 'offline',
    })).toBe(
      "Couldn't refresh live data for background jobs, pending actions, MCTS, memory content, tools, executors, agent views, device consents, and active plan. Showing last known data. offline",
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
    expect(formatLiveRefreshError(errors.errors)).toBe(
      "Couldn't refresh live data for background jobs. Showing last known data. jobs RPC unavailable",
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
    expect(formatLiveRefreshError(errors.errors)).toBe(
      "Couldn't refresh live data for tools and agent views. Showing last known data. catalog offline",
    );

    await refreshLiveResource(
      'tools',
      () => Promise.resolve(['ready']),
      keep,
      errors.report,
      admission.admit(TEST_ACTOR, 'tools'),
    );
    expect(formatLiveRefreshError(errors.errors)).toBe(
      "Couldn't refresh live data for agent views. Showing last known data. catalog offline",
    );

    await refreshLiveResource(
      'views',
      () => Promise.resolve(['ready']),
      keep,
      errors.report,
      admission.admit(TEST_ACTOR, 'views'),
    );
    expect(formatLiveRefreshError(errors.errors)).toBeNull();
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
    const first = deferred<void>();
    const second = deferred<void>();
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
