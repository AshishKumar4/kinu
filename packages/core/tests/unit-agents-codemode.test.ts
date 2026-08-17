// The `agents.*` codemode namespace — delegation projected into the sandbox,
// which is what turns a workflow into an ordinary crafted tool.
//
// What is pinned here:
//   - structural gating: members exist iff the deps wire the action, exactly
//     like the tool's action enum (agentsActionsFor is the one gate);
//   - it is a PROJECTION: every member lands in dispatchAgentsAction over the
//     same deps object the top-level tool holds — no second spawn/join path;
//   - the sandbox trust boundary: the member called decides the action, and a
//     malformed field is a value the script can read rather than a throw —
//     nothing here has the AI SDK's schema validation behind it;
//   - the declaration the model reads, including the non-resumable warning
//     that is the honest cost of forking from inside execute_tools.
//
// Real sandbox execution (node `new Function`, cf `createCodeTool`) is covered
// in the two backend suites; here the surface itself is the subject.
import { describe, expect, test } from 'bun:test';
import { createTestRuntime, createTestStrategy } from '@proteus/test-utils';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  AGENTS_TOOL_ACTIONS,
  FORK_STRATEGY_ID,
  agentsActionsFor,
  createAgentsCodemodeProvider,
  createAgentsTool,
  createStrategyRegistry,
  strategyOption,
  decodeJsonValue,
  type CodemodeProvider,
  type JsonValue,
  type AgentsForkDeps,
  type AgentsToolDeps,
  type PeersToolDeps,
  type StrategyContext,
  type SubordinateRosterEntry,
  type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
} from '../src/index.ts';

interface Call { action: string; input: JsonValue }

const ErrorResultSchema = v.object({ error: v.string() });
const AgentsInputSchemaContract = v.object({
  jsonSchema: v.object({
    properties: v.object({
      action: v.object({ enum: v.array(v.string()) }),
    }),
  }),
});

/** The namespace as sandbox code sees it: one callable per exposed member. */
function namespaceOf(deps: () => TestAgentsToolDeps) {
  const provider = createAgentsCodemodeProvider(() => withBuildMode(deps()));
  expect(provider.name).toBe('agents');
  return provider.tools;
}

function member(tools: CodemodeProvider['tools'], name: string) {
  const descriptor = tools[name];
  if (!descriptor) throw new Error(`missing agents.${name}`);
  return descriptor;
}

function recordCall<Value>(calls: Call[], action: string, input: Value): void {
  calls.push({ action, input: decodeJsonValue({ value: input }) });
}

type TestAgentsToolDeps = Omit<AgentsToolDeps, 'mode'> & { mode?: AgentsToolDeps['mode'] };

function withBuildMode(deps: TestAgentsToolDeps): AgentsToolDeps {
  return { mode: 'build', ...deps };
}

function forkDeps(overrides: Partial<AgentsForkDeps> = {}): AgentsForkDeps {
  const registry = createStrategyRegistry();
  registry.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: 'forked' }));
  registry.register(createTestStrategy({ id: 'mcts', answer: 'searched' }));
  const { rt } = createTestRuntime();
  return { registry, rt, model: new MockLanguageModelV3(), ...overrides };
}

/** The minimum a merge fork takes — settle=merge refuses a call with no briefs. */
const twoForks = [
  { task: 'survey prior art', rationale: 'establish baseline' },
  { task: 'sketch a design', rationale: 'exercise constraints' },
];

const rosterEntry: SubordinateRosterEntry = {
  name: 'researcher', displayName: 'Researcher', role: 'competitive research',
  createdBy: 'orchestrator', status: 'idle', currentTask: null,
  createdAt: 1000, dismissedAt: null,
};

const handoff = (delivery: SubordinateDelivery, busy: boolean): SubordinateHandoff => ({
  eventId: `evt-${delivery}`,
  delivery,
  phase: { busy, lastActivityAt: 1234, workingOn: busy ? 'reading src/auth.ts' : null },
});

