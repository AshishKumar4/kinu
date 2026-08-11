/**
 * The drift gate under agent-authored views.
 *
 * `packages/core` owns the list of RPC methods a view spec may name, because
 * the spec is validated in core, at write time — and core is platform-clean, so
 * it cannot read the Cloudflare scope table that decides what those names
 * actually cost. Nothing stops the two drifting except this file.
 *
 * The claims a reviewer should be able to make about a view — "it can only read
 * what the owner can already read", "it cannot reach a mutation", "it cannot
 * impersonate a host surface" — are each one assertion below. If a method is
 * reclassified, loses `@callable`, or a new host surface appears, this fails.
 *
 * The `@callable` half is checked against the orchestrator's SOURCE rather than
 * its metadata on purpose: `tests/helpers/agents-sdk.ts` replaces the decorator
 * with an identity function so bun can import the DO layer at all, so there is
 * no runtime metadata here to read. The regex asserts its own health first.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_VIEW_TITLES, VIEW_DATA_SOURCES, normalizeViewTitle } from '@proteus/core';
import { AGENT_RPC_ACCESS, requiredRpcAccess } from '../src/cli/rpc-gate.js';

const SRC = join(import.meta.dir, '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Method names carrying `@callable()`, in either layout the file uses. */
function callableMethods(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/@callable\(\)\s*(?:async\s+)?([A-Za-z_]\w*)\s*\(/g)) {
    found.add(match[1]!);
  }
  return found;
}

describe('view data sources', () => {
  const orchestrator = read('orchestrator.ts');
  const callable = callableMethods(orchestrator);

  test('the callable scan works at all, so the assertions below mean something', () => {
    expect(callable.size).toBeGreaterThan(20);
    expect(callable).toContain('getReleaseBoard');
    expect(callable).toContain('listAgentViews');
  });

  test('every source a view may name is classed workspace.read', () => {
    for (const source of VIEW_DATA_SOURCES) {
      expect(requiredRpcAccess(source)).toBe('workspace.read');
    }
  });

  test('every source a view may name is reachable from the browser', () => {
    // A `workspace.read` classing is necessary and not sufficient: the agents
    // SDK refuses any method without `@callable`, so a source that lacks it
    // validates at write time and then fails in the owner's browser.
    for (const source of VIEW_DATA_SOURCES) {
      expect(callable).toContain(source);
    }
  });

  test('no source a view may name is a write, an exec, or an interactive-only read', () => {
    const widened = VIEW_DATA_SOURCES.filter((s) => requiredRpcAccess(s) !== 'workspace.read');
    expect(widened).toEqual([]);
    for (const source of VIEW_DATA_SOURCES) {
      expect(source).not.toMatch(/^(create|update|delete|set|decide|request|record|transition|upsert|run|cancel|destroy|write|revert|approve)/);
    }
  });

  test('consent, approval-decision and credential reads stay off the list', () => {
    // Host chrome the agent must never be able to redraw. Each of these is a
    // real method on the surface; their absence here is the containment.
    const withheld = [
      'listPendingConsents', 'getEvolutionChangelog', 'sampleOutcomeLabeling',
      'decideReleaseApproval', 'requestReleaseApproval', 'getAuthHeaders',
    ];
    for (const method of withheld) {
      expect(VIEW_DATA_SOURCES as readonly string[]).not.toContain(method);
    }
  });

  test('the two view RPCs are reads and nothing more', () => {
    expect(AGENT_RPC_ACCESS.listAgentViews).toBe('workspace.read');
    expect(AGENT_RPC_ACCESS.getAgentView).toBe('workspace.read');
    // Publishing is workspace.createView inside execute_tools; reverting is the
    // changelog. Neither may become an RPC the rendered view can call.
    expect(Object.keys(AGENT_RPC_ACCESS)).not.toContain('createAgentView');
    expect(Object.keys(AGENT_RPC_ACCESS)).not.toContain('publishAgentView');
  });
});

describe('reserved view titles', () => {
  test('cover every host work surface, so no agent tab can wear one of their names', () => {
    const source = read('components/surfaces/WorkSurface.tsx');
    const tuple = /export const SURFACES = \[([^\]]+)\]/.exec(source);
    expect(tuple).not.toBeNull();
    const surfaces = [...tuple![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(surfaces.length).toBeGreaterThan(3);

    const activity = /const ACTIVITY_SURFACE = "([^"]+)"/.exec(source);
    expect(activity).not.toBeNull();

    for (const name of [...surfaces, activity![1]!]) {
      expect(RESERVED_VIEW_TITLES).toContain(normalizeViewTitle(name));
    }
  });
});
