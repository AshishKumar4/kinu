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
//     that is the honest cost of searching from inside execute_tools.
//
// Real sandbox execution (node `new Function`, cf `createCodeTool`) is covered
// in the two backend suites; here the surface itself is the subject.
import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu/test-utils';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  AGENTS_TOOL_ACTIONS,
  agentsActionsFor,
  createAgentsCodemodeProvider,
  createAgentsTool,
  decodeJsonValue,
  type CodemodeProvider,
  type JsonValue,
  SWARM_PRESET_DOCTRINE,
  type AgentsForkDeps,
  type AgentsToolDeps,
  type PeersToolDeps,
  type SubordinateRosterEntry,
  type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
} from '../src/index';
import { NAMED_SWARM_PRESETS, SWARM_PRESETS } from '../src/strategy/swarm';
import { ROOT_DELEGATION_BUDGET } from '../src/subordinates/depth';

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
  const { rt } = createTestRuntime();
  return { rt, model: new MockLanguageModelV3(), ...overrides };
}

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
      delegation: ROOT_DELEGATION_BUDGET,
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
  test('the exploration substrate (CLI / subordinate) exposes the search member alone', () => {
    const deps = withBuildMode({ fork: forkDeps() });
    // `swarm` rides that substrate — a model to expand with and a workspace to
    // measure in — so a sandbox with it can run a configured search, and the
    // namespace says so structurally.
    expect(Object.keys(namespaceOf(() => deps))).toEqual(['swarm']);
  });

  test('full deps (the workspace orchestrator) expose every action', () => {
    const deps = fullDeps();
    expect(Object.keys(namespaceOf(() => deps))).toEqual([...AGENTS_TOOL_ACTIONS]);
  });

  test('team-without-peers drops reply, keeps the subordinate verbs', () => {
    const deps = withBuildMode({ team: makeTeam().deps });
    expect(Object.keys(namespaceOf(() => deps))).toEqual(['hire', 'ask', 'send', 'list', 'dismiss']);
  });

  test('the namespace members ARE the tool action enum — one gate, never two', () => {
    for (const deps of [withBuildMode({ fork: forkDeps() }), fullDeps(), withBuildMode({ team: makeTeam().deps })]) {
      expect(Object.keys(namespaceOf(() => deps))).toEqual(actionEnumOf(deps));
      expect(Object.keys(namespaceOf(() => deps))).toEqual(agentsActionsFor(deps));
    }
  });

  test('an ungated action is structurally absent, not a runtime refusal', () => {
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    expect(ns.hire).toBeUndefined();
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

  test('Plan mode does not narrow the search surface', async () => {
    // What the old settle-availability test was really guarding. Plan mode
    // constrains what a helper may DO, never which rungs exist: a planning turn
    // searches to investigate exactly as a build turn does, over the same members.
    const provider = createAgentsCodemodeProvider(() => ({ mode: 'plan', fork: forkDeps() }));
    expect(await member(provider.tools, 'swarm').execute({ task: 'research' }))
      .toMatchObject({ reason: 'bad_input' });
    expect(Object.keys(provider.tools))
      .toEqual(Object.keys(createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).tools));
  });

  test('the search contract is the tool\'s, not re-implemented here', async () => {
    // The projection funnels into the same dispatch, so the sandbox gets the
    // same classified refusals a tool call does: a search with no preset is
    // refused, and `settle` — which left the surface with the judged tree — is
    // refused as the unknown field it now is, naming what swarm does take.
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    expect(await member(ns, 'swarm').execute({ task: 't' })).toMatchObject({ reason: 'bad_input' });
    const stale = v.parse(ErrorResultSchema, await member(ns, 'swarm').execute({
      task: 't', settle: 'mcts', preset: 'ideate',
    }));
    expect(stale.error).toContain('unknown field "settle"');
    expect(stale.error).toContain(
      'action "swarm" takes: task, preset, objective, key, config, from, label, branches, depth, '
      + 'budget_usd, budget_tokens, budget_label',
    );
  });

  test('typed search fields reach the dispatch exactly as the tool sends them', async () => {
    // The projection hands the SAME parsed input to the SAME dispatcher, so a
    // legal call is answered by the engine and an illegal composition by the
    // axis refusal — never by a second parse living in the sandbox bridge.
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    const refused = v.parse(v.object({ reason: v.string(), error: v.string() }), await member(ns, 'swarm').execute({
      task: 'ship it',
      preset: 'ideate',
      objective: {
        kind: 'scalar', metric: 'ms', unit: 'ms', direction: 'minimise', scale: 'linear',
        target: 1, verify: { kind: 'exec-ratio', spec: {} },
      },
    }));
    expect(refused.reason).toBe('bad_input');
    // The nested objective arrived whole — the refusal is the AXIS one about a
    // flat preset carrying a value signal, not a parse complaint about a field
    // the bridge mangled on the way through.
    expect(refused.error).toMatch(/`ideate` is flat and has no value signal/);
  });

  test('hire / ask / send / reply / list / dismiss reach the same transports', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const deps = withBuildMode({ fork: forkDeps(), team: team.deps, peers: peers.deps });
    const ns = namespaceOf(() => deps);

    expect(await member(ns, 'hire').execute({ role: 'researcher', mission: 'Map the landscape' }))
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
      const { rt } = createTestRuntime();
      return { fork: { rt, model: new MockLanguageModelV3() } };
    });
    // Each call rebuilds the deps, which is what the generation counter proves:
    // two calls, two reads, and the second sees the later binding.
    await member(ns, 'swarm').execute({ task: 'a' });
    await member(ns, 'swarm').execute({ task: 'b' });
    expect(generation).toBe(3);
  });

  test('deps failures come back as inspectable values, never thrown into the script', async () => {
    const team = makeTeam();
    team.deps.spawn = async () => { throw new Error('kaboom'); };
    const ns = namespaceOf(() => ({ team: team.deps }));
    const result = v.parse(ErrorResultSchema, await member(ns, 'hire').execute({
      role: 'researcher', mission: 'map the landscape',
    }));
    expect(result.error).toMatch(/kaboom/);
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

  test('a misspelled field in a hand-built object is an error naming the field meant', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const ns = namespaceOf(() => ({ team: team.deps, peers: peers.deps }));
    // The sandbox builds this object by hand with no schema behind it, so this
    // is the surface where a name mistake was most invisible: the field was
    // dropped and the call ran as if it had never been written.
    const result = v.parse(ErrorResultSchema, await member(ns, 'ask').execute({
      agent: 'researcher', message: 'go', timeoutSeconds: 30,
    }));
    expect(result.error).toContain('agents.ask: unknown field "timeoutSeconds" — did you mean "timeout_seconds"?');
    expect(team.calls).toEqual([]);
  });

  test('the exec context is not read as a field, even beside the script\'s own options', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    // Both shapes the node sandbox produces: the context alone (above), and the
    // context appended AFTER the script's object. Neither may reach the parse —
    // `signal` is the host's, and refusing it as unknown would refuse the call
    // the script actually made.
    expect(await member(ns, 'list').execute(
      { agent: 'researcher' },
      { signal: new AbortController().signal },
    )).toEqual({ roster: [rosterEntry] });
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

  test('the trailing exec context carries cancellation into the search', async () => {
    // The node sandbox appends `{ signal }` as a trailing argument. It is the
    // HOST's object, found by the signal it carries and taken OUT of the input —
    // so a search called with it is answered by the dispatcher's own refusal and
    // never by "unknown field \"signal\"", which is what would happen the moment
    // the bridge stopped recognising it. From there `runSwarmAction`'s
    // readAbortSignal is what hands it to the run.
    const ns = namespaceOf(() => ({ fork: forkDeps() }));
    const controller = new AbortController();
    const result = v.parse(ErrorResultSchema, await member(ns, 'swarm').execute(
      { task: 't' }, { signal: controller.signal },
    ));
    expect(result.error).toContain('swarm needs `preset`');
    expect(result.error).not.toContain('unknown field "signal"');
  });

  test('a non-object argument is a sharp error, not a deps call', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    expect(await member(ns, 'hire').execute('just a string')).toEqual({ error: 'agents.hire: expects a single options object' });
    expect(await member(ns, 'dismiss').execute(['researcher'])).toEqual({ error: 'agents.dismiss: expects a single options object' });
    expect(team.calls).toEqual([]);
  });

  test('missing required fields stay the tool\'s own sharp errors', async () => {
    const ns = namespaceOf(() => fullDeps());
    expect(await member(ns, 'ask').execute({ agent: 'researcher' })).toEqual({ error: 'ask requires agent and message' });
    // The refusal carries its classification, exactly as the declared type promises.
    expect(await member(ns, 'swarm').execute({})).toEqual({ reason: 'bad_input', error: expect.stringContaining('swarm needs `preset`') });
  });
});

