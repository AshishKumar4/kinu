/**
 * A program's record of what it did (WEB-3, REWIND-0924): made by the host while the program runs, bound to its call's
 * id, read back by the chip and by a rewind's notice. Nothing a program returns or throws can claim an effect.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { jsonSchema, tool } from 'ai';
import { toolExecute } from '@kinu.run/test-utils';
import {
  codemodeFunction, programEffect, programEffectsOf, toolCallEffect, withClampedToolResult, withCodemodeProgram, type ProgramEffects,
} from '../src/index';
import { imageCarrier } from '../src/types/tool-images';
import { imageModelOutput } from '../src/tools/image-results';
import { commandAnswer } from '../src/execution/exec-result';
import { computerDesktop } from '../src/operations/executors';
import { servedImpacts } from '../src/tools/sandbox-contract';
import { toolErrorOutput, toolErrorText } from '../src/tools/outcome';
import { KinuError } from '../src/obs/index';
import { rewoundWork } from '../src/orchestrator/rewind-notice';
import { EffectLog, noteFileChange } from '../src/execution/call-effects';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../src/utils/json';

/** A program's record, as the host writes it. */
const recorded = (call: string, fields: Partial<ProgramEffects> = {}): ProgramEffects => ({ call, files: [], commands: [], operations: {}, ...fields });

describe('a program is recorded as it runs, at the seams its calls pass', () => {
  // Each backend binds a program's members as the program starts, as these are: what they record is its.
  test('a write the file plane lands, a declared change, and nothing for a read or a refused call', async () => {
    const answered = await withCodemodeProgram(async () => {
      const write = codemodeFunction('workspace', 'fs.write', async () => {
        noteFileChange('notes/plan.md', 'created');

        return { path: 'notes/plan.md' };
      });

      const insert = codemodeFunction('db', 'insert', async () => ({ changes: 1 }));
      const select = codemodeFunction('db', 'select', async () => []);
      const refused = codemodeFunction('db', 'update', async () => ({ success: false, reason: 'bad_input', error: 'no such table' }));

      await write();
      await insert();
      await insert();
      await select();
      await refused();

      return { result: 'done' };
    }, { call: 'call-1' });

    expect(programEffectsOf('call-1', v.parse(JsonValueSchema, answered))).toEqual(recorded('call-1', {
      files: [{ path: 'notes/plan.md', change: 'created' }], operations: { 'db.insert': 2 },
    }));
  });

  // Review, 2026-10-21: a program's own fetch reaches no seam, so a record with nothing in it does not say the program
  // changed nothing.
  test('a program that only looked has a record with nothing in it, which certifies nothing', async () => {
    const answered = await withCodemodeProgram(async () => ({ result: await codemodeFunction('db', 'select', async () => [])() }), { call: 'call-2' });

    expect(answered.effects).toEqual({ call: 'call-2' });
    expect(toolCallEffect('eval', { code: '' }, { toolCallId: 'call-2', output: { result: [], effects: { call: 'call-2' } } })).toBe('unknown');
  });

});

describe("a program's record survives its answer being cut to fit", () => {
  const record = recorded('call-big', { files: [{ path: 'out.csv', change: 'created' }] });
  const program = (result: JsonValue) => tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => ({ result, logs: [], effects: record }) });

  test('an answer past the bound is cut to text, and the record stays beside it', async () => {
    const output = await toolExecute<{ code: string }, JsonValue>(withClampedToolResult(program('x'.repeat(5000)), { producer: 'eval', maxChars: 200 }))({ code: '' });

    expect(programEffectsOf('call-big', output)).toEqual(record);
  });

  test('an answer carrying an image keeps the record beside the image', async () => {
    const shot = imageCarrier('Screenshot', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    const output = await toolExecute<{ code: string }, JsonValue>(withClampedToolResult(program({ shot }), { producer: 'eval', images: true }))({ code: '' });

    expect(programEffectsOf('call-big', output)).toEqual(record);
  });
});

