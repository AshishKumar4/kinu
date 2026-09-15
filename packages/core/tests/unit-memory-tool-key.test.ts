/**
 * One fact, one name — the spelling the STORE wrote it under.
 *
 * The defect this locks: the tool answered `remember` with the caller's raw
 * key while the store had folded it on write, so the model was told a fact is
 * "every-tool probe" and a search rendered it as `[fact: every-tool_probe]`.
 * Two names for one row — and a caller that checks its own echo (the
 * first-run every-tool case did) misses what it just wrote. Post-publish
 * f1da0985f measured exactly that: remember answered `{"ok":true,"key":
 * "every-tool probe"}` and the following search named `every-tool_probe`.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import {
  buildBuiltinTools, createFactsStore, initAllTables, initFactsTable,
  type MemoryToolInput, type JsonValue,
} from '../src/index';

const FactAnswerSchema = v.object({ ok: v.boolean(), key: v.string() });

const RecallSchema = v.object({ found: v.boolean(), key: v.string() });

const ForgetSchema = v.object({ ok: v.boolean(), key: v.string(), existed: v.boolean() });

function memoryTool() {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, testSql.sql);
  initFactsTable(testSql.execRaw);
  rt.memory.search = async () => [];

  return toolExecute<MemoryToolInput, JsonValue | string>(
    buildBuiltinTools({ rt, facts: createFactsStore(testSql.sql, rt.actor) }).memory);
}

describe('the memory tool names a fact by its stored key', () => {
  test('remember answers the folded key, and search renders the same name', async () => {
    const memory = memoryTool();
    const remembered = v.parse(FactAnswerSchema, await memory({ action: 'remember', key: 'Every-Tool  Probe', value: 'ok' }));

    expect(remembered).toEqual({ ok: true, key: 'every-tool_probe' });

    const search = v.parse(v.string(), await memory({ action: 'search', query: 'every-tool probe' }));

    expect(search).toContain('[fact: every-tool_probe]');

    // Recall names the row the store keeps under either spelling.
    const recalled = v.parse(RecallSchema, await memory({ action: 'recall', key: 'Every-Tool Probe' }));
    const missing = v.parse(RecallSchema, await memory({ action: 'recall', key: 'Never There' }));

    expect(recalled).toMatchObject({ found: true, key: 'every-tool_probe' });
    expect(missing).toEqual({ found: false, key: 'never_there' });
  });

  test('forget answers the folded key too', async () => {
    const memory = memoryTool();
    await memory({ action: 'remember', key: 'Every-Tool Probe', value: 'ok' });

    const forgotten = v.parse(ForgetSchema, await memory({ action: 'forget', key: 'Every-Tool Probe' }));

    expect(forgotten).toEqual({ ok: true, key: 'every-tool_probe', existed: true });
  });
});
