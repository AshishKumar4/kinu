/**
 * Every field the client's snapshot interfaces declare must be returned by the server's literal and by the gallery stub.
 * Defends: `tabPresence` was declared but returned by no server method, so a fresh workspace showed the gated tabs;
 * and the stub lacked `branchRuns`, killing four browser cases. Subset check only: a server may return more.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parse, walk, type SyntaxNode } from '../../../scripts/syntax';
import { AGENT_RPC_ACCESS } from '@kinu.run/core';

const CLIENT = 'packages/cf-backend/src/hooks/use-kinu.ts';

const SERVER = 'packages/cf-backend/src/orchestrator.ts';

const GALLERY = 'packages/cf-backend/src/gallery.tsx';

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

/** Parsed rather than narrowed by hand: a `Literal` may carry any primitive or a RegExp; only strings name a source. */
const StringLiteralNode = v.object({ type: v.literal('Literal'), value: v.string() });

function literalText(node: SyntaxNode['raw'] | null | undefined): string | null {
  const parsed = v.safeParse(StringLiteralNode, node);

  return parsed.success ? parsed.output.value : null;
}

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
  const DECLARED_CONTRACTS = [
    {
      name: 'every field the client declares is returned by the server',
      interfaceName: 'WorkspaceSnapshot',
      serverFn: 'getWorkspaceSnapshot',
    },
    /**
     * `actorId` decides what a pane admits, and an `undefined` read would silently close admission on its own frames.
     * The gallery answer already carries `satisfies SubordinateSnapshot`, a stronger check than this one.
     */
    {
      name: 'every field a facet tab declares is returned by getActorSnapshot',
      interfaceName: 'SubordinateSnapshot',
      serverFn: 'getActorSnapshot',
    },
  ] as const;

  for (const { name, interfaceName, serverFn } of DECLARED_CONTRACTS) {
    test(name, () => {
      const declared = interfaceFields(CLIENT, interfaceName);
      const returned = returnedKeys(SERVER, serverFn);

      expect(declared.filter((field) => !returned.includes(field))).toEqual([]);
    });
  }

  test('the gallery stub supplies each field a current snapshot reads', () => {
    const stubbed = stubbedKeys(GALLERY, 'AGENT_RPC_DATA', 'getWorkspaceSnapshot');

    const declared = interfaceFields(CLIENT, 'WorkspaceSnapshot');
    expect(declared.filter((field) => !stubbed.includes(field))).toEqual([]);
  });

  test('every seeded source guards its own write in loadAllData', () => {
    // `unit-live-refresh` supplies its own `read`, so it never exercises `loadAllData`'s guards (measured: all five
    // replaced with `true` still passed 22/0). An unguarded sixth source fails here instead of overwriting a newer poll.
    const seeded = arrayConstant(CLIENT, 'SNAPSHOT_SEEDED_SOURCES');
    const guarded = guardedSources(CLIENT, 'loadAllData');

    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.filter((source) => !guarded.includes(source))).toEqual([]);
    // A guard on a source the snapshot never seeds would read `false` forever and never load.
    expect(guarded.filter((source) => !seeded.includes(source))).toEqual([]);
  });

  test('the durable authorities a reconnecting tab cannot learn any other way are on it', () => {
    const returned = returnedKeys(SERVER, 'getWorkspaceSnapshot');

    // Facts a live broadcast will not repeat for a tab that was disconnected when they happened.
    expect(returned).toContain('pendingSteers');
    expect(returned).toContain('branchRuns');
    expect(returned).toContain('tabPresence');
  });

  test('the tab-presence read the live cycle calls is a real, tiered RPC', () => {
    // The capability-tier map is also what puts the method on the orchestrator's declared RPC surface.
    expect(AGENT_RPC_ACCESS).toHaveProperty('getWorkspaceTabPresence', 'workspace.read');
    expect(returnedKeys(SERVER, 'getWorkspaceTabPresence')).toEqual(['work', 'explorations']);
  });
});