function makeTeam() {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      list: async () => [rosterEntry],
      create: async (input) => ({
        name: input.name ?? 'researcher',
        displayName: 'Researcher',
        subordinate: {
          name: input.name ?? 'researcher', displayName: 'Researcher', role: input.role,
          createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null,
        },
      }),
      spawn: async (input) => {
        recordCall(calls, 'spawn', input);
        return { name: input.name ?? 'researcher', displayName: 'Researcher' };
      },
      assign: async (input) => { recordCall(calls, 'assign', input); return { ok: true, name: input.name, ...handoff('queued', true) }; },
      status: async (input) => { recordCall(calls, 'status', input); return { roster: [rosterEntry] }; },
      message: async (input) => { recordCall(calls, 'message', input); return { ok: true, name: input.name, ...handoff('starts_now', false) }; },
      dismiss: async (input) => {
        recordCall(calls, 'dismiss', input);
        return { ok: true, name: input.name, historyKept: input.keepHistory ?? false };
      },
    } satisfies TeamToolDeps,
  };
}

function makePeers() {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      listPeers: async () => [{ name: 'scout', displayName: 'Scout' }],
      ask: async (input) => {
        recordCall(calls, 'ask', input);
        return { status: 'replied', from: input.agent, reply: 'answer' };
      },
      send: async (input) => { recordCall(calls, 'send', input); return { status: 'delivered', message_id: 'ox1' }; },
      reply: async (input) => { recordCall(calls, 'reply', input); return { ok: true }; },
      spawnWorkspace: async (input) => {
        recordCall(calls, 'spawn_workspace', input);
        return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
      },
    } satisfies PeersToolDeps,
  };
}

function fullDeps(): AgentsToolDeps {
  return withBuildMode({ fork: forkDeps(), team: makeTeam().deps, peers: makePeers().deps });
}

function actionEnumOf(deps: TestAgentsToolDeps): string[] {
  const schema = v.parse(
    AgentsInputSchemaContract,
    createAgentsTool(withBuildMode(deps)).inputSchema,
  );
  return schema.jsonSchema.properties.action.enum;
}

// ── Structural gating: one gate, two surfaces ───────────────────────────────

describe('agents.* codemode namespace — dep gating', () => {
  test('fork-only deps (CLI / subordinate) expose exactly agents.fork', () => {
    const deps = withBuildMode({ fork: forkDeps() });
    expect(Object.keys(namespaceOf(() => deps))).toEqual(['fork']);
  });

  test('full deps (the workspace orchestrator) expose every action', () => {
    const deps = fullDeps();
    expect(Object.keys(namespaceOf(() => deps))).toEqual([...AGENTS_TOOL_ACTIONS]);
  });

  test('team-without-peers drops reply, keeps the subordinate verbs', () => {
    const deps = withBuildMode({ team: makeTeam().deps });
    expect(Object.keys(namespaceOf(() => deps))).toEqual(['staff', 'ask', 'send', 'list', 'dismiss']);
  });

  test('the namespace members ARE the tool action enum — one gate, never two', () => {
    for (const deps of [withBuildMode({ fork: forkDeps() }), fullDeps(), withBuildMode({ team: makeTeam().deps })]) {
      expect(Object.keys(namespaceOf(() => deps))).toEqual(actionEnumOf(deps));
      expect(Object.keys(namespaceOf(() => deps))).toEqual(agentsActionsFor(deps));
    }
  });

  test('an ungated action is structurally absent, not a runtime refusal', () => {
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    expect(ns.staff).toBeUndefined();
    expect(ns.ask).toBeUndefined();
  });
});

// ── The projection reaches the same deps as the tool ────────────────────────

