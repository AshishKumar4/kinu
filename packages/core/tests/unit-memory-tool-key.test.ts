/** The tool answers with the key the store wrote under, so a caller checking its own echo finds the row. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import {
  buildBuiltinTools, createFactsStore, initAllTables, initFactsTable,
  type JsonValue,
} from '../src/index';
import { conversationsFor } from './helpers';
import type { JsonObject } from '../src/utils/json';

const FactAnswerSchema = v.object({ key: v.string() });

const RecallSchema = v.nullable(v.object({ key: v.string() }));

const ForgetSchema = v.object({ key: v.string(), existed: v.boolean() });

const SearchSchema = v.object({ hits: v.array(v.object({ ref: v.string() })) });

function memoryTool() {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, testSql.sql);
  initFactsTable(testSql.execRaw);
  rt.memory.search = async () => [];

  return toolExecute<JsonObject, JsonValue | string>(
    buildBuiltinTools({ rt, facts: createFactsStore(testSql.sql, rt.actor), conversations: conversationsFor(rt) }).memory);
}

describe('the memory tool names a fact by its stored key', () => {
  test('remember answers the folded key, and search renders the same name', async () => {
    const memory = memoryTool();
    const remembered = v.parse(FactAnswerSchema, await memory({ op: 'remember', key: 'Every-Tool  Probe', value: 'ok' }));

    expect(remembered).toEqual({ key: 'every-tool_probe' });

    const search = v.parse(SearchSchema, await memory({ op: 'search', query: 'every-tool probe' }));

    expect(search.hits.map((hit) => hit.ref)).toContain('fact: every-tool_probe');

    // Recall names the row the store keeps under either spelling.
    const recalled = v.parse(RecallSchema, await memory({ op: 'recall', key: 'Every-Tool Probe' }));
    const missing = v.parse(RecallSchema, await memory({ op: 'recall', key: 'Never There' }));

    expect(recalled).toMatchObject({ key: 'every-tool_probe' });
    expect(missing).toBeNull();
  });

  test('forget answers the folded key too', async () => {
    const memory = memoryTool();
    await memory({ op: 'remember', key: 'Every-Tool Probe', value: 'ok' });

    const forgotten = v.parse(ForgetSchema, await memory({ op: 'forget', key: 'Every-Tool Probe' }));

    expect(forgotten).toEqual({ key: 'every-tool_probe', existed: true });
  });
});
