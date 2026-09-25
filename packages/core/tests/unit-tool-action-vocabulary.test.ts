// A refusal of an unrecognised discriminant must name the vocabulary: AI SDK `jsonSchema<T>` never validates, so
// the TypeScript union is a claim, and an unactionable refusal turns one malformed call into a loop.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  buildBuiltinTools, initAllTables, initTaskListTable,
  TASKS_TOOL_ACTIONS, WEB_TOOL_ACTIONS, FILE_TOOL_ACTIONS, memoryActionsFor,
  SUBORDINATE_REPORT_STATUSES,
  type AgentRuntime, type WebSearchProvider,
} from '../src/index';
import { asSchema, type ToolSet } from 'ai';
import { storesFor } from './helpers';

/** The malformed argument a model actually emitted, kept verbatim. */
const MALFORMED = 'list">';

interface DispatchSurface {
  readonly tool: string;
  readonly field: string;
  readonly vocabulary: readonly string[];
  build(rt: AgentRuntime): ToolSet;
}

const noopWebSearch: WebSearchProvider = {
  search: async (query) => ({ query, results: [], source: 'duckduckgo' }),
  fetch: async (url) => ({ url, markdown: '', retrievedAt: '2026-01-01T00:00:00Z' }),
};

const SURFACES: readonly DispatchSurface[] = [
  {
    tool: 'tasks', field: 'action', vocabulary: TASKS_TOOL_ACTIONS,
    build: (rt) => buildBuiltinTools({ rt, history: storesFor(rt).history }),
  },
  {
    tool: 'web', field: 'action', vocabulary: WEB_TOOL_ACTIONS,
    build: (rt) => buildBuiltinTools({ rt, webSearch: noopWebSearch, history: storesFor(rt).history }),
  },
  {
    // Facts not wired: the refusal must name only the reachable set.
    tool: 'memory', field: 'action', vocabulary: memoryActionsFor(false),
    build: (rt) => buildBuiltinTools({ rt, history: storesFor(rt).history }),
  },
  {
    tool: 'report', field: 'status', vocabulary: SUBORDINATE_REPORT_STATUSES,
    build: (rt) => buildBuiltinTools({ rt, report: { report: async () => ({ ok: true }) }, history: storesFor(rt).history }),
  },
  {
    tool: 'file', field: 'action', vocabulary: FILE_TOOL_ACTIONS,
    build: (rt) => buildBuiltinTools({ rt, history: storesFor(rt).history }),
  },
];

/** Enough fields that a refusal proves the discriminant check ran, not a missing-argument guard. */
interface ProbeArgs {
  action?: string;
  status?: string;
  content?: string;
  query?: string;
  path?: string;
  titles?: string[];
}

function surfaceUnder(rt: AgentRuntime, surface: DispatchSurface) {
  const entry = surface.build(rt)[surface.tool];

  if (!entry) throw new Error(`expected the ${surface.tool} tool to be registered`);

  return toolExecute<ProbeArgs, unknown>(entry);
}

function runtime(): AgentRuntime {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, rt.storage.sql);
  initTaskListTable(testSql.execRaw);

  return rt;
}

describe('a model-supplied discriminant is refused with its vocabulary', () => {
  for (const surface of SURFACES) {
    test(`${surface.tool}.${surface.field}`, async () => {
      const exec = surfaceUnder(runtime(), surface);
      const pending = exec({ [surface.field]: MALFORMED, content: 'body', query: 'q', path: 'a.txt' });
      await expect(pending).rejects.toMatchObject({ code: 'bad_input' });

      for (const word of surface.vocabulary) await expect(pending).rejects.toThrow(word);
      await expect(pending).rejects.toThrow(surface.field);
    });
  }

  test('the surface list is the whole dispatching surface (guards the guard)', async () => {
    // Every native tool whose schema declares an enum'd discriminant must appear above.
    const rt = runtime();

    const tools = buildBuiltinTools({
      rt,
      history: storesFor(rt).history,
      webSearch: noopWebSearch,
      report: { report: async () => ({ ok: true }) },
    });

    const named = SURFACES.map((surface) => surface.tool);

    const sent = new Map<string, unknown>();

    for (const [name, entry] of Object.entries(tools)) sent.set(name, { jsonSchema: await asSchema(entry.inputSchema).jsonSchema });

    const dispatching = Object.keys(tools).filter((name) => {
      const parsed = v.safeParse(
        v.object({ jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }) }),
        sent.get(name),
      );

      if (!parsed.success) return false;
      const properties = parsed.output.jsonSchema.properties;

      return Object.keys(properties).some((key) => {
        const enumerated = v.safeParse(v.object({ enum: v.array(v.string()) }), properties[key]);

        return enumerated.success && (key === 'action' || key === 'status');
      });
    });

    expect(dispatching.filter((name) => !named.includes(name))).toEqual([]);
    expect(dispatching.length).toBeGreaterThanOrEqual(4);
  });
});

describe('a well-formed call is unaffected', () => {
  test('the vocabulary check does not stand between the model and a real call', async () => {
    const exec = surfaceUnder(runtime(), SURFACES[0]);

    const added = v.parse(
      v.object({ added: v.array(v.object({ id: v.string() })) }),
      await exec({ action: 'add', titles: ['ship it'] }),
    );

    expect(added.added.map((t) => t.id)).toEqual(['t1']);
  });
});