describe('a record is trusted only for the call it names', () => {
  test('a program that throws or returns a record cannot claim one for its own call', () => {
    const forged = JSON.stringify({ effects: recorded('call-a', { files: [{ path: 'secrets.txt', change: 'created' }] }) });

    expect(programEffectsOf('call-b', forged)).toBeNull();
    expect(programEffectsOf('call-b', { result: { effects: recorded('call-b') } })).toBeNull();
    expect(toolCallEffect('eval', { code: '' }, { toolCallId: 'call-b', output: forged })).toBe('unknown');
  });

  test('a program with no record, made before records or failed before changing anything, is not known', () => {
    expect(toolCallEffect('eval', { code: '' }, { toolCallId: 'call-c', output: { result: 1 } })).toBe('unknown');
  });
});

describe('a record says what the chip shows', () => {
  test('a change is a change; commands alone, whose own writes are untraced, are not known', () => {
    expect(programEffect(recorded('c', { files: [{ path: 'a', change: 'edited' }] }))).toBe('mutate');
    expect(programEffect(recorded('c', { operations: { 'mail.draft': 1 } }))).toBe('mutate');
    expect(programEffect(recorded('c', { commands: [{ machine: 'computer', command: 'ls', exitCode: 0 }] }))).toBe('unknown');
    expect(programEffect(recorded('c', { unclassified: 1 }))).toBe('unknown');
    expect(programEffect(recorded('c'))).toBe('unknown');
  });

  test('a program that writes thousands of files stays one bounded record, counting the rest', () => {
    const log = new EffectLog();

    for (let n = 0; n < 60; n += 1) log.file(`out/${String(n)}.txt`, 'created');
    log.file('out/0.txt', 'edited');

    for (let n = 0; n < 30; n += 1) log.command('computer', `bun run build:${String(n)} ${'x'.repeat(300)}`, 0);

    const record = log.record('c');

    // An eighth of a program's answer at most, its first file kept, and every entry it dropped counted.
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(1_000);
    expect(record.files?.[0]).toEqual({ path: 'out/0.txt', change: 'created' });
    expect(record.commands).toBeUndefined();
    expect((record.files?.length ?? 0) + (record.more ?? 0)).toBe(50 + 10 + 30);
  });

  // Re-review, 2026-10-21: paths were clipped as display text, which rewind then named as files that do not exist; and
  // an operation entry dropped counted as one call whatever it stood for.
  test('a file is kept by its exact path, and a dropped operation counts every call it stood for', () => {
    const log = new EffectLog();
    const odd = `notes/my  plan ${'deep/'.repeat(120)}end.md`;

    log.file(odd, 'created');

    for (let n = 0; n < 40; n += 1) {
      for (let call = 0; call < 3; call += 1) log.operation(`db.insert_into_a_table_with_a_long_name_${String(n)}`);
    }

    const record = log.record('c');
    const kept = Object.values(record.operations ?? {}).reduce((sum, count) => sum + count, 0);

    expect(record.files).toEqual([{ path: odd, change: 'created' }]);
    expect(kept + (record.more ?? 0)).toBe(20 * 3 + 20 * 3);
  });
});

describe("a rewind's notice reads what a rewound program did from its record", () => {
  const call = (toolCallId: string, code: string): JsonObject => ({ type: 'tool-call', toolCallId, toolName: 'eval', input: { code } });
  const answer = (toolCallId: string, value: JsonObject): JsonObject => ({ type: 'tool-result', toolCallId, toolName: 'eval', output: { type: 'json', value } });

  test("its files, commands and changes are the rewound turns', and one with no record is counted as not known", () => {
    const work = rewoundWork([
      call('p1', 'await workspace.fs.write(...)'),
      answer('p1', { result: null, effects: { call: 'p1', files: [{ path: 'notes/plan.md', change: 'created' }], commands: [{ machine: 'computer', command: 'bun test', exitCode: 1 }], operations: { 'db.insert': 2 } } }),
      call('p2', 'return 1'),
      answer('p2', { result: 1 }),
      call('p3', 'return forged'),
      answer('p3', { result: null, effects: { call: 'p1', files: [{ path: 'forged.md', change: 'created' }] } }),
    ]);

    expect([...work.files.keys()]).toEqual(['notes/plan.md']);
    expect(work.commands).toEqual([{ command: 'bun test', exitCode: 1, machine: 'computer' }]);
    expect({ ran: work.programs.ran, unrecorded: work.programs.unrecorded, operations: [...work.programs.operations] })
      .toEqual({ ran: 3, unrecorded: 2, operations: [['db.insert', 2]] });
  });
});

