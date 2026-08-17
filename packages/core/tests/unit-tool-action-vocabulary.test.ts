// Every native tool that dispatches on a model-supplied discriminant must
// refuse an unrecognised one BY NAMING THE VOCABULARY.
//
// The class, not the instance. `jsonSchema<T>({…})` from the AI SDK carries a
// schema to the provider and leaves `Schema.validate` undefined, so
// `safeValidateTypes` returns the model's raw JSON untouched and the declared
// TypeScript union is a claim about the value, never a fact. Four dispatchers
// then switched on that claim:
//
//   agents  guarded it and answered with the available actions   — correct
//   tasks   fell out of a `default` into `unknown tasks action 'list">'`
//   web     fell out of a `default` into `unknown web action '…'`
//   memory  named the action back, but never the alternatives
//   report  did not check `status` at all — a bogus status reached the
//           orchestrator's inbox typed as one of the three
//
// A refusal the model cannot act on is how one malformed call becomes a loop,
// which is what the owner saw. This gate makes the whole class impossible: add
// a dispatcher that answers without its vocabulary and it goes red.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute } from '@proteus/test-utils';
import * as v from 'valibot';
import {
  buildBuiltinTools, initAllTables, initTaskListTable,
  TASKS_TOOL_ACTIONS, WEB_TOOL_ACTIONS, FILE_TOOL_ACTIONS, memoryActionsFor,
  SUBORDINATE_REPORT_STATUSES,
  type AgentRuntime, type WebSearchProvider,
} from '../src/index.ts';
import type { ToolSet } from 'ai';

/** The malformed argument the owner's model actually emitted. A `">` fragment
 *  inside a tool argument, kept verbatim so this gate is anchored to the real
 *  payload rather than a tidy stand-in. */
const MALFORMED = 'list">';

const ErrorSchema = v.object({ error: v.string() });

/** One dispatching tool: how to build it, which argument carries the
 *  discriminant, and the vocabulary a refusal has to name. */
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
    build: (rt) => buildBuiltinTools({ rt }),
  },
  {
    tool: 'web', field: 'action', vocabulary: WEB_TOOL_ACTIONS,
    build: (rt) => buildBuiltinTools({ rt, webSearch: noopWebSearch }),
  },
  {
    // Facts NOT wired, deliberately: the refusal must name the reachable set,
    // so offering `remember` here would be the drift memoryActionsFor prevents.
    tool: 'memory', field: 'action', vocabulary: memoryActionsFor(false),
    build: (rt) => buildBuiltinTools({ rt }),
  },
  {
    tool: 'report', field: 'status', vocabulary: SUBORDINATE_REPORT_STATUSES,
    build: (rt) => buildBuiltinTools({ rt, report: { report: async () => ({ ok: true }) } }),
  },
  {
    tool: 'file', field: 'action', vocabulary: FILE_TOOL_ACTIONS,
    build: (rt) => buildBuiltinTools({ rt }),
  },
];


/** Arguments as a MODEL can send them: the discriminant plus enough of the
 *  other fields that a surface reaching its dispatch body would proceed, so a
 *  refusal proves the discriminant check ran and not a missing-argument guard. */
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
      const result = await exec({
        [surface.field]: MALFORMED, content: 'body', query: 'q', path: 'a.txt',
      });
      const { error } = v.parse(ErrorSchema, result);

      // Every reachable value is offered, so one retry can succeed.
      for (const word of surface.vocabulary) {
        expect(error).toContain(word);
      }
      // And the refusal is about the argument, not a bare restatement of what
      // the model typed — which is all `unknown tasks action 'list">'` was.
      expect(error).toContain(surface.field);
    });
  }

  test('the surface list is the whole dispatching surface (guards the guard)', () => {
    // A dispatcher added without an entry here would never be checked. Every
    // native tool whose schema declares an enum'd discriminant must appear
    // above.
    const rt = runtime();
    const tools = buildBuiltinTools({
      rt,
      webSearch: noopWebSearch,
      report: { report: async () => ({ ok: true }) },
    });
    const named = SURFACES.map((surface) => surface.tool);
    const dispatching = Object.keys(tools).filter((name) => {
      const parsed = v.safeParse(
        v.object({ jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }) }),
        tools[name]?.inputSchema,
      );
      if (!parsed.success) return false;
      const properties = parsed.output.jsonSchema.properties;
      return Object.keys(properties).some((key) => {
        const enumerated = v.safeParse(v.object({ enum: v.array(v.string()) }), properties[key]);
        // Only the DISCRIMINANT counts: `tasks.status`/`tasks.stance` are enum'd
        // arguments of an action, not the choice of action itself.
        return enumerated.success && (key === 'action' || key === 'status');
      });
    });
    expect(dispatching.filter((name) => !named.includes(name))).toEqual([]);
    expect(dispatching.length).toBeGreaterThanOrEqual(4);
  });
});

describe('a well-formed call is unaffected', () => {
  test('the vocabulary check does not stand between the model and a real call', async () => {
    const exec = surfaceUnder(runtime(), SURFACES[0]!);
    const added = v.parse(
      v.object({ added: v.array(v.object({ id: v.string() })) }),
      await exec({ action: 'add', titles: ['ship it'] }),
    );
    expect(added.added.map((t) => t.id)).toEqual(['t1']);
  });
});
