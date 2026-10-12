// Authenticated workspace requests recover platform losses without bypassing ownership or reusing broken stubs.
import { Result } from 'effect';
import { describe, test, expect } from 'bun:test';
import {
  claimOwnedWorkspace, notInRegistry, ownedByAnotherAccount,
  type OwnedWorkspaceResult, type WorkspaceOwnerClaim, type WorkspaceOwnershipEnv, type WorkspaceRegistry,
} from '../src/user/workspace-ownership';

const USER = '0123456789abcdef0123456789abcdef';

const CONNECTION_LOST = 'Network connection lost.';

/** Fails `failures` times with `error`, then succeeds. */
function flaky<T>(failures: number, error: Error, value: T) {
  let seen = 0;

  return {
    call: async () => {
      if (seen++ < failures) throw error;

      return value;
    },
  };
}

function answers<T>(...values: T[]) {
  let seen = 0;

  return {
    call: async () => values[Math.min(seen++, values.length - 1)],
  };
}

describe('claimOwnedWorkspace — the gate on every authenticated workspace request', () => {
  function envWith(opts: {
    dropHasWorkspace?: number;
    membershipError?: Error;
    membershipAnswers?: boolean[];
    registryReads?: string[];
    claimError?: Error;
    capabilityError?: Error;
        /** Reconciles that succeed before `capabilityError` applies. Default 0: always throws. */
    capabilitySucceeds?: number;
    claims?: string[];
  }): WorkspaceOwnershipEnv<string, WorkspaceOwnerClaim> {
    const membership = opts.membershipAnswers
      ? answers(...opts.membershipAnswers)
      : flaky(opts.dropHasWorkspace ?? 0, opts.membershipError ?? new Error(CONNECTION_LOST), true);

    let reconciles = 0;

    const registry: WorkspaceRegistry = {
      async hasWorkspace(_owner, name) {
        opts.registryReads?.push(name);

        return await membership.call();
      },
      async ensureWorkspaceCapability() {
        reconciles += 1;

        if (opts.capabilityError && reconciles > (opts.capabilitySucceeds ?? 0)) {
          throw opts.capabilityError;
        }
      },
    };

    const workspace: WorkspaceOwnerClaim = {
      async claimOwner(userId) {
        opts.claims?.push(userId);

        if (opts.claimError) throw opts.claimError;

        return await Promise.resolve({ owner: USER, capabilityHash: 'h' });
      },
    };

    return {
      CREDENTIAL_ENCRYPTION_KEY: 'test-owner-secret',
      UserDO: { idFromName: (name) => name, get: () => registry },
      OrchestratorAgent: { idFromName: (name) => name, get: () => workspace },
    };
  }

  async function claimFailure(workspace: string, message: string): Promise<OwnedWorkspaceResult<WorkspaceOwnerClaim>> {
    return await claimOwnedWorkspace(envWith({ claimError: new Error(message) }), USER, workspace);
  }

  test('one dropped membership read does not fail the request', async () => {
    const result = await claimOwnedWorkspace(envWith({ dropHasWorkspace: 1 }), USER, 'drop-retry');
    expect(Result.isSuccess(result)).toBe(true);
  });

  test('a live storage reset recovers the authenticated workspace request', async () => {
    const reads: string[] = [];

    const result = await claimOwnedWorkspace(envWith({
      dropHasWorkspace: 1,
      membershipError: new Error('Internal error in Durable Object storage caused object to be reset; reference = abc'),
      registryReads: reads,
    }), USER, 'live-storage-retry');

    expect(Result.isSuccess(result)).toBe(true);
    expect(reads).toEqual(['live-storage-retry', 'live-storage-retry']);
  });

  test('a platform retryable flag is honored without a literal overload refusal', async () => {
    const reads: string[] = [];

    const result = await claimOwnedWorkspace(envWith({
      dropHasWorkspace: 1,
      membershipError: Object.assign(new Error('Durable Object iſ overloaded.'), { retryable: true }),
      registryReads: reads,
    }), USER, 'flagged-nonliteral-overload');

    expect(Result.isSuccess(result)).toBe(true);
    expect(reads).toEqual(['flagged-nonliteral-overload', 'flagged-nonliteral-overload']);
  });

  test('overload anywhere in an ownership failure vetoes another delivery', async () => {
    const failures = [
      new Error('Durable Object reset because its code was updated.', { cause: Object.assign(new Error('refused'), { overloaded: true }) }),
      Object.assign(new Error('refused', { cause: new Error(CONNECTION_LOST) }), { overloaded: true }),
      Object.assign(new Error('refused', { cause: new Error('Durable Object is overloaded.') }), { retryable: true }),
    ];

    for (const [index, claimError] of failures.entries()) {
      const claims: string[] = [];
      await expect(claimOwnedWorkspace(envWith({ claimError, claims }), USER, `overload-veto-${index}`))
        .resolves.toMatchObject({ failure: { status: 503 } });
      expect(claims).toEqual([USER]);
    }
  });

  test('a scalar cause is not a platform signal for another registry read', async () => {
    const reads: string[] = [];

    await expect(claimOwnedWorkspace(envWith({
      dropHasWorkspace: 1,
      membershipError: new Error('registry read failed', { cause: CONNECTION_LOST }),
      registryReads: reads,
    }), USER, 'scalar-cause')).rejects.toThrow('registry read failed');
    expect(reads).toEqual(['scalar-cause']);
  });

  test('ownership retries mint and dispose stubs without disposing the returned workspace', async () => {
    const disposed: string[] = [];
    let registryStubs = 0;
    let workspaceStubs = 0;

    const env: WorkspaceOwnershipEnv<string, WorkspaceOwnerClaim> = {
      CREDENTIAL_ENCRYPTION_KEY: 'test-owner-secret',
      UserDO: {
        idFromName: (name) => name,
        get: () => {
          const number = ++registryStubs;
          let live = true;

          return {
            [Symbol.dispose]() { live = false; disposed.push(`registry-${number}`); },
            async hasWorkspace() {
              if (!live || number === 1) throw new Error(CONNECTION_LOST);

              return true;
            },
            async ensureWorkspaceCapability() {
              if (!live) throw new Error('disposed registry stub');
            },
          };
        },
      },
      OrchestratorAgent: {
        idFromName: (name) => name,
        get: () => {
          const number = ++workspaceStubs;
          let live = true;

          return {
            [Symbol.dispose]() { live = false; disposed.push(`workspace-${number}`); },
            async claimOwner() {
              if (!live) throw new Error('disposed workspace stub');

              return { owner: USER, capabilityHash: 'h' };
            },
          };
        },
      },
    };

    const result = await claimOwnedWorkspace(env, USER, 'stub-lifecycle');

    expect(Result.isSuccess(result)).toBe(true);

    if (Result.isFailure(result)) throw new Error(result.failure.error);
    await expect(result.success.claimOwner(USER)).resolves.toMatchObject({ owner: USER });
    expect(disposed).toEqual(['registry-1', 'registry-2', 'workspace-1', 'registry-3']);
    expect(workspaceStubs).toBe(2);
  });

  test('a platform failure that persists reports 503, not 500', async () => {
    expect(await claimFailure('persist-503', CONNECTION_LOST)).toMatchObject({ failure: { status: 503 } });
  });

  test('a genuine ownership collision still reports 403, whatever its words', async () => {
    const collision = ownedByAnotherAccount('someone else already holds collision-403');

    expect(await claimOwnedWorkspace(envWith({ claimError: collision }), USER, 'collision-403'))
      .toMatchObject({ failure: { status: 403, error: 'Workspace collision-403 belongs to another account.' } });
  });

  test('an application failure is still ours to own, at 500', async () => {
    expect(await claimFailure('schema-fault', 'no such table: workspace_identity'))
      .toMatchObject({ failure: { status: 500 } });
  });

  test('a dropped capability reconcile reports 503, a schema fault 500', async () => {
    await expect(claimOwnedWorkspace(
      envWith({ capabilityError: new Error(CONNECTION_LOST) }), USER, 'reconcile-drop'))
      .resolves.toMatchObject({ failure: { status: 503 } });
    await expect(claimOwnedWorkspace(
      envWith({ capabilityError: new Error('no such column: capability_hash') }), USER, 'reconcile-schema'))
      .resolves.toMatchObject({ failure: { status: 500 } });
  });

  // staging f62dfcb9, 2026-10-01 01:07Z: 180 workspaces of one account at once overloaded its UserDO, and ~128 trials died on
  // "Could not issue this workspace's capability token" with a 500. The platform refused the call before running it.
  test('an overloaded registry reports 503: not retried, but still try again', async () => {
    const overloaded = Object.assign(new Error('Durable Object is overloaded.'), { retryable: true, overloaded: true });

    await expect(claimOwnedWorkspace(envWith({ capabilityError: overloaded }), USER, 'reconcile-overloaded'))
      .resolves.toMatchObject({ failure: { status: 503 } });
    expect(await claimFailure('claim-overloaded', 'Durable Object is overloaded.')).toMatchObject({ failure: { status: 503 } });
  });

  test('a warm request skips the registry read', async () => {
    const reads: string[] = [];
    const env = envWith({ membershipAnswers: [true], registryReads: reads });
    expect(Result.isSuccess(await claimOwnedWorkspace(env, USER, 'warm-cache'))).toBe(true);
    expect(reads).toEqual(['warm-cache']);
    expect(Result.isSuccess(await claimOwnedWorkspace(env, USER, 'warm-cache'))).toBe(true);
    expect(reads).toEqual(['warm-cache']);
  });

  test('an unproven caller is membership-checked before the agent wakes', async () => {
    const claims: string[] = [];

    const result = await claimOwnedWorkspace(
      envWith({ membershipAnswers: [false], claims }), USER, 'unproven-404');

    expect(result).toMatchObject({ failure: { status: 404 } });
    expect(claims).toEqual([]);
  });

  test('a removed workspace evicts the proof and reports 404', async () => {
    const reads: string[] = [];

    const env = envWith({
      membershipAnswers: [true, false],
      registryReads: reads,
      capabilityError: notInRegistry('evicted-404 left the registry'),
      capabilitySucceeds: 1,
    });

    expect(Result.isSuccess(await claimOwnedWorkspace(env, USER, 'evicted-404'))).toBe(true);
    // The UserDO's registry re-check contradicts the stale proof: 404, proof discarded.
    await expect(claimOwnedWorkspace(env, USER, 'evicted-404'))
      .resolves.toMatchObject({ failure: { status: 404 } });
    await expect(claimOwnedWorkspace(env, USER, 'evicted-404'))
      .resolves.toMatchObject({ failure: { status: 404 } });
    expect(reads).toEqual(['evicted-404', 'evicted-404']);
  });
});
