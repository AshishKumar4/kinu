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
 *
 * THE FIXTURE IS THE THIRD PARTY TO THE SAME CONTRACT, and it broke first. The
 * gallery's stub agent answers `getWorkspaceSnapshot` for every browser frame,
 * and when `branchRuns` joined the interface the stub kept its old shape — so
 * `snap.branchRuns.map` read `undefined`, the render died, and four browser
 * cases failed on a composer that never appeared. A server-only check cannot
 * see that, so the stub is held to the same field set here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parse, walk, type SyntaxNode } from '../../../scripts/syntax';
import { AGENT_RPC_ACCESS } from '../src/cli/rpc-gate';

const CLIENT = 'packages/cf-backend/src/hooks/use-kinu.ts';
const SERVER = 'packages/cf-backend/src/orchestrator.ts';
const GALLERY = 'packages/cf-backend/src/gallery.tsx';

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

/** The keys of one property's object literal inside a named `const` object —
 *  here, the gallery's canned answer for a single RPC method. */
function stubbedKeys(file: string, container: string, method: string): string[] {
  const parsed = parse(file, readFileSync(file, 'utf8'));
  let keys: string[] | null = null;
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;
    if (keys !== null) return;
    if (raw.type !== 'VariableDeclarator') return;
    if (raw.id.type !== 'Identifier' || raw.id.name !== container) return;
    walk(node, (inner: SyntaxNode) => {
      const innerRaw = inner.raw;
      if (keys !== null) return;
      if (innerRaw.type !== 'Property') return;
      if (innerRaw.key.type !== 'Identifier' || innerRaw.key.name !== method) return;
      if (innerRaw.value.type !== 'ObjectExpression') return;
      keys = innerRaw.value.properties.flatMap((property) =>
        property.type === 'Property' && property.key.type === 'Identifier' ? [property.key.name] : []);
    });
  });
  if (keys === null) throw new Error(`${file}'s ${container} no longer stubs ${method} with an object literal`);
  return keys;
}

/** A string-valued AST literal. An `ObjectExpression` element or call argument
 *  may be any node kind and a `Literal` carries string, number, boolean, null or
 *  a RegExp, so the shape is PARSED here rather than narrowed by hand: only the
 *  string case names a live-refresh source. */
const StringLiteralNode = v.object({ type: v.literal('Literal'), value: v.string() });

/** The string a node carries when it is a string literal, else null. */
function literalText(node: SyntaxNode['raw'] | null | undefined): string | null {
  const parsed = v.safeParse(StringLiteralNode, node);
  return parsed.success ? parsed.output.value : null;
}

/** The string literals a named function passes to `isSourceCurrent(...)`. */
function guardedSources(file: string, fn: string): string[] {
  const parsed = parse(file, readFileSync(file, 'utf8'));
  const found = new Set<string>();
  let seen = false;
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;
    if (raw.type !== 'FunctionDeclaration') return;
    if (raw.id === null || raw.id === undefined || raw.id.name !== fn) return;
    seen = true;
    walk(node, (inner: SyntaxNode) => {
      const call = inner.raw;
      if (call.type !== 'CallExpression') return;
      if (call.callee.type !== 'Identifier' || call.callee.name !== 'isSourceCurrent') return;
      const text = literalText(call.arguments[0]);
      if (text !== null) found.add(text);
    });
  });
  if (!seen) throw new Error(`${file} no longer declares function ${fn}`);
  return [...found];
}

/** The elements of a named `readonly` string-array constant. */
function arrayConstant(file: string, name: string): string[] {
  const parsed = parse(file, readFileSync(file, 'utf8'));
  let values: string[] | null = null;
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;
    if (values !== null) return;
    if (raw.type !== 'VariableDeclarator') return;
    if (raw.id.type !== 'Identifier' || raw.id.name !== name) return;
    if (raw.init === null || raw.init === undefined || raw.init.type !== 'ArrayExpression') return;
    values = raw.init.elements.flatMap((element) => {
      const text = literalText(element);
      return text === null ? [] : [text];
    });
  });
  if (values === null) throw new Error(`${file} no longer declares ${name} as an array literal`);
  return values;
}

describe('the workspace snapshot contract', () => {
  test('every field the client declares is returned by the server', () => {
    const declared = interfaceFields(CLIENT, 'WorkspaceSnapshot');
    const returned = returnedKeys(SERVER, 'getWorkspaceSnapshot');

    expect(declared.filter((field) => !returned.includes(field))).toEqual([]);
  });

  test('the gallery stub supplies each field a current snapshot reads', () => {
    const stubbed = stubbedKeys(GALLERY, 'AGENT_RPC_DATA', 'getWorkspaceSnapshot');

    // Snapshot-only fields have no granular source and always replace state.
    const snapshotOnly = ['status', 'pendingSteers', 'branchRuns'];
    // These fields have freshness guards, not presence guards. A current
    // initial load still reads them, so the gallery must supply them.
    const seeded = ['tools', 'executors', 'executorOutputs'];
    for (const field of [...snapshotOnly, ...seeded]) {
      expect(stubbed).toContain(field);
    }
  });

  test('every seeded source guards its own write in loadAllData', () => {
    // THE HALF THE SEAM TEST CANNOT REACH. `unit-live-refresh` proves
    // `isSourceCurrent` answers correctly for a superseded source, but it
    // supplies its own `read` callback, so it never exercises `loadAllData`'s
    // call sites. Measured: every one of the five guards could be replaced with
    // `true` and that suite still passed 22/0. So the application half is
    // asserted here, by derivation, and a sixth seeded source added without a
    // guard fails rather than silently overwriting a newer poll.
    const seeded = arrayConstant(CLIENT, 'SNAPSHOT_SEEDED_SOURCES');
    const guarded = guardedSources(CLIENT, 'loadAllData');

    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.filter((source) => !guarded.includes(source))).toEqual([]);
    // And nothing guards on a source the snapshot never seeds: that guard would
    // read `false` forever and the surface would never load at all.
    expect(guarded.filter((source) => !seeded.includes(source))).toEqual([]);
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
