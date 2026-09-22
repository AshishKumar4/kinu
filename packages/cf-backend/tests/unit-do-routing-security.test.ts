import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  hostedActorRoute,
  hostedActorSocketPath,
  isForeignAgentNamespacePath,
} from '@kinu.run/core';
import { deriveUserId } from '../src/auth/store';

/**
 * F1 account-takeover regression: partyserver routes every DO namespace by slug, and a derivable
 * userId is a legal workspace name, so /agents/user-d-o/<victimId> reached the victim's UserDO.
 * Defenses: the /agents/* transport is pinned to the orchestrator namespace; UserDO exposes no @callable.
 */

const ROOT = join(import.meta.dir, '..');

const source = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('F1 defense 1 — the /agents/* transport is pinned to the orchestrator', () => {
  test('the concrete exploit path is a foreign-namespace request (→ rejected)', async () => {
    const victimId = await deriveUserId('victim@example.com');
    expect(victimId).toMatch(/^[0-9a-f]{32}$/);
    expect(isForeignAgentNamespacePath(`/agents/user-d-o/${victimId}`)).toBe(true);
  });

  test('every non-orchestrator DO namespace is foreign (→ rejected)', () => {
    for (const slug of ['user-d-o', 'exploration-agent', 'kinu-sandbox', 'nimbus-preview', 'anything']) {
      expect(isForeignAgentNamespacePath(`/agents/${slug}/some-name`)).toBe(true);
    }
  });

  test('a sibling-slug prefix cannot smuggle past the pin', () => {
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent-evil/x')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agentX/x')).toBe(true);
  });

  test('only the orchestrator root and hosted-actor paths are admitted', () => {
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace')).toBe(false);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/actor/researcher')).toBe(false);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/actor/researcher/get-messages')).toBe(false);

    // The root serves hosted actors under `/actor/<name>`; any `sub` segment or unnamed tail stays foreign.
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/websocket')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/actor/researcher/websocket')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/exploration-agent/head-1')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/sub/exploration-agent/head-1')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/sub/subordinate-agent/nested')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/user-d-o/victim')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/arbitrary')).toBe(true);
  });

  /**
     * Both directions of one regex: the F1 fix once 404'd the SDK's own `/get-messages`. A wildcard
     * segment would re-open the hole, so the endpoint set is enumerated.
     */
  test('every client builds a hosted actor\'s address through the one helper the edge admits', () => {
    // The SDK's `sub` option renders `/sub/<class>/<name>`, a facet hop this transport refuses;
    // one helper answers the admitted address.
    const path = `/agents/orchestrator-agent/my-workspace/${hostedActorSocketPath('researcher')}`;
    expect(path).toBe('/agents/orchestrator-agent/my-workspace/actor/researcher');
    expect(isForeignAgentNamespacePath(path)).toBe(false);
    expect(hostedActorRoute(path)).toEqual({ name: 'researcher', suffix: '' });
    const odd = `/agents/orchestrator-agent/my-workspace/${hostedActorSocketPath('a/b c')}`;
    expect(isForeignAgentNamespacePath(odd)).toBe(false);
    expect(hostedActorRoute(odd)).toEqual({ name: 'a/b c', suffix: '' });

    // No client builds the address by hand; the helper is the one definition.
  });

  test("the transport's own chat-history endpoint is admitted at the workspace root", () => {
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/get-messages')).toBe(false);
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/get-messages')).toBe('my-workspace');

    // Admitting it does not open the tail: the endpoint list is named, and a connect ticket buys only the root socket.
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/get-messages/extra')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/get-messages/sub/user-d-o/victim')).toBe(true);
    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/get-messages')).toBeNull();
  });

  test('ownership and CLI ticket extraction include hosted-actor paths', () => {
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace')).toBe('my-workspace');
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/actor/researcher')).toBe('my-workspace');
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/actor/researcher/get-messages')).toBe('my-workspace');
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/websocket')).toBeNull();
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/exploration-agent/head-1')).toBeNull();
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/sub/exploration-agent/head-1')).toBeNull();
    expect(extractOrchestratorAgentName('/agents/user-d-o/victim')).toBeNull();

    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/my-workspace')).toBe('my-workspace');
    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/actor/researcher')).toBe('my-workspace');
  });

  test('server.ts rejects foreign namespaces with a 404 before ownership + routing', () => {
    const src = source('src/server.ts');
    // The pin 404s ahead of the ownership claim and the partyserver route, so no privileged code runs on a foreign path.
    const pin = src.indexOf('if (isForeignAgentNamespacePath(url.pathname)) {');
    const claim = src.indexOf('claimOwnedWorkspace(env, identity.userId, agentName)');
    const route = src.indexOf('routeAgentRequest(reqWithId, env)');
    expect(pin).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(src).toContain("return err(404, 'Not found');");
    expect(pin).toBeLessThan(claim);
    expect(claim).toBeLessThan(route);
  });
});

describe('F1 defense 2 — @callable surface reduction (worker-side stubs preserved)', () => {
  // Exposure is asserted in `tests/workerd/decorated-agent.test.ts` (the SDK registry, KINU-065); a
  // source-text oracle cannot hold it. Here: the methods must stay declared `async`, since stub holders
  // call them over native Durable Object RPC.

  test('every UserDO method is preserved for worker-side stub callers', () => {
    const src = source('src/user/user-do.ts');

    for (const m of ['getAuthHeaders', 'mintCliToken', 'setCredential', 'listWorkspaces', 'ensureProfile', 'ensureWorkspaceCapability']) {
      expect(src).toMatch(new RegExp(`async ${m}(?:<[^>]+>)?\\(`));
    }
  });

  test('worker-only privileged methods are preserved on both actor roots', () => {
    // Declared once on ActorAgent so both roots share one implementation and exposure decision;
    // unreachability is asserted in `tests/workerd/decorated-agent.test.ts`.
    const orchestrator = source('src/orchestrator.ts');

    for (const m of [
      'rawCopyFromFork', 'claimOwner', 'acceptWebhookDelivery', 'acceptEmailDelivery',
      'receivePeerMessage', 'listPeersFromMcp', 'runTaskFromMcp', 'saveNoteFromMcp', 'sendPeerFromMcp',
    ]) {
      expect(orchestrator).toContain(`async ${m}(`);
    }

    const actor = source('src/actor-agent.ts');

    for (const m of ['installWorkspaceCapability', 'getSubordinateBootstrapIdentity', 'receiveSubordinateEvent']) {
      expect(actor).toContain(`async ${m}(`);
    }
  });
});
