// Every agent in a workspace shares the container, so it must share the
// container's granted capabilities — or a SUBSET, never a superset.
//
// The owner's newest invariant, and the fix for a live defect: grants are only
// ever written to the ROOT workspace DO's `actor_config`, while a facet — a
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
  createInheritedApprovalPolicy, egressSecretRule, gateExec,
  grantsAreSubset, resolveInheritedGrants,
  type ApprovalGrant, type ShellApprovalMode,
} from '@kinu.run/core';
import { AGENT_RPC_ACCESS } from '../src/cli/rpc-gate';
import { ORCHESTRATOR_RPC_SURFACE } from '../src/rpc-surface';
import { hostedMainActor, hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const root = new URL('../', import.meta.url).pathname;

/** A force-push reaches out, so the agent's own `sandbox` does not exempt it:
 *  the one command rule here that a root grant can stand for. */
const GATED = 'git push --force origin main';
const GATED_RULE = 'git-force-push';

const ROOT_GRANTS: ApprovalGrant[] = [
  { rule: 'rm-recursive', executor: 'sandbox' },
  { rule: GATED_RULE, executor: 'sandbox' },
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

  /**
   * WHICH ACTOR reaches that read, decided by the actor's registered KIND.
   *
   * This replaces a case that asserted the source text
   * `const isRootActor = agent.name === actor.workspaceName` and justified it as
   * "the same predicate the sandbox handle uses". Both halves are gone. Every
   * actor of a workspace now rides ONE container (`sandboxIdForWorkspace` is
   * keyed on `workspaceName`, the same string for all of them), so there is no
   * container-ownership split left for a grants split to agree with; and the
   * name comparison is exactly what the cutover had to delete, because hosted in
   * the root's isolate every actor answers to that same name and a subordinate
   * would have been handed the root's own recording authority.
   *
   * So the surviving guarantee is stated instead of spelled: a hosted actor that
   * is not main reaches the ROOT for its answers and can only narrow them. Both
   * actors below are acquired from one `ActorHost` through one `runtimeFor`, so
   * the registered kind is the only difference between them — which is the whole
   * claim.
   */
  test('a hosted actor reaches the root for its policy; the main actor never does', async () => {
    const workspace = orchestratorHarness();
    let rootReads = 0;
    const readGrants = workspace.agent.getShellApprovalGrants.bind(workspace.agent);
    Object.defineProperty(workspace.agent, 'getShellApprovalGrants', {
      configurable: true,
      value: async () => { rootReads += 1; return readGrants(); },
    });

    // The owner's standing decision, recorded where grants are only ever
    // written: the workspace's own main actor.
    workspace.agent.observeRuntime().actor.config
      .grantShellApproval([{ rule: GATED_RULE, executor: 'workspace' }]);

    const main = await hostedMainActor(workspace);
    const mainShell = main.actor.runtime.shell;
    if (!mainShell) throw new Error('the main actor carries a shell');
    expect((await mainShell.exec(GATED)).refusal).toBeUndefined();
    // It answered out of its OWN config — no root hop, because it IS the root.
    expect(rootReads).toBe(0);

    const child = await hostedSubordinateHarness(workspace, {
      name: 'grantee-1', displayName: 'Grantee', nameOrigin: 'user',
      mission: 'inherit the workspace policy', roleId: 'implementer',
    });
    // It recorded nothing of its own, so anything it holds, it holds because the
    // root holds it.
    expect(child.actor.handle.config.getShellApprovalGrants()).toEqual([]);
    const childShell = child.actor.runtime.shell;
    if (!childShell) throw new Error('a hosted subordinate carries a shell');
    // Counted from AFTER the hire, so the hop is attributed to the child's own
    // gate rather than to anything the hiring did on the way.
    const beforeExec = rootReads;
    expect((await childShell.exec(GATED)).refusal).toBeUndefined();
    expect(rootReads).toBeGreaterThan(beforeExec);
  });

  /** The control that makes the pass above mean "inherited" rather than
   *  "ungated": with nothing granted on the root, the same command through the
   *  same hosted shell is refused. */
  test('a hosted actor whose root granted nothing is still gated', async () => {
    const workspace = orchestratorHarness();
    const child = await hostedSubordinateHarness(workspace, {
      name: 'grantee-2', displayName: 'Grantee', nameOrigin: 'user',
      mission: 'inherit an empty policy', roleId: 'implementer',
    });
    const shell = child.actor.runtime.shell;
    if (!shell) throw new Error('a hosted subordinate carries a shell');
    expect((await shell.exec(GATED)).refusal).toBeDefined();
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
    // Through `gateExec`, the seam every shell boundary is wrapped with: the
    // ladder resolves the root before it reads a grant.
    const probe = source('strict', null);
    const ran: string[] = [];
    const run = gateExec<string>(
      async (command) => { ran.push(command); return `ran:${command}`; },
      (error) => error.message,
      'sandbox',
      createInheritedApprovalPolicy(probe.deps),
    );
    expect(await run(GATED)).toBe(`ran:${GATED}`);
    expect(ran).toEqual([GATED]);
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
