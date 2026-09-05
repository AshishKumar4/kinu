/**
 * The drift gate under agent-authored gadgets.
 *
 * `packages/core` owns the list of RPC methods a gadget's `workspace`
 * binding may name, because the manifest is validated in core, at write
 * time — and core is platform-clean, so it cannot read the Cloudflare scope
 * table that decides what those names actually cost. Nothing stops the two
 * drifting except this file.
 *
 * The claims a reviewer should be able to make about a gadget — "it can only
 * read what the owner can already read", "it cannot reach a mutation", "it
 * cannot impersonate a host surface" — are each one assertion below. If a
 * method is reclassified, loses `@callable`, or a new host surface appears,
 * this fails.
 *
 * The `@callable` half is checked against the orchestrator's SOURCE rather
 * than its metadata on purpose: `tests/helpers/agents-sdk.ts` replaces the
 * decorator with an identity function so bun can import the DO layer at all,
 * so there is no runtime metadata here to read. The regex asserts its own
 * health first.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GADGET_DATA_SOURCES, parseGadgetManifest } from '@kinu.run/core';
import { AGENT_RPC_ACCESS, requiredRpcAccess } from '../src/cli/rpc-gate';

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

describe('gadget data sources', () => {
  const orchestrator = read('orchestrator.ts');
  const callable = callableMethods(orchestrator);

  test('the callable scan works at all, so the assertions below mean something', () => {
    expect(callable.size).toBeGreaterThan(20);
    expect(callable).toContain('getReleaseBoard');
    expect(callable).toContain('listGadgets');
  });

  test('every source a gadget may name is classed workspace.read', () => {
    for (const source of GADGET_DATA_SOURCES) {
      expect(requiredRpcAccess(source)).toBe('workspace.read');
    }
  });

  test('every source a gadget may name is reachable from the browser', () => {
    // A `workspace.read` classing is necessary and not sufficient: the agents
    // SDK refuses any method without `@callable`, so a source that lacks it
    // validates at write time and then fails in the owner's browser.
    for (const source of GADGET_DATA_SOURCES) {
      expect(callable).toContain(source);
    }
  });

  test('no source a gadget may name is a write, an exec, or an interactive-only read', () => {
    const widened = GADGET_DATA_SOURCES.filter((s) => requiredRpcAccess(s) !== 'workspace.read');
    expect(widened).toEqual([]);
    for (const source of GADGET_DATA_SOURCES) {
      expect(source).not.toMatch(/^(create|update|delete|set|decide|request|record|transition|upsert|run|cancel|destroy|write|revert|approve)/);
    }
  });

  test('consent, approval-decision and credential reads stay off the list', () => {
    // Host chrome the agent must never be able to redraw. Each of these is a
    // real method on the surface; their absence here is the containment.
    // The last three take a caller-chosen string argument, which no source
    // here carries by design (see sources.ts).
    const withheld = [
      'listPendingConsents', 'getEvolutionChangelog', 'sampleOutcomeLabeling',
      'decideReleaseApproval', 'getAuthHeaders',
      // The needs-you queue: what an owner reads immediately before
      // authorising a deploy. A gadget able to draw it could counterfeit it.
      'listPendingActions',
      'getMctsNodeDetail', 'searchMemoryHybrid', 'getGepaRun',
    ];
    const permitted = new Set<string>(GADGET_DATA_SOURCES);
    for (const method of withheld) {
      expect(permitted.has(method)).toBe(false);
    }
  });

  test('the two gadget read RPCs are reads and the call is interactive', () => {
    expect(AGENT_RPC_ACCESS.listGadgets).toBe('workspace.read');
    expect(AGENT_RPC_ACCESS.getGadgetClient).toBe('workspace.read');
    // A call runs agent-written code that may act through an MCP binding, so
    // a scoped token must not reach it.
    expect(AGENT_RPC_ACCESS.gadgetCall).toBe('interactive');
    // Publishing is writing files under gadgets/; the host reacts to the
    // write. Neither may become an RPC the rendered gadget can call.
    expect(Object.keys(AGENT_RPC_ACCESS)).not.toContain('createGadget');
    expect(Object.keys(AGENT_RPC_ACCESS)).not.toContain('publishGadget');
  });
});

describe('reserved gadget titles', () => {
  /** Why the parser refuses a manifest wearing `title`, or null when it
   *  accepts it. The reason is asserted, so a title refused for some other
   *  cause (length, encoding) cannot pass as reserved. */
  const refusal = (title: string): string | null => {
    const out = parseGadgetManifest({ v: 1, title });
    return out.ok ? null : out.error;
  };

  test('the parser refuses a reserved title and accepts an ordinary one', () => {
    expect(refusal('Deploy health')).toBeNull();
    expect(refusal('Releases')).toContain('host owns');
  });

  test('cover every host work surface, so no agent tab can wear one of their names', () => {
    const source = read('components/surfaces/WorkSurface.tsx');
    const tuple = /(?:export )?const SURFACES = \[([^\]]+)\]/.exec(source);
    const surfaceList = tuple?.[1];
    if (!surfaceList) throw new Error('WorkSurface.tsx must declare SURFACES');
    const surfaces = [...surfaceList.matchAll(/"([^"]+)"/g)].flatMap((match) => {
      const name = match[1];
      return name ? [name] : [];
    });
    expect(surfaces.length).toBeGreaterThan(3);

    const activity = /const ACTIVITY_SURFACE = "([^"]+)"/.exec(source);
    const activityName = activity?.[1];
    if (!activityName) throw new Error('WorkSurface.tsx must declare ACTIVITY_SURFACE');

    for (const name of [...surfaces, activityName]) {
      expect(refusal(name)).toContain('host owns');
    }
  });

  test('keep every RETIRED host name, forever', () => {
    // A name the host has dropped is more dangerous than one it still uses:
    // the returning user's muscle memory still reaches for it, so an
    // agent-authored tab wearing it would inherit exactly the trust the
    // retired surface earned. Nothing may be removed from that list — this is
    // the assertion that stops a future rename from quietly doing it.
    const retired = [
      'Brain', 'Reasoning', 'Self', 'Tasks', 'Jobs', 'Changelog', 'Evolution Changelog',
    ];
    for (const name of retired) {
      expect(refusal(name)).toContain('host owns');
    }
  });
});
