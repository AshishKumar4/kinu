/**
 * The reconnect snapshot's two halves have to agree.
 *
 * `getWorkspaceSnapshot` is the ONE round trip a tab makes when it opens or
 * reconnects, and the client reads it field by field off its own
 * `WorkspaceSnapshot` interface. Nothing at runtime notices when the interface
 * declares a field the server never returns: the read is `undefined`, the
 * setter stores it, and the surface that consumes it falls back to whatever its
 * absent-value default happens to be.
 *
 * That is not hypothetical. `tabPresence` was declared here, documented in
 * `lib/protocol.ts` as "also seeded into getWorkspaceSnapshot", consumed by the
 * tab strip through `surfaceHasContent`, and returned by NO server method —
 * `getWorkspaceTabPresence` did not exist either. Because the gated tabs'
 * predicate treats unknown as "not empty", a fresh workspace showed both tabs
 * the feature exists to hide, and the only proof of the feature was a unit test
 * over the client predicate, which passed.
 *
 * So this compares the declared field set against the keys the server's own
 * return literal carries, read from the source of both. It is a subset check in
 * one direction only: a server may return more than any client reads yet, and a
 * field no client reads is dead weight rather than a broken contract.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { parse, walk, type SyntaxNode } from '../../../scripts/syntax';
import { AGENT_RPC_ACCESS } from '../src/cli/rpc-gate';

const CLIENT = 'packages/cf-backend/src/hooks/use-kinu.ts';
const SERVER = 'packages/cf-backend/src/orchestrator.ts';

/** Property names of a named interface, as its own source declares them. */
function interfaceFields(file: string, name: string): string[] {
  const parsed = parse(file, readFileSync(file, 'utf8'));
  const found: string[] = [];
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;
    if (raw.type !== 'TSInterfaceDeclaration' || raw.id.name !== name) return;
    for (const member of raw.body.body) {
      if (member.type !== 'TSPropertySignature') continue;
      if (member.key.type === 'Identifier') found.push(member.key.name);
    }
  });
  if (found.length === 0) throw new Error(`${file} no longer declares interface ${name}`);
  return found;
}

/** The keys of the object literal a named method returns. */
function returnedKeys(file: string, method: string): string[] {
  const parsed = parse(file, readFileSync(file, 'utf8'));
  let keys: string[] | null = null;
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;
    if (raw.type !== 'MethodDefinition') return;
    if (raw.key.type !== 'Identifier' || raw.key.name !== method) return;
    walk(node, (inner: SyntaxNode) => {
      const innerRaw = inner.raw;
      if (keys !== null) return;
      if (innerRaw.type !== 'ReturnStatement') return;
      const returned = innerRaw.argument;
      if (returned === null || returned === undefined || returned.type !== 'ObjectExpression') return;
      keys = returned.properties.flatMap((property) =>
        property.type === 'Property' && property.key.type === 'Identifier' ? [property.key.name] : []);
    });
  });
  if (keys === null) throw new Error(`${file}'s ${method} no longer returns an object literal`);
  return keys;
}

describe('the workspace snapshot contract', () => {
  test('every field the client declares is returned by the server', () => {
    const declared = interfaceFields(CLIENT, 'WorkspaceSnapshot');
    const returned = returnedKeys(SERVER, 'getWorkspaceSnapshot');

    expect(declared.filter((field) => !returned.includes(field))).toEqual([]);
  });

  test('the durable authorities a reconnecting tab cannot learn any other way are on it', () => {
    const returned = returnedKeys(SERVER, 'getWorkspaceSnapshot');

    // Each of these is a fact a live broadcast will not repeat for a tab that
    // was disconnected when it happened: queued steers, running branches, and
    // whether the gated tabs have content.
    expect(returned).toContain('pendingSteers');
    expect(returned).toContain('branchRuns');
    expect(returned).toContain('tabPresence');
  });

  test('the tab-presence read the live cycle calls is a real, tiered RPC', () => {
    // The client refreshes presence on the shared live cycle. The method has to
    // exist AND carry a capability tier, because that map is also what puts it
    // on the orchestrator's declared RPC surface.
    expect(AGENT_RPC_ACCESS).toHaveProperty('getWorkspaceTabPresence', 'workspace.read');
    expect(returnedKeys(SERVER, 'getWorkspaceTabPresence')).toEqual(['releases', 'explorations']);
  });
});
