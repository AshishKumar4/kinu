/**
 * The fast tier names each finished phase of an answer (the owner, 2026-10-19) once a tab shows it, written into its
 * metadata; a phase it could not name keeps the calls' own line, and a failed call ends the writing.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { Effect } from 'effect';
import { writePhaseLines, type PhaseLinePorts } from '../src/orchestrator/phase-lines';
import { PHASE_TITLES_METADATA_KEY, TURN_TITLE_METADATA_KEY } from '../src/read-models/tool-phase-title';
import type { JsonObject } from '../src/utils/json';

type Part = UIMessage['parts'][number];

const read = (id: string): Part => ({ type: 'tool-file', toolCallId: id, state: 'output-available', input: { op: 'read', path: `${id}.ts` }, output: '…' });

const said = (text: string): Part => ({ type: 'text', state: 'done', text });

/** An answer of `phases` phases of two calls each, its words after each. */
function answerOf(phases: number): Part[] {
  return Array.from({ length: phases }, (_, at) => [read(`p${String(at)}a`), read(`p${String(at)}b`), said(`phase ${String(at)} done`)]).flat();
}

/** Ports over one answer: the prompts the fast tier was asked, the patches written, and whether the route was resolved. */
function portsOver(parts: readonly Part[] | null, answers: (prompt: string, at: number) => string, metadata?: JsonObject) {
  const asked: string[] = [];
  const patches: JsonObject[] = [];
  let resolved = 0;

  const ports: PhaseLinePorts = {
    answer: async () => (parts === null ? null : { parts, metadata, ask: 'Fix the Worker.' }),
    completer: async () => {
      resolved += 1;

      return async (_system, prompt) => {
        asked.push(prompt);

        return answers(prompt, asked.length - 1);
      };
    },
    amend: async (_id, patch) => { patches.push(patch); },
  };

  return { ports, asked, patches, resolved: () => resolved };
}

const run = async (ports: PhaseLinePorts) => await Effect.runPromise(writePhaseLines(ports, 'a1'));

describe("an answer's phase lines", () => {
  test('each phase is named in order, and a turn of three phases or more is named whole, in one write', async () => {
    const lines = ['Found the renamed binding', 'Fixed the reader', 'Shipped it', 'Fixed and shipped the Worker'];
    const { ports, asked, patches, resolved } = portsOver(answerOf(3), (_prompt, at) => JSON.stringify({ title: lines[at] }));

    expect(await run(ports)).toBe('named');
    expect(resolved()).toBe(1);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain('"path":"p0a.ts"');
    expect(asked[3]).toContain('1. Found the renamed binding');
    expect(patches).toEqual([{
      [PHASE_TITLES_METADATA_KEY]: { p0a: 'Found the renamed binding', p1a: 'Fixed the reader', p2a: 'Shipped it' },
      [TURN_TITLE_METADATA_KEY]: 'Fixed and shipped the Worker',
    }]);
  });

  test('a short turn is named phase by phase only, and a phase already named is not asked again', async () => {
    const written = { [PHASE_TITLES_METADATA_KEY]: { p0a: 'Found it' } };
    const { ports, asked, patches } = portsOver(answerOf(2), () => '{"title": "Fixed it."}', written);

    expect(await run(ports)).toBe('named');
    expect(asked).toHaveLength(1);
    expect(patches).toEqual([{ [PHASE_TITLES_METADATA_KEY]: { p0a: 'Found it', p1a: 'Fixed it' } }]);
  });

  test('a failed call ends the writing: the lines before it are kept, the rest keep the calls\' lines, and none is asked again', async () => {
    const { ports, asked, patches } = portsOver(answerOf(3), (_prompt, at) => {
      if (at === 1) throw new Error('429 rate limiting: inference request per min rate reached');

      return '{"title": "Found the renamed binding"}';
    });

    expect(await run(ports)).toBe('named some; the fast tier did not answer the rest');
    expect(asked).toHaveLength(2);
    expect(patches).toEqual([{ [PHASE_TITLES_METADATA_KEY]: { p0a: 'Found the renamed binding' } }]);
  });

  test('an answer rewound, or with no phase, asks the fast tier nothing and writes nothing', async () => {
    const gone = portsOver(null, () => '{}');
    const plain = portsOver([read('only'), said('Done.')], () => '{}');

    expect(await run(gone.ports)).toBeNull();
    expect(await run(plain.ports)).toBe('no phase to name');
    expect([gone.resolved(), plain.resolved(), gone.patches.length + plain.patches.length]).toEqual([0, 0, 0]);
  });

});

describe('a line as the model writes it', () => {
  test('is read from its JSON without a closing full stop; words outside JSON, or an empty title, are no line', async () => {
    const answers = ['Here: {"title": "Traced 500 to renamed D1 binding."}', 'Fixed the reader', '{"title": ""}'];
    const { ports, patches } = portsOver(answerOf(3), (_prompt, at) => answers[at] ?? '{}');
    const none = portsOver(answerOf(1), () => 'Fixed the reader');

    expect(await run(ports)).toBe('named');
    expect(patches).toEqual([{ [PHASE_TITLES_METADATA_KEY]: { p0a: 'Traced 500 to renamed D1 binding' } }]);
    expect(await run(none.ports)).toBe('nothing left to name');
    expect(none.patches).toEqual([]);
  });
});