// ── The declaration the model reads ─────────────────────────────────────────

describe('agents.* codemode namespace — declared types', () => {
  test('declares exactly the gated members', () => {
    const searchOnly = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    expect(searchOnly).toContain('swarm(input: {');
    expect(searchOnly).not.toContain('hire(input: {');
    expect(searchOnly).not.toContain('dismiss(input: {');

    const full = createAgentsCodemodeProvider(fullDeps).types ?? '';
    for (const action of AGENTS_TOOL_ACTIONS) expect(full).toContain(`${action}(input`);
  });

  test('the search docstring states the non-resumable cost of searching in-sandbox', () => {
    const types = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    expect(types).toContain('NOT resumable from here');
    expect(types).toContain('execute_tools declines background resume');
    expect(types).toContain('top-level `agents` tool');
  });

  test('the search docstring says what is measured and what a refusal names', () => {
    // The declaration a script reads has to carry the two facts a caller gets
    // wrong: that `verify` names a REGISTERED instrument rather than a path it
    // invents, and that an illegal composition is refused by NAME rather than
    // silently run under a different shape.
    const types = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    expect(types).toContain('MEASURED rather than judged');
    expect(types).toContain('names a REGISTERED instrument');
    expect(types).toContain('names the axis');
    expect(types).toMatch(/^ {4}preset: "ideate" \| "research"/m);
    expect(types).not.toContain('settle');
    // The refusal's classification is declared, like the file dispatcher's.
    expect(types).toContain('{ reason: string; error: string }');
  });

  test('the declared preset union is every preset the tool advertises, with the same doctrine', () => {
    // Both unions were hardcoded literals and both had gone stale in the same
    // direction: `prove` was absent, so a sandbox script naming the one preset
    // with an exact checker was a TYPE ERROR — the declaration made a live
    // capability unreachable rather than merely undescribed. Derived now, so the
    // sandbox contract cannot come to offer a different set than the schema.
    const types = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types ?? '';
    for (const preset of SWARM_PRESETS) expect(types).toContain(`"${preset}"`);
    expect(types).toContain(`preset: ${SWARM_PRESETS.map((preset) => `"${preset}"`).join(' | ')};`);
    expect(types).toContain(`from?: ${NAMED_SWARM_PRESETS.map((preset) => `"${preset}"`).join(' | ')};`);
    for (const line of SWARM_PRESET_DOCTRINE) expect(types).toContain(line);
  });

  test('the same action set renders byte-identically whatever built the deps', () => {
    // Two unrelated deps objects, same actions: the declaration the cf and node
    // sandboxes show the model must not differ by a byte, because it is one
    // literal per action rather than text derived from whatever is wired.
    const a = createAgentsCodemodeProvider(() => withBuildMode({ fork: forkDeps() })).types;
    const b = createAgentsCodemodeProvider(() => withBuildMode({
      fork: { rt: createTestRuntime().rt, model: new MockLanguageModelV3() },
    })).types;
    expect(a).toBe(b);
  });

  test('members are declared in the canonical ladder order', () => {
    const types = createAgentsCodemodeProvider(fullDeps).types ?? '';
    const order = [...types.matchAll(/^ {2}(\w+)\(input/gm)].map((m) => m[1]);
    expect(order).toEqual([...AGENTS_TOOL_ACTIONS]);
  });
});
