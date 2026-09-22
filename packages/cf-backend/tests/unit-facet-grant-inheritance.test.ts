// Every agent in a workspace shares the container, so it shares the root's grants or a subset, never a superset.
// Grants are only written to the root DO's `actor_config`; a facet reads them over RPC, and a method missing
// from the surface is silently unreachable rather than a build error.
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

/** A force-push reaches out, so the agent's own `sandbox` does not exempt it. */
const GATED = 'git push --force origin main';

const GATED_RULE = 'git-force-push';

const ROOT_GRANTS: ApprovalGrant[] = [
  { rule: 'rm-recursive', executor: 'sandbox' },
  { rule: GATED_RULE, executor: 'sandbox' },
  { rule: egressSecretRule('stripe'), executor: 'sandbox' },
];

describe('reachability of the root policy read', () => {
  // Derived from runtime.ts: a call added there without allowlisting it must fail here.
  test('every root method the facet policy calls is on the RPC surface', () => {
    const source = readFileSync(`${root}src/runtime.ts`, 'utf8');
    const block = source.slice(source.indexOf('async function fetchRootApprovalPolicy'));
    const called = [...block.slice(0, 900).matchAll(/\broot\.(\w+)\(/g)].map(([, name]) => name);
    expect(called.length).toBeGreaterThan(0);
    expect([...new Set(called)].filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });

  test('they are reachable BECAUSE they are in AGENT_RPC_ACCESS, not a second list', () => {
    // ORCHESTRATOR_RPC_SURFACE spreads Object.keys(AGENT_RPC_ACCESS): the mechanism runtime.ts's SAFETY comment cites.
    for (const name of ['getShellApprovalMode', 'getShellApprovalGrants']) {
      expect(Object.hasOwn(AGENT_RPC_ACCESS, name)).toBe(true);
      expect(ORCHESTRATOR_RPC_SURFACE).toContain(name);
    }
  });

  /**
   * Which actor reaches the root is decided by registered kind: every hosted actor shares the container and
   * answers to the workspace name, so a name comparison would hand a subordinate the root's authority.
   */
  test('a hosted actor reaches the root for its policy; the main actor never does', async () => {
    const workspace = orchestratorHarness();
    let rootReads = 0;
    const readGrants = workspace.agent.getShellApprovalGrants.bind(workspace.agent);
    Object.defineProperty(workspace.agent, 'getShellApprovalGrants', {
      configurable: true,
      value: async () => {
        rootReads += 1;

        return readGrants();
      },
    });

    workspace.agent.observeRuntime().actor.config
      .grantShellApproval([{ rule: GATED_RULE, executor: 'workspace' }]);

    const main = await hostedMainActor(workspace);
    const mainShell = main.actor.runtime.shell;

    if (!mainShell) throw new Error('the main actor carries a shell');
    expect((await mainShell.exec(GATED)).refusal).toBeUndefined();
    expect(rootReads).toBe(0);

    const child = await hostedSubordinateHarness(workspace, {
      name: 'grantee-1', displayName: 'Grantee', nameOrigin: 'user',
      mission: 'inherit the workspace policy', roleId: 'task',
    });

    expect(child.actor.handle.config.getShellApprovalGrants()).toEqual([]);
    const childShell = child.actor.runtime.shell;

    if (!childShell) throw new Error('a hosted subordinate carries a shell');
    // Counted after the hire, so the hop is attributed to the child's own gate.
    const beforeExec = rootReads;
    expect((await childShell.exec(GATED)).refusal).toBeUndefined();
    expect(rootReads).toBeGreaterThan(beforeExec);
  });

  /** The control that makes the pass above mean "inherited", not "ungated": with nothing granted on the root
   *  the command is refused as `unavailable` off the named rule (a facet has no approval channel,
   *  `createInheritedApprovalPolicy`). */
  test('a hosted actor whose root granted nothing is still gated', async () => {
    const workspace = orchestratorHarness();
    // Read, not assumed: a harness seeding a grant here would duplicate the case above.
    expect(workspace.agent.observeRuntime().actor.config.getShellApprovalGrants()).toEqual([]);

    const child = await hostedSubordinateHarness(workspace, {
      name: 'grantee-2', displayName: 'Grantee', nameOrigin: 'user',
      mission: 'inherit an empty policy', roleId: 'task',
    });

    const shell = child.actor.runtime.shell;

    if (!shell) throw new Error('a hosted subordinate carries a shell');

    const refused = await shell.exec(GATED);

    expect(refused.refusal?.reason).toBe('unavailable');
    // Attributable to the ungranted force-push, not a missing or broken shell.
    expect(refused.refusal?.error).toContain(GATED_RULE);
    expect(refused.refusal?.error).toContain('needs owner approval');
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe('');
  });
});

describe('a facet holds the root set, or a subset of it', () => {
  function source(mode: ShellApprovalMode, own: ApprovalGrant[] | null) {
    let fetches = 0;

    return {
      fetches: () => fetches,
      deps: {
        fetchRoot: async () => {
          fetches += 1;

          return { mode, grants: ROOT_GRANTS };
        },
        ownGrants: () => own,
      },
    };
  }

  test('a facet that recorded nothing inherits the whole root set — it does not re-ask', async () => {
    // `gateExec` wraps every shell boundary; the ladder resolves the root before reading a grant.
    const probe = source('strict', null);
    const ran: string[] = [];

    const run = gateExec<string>(
      async (command) => {
        ran.push(command);

        return `ran:${command}`;
      },
      (error) => error.message,
      'sandbox',
      { policy: createInheritedApprovalPolicy(probe.deps) },
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
    expect(policy).not.toHaveProperty('remember');
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
