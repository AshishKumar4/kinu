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
import { rewoundWork } from '../src/orchestrator/rewind-notice';
import { EffectLog, noteFileChange } from '../src/execution/call-effects';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../src/utils/json';

/** What a program that failed threw, as its call fails. */
async function thrownMessage(ran: Promise<object>): Promise<string> {
  const [settled] = await Promise.allSettled([ran]);

  return settled?.status === 'rejected' ? v.parse(v.instance(Error), settled.reason).message : '';
}

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

  test('a program that only looked is recorded as having changed nothing', async () => {
    const answered = await withCodemodeProgram(async () => ({ result: await codemodeFunction('db', 'select', async () => [])() }), { call: 'call-2' });

    expect(answered.effects).toEqual({ call: 'call-2' });
    expect(toolCallEffect('eval', { code: '' }, { toolCallId: 'call-2', output: { result: [], effects: { call: 'call-2' } } })).toBe('read');
  });

  test("a failed program's record is in the host's envelope, beside its own error; one that changed nothing keeps its words", async () => {
    const thrown = await thrownMessage(withCodemodeProgram(async () => {
      await codemodeFunction('workspace', 'fs.write', async () => {
        noteFileChange('notes/plan.md', 'replaced');

        return null;
      })();

      throw new Error('half done');
    }, { call: 'call-3' }));

    expect(programEffectsOf('call-3', thrown)?.files).toEqual([{ path: 'notes/plan.md', change: 'replaced' }]);
    expect(thrown).toContain('half done');

    const plain = await thrownMessage(withCodemodeProgram(async () => { throw new Error('nothing done'); }, { call: 'call-4' }));

    expect(plain).toBe('nothing done');
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
    expect(programEffect(recorded('c'))).toBe('read');
  });

  test('a program that writes thousands of files stays one bounded record, counting the rest', () => {
    const log = new EffectLog();

    for (let n = 0; n < 60; n += 1) log.file(`out/${String(n)}.txt`, 'created');
    log.file('out/0.txt', 'edited');

    const record = log.record('c');

    expect(record.files).toHaveLength(50);
    expect(record.files?.[0]).toEqual({ path: 'out/0.txt', change: 'created' });
    expect(record.more).toBe(10);
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
