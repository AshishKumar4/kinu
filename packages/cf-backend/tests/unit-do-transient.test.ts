// A call that crosses into a Durable Object can fail for reasons that belong to
// the platform rather than to the request — a dropped connection, a deploy
// superseding the callee's isolate. These pin what the retry seam does with each
// class, that the classes it must NOT touch are untouched, and that the paths
// every request passes through survive one drop.
//
// The set of re-attemptable reset strings is not retyped here: it is read out of
// PLATFORM_CATALOG['do.reset.transient'], the entry the classifier cites, so the
// two cannot drift apart.
import { describe, test, expect } from 'bun:test';
import { PLATFORM_CATALOG } from '@kinu/core';
import { retryTransientDO, classifyTransientDO } from '../src/lib/do-rpc';
import { claimOwnedWorkspace } from '../src/user/workspace-access';

const USER = '0123456789abcdef0123456789abcdef';
const CONNECTION_LOST = 'Network connection lost.';

/** A call that fails `failures` times with `error`, then succeeds. Counts calls
 *  so "retried" is proven by attempts, never inferred from the outcome. */
function flaky<T>(failures: number, error: Error, value: T) {
  let seen = 0;
  return {
    call: async () => {
      if (seen++ < failures) throw error;
      return value;
    },
    calls: () => seen,
  };
}

describe('classifyTransientDO — which failures belong to the platform', () => {
  // The catalog entry is the source of truth for this class. If someone adds a
  // fourth observable string to it, this fails until the matcher learns it.
  test('every reset string do.reset.transient declares is classified transient', () => {
    const observables = PLATFORM_CATALOG['do.reset.transient'].observable;
    expect(observables.length).toBeGreaterThan(0);
    for (const { message } of observables) {
      expect(classifyTransientDO({ cause: new Error(message) })).not.toBeNull();
    }
  });

  test('a dropped connection is a platform transient', () => {
    expect(classifyTransientDO({ cause: new Error(CONNECTION_LOST) })).toBe('connection_lost');
  });

  test('a superseded script is a platform transient', () => {
    expect(classifyTransientDO({ cause: new Error(
      'This script has been upgraded. Please send a new request to connect to the new version.',
    ) })).toBe('superseded_isolate');
  });

  test('the platform signal survives a wrapper that kept only message and cause', () => {
    const wrapped = new Error('SQL query failed', { cause: new Error(CONNECTION_LOST) });
    expect(classifyTransientDO({ cause: wrapped })).toBe('connection_lost');
  });

  test('the retryable flag is read at any depth, not just on top', () => {
    const flagged = Object.assign(new Error('storage went away'), { retryable: true });
    expect(classifyTransientDO({ cause: new Error('wrapped', { cause: flagged }) }))
      .toBe('retryable_flag');
  });

  test('an application error is not a transient', () => {
    expect(classifyTransientDO({ cause: new Error('workspace is owned by a different user') })).toBeNull();
    expect(classifyTransientDO({ cause: new Error('no such table: workspace_identity') })).toBeNull();
  });

  test('an overloaded object is not a transient — retrying is what overloaded it', () => {
    const overloaded = Object.assign(new Error('Durable Object is overloaded.'),
      { retryable: true, overloaded: true });
    expect(classifyTransientDO({ cause: overloaded })).toBeNull();
  });

  test('a memory-limit reset is not a transient — it recurs on retry', () => {
    expect(classifyTransientDO({ cause: new Error(
      "Durable Object's isolate exceeded its memory limit and was reset.",
    ) })).toBeNull();
  });

  test('a cyclic cause chain terminates', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(classifyTransientDO({ cause: a })).toBeNull();
  });

  // The platform surfaces these as Errors; a thrown string is unclassifiable
  // here for the same reason it is in classifyErrorCode, rather than a crash.
  test('a non-error throw is unclassifiable, not a crash', () => {
    expect(classifyTransientDO({ cause: CONNECTION_LOST })).toBeNull();
    expect(classifyTransientDO({ cause: null })).toBeNull();
    expect(classifyTransientDO({ cause: undefined })).toBeNull();
    expect(classifyTransientDO({ cause: 42 })).toBeNull();
  });
});

