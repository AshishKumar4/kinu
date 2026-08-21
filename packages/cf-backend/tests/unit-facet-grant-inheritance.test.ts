// Every agent in a workspace shares the container, so it must share the
// container's granted capabilities — or a SUBSET, never a superset.
//
// The owner's newest invariant, and the fix for a live defect: grants are only
// ever written to the ROOT workspace DO's `agent_config`, while a facet — a
// head, a subordinate — is a different Durable Object with its own empty one.
// So a facet read no grants and no mode and re-asked for consent the owner had
// already given on the workspace, one concrete mechanism behind unattended runs
// stalling.
//
// The cf-backend half of the property is REACHABILITY: a facet now reads its
// root's answers over RPC, and a method missing from the surface is silently
// unreachable rather than a build error.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createInheritedApprovalPolicy, decideApproval, egressSecretRule,
  grantsAreSubset, resolveInheritedGrants, reviewEgressBinding,
  type ApprovalGrant, type ShellApprovalMode,
} from '@kinu.run/core';
import { AGENT_RPC_ACCESS } from '../src/cli/rpc-gate';
import { ORCHESTRATOR_RPC_SURFACE } from '../src/rpc-surface';

const root = new URL('../', import.meta.url).pathname;

const ROOT_GRANTS: ApprovalGrant[] = [
  { rule: 'rm-recursive', executor: 'sandbox' },
  { rule: egressSecretRule('stripe'), executor: 'sandbox' },
];

describe('reachability of the root policy read', () => {
  // Derived from runtime.ts rather than restated: adding a call there without
  // allowlisting it must fail here.
  test('every root method the facet policy calls is on the RPC surface', () => {
    const source = readFileSync(`${root}src/runtime.ts`, 'utf8');
    const block = source.slice(source.indexOf('async function fetchRootApprovalPolicy'));
    const called = [...block.slice(0, 900).matchAll(/\broot\.(\w+)\(/g)].map(([, name]) => name!);
    expect(called.length).toBeGreaterThan(0);
    expect([...new Set(called)].filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });

  test('they are reachable BECAUSE they are in AGENT_RPC_ACCESS, not a second list', () => {
    // ORCHESTRATOR_RPC_SURFACE spreads Object.keys(AGENT_RPC_ACCESS), so this is
    // the actual mechanism the SAFETY comment in runtime.ts cites.
    for (const name of ['getShellApprovalMode', 'getShellApprovalGrants']) {
      expect(Object.hasOwn(AGENT_RPC_ACCESS, name)).toBe(true);
      expect(ORCHESTRATOR_RPC_SURFACE).toContain(name);
    }
  });

  test('the root/facet split is decided by the container-ownership test', () => {
    // Same predicate the sandbox handle uses, so a facet cannot be a root for
    // grants while being a facet for its container.
    expect(readFileSync(`${root}src/runtime.ts`, 'utf8'))
      .toContain('const isRootActor = agent.name === actor.workspaceName');
  });
});

describe('a facet holds the root set, or a subset of it', () => {
  function source(mode: ShellApprovalMode, own: ApprovalGrant[] | null) {
    let fetches = 0;
    return {
      fetches: () => fetches,
      deps: {
        fetchRoot: async () => { fetches += 1; return { mode, grants: ROOT_GRANTS }; },
        ownGrants: () => own,
      },
    };
  }

  test('a facet that recorded nothing inherits the whole root set — it does not re-ask', async () => {
    const probe = source('strict', null);
    const policy = createInheritedApprovalPolicy(probe.deps);
    const decision = await decideApproval(
      { command: 'bind stripe', executor: 'sandbox' },
      reviewEgressBinding({ id: 'stripe', label: 'Stripe', host: 'api.stripe.com' }),
      policy,
    );
    expect(decision.run).toBe(true);
    expect(probe.fetches()).toBe(1);
  });

  test('a facet cannot hold a grant its root lacks', async () => {
    const policy = createInheritedApprovalPolicy(source('strict', [
      { rule: egressSecretRule('prod-db'), executor: 'sandbox' },
    ]).deps);
    await policy.resolve?.();
    expect(policy.granted?.({ rule: egressSecretRule('prod-db'), executor: 'sandbox' })).toBe(false);
    // And the resolved set is provably a subset of the root's.
    expect(grantsAreSubset(
      resolveInheritedGrants({ root: ROOT_GRANTS, own: [{ rule: egressSecretRule('prod-db'), executor: 'sandbox' }] }),
      ROOT_GRANTS,
    )).toBe(true);
  });

  test('a facet that narrowed itself keeps only the narrowing', async () => {
    const policy = createInheritedApprovalPolicy(source('strict', [
      { rule: 'rm-recursive', executor: 'sandbox' },
    ]).deps);
    await policy.resolve?.();
    expect(policy.granted?.({ rule: 'rm-recursive', executor: 'sandbox' })).toBe(true);
    expect(policy.granted?.({ rule: egressSecretRule('stripe'), executor: 'sandbox' })).toBe(false);
  });

  test('the root\'s MODE applies too, so a facet does not silently harden to strict', async () => {
    const policy = createInheritedApprovalPolicy(source('allow_all', null).deps);
    await policy.resolve?.();
    expect(policy.mode()).toBe('allow_all');
  });

  test('a facet can never record a grant, so it cannot widen itself', () => {
    const policy = createInheritedApprovalPolicy(source('strict', null).deps);
    expect(policy.remember).toBeUndefined();
  });

  test('an unreachable root narrows the facet rather than unleashing it', async () => {
    const policy = createInheritedApprovalPolicy({
      fetchRoot: () => Promise.reject(new Error('root DO unreachable')),
      ownGrants: () => null,
    });
    expect(policy.mode()).toBe('strict');
    expect(policy.granted?.({ rule: 'rm-recursive', executor: 'sandbox' })).toBe(false);
  });
});