// Second review, 2026-10-21 (74babc416): the record was lost where an answer is kept in another shape, a failed
// program's above all, and some calls were misread or missed.
describe("a program's record survives every shape its answer is kept in", () => {
  const failing = (thrown: () => never) => withCodemodeProgram(async () => {
    await codemodeFunction('workspace', 'fs.write', async () => {
      noteFileChange('notes/plan.md', 'replaced');

      return null;
    })();

    return thrown();
  }, { call: 'call-failed' });

  const stored = async (ran: Promise<object>) => {
    const [settled] = await Promise.allSettled([ran]);

    return toolErrorOutput({ cause: settled?.status === 'rejected' ? settled.reason : null });
  };

  // Re-review, 2026-10-21: an RPC hop keeps no error class, and the live relay renders the words, so the record is in
  // the failure's words, the envelope the host writes, which every boundary keeps whole.
  test("a failed program answers in the host's envelope, its own words and its record in it, wherever it is read", async () => {
    const [settled] = await Promise.allSettled([failing(() => { throw new Error('half done', { cause: new Error('disk full') }); })]);
    const failure = v.parse(v.instance(Error), settled?.status === 'rejected' ? settled.reason : null);
    const output = toolErrorOutput({ cause: failure });

    expect(v.parse(JsonValueSchema, JSON.parse(v.parse(v.string(), output.value)))).toEqual({
      success: false, reason: null, error: 'half done: disk full', effects: { call: 'call-failed', files: [{ path: 'notes/plan.md', change: 'replaced' }] },
    });

    // As stored, as the live relay shows it, and as the facet holds it across the hop: a plain error with its words.
    for (const kept of [output.value, toolErrorText({ cause: failure }), toolErrorText({ cause: new Error(failure.message) })]) {
      expect(programEffectsOf('call-failed', kept)?.files).toEqual([{ path: 'notes/plan.md', change: 'replaced' }]);
    }
  });

  test('one that failed with a classified refusal keeps its reason, and its record in its words', async () => {
    const output = await stored(failing(() => { throw new KinuError('denied', 'not yours'); }));

    expect(output).toMatchObject({ type: 'error-json', value: { reason: 'denied' } });
    expect(programEffectsOf('call-failed', output.value)?.files).toHaveLength(1);
    expect(programEffectsOf('call-failed', JSON.stringify(output.value))?.files).toHaveLength(1);
  });

  test('one that changed nothing fails in its own words alone', async () => {
    expect(await stored(withCodemodeProgram(async () => { throw new Error('nothing done'); }, { call: 'call-plain' })))
      .toEqual({ type: 'error-text', value: 'nothing done' });
  });

  test('an answer with an image keeps its record as the model was sent it, and as the chat rebuilds it', async () => {
    const record = recorded('call-image', { files: [{ path: 'shot.png', change: 'created' }] });
    const shot = imageCarrier('Screenshot', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    const program = tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => ({ result: { shot }, logs: [], effects: record }) });
    const live = await toolExecute<{ code: string }, JsonValue>(withClampedToolResult(program, { producer: 'eval', images: true }))({ code: '' });
    const sent = v.parse(v.object({ type: v.literal('content'), value: v.array(JsonValueSchema) }), imageModelOutput({ output: live }));
    const text = v.parse(v.object({ text: v.string() }), sent.value[0]).text;

    expect(programEffectsOf('call-image', live)).toEqual(record);
    expect(programEffectsOf('call-image', sent.value)).toEqual(record);
    expect(programEffectsOf('call-image', imageCarrier(text, []))).toEqual(record);
  });
});