describe('agents.* codemode namespace — dispatch', () => {
  test('a Plan provider keeps its trusted mode after the host advances to Build', async () => {
    const team = makeTeam();
    let currentMode: 'plan' | 'build' = 'plan';
    const provider = createAgentsCodemodeProvider(() => ({ mode: currentMode, team: team.deps }));
    currentMode = 'build';

    await member(provider.tools, 'send').execute({ agent: 'researcher', message: 'inspect only' });

    expect(team.calls[0]).toMatchObject({
      action: 'message',
      input: { mode: 'plan', name: 'researcher', content: 'inspect only' },
    });
  });

  test('Plan mode keeps every fork settle strategy available', async () => {
    const provider = createAgentsCodemodeProvider(() => ({ mode: 'plan', fork: forkDeps() }));
    expect(await member(provider.tools, 'fork').execute({ task: 'research', settle: 'mcts' }))
      .toMatchObject({ strategy: 'mcts', text: 'searched' });
    expect(await member(provider.tools, 'fork').execute({ task: 'research', forks: twoForks }))
      .toMatchObject({ strategy: FORK_STRATEGY_ID, text: 'forked' });
  });

  test('fork routes through the strategy registry and returns the settled answer', async () => {
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    expect(await member(ns, 'fork').execute({ task: 'map the options', forks: twoForks })).toMatchObject({
      strategy: FORK_STRATEGY_ID, text: 'forked',
    });
    expect(await member(ns, 'fork').execute({ task: 'map the options', settle: 'mcts' })).toMatchObject({
      strategy: 'mcts', text: 'searched',
    });
  });

  test('the forks/settle contract is the tool\'s, not re-implemented here', async () => {
    // The projection funnels into the same dispatch, so the sandbox gets the
    // same classified refusal — briefs handed to mcts are refused, and a merge
    // fork with no briefs is refused, in a script exactly as in a tool call.
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    expect(await member(ns, 'fork').execute({ task: 't', settle: 'mcts', forks: twoForks }))
      .toMatchObject({ reason: 'bad_input' });
    expect(await member(ns, 'fork').execute({ task: 't' })).toMatchObject({ reason: 'bad_input' });
  });

  test('typed fork fields reach the strategy context exactly as the tool sends them', async () => {
    const registry = createStrategyRegistry();
    let observed: StrategyContext | undefined;
    registry.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx) {
        observed = ctx;
        return { strategy: FORK_STRATEGY_ID, best: { text: 'ok', score: 1, source: '' }, all: [], cost: { durationMs: 0 } };
      },
    });
    const { rt } = createTestRuntime();
    const controller = { __infra: true };
    const ns = namespaceOf(() => ({
      fork: { registry, rt, model: new MockLanguageModelV3(), defaultOptions: () => ({ heads: { controller } }) },
    }));
    await member(ns, 'fork').execute({ task: 'ship it', forks: twoForks, merge_strategy: 'consensus', budget: 9, wall_clock_ms: 4321 });
    expect(observed?.task).toBe('ship it');
    expect(observed?.budget).toEqual({ maxIterations: 9, wallClockMs: 4321 });
    // Host-injected infra survives the caller's fields, same deep merge as the tool.
    expect(strategyOption(observed?.options, 'heads')).toEqual({ controller, heads: twoForks, mergeStrategy: 'consensus' });
  });

  test('staff / ask / send / reply / list / dismiss reach the same transports', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const deps = withBuildMode({ fork: forkDeps(), team: team.deps, peers: peers.deps });
    const ns = namespaceOf(() => deps);

    expect(await member(ns, 'staff').execute({ role: 'researcher', mission: 'Map the landscape' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(await member(ns, 'ask').execute({ agent: 'researcher', message: 'Survey auth', deliverable: 'a note' }))
      .toMatchObject({ status: 'working', agent: 'researcher' });
    expect(await member(ns, 'send').execute({ agent: 'researcher', message: 'also check the CLI' }))
      .toMatchObject({ status: 'delivered', agent: 'researcher', delivery: 'starts_now', event_id: 'evt-starts_now' });
    expect(await member(ns, 'reply').execute({ event_id: 'pe1', message: 'here you go' })).toEqual({ ok: true });
    expect(await member(ns, 'list').execute()).toEqual({ subordinates: [rosterEntry], peers: [{ name: 'scout', displayName: 'Scout' }] });
    expect(await member(ns, 'dismiss').execute({ agent: 'researcher' }))
      .toEqual({ ok: true, name: 'researcher', historyKept: true });

    expect(team.calls.map((c) => c.action)).toEqual(['spawn', 'assign', 'message', 'dismiss']);
    expect(peers.calls.map((c) => c.action)).toEqual(['reply']);
  });

  test('a peer ask from the sandbox rides the peer transport with the clamped timeout', async () => {
    const peers = makePeers();
    const ns = namespaceOf(() => ({ peers: peers.deps }));
    expect(await member(ns, 'ask').execute({ agent: 'scout', message: 'What changed?', topic: 'research', timeout_seconds: 9999 }))
      .toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(peers.calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', timeoutMs: 600_000 });
  });

  test('deps are read per call, so a re-bound model/session lands without a rebuild', async () => {
    let generation = 0;
    const ns = namespaceOf(() => {
      generation += 1;
      const registry = createStrategyRegistry();
      registry.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: `generation ${generation}` }));
      const { rt } = createTestRuntime();
      return { fork: { registry, rt, model: new MockLanguageModelV3() } };
    });
    expect(await member(ns, 'fork').execute({ task: 'a', forks: twoForks })).toMatchObject({ text: 'generation 2' });
    expect(await member(ns, 'fork').execute({ task: 'b', forks: twoForks })).toMatchObject({ text: 'generation 3' });
  });

  test('deps failures come back as inspectable values, never thrown into the script', async () => {
    const registry = createStrategyRegistry();
    registry.register(createTestStrategy({ id: FORK_STRATEGY_ID, throwError: 'kaboom' }));
    const { rt } = createTestRuntime();
    const ns = namespaceOf(() => ({ fork: { registry, rt, model: new MockLanguageModelV3() } }));
    const result = v.parse(ErrorResultSchema, await member(ns, 'fork').execute({ task: 't', forks: twoForks }));
    expect(result.error).toMatch(/Fork \(settle=merge\) failed.*kaboom/);
  });
});

