import { describe, expect, test } from 'bun:test';
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  hostedActorRoute,
  hostedActorSocketPath,
  isForeignAgentNamespacePath,
} from '@kinu.run/core';
import { deriveUserId } from '../src/auth/store';
import { unreachableNamespace, workerContext } from './helpers/bindings';
import { makeKv } from './helpers/kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

/**
 * F1 account-takeover regression: partyserver routes every DO namespace by slug, and a derivable
 * userId is a legal workspace name, so /agents/user-d-o/<victimId> reached the victim's UserDO.
 * Defenses: the /agents/* transport is pinned to the orchestrator namespace; UserDO exposes no @callable.
 */

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`.
const { default: worker } = await import('../src/server');

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

  test('a signed-in request for a foreign namespace is refused before anything asks an account', async () => {
    // Every account and workspace object refuses: an ownership claim or a route would answer 500, not 404.
    const env: Partial<Env> = {};
    Object.assign(env, {
      AUTH_KV: makeKv(),
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      DEV_USER_EMAIL: 'owner@example.com',
      UserDO: unreachableNamespace('UserDO'),
      OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
    });

    for (const path of ['/agents/user-d-o/victim', `/agents/user-d-o/${await deriveUserId('victim@example.com')}`]) {
      // SAFETY: every member the foreign-namespace refusal reads is constructed above; the loopback host is
      // where the dev identity signs the request in.
      const answer = await worker.fetch(new Request(`http://localhost${path}`), env as Env, workerContext());

      expect(answer.status).toBe(404);
    }
  });
});
