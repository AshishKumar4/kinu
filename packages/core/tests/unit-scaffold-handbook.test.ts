// The Scaffold Handbook — the behaviour→site index the proposal prompt
// navigates by (Harness Handbook, arXiv:2607.13285).
//
// What these pin: the handbook is DERIVED from the layer gate's taxonomy
// (never a second copy of it), it is deterministic, and its scan of the live
// scaffold source reads code rather than prose.
import { describe, expect, test } from 'bun:test';
import { indexScaffoldSites, renderScaffoldHandbook } from '../src/evolution/scaffold-handbook.js';
import { LAYERS } from '../src/layergate/layers.js';
import { SUBJECT_SOURCE } from '../src/layergate/subjects.js';
import { INITIAL_SCAFFOLD_SOURCE } from '../src/scaffold/bootstrap.js';

describe('the handbook renders the layer gate’s taxonomy, not a second one', () => {
  const handbook = renderScaffoldHandbook(INITIAL_SCAFFOLD_SOURCE);

  test('every layer appears exactly once, with what it owns', () => {
    for (const layer of LAYERS) {
      expect(handbook.split(`L1 ${layer.id} [`).length - 1).toBe(1);
      expect(handbook).toContain(layer.owns);
    }
  });

  test('every subject appears at the module SUBJECT_SOURCE names for it', () => {
    for (const [subject, module] of Object.entries(SUBJECT_SOURCE)) {
      const line = handbook.split('\n').find((l) => l.startsWith('   L2 ') && l.includes(` ${subject}`));
      expect(line).toBeDefined();
      expect(line).toContain(module);
    }
  });

  test('measured layers advertise their probe count; unmeasured ones say so and why', () => {
    for (const layer of LAYERS) {
      if (layer.probes.length > 0) {
        expect(handbook).toContain(`L1 ${layer.id} [${layer.probes.length} probe`);
      } else {
        expect(handbook).toContain(`L1 ${layer.id} [NOT SCORED]`);
        expect(handbook).toContain(layer.unmeasuredBecause!.slice(0, 40));
      }
    }
  });

  test('it is deterministic — same source, byte-identical handbook', () => {
    expect(renderScaffoldHandbook(INITIAL_SCAFFOLD_SOURCE)).toBe(handbook);
  });

  test('it stays compact enough to prepend to every proposal prompt', () => {
    expect(handbook.length).toBeLessThan(8_000);
  });

  test('it makes no claim about which layers a bridge call reaches', () => {
    // A hand-maintained reachability table would drift silently. The
    // handbook indexes sites; it never asserts runtime reach.
    expect(handbook).not.toMatch(/host\.\w+\(\)\s+reaches\s+(context-assembly|every layer)/);
  });
});

describe('indexScaffoldSites — the L2 scan of the live scaffold', () => {
  test('the v0 bootstrap indexes to its one declaration and its real bridge call', () => {
    expect(indexScaffoldSites(INITIAL_SCAFFOLD_SOURCE)).toEqual([
      {
        name: 'run',
        kind: 'generator',
        line: 13,
        note: "The default loop delegates to host.defaultInference(), which runs the agent's standard " +
          'inference (full tools + multi-step) and streams the response to the user.',
        bridgeCalls: ['defaultInference'],
      },
    ]);
  });

  test('prose that mentions the bridge is not a site — comments are stripped', () => {
    const sites = indexScaffoldSites(
      '// this loop could call host.llmStream() one day\n' +
      '/* and host.callTool() too */\n' +
      'async function* run(rt, task) {\n  await host.defaultInference();\n}\n',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]!.bridgeCalls).toEqual(['defaultInference']);
  });

  test('a `//` inside a string literal stays code', () => {
    const sites = indexScaffoldSites(
      'async function* run(rt, task) {\n' +
      '  const url = "https://x/y"; // a note\n' +
      '  await host.callTool("web_fetch", { url });\n}\n',
    );
    expect(sites[0]!.bridgeCalls).toEqual(['callTool']);
  });

  test('several declarations each get their own span, in source order', () => {
    const sites = indexScaffoldSites(
      '// Plan the turn.\nfunction plan(task) { return task; }\n\n' +
      'const REVIEW = 3;\n\n' +
      'async function* run(rt, task) {\n' +
      '  await host.llmStream({ system: plan(task), messages: [] });\n' +
      '  await host.emit({ type: "done" });\n' +
      '  await host.emit({ type: "done" });\n}\n',
    );
    expect(sites.map((s) => [s.name, s.kind, s.bridgeCalls])).toEqual([
      ['plan', 'function', []],
      ['REVIEW', 'binding', []],
      ['run', 'generator', ['llmStream', 'emit']],
    ]);
    expect(sites[0]!.note).toBe('Plan the turn.');
  });

  test('top-level statements that reach the bridge are their own site', () => {
    const sites = indexScaffoldSites(
      'await host.emit({ type: "chunk", data: "warming up" });\n' +
      'async function* run(rt, task) {\n  await host.defaultInference();\n}\n',
    );
    expect(sites.map((s) => s.name)).toEqual(['<module>', 'run']);
    expect(sites[0]!.kind).toBe('module');
  });

  test('a source with nothing top-level indexes to nothing, and still renders', () => {
    expect(indexScaffoldSites('// just a comment\n')).toEqual([]);
    expect(renderScaffoldHandbook('// just a comment\n')).toContain('no top-level declarations found');
  });
});