// ── The sandbox trust boundary ──────────────────────────────────────────────

describe('agents.* codemode namespace — sandbox input handling', () => {
  test('the member decides the action — a script cannot smuggle another one', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const ns = namespaceOf(() => ({ team: team.deps, peers: peers.deps }));
    // `dismiss` would archive the subordinate; the member called was `list`.
    expect(await member(ns, 'list').execute({ action: 'dismiss', agent: 'researcher' })).toEqual({ roster: [rosterEntry] });
    expect(team.calls.map((c) => c.action)).toEqual(['status']);
  });

  test('a zero-arg call on the node backend sees the exec context, not an input', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    // The node sandbox appends `{ signal }` to every call, so `agents.list()`
    // arrives as list({ signal }). It must still be the roster, not a lookup
    // of a subordinate named after the context.
    expect(await member(ns, 'list').execute({ signal: new AbortController().signal })).toEqual({ subordinates: [rosterEntry] });
    expect(team.calls).toEqual([]);
  });

  test('a malformed field is an inspectable error, never a throw into the script', async () => {
    const peers = makePeers();
    const ns = namespaceOf(() => ({ peers: peers.deps }));
    // Sandbox input carries none of the tool schema's validation, so a field of
    // the wrong type has to come back as a value the script can read.
    const result = v.parse(ErrorResultSchema, await member(ns, 'send').execute({ agent: 'scout', message: 'hi', topic: 42 }));
    expect(result.error).toMatch(/Expected string/);
    expect(peers.calls).toEqual([]);
  });

  test('the trailing exec context carries cancellation into the fork', async () => {
    const registry = createStrategyRegistry();
    let observed: AbortSignal | undefined;
    registry.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx) {
        observed = ctx.signal;
        return { strategy: FORK_STRATEGY_ID, best: { text: '', score: 1, source: '' }, all: [], cost: { durationMs: 0 } };
      },
    });
    const { rt } = createTestRuntime();
    const ns = namespaceOf(() => ({ fork: { registry, rt, model: new MockLanguageModelV3() } }));
    const controller = new AbortController();
    await member(ns, 'fork').execute({ task: 't', forks: twoForks }, { signal: controller.signal });
    expect(observed).toBe(controller.signal);
  });

  test('a non-object argument is a sharp error, not a deps call', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    expect(await member(ns, 'staff').execute('just a string')).toEqual({ error: 'agents.staff: expects a single options object' });
    expect(await member(ns, 'dismiss').execute(['researcher'])).toEqual({ error: 'agents.dismiss: expects a single options object' });
    expect(team.calls).toEqual([]);
  });

  test('missing required fields stay the tool\'s own sharp errors', async () => {
    const ns = namespaceOf(() => fullDeps());
    expect(await member(ns, 'ask').execute({ agent: 'researcher' })).toEqual({ error: 'ask requires agent and message' });
    // The refusal carries its classification, exactly as the declared type promises.
    expect(await member(ns, 'fork').execute({})).toEqual({ reason: 'bad_input', error: 'fork requires task' });
  });
});