describe('retryTransientDO', () => {
  test('a dropped connection is retried and the call succeeds', async () => {
    const flake = flaky(1, new Error(CONNECTION_LOST), 'ok');
    await expect(retryTransientDO('t', flake.call)).resolves.toBe('ok');
    expect(flake.calls()).toBe(2);
  });

  test('a deploy that superseded the callee is retried', async () => {
    const flake = flaky(1, new Error('Durable Object reset because its code was updated.'), 'ok');
    await expect(retryTransientDO('t', flake.call)).resolves.toBe('ok');
    expect(flake.calls()).toBe(2);
  });

  test('an application error is not retried', async () => {
    const flake = flaky(1, new Error('workspace is owned by a different user'), 'ok');
    await expect(retryTransientDO('t', flake.call)).rejects.toThrow(/different user/);
    expect(flake.calls()).toBe(1);
  });

  test('an overloaded object is not retried', async () => {
    const flake = flaky(1,
      Object.assign(new Error('Durable Object is overloaded.'), { retryable: true, overloaded: true }),
      'ok');
    await expect(retryTransientDO('t', flake.call)).rejects.toThrow(/overloaded/);
    expect(flake.calls()).toBe(1);
  });

  test('a transient that outlives the attempts throws unchanged, so callers report it', async () => {
    const flake = flaky(Infinity, new Error(CONNECTION_LOST), 'ok');
    await expect(retryTransientDO('t', flake.call)).rejects.toThrow(/Network connection lost/);
    expect(flake.calls()).toBe(3);
  });
});

describe('claimOwnedWorkspace — the gate on every authenticated workspace request', () => {
  function envWith(opts: {
    dropHasWorkspace?: number;
    claimError?: Error;
    capabilityError?: Error;
  }): Env {
    const membership = flaky(opts.dropHasWorkspace ?? 0, new Error(CONNECTION_LOST), true);
    const partial: Partial<Env> = {};
    Object.assign(partial, {
      CREDENTIAL_ENCRYPTION_KEY: 'test-owner-secret',
      UserDO: {
        idFromName: (name: string) => name,
        get: () => ({
          hasWorkspace: () => membership.call(),
          async ensureWorkspaceCapability() {
            if (opts.capabilityError) throw opts.capabilityError;
          },
        }),
      },
      OrchestratorAgent: {
        idFromName: (name: string) => name,
        get: () => ({
          async claimOwner() {
            if (opts.claimError) throw opts.claimError;
            return { owner: USER, capabilityHash: 'h' };
          },
        }),
      },
    });
    // SAFETY: this harness constructs the whole Env it returns, and
    // claimOwnedWorkspace reads only the owner secret and the two namespace
    // bindings built above, calling only the three RPCs stubbed on them.
    return partial as Env;
  }

  test('one dropped membership read does not fail the request', async () => {
    const result = await claimOwnedWorkspace(envWith({ dropHasWorkspace: 1 }), USER, 'jarvis');
    expect(result.ok).toBe(true);
  });

  test('a platform failure that persists reports 503, not 500', async () => {
    const result = await claimOwnedWorkspace(
      envWith({ claimError: new Error(CONNECTION_LOST) }), USER, 'jarvis');
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  test('a genuine ownership collision still reports 403', async () => {
    const result = await claimOwnedWorkspace(
      envWith({ claimError: new Error('jarvis is owned by a different user') }), USER, 'jarvis');
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  test('an application failure is still ours to own, at 500', async () => {
    const result = await claimOwnedWorkspace(
      envWith({ claimError: new Error('no such table: workspace_identity') }), USER, 'jarvis');
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  test('a dropped capability reconcile reports 503, a schema fault 500', async () => {
    await expect(claimOwnedWorkspace(
      envWith({ capabilityError: new Error(CONNECTION_LOST) }), USER, 'jarvis'))
      .resolves.toMatchObject({ ok: false, status: 503 });
    await expect(claimOwnedWorkspace(
      envWith({ capabilityError: new Error('no such column: capability_hash') }), USER, 'jarvis'))
      .resolves.toMatchObject({ ok: false, status: 500 });
  });
});
