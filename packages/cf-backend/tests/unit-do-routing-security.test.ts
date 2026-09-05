import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  isForeignAgentNamespacePath,
} from '../src/agent-routing';
import { deriveUserId } from '../src/auth/store';

/**
 * F1 account-takeover regression.
 *
 * `routeAgentRequest` (partyserver) maps EVERY Durable Object namespace binding
 * by slug, and userId = sha256(email).slice(0,32) is both derivable and a legal
 * workspace name. Before the fix, an attacker who registered a victim's userId
 * as a workspace name could reach GET /agents/user-d-o/<victimId> — the victim's
 * UserDO @callable surface (getAuthHeaders / mintCliToken → full account
 * takeover), plus worker-only facet namespaces / KinuSandbox / Nimbus*.
 *
 * Two lines of defense are asserted:
 *   1. the `/agents/*` transport is pinned to the orchestrator namespace
 *      (isForeignAgentNamespacePath → 404 before routing);
 *   2. UserDO carries no @callable surface, and neither do the worker-only
 *      privileged orchestrator methods — so even a routed request exposes no RPC.
 */

const ROOT = join(import.meta.dir, '..');
const source = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('F1 defense 1 — the /agents/* transport is pinned to the orchestrator', () => {
  test('the concrete exploit path is a foreign-namespace request (→ rejected)', async () => {
    // The exact primitive: userId derived from a victim email, used as the
    // workspace-name segment under the UserDO slug.
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

  test('only the orchestrator root and direct subordinate paths are admitted', () => {
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace')).toBe(false);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher')).toBe(false);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/websocket')).toBe(false);

    // A literal `sub` segment at any deeper level would make the agents SDK
    // recursively route another facet. Exploration heads remain worker-only.
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/exploration-agent/head-1')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/sub/exploration-agent/head-1')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/sub/subordinate-agent/nested')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub/user-d-o/victim')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/sub')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/arbitrary')).toBe(true);
  });

  /**
   * Pinning BOTH directions of one regex, because closing the F1 hole
   * accidentally closed the chat with it.
   *
   * `useAgentChat` fetches initial messages over HTTP, not the socket, by
   * appending this segment to the agent URL. The grammar allowed the agent name
   * followed by end-of-string or `/sub/<subordinate>/…` and nothing else, so the
   * SDK's own `/get-messages` matched nothing, `isForeignAgentNamespacePath`
   * called it foreign, and the worker answered 404. The socket still connected,
   * so the live turn streamed while every prior message was missing — which
   * reads as total data loss and was not: `getChatHistory` returned 100 messages
   * throughout, the last of them the one on screen.
   *
   * A wildcard segment would have fixed the symptom and re-opened the hole. The
   * endpoint set is enumerated, and the negative half below is the thing that
   * stops either direction regressing.
   */
  test("the transport's own chat-history endpoint is admitted at the workspace root", () => {
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/get-messages')).toBe(false);
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/get-messages')).toBe('my-workspace');

    // Admitting it does NOT open the tail: the endpoint list is named, and a
    // connect ticket still only buys the root socket.
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/get-messages/extra')).toBe(true);
    expect(isForeignAgentNamespacePath('/agents/orchestrator-agent/my-workspace/get-messages/sub/user-d-o/victim')).toBe(true);
    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/get-messages')).toBeNull();
  });

  test('ownership and CLI ticket extraction include direct additional-agent facets', () => {
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace')).toBe('my-workspace');
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/websocket')).toBe('my-workspace');
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/exploration-agent/head-1')).toBeNull();
    expect(extractOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher/sub/exploration-agent/head-1')).toBeNull();
    expect(extractOrchestratorAgentName('/agents/user-d-o/victim')).toBeNull();

    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/my-workspace')).toBe('my-workspace');
    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/my-workspace/sub/subordinate-agent/researcher')).toBe('my-workspace');
  });

  test('server.ts rejects foreign namespaces with a 404 before ownership + routing', () => {
    const src = source('src/server.ts');
    // The pin runs, returns 404, and does so ahead of the ownership claim and
    // the partyserver route — so no privileged code runs on a foreign path.
    const pin = src.indexOf('if (isForeignAgentNamespacePath(url.pathname)) {');
    const claim = src.indexOf('ensureAgentOwnership(env, identity, agentName)');
    const route = src.indexOf('routeAgentRequest(reqWithId, env)');
    expect(pin).toBeGreaterThan(-1);
    expect(src).toContain("return err(404, 'Not found');");
    expect(pin).toBeLessThan(claim);
    expect(claim).toBeLessThan(route);
  });
});

describe('F1 defense 2 — @callable surface reduction (worker-side stubs preserved)', () => {
  // The exposure half of this defense moved to
  // `tests/workerd/decorated-agent.test.ts`, which reads the SDK's own callable
  // registry off the real class prototypes after the real transform.
  //
  // What used to be here was `expect(source('src/user/user-do.ts')).not.toContain('@callable')`
  // and eleven `expect(src).not.toContain('@callable()\n  async <name>')` checks.
  // That oracle passed for the wrong reasons. It matched one exact spelling, so
  // putting the decorator on the same line as the signature, inserting a blank
  // line or a doc comment between them, or renaming the method all stop the
  // string from matching while leaving the method exposed. It also could not
  // fail when a decorator appeared in a shape the pattern did not describe.
  // KINU-065 made the registry readable in workerd, so the exposure decision is
  // now asserted where dispatch actually reads it.
  //
  // WHAT STAYS HERE is the half that is not about exposure: these methods must
  // still EXIST, because a worker-side stub holder calls them by name over
  // native Durable Object RPC, which needs no decorator. The workerd layer
  // asserts the same existence through the prototype, so this file keeps only
  // the declaration shape that a stub caller depends on and that no runtime
  // read can express: that each one is declared `async` on the class.

  test('every UserDO method is preserved for worker-side stub callers', () => {
    const src = source('src/user/user-do.ts');
    for (const m of ['getAuthHeaders', 'mintCliToken', 'setCredential', 'listWorkspaces', 'ensureProfile', 'ensureWorkspaceCapability']) {
      expect(src).toMatch(new RegExp(`async ${m}(?:<[^>]+>)?\\(`));
    }
  });

  test('worker-only privileged methods are preserved on both actor roots', () => {
    // `installWorkspaceCapability` installs this workspace's proof of identity to
    // the owner's UserDO. It is declared once on ActorAgent (the orchestrator's
    // override folded into it when the capability push became recursive down a
    // subordinate tree), so both roots get the one implementation and the one
    // exposure decision. The two subordinate-tree calls moved the same way and
    // for the same reason: a subordinate is now the parent in that relationship
    // too. That no browser socket can reach any of them is asserted in
    // `tests/workerd/decorated-agent.test.ts`.
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