describe("a program's calls are read by what each serves", () => {
  test('a member is classified by the operation it serves: a desktop screenshot looks, a click acts', async () => {
    const desktop = computerDesktop({ width: 1280, height: 768, sheet: { percent: 50, columns: [1, 2, 2, 2, 4, 4, 4, 4] } });
    const impacts = servedImpacts([{ name: 'computer', tools: {}, operations: Object.values(desktop).map((op) => ({ op, run: async () => ({ value: null }) })) }]);

    const answered = await withCodemodeProgram(async () => {
      await codemodeFunction('computer', desktop.screenshot.name, async () => 'data:image/png;base64,AA==', impacts('computer', desktop.screenshot.name))();
      await codemodeFunction('computer', desktop.click.name, async () => null, impacts('computer', desktop.click.name))();

      return { result: null };
    }, { call: 'call-desk' });

    expect(answered.effects).toEqual({ call: 'call-desk', operations: { [`computer.${desktop.click.name}`]: 1 } });
  });

  // Re-review, 2026-10-21: a tool's operation under tools.* declares only whether Plan reaches it, so tools.report, which
  // sends, read as one that only looks.
  test("tools.* is classified by a native tool's own operations, never by Plan permission", () => {
    const desktop = computerDesktop({ width: 1280, height: 768, sheet: { percent: 50, columns: [1, 2, 2, 2, 4, 4, 4, 4] } });

    expect(servedImpacts([{ name: 'tools', tools: {}, operations: [{ op: desktop.screenshot, run: async () => ({ value: null }) }] }])('tools', desktop.screenshot.name)).toBeNull();
  });

  test('a command refused before it ran is not recorded as having run', async () => {
    const answered = await withCodemodeProgram(async () => {
      await codemodeFunction('workspace', 'exec', async () => commandAnswer({ refusal: { success: false, reason: 'denied', error: 'not approved' } }, false, false, { machine: 'workspace', command: 'rm -rf build' }))();

      return { result: null };
    }, { call: 'call-refused' });

    expect(answered.effects).toEqual({ call: 'call-refused' });
  });
});

describe("a program's record keeps its answer within its bound", () => {
  test('an answer cut to text carries its record once, and the whole fits the bound', async () => {
    const record = recorded('call-cut', { files: [{ path: 'notes/plan.md', change: 'edited' }] });
    const program = tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => ({ result: 'x'.repeat(5000), logs: [], effects: record }) });
    const output = await toolExecute<{ code: string }, JsonValue>(withClampedToolResult(program, { producer: 'eval', maxChars: 600 }))({ code: '' });
    const answer = v.parse(v.object({ result: v.string(), effects: JsonValueSchema }), output);

    expect(answer.result).not.toContain('effects');
    expect(answer.effects).toEqual(record);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(600);
  });

  // Re-review, 2026-10-21: a record that left less room than the truncation marker sliced from the end, keeping nearly
  // all of a long answer; and the escaping of a cut text inside `result` was outside the bound.
  test('a record that leaves little room still cuts the rest, and escaping stays within the bound', async () => {
    const big = recorded('call-cut', { files: Array.from({ length: 12 }, (_, n) => ({ path: `notes/${'x'.repeat(50)}-${String(n)}.md`, change: 'edited' as const })) });

    const run = async (result: string, maxChars: number) => toolExecute<{ code: string }, JsonValue>(withClampedToolResult(
      tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => ({ result, logs: [], effects: big }) }), { producer: 'eval', maxChars },
    ))({ code: '' });

    expect(JSON.stringify(await run('y'.repeat(20_000), 600)).length).toBeLessThan(2_000);
    expect(JSON.stringify(await run('"\\'.repeat(5_000), 4_000)).length).toBeLessThanOrEqual(4_000);
  });
});