// ── The declaration the model reads ─────────────────────────────────────────

describe('agents.* codemode namespace — declared types', () => {
  test('declares exactly the gated members', () => {
    const forkOnly = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    expect(forkOnly).toContain('fork(input: {');
    expect(forkOnly).not.toContain('staff(input: {');
    expect(forkOnly).not.toContain('dismiss(input: {');

    const full = createAgentsCodemodeProvider(fullDeps).types ?? '';
    for (const action of AGENTS_TOOL_ACTIONS) expect(full).toContain(`${action}(input`);
  });

  test('the fork docstring states the non-resumable cost of forking in-sandbox', () => {
    const types = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    expect(types).toContain('NOT resumable from here');
    expect(types).toContain('execute_tools declines background resume');
    expect(types).toContain('top-level `agents` tool');
  });

  test('the fork docstring says which settle gets a tool loop, and that briefs are refused by the other', () => {
    // It used to read "each runs its own multi-step tool loop, then they settle
    // into one answer: merged by default, or scored ... with settle:mcts",
    // which attaches the tool loop to both settles, and "Omit `forks` to let
    // the strategy pick the angles", which nothing implements. Measured truth:
    // a merge fork holds HEAD_BUILTIN_TOOLS (heads/head-tools.ts) filtered by
    // allowedTools; an mcts branch is one generateText call with no ToolSet.
    const types = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    expect(types).toContain('merge (default) runs the briefs in `forks` — required —');
    expect(types).toContain('execute_tools/run/file/web');
    expect(types).toContain('no tool loop of its');
    expect(types).toContain('REFUSED rather than ignored');
    expect(types).not.toContain('Omit `forks`');
    // The refusal's classification is declared, like the file dispatcher's.
    expect(types).toContain('reason?: "bad_input"');
  });

  test('the same action set renders byte-identically whatever built the deps', () => {
    // Two unrelated deps objects, same actions: the declaration the cf and node
    // sandboxes show the model must not differ by a byte, because it is one
    // literal per action rather than text derived from whatever is wired.
    const a = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types;
    const b = createAgentsCodemodeProvider(() => withBuildMode({
      fork: { registry: createStrategyRegistry(), rt: createTestRuntime().rt, model: new MockLanguageModelV3() },
    })).types;
    expect(a).toBe(b);
  });

  test('members are declared in the canonical ladder order', () => {
    const types = createAgentsCodemodeProvider(fullDeps).types ?? '';
    const order = [...types.matchAll(/^ {2}(\w+)\(input/gm)].map((m) => m[1]);
    expect(order).toEqual([...AGENTS_TOOL_ACTIONS]);
  });
});
