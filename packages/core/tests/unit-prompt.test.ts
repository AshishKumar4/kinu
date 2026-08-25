// Behavior tests for buildSystemPromptSync — the canonical system prompt.
// Catches drift: stale tool references, missing capability sections, execution
// guidance, and that registered-executors render correctly.
import { describe, test, expect } from 'bun:test';
import {
  assertToolsSupportedByModel,
  buildSystemPromptSync,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOL_SPECS,
  compilePromptSurface,
  currentDateForPrompt,
  DELEGATION_INHERITANCE,
  DELEGATION_RUNGS,
  modelSupportsTools,
  BUILTIN_ROLE_DEFINITIONS,
  deriveRoleLabel,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  splitPromptSections,
  AGENTS_TOOL_ACTIONS,
  BUILTIN_SKILLS,
  SWARM_PRESET_DOCTRINE,
  type ParsedSkill,
} from '../src/index';
import { AGENTS_ACTION_FIELDS } from '../src/tools/agents-tool';
import { DELEGATION_SECTION } from '../src/prompting/section-templates';
import {
  NAMED_SWARM_PRESETS, SWARM_PRESETS, SWARM_PRESET_POINTS, resolveSwarm,
  type SwarmInput,
} from '../src/strategy/swarm';
import { createTestRuntime } from '@kinu.run/test-utils';
import { createAgentSelfProvider, type AgentSelfHost } from '../src/tools/agent-self';

/**
 * The ONE declaration of the `agent.*` contract — the codemode type block that
 * reaches the model inside the execute_tools description.
 *
 * The prompt's Code-execution section points at this namespace instead of
 * restating its signatures, so the tests that used to assert a signature in the
 * prompt assert it HERE, against the declaration that actually ships. The host
 * is never called: only `types` is read, so a proxy that answers every method is
 * enough and cannot rot as `AgentSelfHost` grows.
 */
function agentSelfTypes(): string {
  const host: AgentSelfHost = new Proxy(Object.create(null), {
    get: () => async () => null,
  });
  return createAgentSelfProvider(host).types ?? '';
}

describe('buildSystemPromptSync', () => {
  test('uses fallback SOUL.md when SOUL.md is missing', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Kinu/);                 // identity self-id
    expect(prompt).toMatch(/self-evolving/i);          // general-purpose, not code-centric
  });

  test('renders ONE delegation ladder keyed on lifetime — one tool, exactly two rungs', () => {
    // The duplicate-sounding-tools gap: think/team/peers were three delegation
    // surfaces, so the model saw `team` and never considered delegating the
    // exploration. ONE tool (`agents`) now asks one question — how long does the
    // helper need to live — indexed here and specified in the tool schema.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/## Delegation/);
    expect(prompt).toMatch(/one tool — `agents`/);
    expect(prompt).toMatch(/how long does the helper need to live/);
    // The DEFAULT, where the zeroth rung used to be a bullet. A first bullet
    // reading "- Do it yourself" made rung 0 the visually first choice and the
    // section a classification; the exemptions now come last, and as things to
    // DO, so an unrecognised shape falls toward the ladder instead of away.
    expect(prompt).toMatch(/Delegate once the shape of the work is settled/);
    expect(prompt).toMatch(/naming the parts is yours, running them is theirs/);
    expect(prompt).toMatch(/Work alone on a single coherent change in one file/);
    expect(prompt).toMatch(/two or more independent parts goes to the ladder/);
    expect(prompt).not.toContain('- Do it yourself');
    // …and the default is read BEFORE any rung, which is the whole point.
    expect(prompt.indexOf('Delegate once the shape'))
      .toBeLessThan(prompt.indexOf('- Ephemeral search'));
    expect(prompt).toMatch(/- Ephemeral search \(action=swarm\) — /);
    expect(prompt).toMatch(/- Persistent subordinate \(action=hire\) — /);
    // The old split surface is gone entirely.
    expect(prompt).not.toContain('`think`');
    expect(prompt).not.toContain('`team`');
    expect(prompt).not.toContain('`peers`');
    // The nodes' durable artifact trail survives. (The search-then-fetch loop
    // that used to ride this line is `web`'s own whenToUse, restated here in a
    // section about delegation and ungated on `web` actually being present.)
    expect(prompt).not.toMatch(/loop `web` search then fetch/);
    expect(prompt).toMatch(/search depth 3/);
    expect(prompt).toContain('shared/findings/');
    expect(prompt).toMatch(/NOT stateless between turns/);
  });

  test('tree search is action=swarm, and it is a rung rather than a settlement', () => {
    // Preservation contract, inverted twice by two cutovers: the tree search that
    // was once a settle policy is its own ACTION, and the ephemeral rung it used
    // to live inside is gone. What must not come back is a second spelling — so
    // the docstring names no settle at all, and the prompt's index carries the
    // rung once.
    const agents = BUILTIN_TOOL_DESCRIPTIONS.agents;
    expect(agents).not.toContain('settle=');
    expect(agents).toMatch(/Run a search \(action=swarm\)/);
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt.match(/^- Ephemeral search \(action=swarm\) — /gm)).toHaveLength(1);
  });

  test('each rung renders only for the agents actions the backend wires', () => {
    const { rt } = createTestRuntime();
    const both = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      registeredExecutors: [],
    });
    expect(both).toContain('## Delegation');
    expect(both).toMatch(/- Ephemeral search \(action=swarm\) — /);
    expect(both).toMatch(/- Persistent subordinate \(action=hire\) — /);
    expect(both).toMatch(/hire the needed roles.*ask each an independent workstream.*integrate/i);

    // A CLI session gets the search rung but never hire: one rung, no
    // staffing loop, no peer converse.
    const searchOnly = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['swarm'],
      registeredExecutors: [],
    });
    expect(searchOnly).toContain('## Delegation');
    expect(searchOnly).toMatch(/- Ephemeral search \(action=swarm\) — /);
    expect(searchOnly).not.toMatch(/- Persistent subordinate/);
    expect(searchOnly).not.toContain('hire the needed roles');
    expect(searchOnly).not.toContain('OTHER workspace agents');
  });

  test('the in-sandbox rungs are advertised only where both halves exist', () => {
    // `agents.*` is built from the same deps that produce agentsActions, so
    // the line renders exactly when an actor can both delegate and run code.
    const { rt } = createTestRuntime();
    const both = buildSystemPromptSync(rt, {
      availableTools: ['agents', 'execute_tools'],
      agentsActions: ['swarm'],
      registeredExecutors: [],
    });
    expect(both).toContain('callable inside execute_tools as `agents.<action>`');
    // The honest cost of searching from inside the sandbox, stated once.
    expect(both).toContain('does not resume after an eviction');

    // No sandbox → no namespace to advertise.
    const noSandbox = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['swarm'],
      registeredExecutors: [],
    });
    expect(noSandbox).not.toContain('agents.<action>');

    // No delegation deps → the section is not rendered at all.
    const noDelegation = buildSystemPromptSync(rt, {
      availableTools: ['execute_tools'],
      registeredExecutors: [],
    });
    expect(noDelegation).not.toContain('agents.<action>');
  });

  test('the agents schema description leads with positive delegation triggers', () => {
    // The ladder lost a rung when `fork` went: the two that remain differ on
    // lifetime and on who decides the answer, and the frame names both axes
    // before it names either rung, so the sentence is a trigger rather than a
    // menu.
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(
      /Use when: One delegation ladder, two rungs, and they differ on lifetime and on who decides/,
    );
    // The frame states BOTH scorers now. It used to promise that a search's candidates
    // "are MEASURED against a number you declare", which described the shape a preset
    // reaches WITH an `objective` and not the call a model actually makes: a bare
    // `{preset, task}` takes the row's judged sweep. One sentence covering only the
    // upgraded half is how a model came to believe its first call would run.
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(
      /candidates are SCORED against each other and ranked — by your own verifier running in this workspace when you declare an `objective`, and by a judge ensemble when you do not/,
    );
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents.indexOf('one subordinate per independent workstream'))
      .toBeLessThan(BUILTIN_TOOL_DESCRIPTIONS.agents.indexOf('full turn'));
  });

  test('the rungs are specified once, in the schema — the prompt only indexes them', () => {
    // The rung triggers used to render verbatim in BOTH surfaces, on the
    // rationale that a bare tool-name index (kimi) would otherwise leave the
    // model with no ladder. That rationale was void — schema descriptions are
    // family-neutral, so every family already received them — and it cost 418
    // tokens of byte-identical text in every request. The schema is the one
    // place they are stated; the prompt names the rungs and nothing more.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_RUNGS.swarm);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_RUNGS.hire);
    expect(prompt).not.toContain(DELEGATION_RUNGS.swarm);
    expect(prompt).not.toContain(DELEGATION_RUNGS.hire);
  });

  test('the two delegation bodies share no sentence, so neither can drift into the other', () => {
    // `registry.ts` used to claim this spec was the SINGLE SOURCE of delegation
    // doctrine, "which the system prompt's Delegation section also renders
    // verbatim". It never did, and the test above pins that it must not. What
    // nothing checked was the reverse direction: two bodies about one subject,
    // one of them a GEPA target, converging sentence by sentence until a reader
    // has to diff them to find which is in force.
    //
    // The check is a whole sentence, not a phrase: both bodies legitimately say
    // `action=swarm` and `agents`, and a shared noun is the vocabulary agreeing
    // rather than the prose being copied.
    //
    // Template markers come out FIRST. Without that the check could not fire in
    // the place a copy actually lands: a `{{#if}}` sits between the section's
    // lines, it ends in `}}` rather than a full stop, so the sentence after it
    // was glued to the sentence before and matched nothing. Proven by pasting
    // one of the spec's own sentences into the section — invisible before the
    // strip, caught after it.
    const sentences = (text: string): string[] =>
      text.replace(/\{\{[^}]*\}\}/g, ' ')
        .split(/(?<=[.!?])[\s\n]+/).map((s) => s.trim()).filter((s) => s.length > 25);
    const section = new Set(sentences(DELEGATION_SECTION.source));
    const shared = sentences(BUILTIN_TOOL_SPECS.agents.whenToUse).filter((s) => section.has(s));
    expect(shared).toEqual([]);
    // The rungs each contribute at least one whole sentence, so the comparison
    // is over real prose on both sides rather than two empty lists agreeing.
    expect(sentences(BUILTIN_TOOL_SPECS.agents.whenToUse).length).toBeGreaterThan(10);
    expect(section.size).toBeGreaterThan(5);
  });

  test('completion never evicts: the hire rung teaches that finished subordinates STAY', () => {
    // The eviction bug: the old doctrine said "retire it when done", so the
    // orchestrator dismissed subordinates the moment they reported completed —
    // wiping their context. Persistence is now the doctrine in both surfaces.
    expect(DELEGATION_RUNGS.hire).toMatch(/reports and STAYS/);
    expect(DELEGATION_RUNGS.hire).toMatch(/dismiss only a subordinate whose role is permanently over/);
    expect(DELEGATION_RUNGS.hire).not.toMatch(/retire it when done/);
    expect(DELEGATION_RUNGS.hire).not.toMatch(/cheap to create and dismiss/);
    // The prompt no longer says it a second time: the roster/re-engage/dismiss
    // sentence that stood in the Delegation section was this rung paraphrased,
    // and the rungs live in the schema every family reads.
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('A finished subordinate');
  });

  test('the search rung says who decides, stated as a mechanism and not a preference', () => {
    // What replaced the settle doctrine, and then the fork/swarm boundary after
    // it: with one ephemeral rung left, the thing a caller has to get right is
    // WHO SCORES its candidates, and the line states the fact that decides it
    // rather than a preference.
    //
    // IT NAMES BOTH SCORERS NOW. The rung used to promise a verifier
    // unconditionally, which was true of the shape and false of the call: five of
    // the six presets refused without an `objective`, so the surface the sentence
    // described was one a bare call could not reach. A named preset falls back to a
    // judged sweep, so the sentence has to say which scorer runs when.
    //
    // 2026-08-25: the WHICH-SCORER-WHEN clause is asserted ONCE, on the whole
    // rendered description, because that is where it has to be true. It used to
    // be pinned twice because it was WRITTEN twice — DELEGATION_FRAME and
    // DELEGATION_RUNGS.swarm both carried "by your own verifier running in this
    // workspace when you declare an `objective` … and by a judge ensemble when
    // you do not" verbatim. The frame always prefixes the rung
    // (renderAgentsToolDescription composes it unconditionally), so the rung's
    // copy was redundant, and the assertion below is STRONGER than the pair it
    // replaces: it proves the clause reaches the model AND that exactly one
    // source states it, which the old pins could not distinguish from drift.
    const agents = BUILTIN_TOOL_DESCRIPTIONS.agents;
    const scorers = /by your own verifier running in this workspace when you declare an `objective`/g;
    expect(agents).toMatch(scorers);
    expect(agents.match(scorers)).toHaveLength(1);
    expect(agents).toMatch(/and by a judge ensemble when you do not/);
    expect(agents.match(/and by a judge ensemble when you do not/g)).toHaveLength(1);
    // The rung still says who NAMES the shape, and that scoring is a mechanism
    // rather than an opinion — the half the frame does not carry.
    expect(agents).toMatch(/You name the shape with `preset`, and a verifier is CODE that runs here rather than a model's opinion of the answer/);
    expect(agents).toMatch(/a metric nothing can execute is not an objective/);
    // Payoff before limitation, the ordering this test was written for: what a
    // search buys the caller comes before what it refuses to do for them.
    expect(agents.indexOf('hands you back only what it found'))
      .toBeLessThan(agents.indexOf('It refuses rather than approximates'));
    // And the deterrent framing the doctrine shed stays shed.
    expect(agents).not.toMatch(/genuinely unclear/);
  });

  test('the search rung triggers on DOUBT, not only on decomposability', () => {
    // The benchmark finding: the ephemeral rung's trigger was purely a
    // decomposability test ("work splits into 2+ independent angles"), which a
    // model applies only to work it already understands. It said nothing about
    // the case a weak model most needs a helper for — first attempt failed, two
    // approaches plausible, can't check its own output — so 0/10 tasks ever
    // reached for a lift lever. Both triggers are now named, in the registry
    // single source, so the schema and the prompt carry them together.
    // Opens on the payoff in the caller's own currency — nothing in the
    // delegation surface bought the model anything before, and the section's
    // one use of "cheapest" argued for NOT reaching for the ladder.
    expect(DELEGATION_RUNGS.swarm).toMatch(/^Run a search \(action=swarm\) to spend someone else's context instead of your own/);
    expect(DELEGATION_RUNGS.swarm).toMatch(/hands you back only what it found/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain('spend someone else\'s context instead of your own');
    expect(buildSystemPromptSync(createTestRuntime().rt)).not.toContain('spend someone else\'s context');
    expect(DELEGATION_RUNGS.swarm).toMatch(/Two triggers\./);
    expect(DELEGATION_RUNGS.swarm).toMatch(/Breadth: work splits into 2\+ independent angles/);
    expect(DELEGATION_RUNGS.swarm).toMatch(/Doubt: your first attempt failed/);
    expect(DELEGATION_RUNGS.swarm).toMatch(/you cannot check your own output/);
    expect(DELEGATION_RUNGS.swarm).toMatch(/being unsure is itself a reason to search/);
    // Both triggers reach the model through the schema, which every family
    // reads for selection. The prompt's second copy is gone, and the doubt
    // trigger is additionally mechanised — turn-steering's repeated_failure
    // states it at the step where the decision is still open.
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain('Doubt: your first attempt failed');
  });

  test('the prompt teaches the SHAPE of work that calls for a search, not just what one is', () => {
    // The rung was a definition: "copies of you that run their own tool loops
    // in parallel". A definition answers "what is this" and never "is my work
    // this". The schema owns the selection triggers and keeps them; what the
    // prompt adds is the shape test, because whether the work HAS parts is
    // decided before any tool is picked. turn-steering states the same thing
    // mechanically, but only at 25 steps — after the shape was chosen wrong.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/when the work already has 2\+ independent angles/);
    expect(prompt).toMatch(/uncertain enough to be worth two attempts at once/);
    // A compressed pointer, never the schema's paragraph a second time.
    expect(prompt).not.toContain(DELEGATION_RUNGS.swarm);
  });

  test('the prompt says who writes the candidates and what scores them', () => {
    // The choice used to be between two settles, then between two actions. With
    // one ephemeral rung left, the fact a caller must hold is the division of
    // labour: they supply what counts, the search supplies the angles.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/A search writes its own competing candidates from `task`/);
    expect(prompt).toMatch(/you supply what counts, not the angles/);
    expect(prompt).toMatch(/scores each one with the verifier you named in `objective`/);
  });

  test('every surface that enumerates presets names all six, and every one of them resolves', () => {
    // This test used to check the opposite half of the same property. Three of six
    // named presets did not resolve — `SWARM_PRESET_POINTS` recorded the gap rather
    // than inventing a threshold — and the doctrine had to SAY so, because a model can
    // select one from the advertised enum. It now checks that no such sentence
    // survives: the rows are declared, the presets run, and doctrine describing an
    // absence that no longer exists is exactly the drift one shared constant prevents.
    const doctrine = SWARM_PRESET_DOCTRINE.join(' ');
    for (const preset of SWARM_PRESETS) expect(doctrine).toContain(preset);
    expect(doctrine).not.toContain('UNCONSTRUCTIBLE');

    // Derived from the TABLE rather than from a second list, so a row that stops being
    // declared fails here instead of being described as working.
    for (const preset of NAMED_SWARM_PRESETS) {
      expect(SWARM_PRESET_POINTS[preset].config).toBeDefined();
    }
    // And the claim is true of the engine, not just of the prose.
    for (const preset of NAMED_SWARM_PRESETS) {
      // An archive preset needs its coverage key to be legal, and the key is added as a
      // statement rather than spread conditionally: an absent key must be an ABSENT KEY,
      // which is the same rule the resolver reads to tell "the caller stated none" from
      // "the caller stated undefined".
      const archive = SWARM_PRESET_POINTS[preset].config.advance.kind === 'archive';
      const call: SwarmInput = archive
        ? { preset, task: 'x', key: 'k' }
        : { preset, task: 'x' };
      expect(resolveSwarm(call)).not.toHaveProperty('reason');
    }
  });

  test('the preset list is rendered where `preset` is filled, and not a second time in the rung', () => {
    // Which presets exist is FIELD doctrine — read at the moment the field is
    // typed — so it rides the `preset` property and the missing-`preset` refusal.
    // The rung carried its own copy, which is what drifted; it now carries only
    // what decides whether to search at all, and the prompt's Delegation index
    // never enumerated presets in the first place.
    const doctrine = SWARM_PRESET_DOCTRINE.join(' ');
    expect(DELEGATION_RUNGS.swarm).not.toContain('preset=optimise');
    expect(DELEGATION_RUNGS.swarm).not.toContain('research/audit/redteam');
    expect(DELEGATION_RUNGS.swarm).not.toContain(doctrine);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toContain('research/audit/redteam');
    // Still says who names the shape — the pointer stays, only the list moved.
    expect(DELEGATION_RUNGS.swarm).toContain('You name the shape with `preset`');
    expect(buildSystemPromptSync(createTestRuntime().rt)).not.toContain(doctrine);
  });

  test('no built-in skill body calls an action or a field the tool surface does not have', () => {
    // A skill body is prompt text verbatim on the turn it activates. This one
    // still told the model to call `agents({action:"fork", forks:[...], budget})`
    // — one dead action and two dead fields — which is the failure mode a naming
    // drift produces silently, because nothing typechecks a template string.
    const liveActions: readonly string[] = AGENTS_TOOL_ACTIONS;
    const swarmFields: readonly string[] = AGENTS_ACTION_FIELDS.swarm;
    for (const skill of BUILTIN_SKILLS) {
      for (const [, action] of skill.body.matchAll(/action:\s*["'](\w+)["']/g)) {
        expect(liveActions).toContain(action);
      }
      for (const [, field] of skill.body.matchAll(/agents\(\{([^}]*)\}/g)) {
        for (const [, key] of field.matchAll(/(\w+):/g)) {
          if (key === 'action') continue;
          expect(swarmFields).toContain(key);
        }
      }
    }
  });

  test('what a node can lean on is stated where the task is written, and nowhere twice', () => {
    // Nodes run concurrently with no channel between them, so a task where one
    // node consumes another's finding silently gets nothing. `whenNotToUse`
    // already forbids nodes that RACE on a mutable resource; this is the other
    // half — what a node arrives holding, which is the `context` axis and not
    // something the task text may assume.
    //
    // It rides `task` itself, as half of DELEGATION_INHERITANCE.swarm.brief:
    // read at the moment the field is being typed instead of thousands of tokens
    // earlier, beside the inheritance fact it is the complement of.
    expect(DELEGATION_INHERITANCE.swarm.brief).toMatch(/the search's `context`/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_INHERITANCE.swarm.rung);
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain(DELEGATION_INHERITANCE.swarm.brief);
    // What the prompt keeps is the half no schema carries: the artifact trail.
    expect(prompt).toMatch(/leave durable findings under `shared\/findings\/`/);
  });

  test('per-node model routing is discoverable, and named as a case rather than a default', () => {
    // A search takes `models` for per-node routing and nothing told the model
    // what varying it was FOR. The prompt names the capability at shape time;
    // the Self-MoA caveat (arXiv 2502.00674 — panel quality tracks the AVERAGE
    // member, so diversity for its own sake costs) rides the parameter
    // description in agents-tool.ts, read while the field is being filled.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/`models` puts a different vendor on a genuinely open question/);
    expect(prompt).toMatch(/a weaker model added for variety measurably subtracts/);
    // Never phrased as something to do by default.
    expect(prompt).not.toMatch(/vary the models|diversify|always use different models/i);
  });

  test('the agents example is the cheapest COMPLETE call', () => {
    // An example earns its tokens by being copyable. `preset` + `task` is the
    // whole minimum, and `ideate` is the one preset that legally takes no
    // `objective` — so the example is a call that would run, not a fragment.
    // The shape a model gets wrong here is the objective's nesting, and that
    // rides `objective`'s own property description instead.
    const { rt } = createTestRuntime();
    const example = BUILTIN_TOOL_SPECS.agents.example;
    expect(example).toContain("action:'swarm'");
    expect(example).toContain("preset:'ideate'");
    expect(example).toContain('task:');
    expect(buildSystemPromptSync(rt)).toContain(example);
  });

  test('tool when-to-use doctrine is schema-only: descriptions carry it, prompt prose does not', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      // Schema description = summary + Use when / Avoid when / Returns.
      const description = BUILTIN_TOOL_DESCRIPTIONS[name];
      expect(description.startsWith(spec.summary)).toBe(true);
      expect(description).toContain(`Use when: ${spec.whenToUse}`);
      expect(description).toContain(`Avoid when: ${spec.whenNotToUse}`);
      expect(description).toContain(`Returns: ${spec.result}`);
      // Prompt prose carries ONLY the summary — no duplicated doctrine, for
      // any tool. `agents` used to be exempt: the prompt rendered its rungs
      // verbatim too, on a rationale (the kimi bare index) that was both void
      // and since deleted.
      expect(prompt).not.toContain(spec.whenToUse);
      expect(prompt).not.toContain(spec.whenNotToUse);
      if ('doctrine' in spec && spec.doctrine) expect(prompt).not.toContain(spec.doctrine);
    }
    // The `Use when:` / `Avoid when:` schema prefixes never leak into prose.
    expect(prompt).not.toContain('Use when:');
    expect(prompt).not.toContain('Avoid when:');
  });

  test('the tool index is one rendering for every model family', () => {
    // The kimi branch stripped the index to bare names on a Moonshot claim
    // ("prompt prose about tool usage interferes with autonomous selection")
    // that is retired, K2.5-scoped, and unverifiable at any live source — and
    // that could not have worked anyway, since tool schemas are family-neutral
    // and kimi received every byte of the doctrine the strip was protecting it
    // from. Live K3 guidance argues against DUPLICATION, for everyone, which
    // is what the schema-only doctrine rule already does.
    const { rt } = createTestRuntime();
    const registeredExecutors: string[] = [];
    const opts = {
      availableTools: ['run', 'memory'] as const,
      externalTools: [{ name: 'tool_docs_search', source: 'mcp' as const, description: 'Search docs.' }],
      registeredExecutors,
    };
    const section = (id: string) => {
      const prompt = buildSystemPromptSync(rt, { ...opts, model: { id } });
      const start = prompt.indexOf('## Tools available this turn');
      return prompt.slice(start, prompt.indexOf('\n## ', start + 1));
    };
    const kimi = section('@cf/moonshotai/kimi-k2.6');
    expect(kimi).toEqual(section('anthropic/claude-sonnet-4.5'));
    expect(kimi).toEqual(section('codex/gpt-5.5'));

    // The index carries the EXAMPLE, which nothing else carries — not the
    // summary, which is line 1 of the same tool's schema description in the same
    // request. Pinning the summary here (as this test did until 2026-08-25) was
    // pinning the duplicate: 942 chars of it across the eight builtins. Both
    // directions are asserted, so neither the example going missing nor the
    // summary coming back is silent.
    expect(kimi).toContain(`- **run** — \`${BUILTIN_TOOL_SPECS.run.example}\``);
    expect(kimi).toContain(`- **memory** — \`${BUILTIN_TOOL_SPECS.memory.example}\``);
    for (const name of BUILTIN_TOOLS) {
      expect(kimi).not.toContain(BUILTIN_TOOL_SPECS[name].summary);
    }
    expect(kimi).toContain('**tool_docs_search** (MCP) — Search docs.');
    expect(kimi).toContain('Call the tools listed here');
  });

  test('memory conversations scroll contract is schema-only', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // The mode contract (query searches, around_message_id scrolls, neither
    // browses) lives in the memory tool's input-schema property descriptions.
    expect(prompt).not.toContain('around_message_id');
  });

  test('teaches craft-on-repeat, search-before-solve, and the lessons loop', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('workspace.createTool');
    expect(prompt).toContain('workspace.listTools()');
    expect(prompt).toMatch(/next execute_tools call/);            // freshness, not "when injected"
    // The self-improvement lane is REACHABLE and named, but its signatures are
    // not restated here. Until 2026-08-25 this asserted `agent.proposeCurriculum`
    // in the prompt, which pinned a hand-written copy of a declaration that
    // ships in the same request (tools/agent-self.ts TYPES, carried into the
    // execute_tools description by renderExecuteToolsDescription) — and the copy
    // was the weaker of the two. The pin now proves the same capability is
    // discoverable AND that its contract has exactly one home.
    expect(prompt).toContain('`agent.*` namespace inside execute_tools');
    expect(prompt).toMatch(/curriculum/);
    expect(prompt).not.toContain('agent.proposeCurriculum(');
    expect(agentSelfTypes()).toContain('proposeCurriculum');
    // The lesson loop is a standing fact about what is IN the memory store,
    // not a usage rule, so it rides the memory spec's doctrine field — the one
    // line of `## Memory and facts` the memory schema did not already carry.
    expect(BUILTIN_TOOL_DESCRIPTIONS.memory).toMatch(/failures are recorded as lessons/i);
  });

  test('honors soulOverride', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { soulOverride: 'CUSTOM ROLE TEXT' });
    expect(prompt).toContain('CUSTOM ROLE TEXT');
    expect(prompt).not.toMatch(/^You are Kinu/);   // fallback NOT used
  });

  test('renders every BUILTIN_TOOL with its description', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    for (const name of BUILTIN_TOOLS) {
      expect(prompt).toContain(`**${name}**`);
    }
  });

  test('advertises llm.query only where the provider is wired (rlmAvailable), on any backend', () => {
    const { rt } = createTestRuntime();
    const withRlm = buildSystemPromptSync(rt, { backend: 'cf', rlmAvailable: true });
    expect(withRlm).toMatch(/Code execution and learned capabilities/);
    expect(withRlm).toMatch(/llm\.query/);
    // The recipe names the search rung for deeper decomposition (depth via
    // agents, not nested sub-calls).
    expect(withRlm).toContain('action=swarm');
    // Regression: we previously had `splitLargeText(input, 4000)` which
    // doesn't exist anywhere in the runtime surface.
    expect(withRlm).not.toContain('splitLargeText');

    // A static-model CLI session has no resolver, so llm.query would throw —
    // never advertise it there. The scaffold self-provider ships on BOTH
    // backends since the shared-spine parity, so it is always advertised.
    const withoutRlm = buildSystemPromptSync(rt, { backend: 'cli-local' });
    expect(withoutRlm).toMatch(/Code execution and learned capabilities/);
    expect(withoutRlm).not.toMatch(/llm\.query/);
    // The scaffold lane is still advertised where llm.query is not — that is
    // what this half of the test is for. It is advertised as the NAMESPACE now
    // rather than as a copied signature (see the note in the craft test above);
    // the signature itself is asserted against its one declaration.
    expect(withoutRlm).toContain('`agent.*` namespace inside execute_tools');
    expect(withoutRlm).toMatch(/scaffold proposals/);
    expect(withoutRlm).not.toContain('agent.proposeScaffold(');
    expect(agentSelfTypes()).toContain('proposeScaffold');
    const cliWithRlm = buildSystemPromptSync(rt, { backend: 'cli-local', rlmAvailable: true });
    expect(cliWithRlm).toMatch(/llm\.query/);
  });

  test('does not advertise removed context tools or blocks', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // These tools are never generated. Advertising them sent the model to
    // no-op calls. Durable state now lives in agent_facts, memory notes, and the
    // canonical conversation transcript, all through the one memory surface.
    expect(prompt).not.toMatch(/set_context|search_context|load_context/);
    expect(prompt).not.toMatch(/context blocks/iu);
    expect(BUILTIN_TOOL_DESCRIPTIONS.memory).toContain('past conversations');
  });

  test('durable-state doctrine is schema-only: no `## Memory and facts` section', () => {
    // The section restated the memory schema's own whenToUse in five bullets —
    // keyed facts for precise lookup, save/search for prose, conversations
    // before re-deriving, and stale-key replacement. Two phrasings of one rule
    // cost adherence twice and invite reconciliation.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain('## Memory and facts');
    const memory = BUILTIN_TOOL_DESCRIPTIONS.memory;
    expect(memory).toMatch(/remember\/recall hold a small named value/);
    expect(memory).toMatch(/update a stale key rather than adding a contradictory second fact/);
    expect(memory).toMatch(/conversations reads what this agent said before/);
  });

  test('no release overlay survives: nothing could ever stamp it', () => {
    // `release` was a PromptMode value with no producer. `kinuMode` is
    // written in exactly three places (the composer's Plan/Build choice, the
    // plan-approval turn, and jobs/runner.ts from `background_jobs.work_mode`,
    // which store.ts coerces to plan|build), and no event name maps to it.
    // So the guidance keyed on it had never reached a model, and it is gone
    // rather than kept as an unreachable branch. `release.*` remains reachable
    // exactly where it always was: the codemode namespace.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain('## Kinu release changes');
    expect(prompt).not.toContain('Release mode:');
    expect(prompt).not.toContain('Never deploy Kinu release changes');
  });

  test('the ambient skills index renders name + description for every available skill, active or not', () => {
    // The discovery gap this closes: without this, a skill that never
    // auto-activates is invisible to the model — nothing in the prompt names
    // it, and there is no tool call left that lists it either.
    const { rt } = createTestRuntime();
    const dormant: ParsedSkill = {
      name: 'dormant-skill', description: 'Not active this turn, but the model should still know it exists.',
      allowed_tools: [], keywords: [], auto_activate: false, disable_model_invocation: false,
      user_invocable: true, body: 'DORMANT-BODY-MUST-NOT-APPEAR', ext: {}, source: 'vfs',
    };
    const prompt = buildSystemPromptSync(rt, { availableSkills: [dormant] });
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('**dormant-skill** — Not active this turn');
    // Progressive disclosure: index carries the description, never the body.
    expect(prompt).not.toContain('DORMANT-BODY-MUST-NOT-APPEAR');
  });

  test('omitting availableSkills renders no Skills section (no regression for callers that do not pass it)', () => {
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('## Skills');
  });

  test('renders executor section when registeredExecutors supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: [], available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).toContain('workspace.*');
    expect(prompt).toContain('sandbox.*');
    expect(prompt).toMatch(/Showing a running app/);
    expect(prompt).toMatch(/exposePort/);
    // With ≥2 executors, state the mount doctrine: separate machines, whose
    // live files also appear in the agent's own plane at /pc and /sandbox —
    // and the shell limit that keeps commands routed by namespace.
    expect(prompt).toMatch(/separate machines/i);
    expect(prompt).toContain('/pc');
    expect(prompt).toContain('/sandbox');
    expect(prompt).toMatch(/cannot see mount points/);
  });

  test('teaches the preview workflow for the executor that actually exposes inbound ports', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toMatch(/Showing a running app/);
    expect(prompt).toContain('workspace.exposePort(port)');
    expect(prompt).not.toContain('sandbox.exposePort(port)');
  });

  test('every runtime is its own machine, on every backend, with mounts named', () => {
    // This used to be a backend conditional: on cli-local the workspace and
    // laptop executors shared one host shell, so "separate filesystems" was
    // false there. The workspace is its own durable filesystem on both
    // backends now, so the fact is unconditional and the exception is gone.
    // The mount doctrine rides beside it: a live machine's files also appear
    // in the agent's own plane at /pc (and /sandbox where a container binds),
    // while the shell stays over workspace bytes only.
    const { rt } = createTestRuntime();
    const executors = [
      { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
    ];
    for (const backend of ['cli-local', 'cf'] as const) {
      const prompt = buildSystemPromptSync(rt, { backend, executors });
      expect(prompt).toMatch(/separate machines/i);
      expect(prompt).not.toContain('the same machine and see the same files');
      expect(prompt).toContain('/pc');
      expect(prompt).toMatch(/cannot see mount points/);
    }
  });

  test('renders only selectable executors when lifecycle facts are supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', kind: 'laptop', available: false, configured: false, active: false, status: 'not_configured' },
        { name: 'sandbox', kind: 'sandbox', available: false, configured: false, active: false, status: 'not_configured' },
      ],
    });

    expect(prompt).not.toContain('nimbus.*');
    expect(prompt).toContain('workspace.*');
    // The hosted workspace runtime is a real POSIX shell over the agent's own
    // filesystem, with resident runtimes and processes in the same environment.
    expect(prompt).toContain('real POSIX shell');
    expect(prompt).toContain('resident background processes');
    expect(prompt).not.toContain('laptop');
    expect(prompt).not.toContain('sandbox.*');
    expect(prompt).not.toMatch(/Showing a running app/);
  });

  test('the hosted workspace names its memory ceiling and the sandbox names where oversized work goes', () => {
    // The escalation that did not happen: `git clone` in the Nimbus workspace
    // died with "Worker exceeded memory limit", and the agent retried the same
    // clone three more ways rather than moving to the container. Both halves
    // are doctrine in the cacheable prefix, and neither is inferable from the
    // other — the ceiling only the workspace line can state, the destination
    // only the sandbox line can offer.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', available: true, configured: true, active: false, status: 'idle' },
      ],
    });
    expect(prompt).toContain('runs inside a Worker isolate');
    expect(prompt).toContain('~128 MB');
    expect(prompt).toContain('large clones and builds');
    expect(prompt).toContain('the moment it outgrows the workspace');
  });

  test('the isolate ceiling is claimed only where it holds — never on cli-local', () => {
    // cli-local's workspace is the inline executor on the user's own machine
    // (cli-backend/runtime.ts registers createInlineExecutor), which carries no
    // isolate limit and reports a measured cgroup instead when it has one.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).toContain('workspace.*');
    expect(prompt).not.toContain('Worker isolate');
  });

  test('a registered-but-offline device stays visible, by name, with the way back', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        {
          name: 'laptop', kind: 'laptop', available: false, configured: true, active: false,
          status: 'disconnected', label: 'ashish@studio',
        },
      ],
    });

    expect(prompt).toContain('currently OFFLINE');
    // The row names the machine its owner named. "laptop" is the namespace.
    expect(prompt).toContain('ashish@studio');
    // Calling an offline device is how the owner gets ASKED for it — the hub
    // raises a connect request on that call — so the row no longer forbids it.
    expect(prompt).toContain('asks them to bring it back');
    expect(prompt).toContain('kinu connect');
    // Offline ≠ selectable: no laptop.* namespace advertised for calls.
    expect(prompt).not.toContain('laptop.***');
  });

  test('an ungranted device teaches that the first call asks for this workspace', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        {
          name: 'laptop', kind: 'laptop', available: true, configured: true, active: true,
          status: 'active', label: 'ashish@studio', granted: false,
        },
      ],
    });

    expect(prompt).toContain('laptop.*');
    expect(prompt).toContain('ashish@studio');
    expect(prompt).toContain('NO grant yet');
    expect(prompt).toContain('expected, not an error');
    // The live-state framing replaces "assume absent forever".
    expect(prompt).toContain('live state at the start of THIS turn');
  });

  test('a granted device says so, so the model does not predict a prompt that will not come', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        {
          name: 'laptop', kind: 'laptop', available: true, configured: true, active: true,
          status: 'active', label: 'ashish@studio', granted: true,
        },
      ],
    });

    expect(prompt).toContain('holds its access grant already');
    expect(prompt).not.toContain('NO grant yet');
  });

  test('an unnamed device is described, never called "laptop", to the user', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain("your user's PC");
  });

  test('the cli-local laptop is the CLI host machine — direct, no consent prompt', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('laptop.*');
    expect(prompt).toContain('the local machine the Kinu CLI is running on');
    expect(prompt).toContain('no tunnel or consent prompt');
    expect(prompt).not.toContain('device tunnel');
  });

  test('omits executor section when no executors registered', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { registeredExecutors: [] });
    expect(prompt).not.toMatch(/Execution environments/);
    expect(prompt).not.toMatch(/exposePort/);
  });

  test('names the workspace filesystem and each environment by its own namespace', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    // The workspace filesystem is named by where it actually is, and the shell
    // is said to run over exactly those bytes — the property the mount table
    // used to assert about `/local`.
    expect(prompt).toContain('/home/user');
    expect(prompt).toContain('the same bytes the `file` tool and `workspace.*` file ops read');
    // Every other environment is a namespace, never a directory of this one.
    expect(prompt).toContain('`sandbox.*`');
    expect(prompt).not.toContain('`nimbus.*`');
    expect(prompt).toContain('`laptop.*`');
    expect(prompt).not.toContain('Nimbus for quick cloud execution');
    expect(prompt).toMatch(/paths native to each machine/);
    // The mount doctrine is part of the naming now: a live machine's files sit
    // in the agent's own plane at /pc or /sandbox, and the shell's limit — it
    // cannot see mount points — is stated beside them.
    expect(prompt).toContain('/pc');
    expect(prompt).toContain('/sandbox');
    expect(prompt).toMatch(/cannot see mount points/);
  });

  test('the doctrine follows the executor list, not the backend', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).toContain('`laptop.*`');
    expect(prompt).not.toContain('`sandbox.*`');
    expect(prompt).not.toContain('`nimbus.*`');
  });

  test('a workspace with no execution devices renders no mount doctrine', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).not.toContain('mount table');
  });

  test('verification is doctrine of its own, not a line buried in operating guidance', () => {
    // Two of five benchmark failures were the same shape: the model solved the
    // problem and then fumbled the deliverable. One reasoned the causal
    // structure out exactly right and wrote every row of the CSV transposed.
    // One built an API to its own convenient signature and reported "all 14
    // tests pass" — against its own tests. The prompt had one hedged line
    // ("verify meaningful changes with the narrowest reliable checks") and no
    // section; it now has a section and no duplicate line.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('## Verification');
    // The generic "check your work before calling it done" framing is gone:
    // the CompletionGate is that instruction as a mechanism, and a generic
    // re-check line is what Anthropic's Opus 5 guidance says to delete.
    expect(prompt).not.toMatch(/The artifact is the evidence — read it/);
    expect(prompt).not.toMatch(/Before you call work done/);
    // The transposition test: check the artifact's literal shape, not the plan.
    expect(prompt).toMatch(/Re-read the artifact itself/);
    expect(prompt).toMatch(/column order, direction, units, filenames/);
    // The self-graded-signature test.
    expect(prompt).toMatch(/Build to the interface the task states/);
    expect(prompt).toMatch(/A result is something you executed/);
    // The old buried line is gone — one home for the doctrine, not two.
    expect(prompt).not.toContain('narrowest reliable checks');
    // It lands last, right before the answer it governs.
    expect(prompt.indexOf('## Verification')).toBeGreaterThan(prompt.indexOf('## Delegation'));
    expect(prompt.indexOf('## Verification')).toBeLessThan(prompt.indexOf('## Output format'));
  });

  test('the run-the-real-check line is gated on actually having an executor', () => {
    // Gate to reality: an agent with no way to execute anything cannot run the
    // task's own checks, so it is not told to. The two artifact-shape lines are
    // ungated — they apply to any answer.
    const { rt } = createTestRuntime();
    const noExec = buildSystemPromptSync(rt, {
      availableTools: ['memory'],
      registeredExecutors: [],
    });
    expect(noExec).toContain('## Verification');
    expect(noExec).toContain('Re-read the artifact itself');
    expect(noExec).not.toContain('Run the real check');

    const withRun = buildSystemPromptSync(rt, {
      availableTools: ['memory', 'run'],
      registeredExecutors: [],
    });
    expect(withRun).toMatch(/Run the real check and report what passed or failed/);
    expect(withRun).toMatch(/A result is something you executed/);
  });

  test('includes output-format guidance', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Output format/);
    expect(prompt).toMatch(/plain markdown|markdown/);
  });

  test('renders only the available built-in tools for a gated turn', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['memory', 'web'],
      registeredExecutors: [],
    });
    expect(prompt).toContain('**memory**');
    expect(prompt).toContain('**web**');
    expect(prompt).not.toContain('**execute_tools**');
    expect(prompt).not.toContain('agent.schedule');
    // No delegation tool wired → no ladder at all.
    expect(prompt).not.toContain('## Delegation');
  });

  test('renders external tools separately from built-in tools', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['memory'],
      externalTools: [
        { name: 'tool_docs_search', source: 'mcp', description: 'Search project documentation.' },
        'custom_export',
      ],
      registeredExecutors: [],
    });

    expect(prompt).toContain('**memory**');
    expect(prompt).not.toContain('**web**');
    expect(prompt).toContain('External tools');
    expect(prompt).toContain('**tool_docs_search** (MCP) — Search project documentation.');
    expect(prompt).toContain('**custom_export** (external)');
  });

  test('prompt surface hides unavailable executors from selectable runtimes', () => {
    const surface = compilePromptSurface({
      executors: [
        { name: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', available: false, configured: true, active: false, status: 'disconnected' },
      ],
    });
    expect(surface.executors.map((exec) => exec.name)).toEqual(['laptop', 'workspace']);
    expect(surface.selectableExecutors.map((exec) => exec.name)).toEqual(['workspace']);
  });

  test('model profile blocks tool mode on known non-tool models', () => {
    expect(modelSupportsTools({ id: 'o4-mini' })).toBe(false);
    expect(modelSupportsTools({ id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' })).toBe(false);
    expect(modelSupportsTools({ id: '@cf/moonshotai/kimi-k2.6' })).toBe(true);
    expect(() => assertToolsSupportedByModel({ id: 'o4-mini' }, ['run']))
      .toThrow(/does not support tool calling/);
  });

  test('adds model-specific guidance for Kimi K2.6', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { model: { id: '@cf/moonshotai/kimi-k2.6' } });
    expect(prompt).toContain('Kimi K2.6');
    expect(prompt).toContain('tool/result context');
  });

  test('adds model-specific guidance for GPT and Codex models', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { model: { id: 'codex/gpt-5.5' } });
    expect(prompt).toContain('GPT/Codex-style');
    expect(prompt).toContain('success criteria');
  });

  test('adds mode overlays only when requested', () => {
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('Background-resume mode');
    expect(buildSystemPromptSync(rt, { provenance: 'background_resume' }))
      .toContain('Background-resume mode');
    const plan = buildSystemPromptSync(rt, { workMode: 'plan', planSubmissionAvailable: true });
    expect(plan).toContain('submit_plan');
    expect(plan).toContain('Do not change files, system state, releases, or deployments');
    expect(plan).toContain('Do not expose ports or produce preview or output links');
    expect(plan).toContain('Do not begin implementation until the plan is approved');

    const delegatedPlan = buildSystemPromptSync(rt, { workMode: 'plan', planSubmissionAvailable: false });
    expect(delegatedPlan).toContain('report concrete findings to the parent Plan turn');
    expect(delegatedPlan).not.toContain('End by calling `submit_plan`');
  });

  test('a background-job wake reaches the resume guidance even though it also carries a work mode', () => {
    // The regression this pins. jobs/runner.ts stamps BOTH
    // `kinuEvent: 'background_job'` and `kinuMode: job.workMode` on the
    // wake, and `background_jobs.work_mode` is NOT NULL — so under the old
    // single-`mode` precedence the work mode always won and this guidance,
    // written to stop the agent re-doing or polling settled work, never
    // reached a model on the real wake path. Provenance is now read from the
    // event alone, so the wake carries the overlay AND its permission.
    const wake = { kinuEvent: 'background_job', kinuMode: 'build' };
    expect(turnProvenanceForMetadata(wake)).toBe('background_resume');
    expect(workModeForTurnMetadata(wake)).toBe('build');

    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      provenance: turnProvenanceForMetadata(wake),
      workMode: workModeForTurnMetadata(wake),
    });
    expect(prompt).toContain('fetch the referenced job result first');

    // A Plan job's wake keeps BOTH: the resume overlay and the read-only bar.
    const planWake = { kinuEvent: 'background_job', kinuMode: 'plan' };
    const planPrompt = buildSystemPromptSync(rt, {
      provenance: turnProvenanceForMetadata(planWake),
      workMode: workModeForTurnMetadata(planWake),
    });
    expect(planPrompt).toContain('fetch the referenced job result first');
    expect(planPrompt).toContain('Do not change files, system state, releases, or deployments');
  });

  test('the two axes are read from different metadata keys and neither can suppress the other', () => {
    expect(turnProvenanceForMetadata({ kinuEvent: 'event_drain' })).toBe('chat');
    expect(turnProvenanceForMetadata(null)).toBe('chat');
    expect(turnProvenanceForMetadata({})).toBe('chat');
    // A timer fire is published as an EVENT and drains as `event_drain`; no
    // timer- or cron-named kinuEvent exists, which is why the cron overlay
    // is gone rather than kept as a branch nothing can enter.
    expect(turnProvenanceForMetadata({ kinuEvent: 'timer_cron' })).toBe('chat');

    expect(workModeForTurnMetadata({ kinuMode: 'plan' })).toBe('plan');
    expect(workModeForTurnMetadata({ kinuMode: 'build' })).toBe('build');
    // Only the exact 'plan' string raises the bar — an old or foreign client
    // cannot invent a mode, and cannot lower one either.
    expect(workModeForTurnMetadata({ kinuMode: 'invalid' })).toBe('build');
    expect(workModeForTurnMetadata(null)).toBe('build');
  });

  test('Auto (the build work mode) adds nothing at all, byte for byte', () => {
    // `- Turn mode: build` used to be inserted ~350 bytes into the CACHEABLE
    // prefix, announcing a mode with no guidance branch, so an Auto turn and
    // an otherwise identical chat turn could not share a provider prefix
    // cache. Auto IS the absence of constraint; it renders nothing.
    const { rt } = createTestRuntime();
    const base = { backend: 'cf' as const, model: { id: 'x' }, currentDate: '2026-01-01' };
    expect(buildSystemPromptSync(rt, { ...base, workMode: 'build' }))
      .toBe(buildSystemPromptSync(rt, base));
    expect(buildSystemPromptSync(rt, base)).not.toContain('Turn mode');
  });

  test('a resolved role renders exactly once in its own prompt section', () => {
    const { rt } = createTestRuntime();
    for (const [id, role] of Object.entries(BUILTIN_ROLE_DEFINITIONS)) {
      const prompt = buildSystemPromptSync(rt, {
        roleSection: {
          id,
          label: deriveRoleLabel(id),
          instructions: role.instructions,
        },
      });
      expect(prompt).toContain(`## Role: ${deriveRoleLabel(id)} (${id})`);
      expect(prompt.split(role.instructions)).toHaveLength(2);
    }
  });

  test('a role never widens Plan mode', () => {
    const { rt } = createTestRuntime();
    const planOnly = buildSystemPromptSync(rt, {
      workMode: 'plan',
      planSubmissionAvailable: true,
    });
    for (const [id, role] of Object.entries(BUILTIN_ROLE_DEFINITIONS)) {
      const prompt = buildSystemPromptSync(rt, {
        workMode: 'plan',
        planSubmissionAvailable: true,
        roleSection: {
          id,
          label: deriveRoleLabel(id),
          instructions: role.instructions,
        },
      });
      expect(prompt).toContain('Do not change files, system state, releases, or deployments');
      expect(prompt).toContain('Do not begin implementation until the plan is approved');
      expect(prompt).toContain('Do not expose ports or produce preview or output links');
      for (const line of planOnly.split('\n')) expect(prompt).toContain(line);
    }
    expect(compilePromptSurface({
      workMode: 'plan',
      roleSection: {
        id: 'implementer',
        label: 'Implementer',
        instructions: BUILTIN_ROLE_DEFINITIONS.implementer.instructions,
      },
    }).workMode).toBe('plan');
  });

  test('renders the date-only current date in runtime context', () => {
    const { rt } = createTestRuntime();
    expect(currentDateForPrompt(new Date('2026-06-11T17:42:03Z'))).toBe('2026-06-11');
    const prompt = buildSystemPromptSync(rt, { backend: 'cf', currentDate: currentDateForPrompt() });
    expect(prompt).toContain(`- Current date: ${currentDateForPrompt()}`);
    // Date-only keeps the prompt byte-stable within a day (cache-safe).
    expect(prompt).not.toMatch(/Current date: .*\d:\d/);
  });

  test('persistence is stated plainly and teaches compaction awareness', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // Gating is structural — no hedging about backend support.
    expect(prompt).not.toContain('when the backend supports them');
    // The model must not wrap up early because of token-budget fears.
    expect(prompt).toContain('Your context window is automatically compacted as it approaches its limit');
    expect(prompt).toContain('so work each task through to completion');
  });

  test('per-section char budgets stay pinned (additions must be deliberate)', () => {
    // Budget regression gate: each builder-owned section of the representative
    // CF surface stays within its pinned ceiling, so prompt growth is a
    // reviewed decision, not drift. Ceilings are ~10% over 2026-06 measured
    // sizes — raise one ONLY alongside an intentional content change.
    const BUDGETS = {
      'Runtime context': 160,
      // 2026-08: the ladder pointer is gone. It restated the Delegation
      // section's own opening forty lines above it, and both of its triggers
      // are mechanised — turn-steering states them at the step where the
      // decision is still open, which is the version that measurably converts.
      'Operating guidance': 460,
      // +2 summary lines for the team/peers split + the subordinate report
      // tool (2026-07, Subordinates A2). Real actors advertise a
      // deps-filtered subset; this representative surface carries all three.
      // 2026-08: think/team summaries now name the lifetime rung they are.
      // 2026-08: +1 concrete example call per tool, and the index lost the
      // `experience` line. The prompt teaches tool use by showing a real
      // argument shape rather than by describing one — deliberate, and the
      // only place the specs' `example` field is rendered.
      // 2026-08-11: the `agents` example became the fork call (+92 chars, the
      // nested forks array is longer than hire's flat role/mission). It sits
      // close to this ceiling on purpose — the next example that grows should
      // be a reviewed decision, which is what this gate is for.
      // 2026-08-12: RAISED 2100 → 2350 for the `tasks` line. The index costs
      // one summary + one example per tool (237 chars here, measured 2081 →
      // 2318); the tool's own when-to-use doctrine is schema-only, as every
      // other tool's is, so none of it lands in this section.
      // 2026-08-25: LOWERED 2350 → 1020, measured 990 (−1328 from the 2318 this
      //   ceiling was set against). The index stopped rendering each tool's
      //   `summary`, which is line 1 of that tool's own schema description in
      //   the SAME request — 942 chars of pure duplication across the eight
      //   builtins. What remains is the name and the one real call, which is the
      //   only place BUILTIN_TOOL_SPECS.example reaches a model, and which is
      //   the split OpenAI's GPT-4.1 guide prescribes: examples in the prompt,
      //   contract in the description field.
      'Tools available this turn': 1020,
      // +2 lines of file doctrine: the workspace filesystem is named by where
      // it is, and every other environment is a separate machine whose commands
      // stay behind its own namespace — stated once here for all of them.
      // 2026-08-16: RE-PINNED 2450 → 2700 for TWO additions, measured 2657
      // (+374 the Worker isolate ceiling and sandbox work doctrine; +472 the
      // Approvals block replacing a per-call paragraph).
      // 2026-08-21: RAISED 2700 → 3100 for the mount doctrine, measured 3051.
      //   +351 — the separate-machines paragraph now states the mount table
      //     (/pc, /sandbox) with the shell limit that keeps commands routed by
      //     namespace, and the hasDevices block maps a mounted native path.
      //     The owner's ruling made the mounts product surface (#36/#142/#143).
      // 2026-08-25: LOWERED 3100 → 3050, measured 3001. Two changes landed on
      //   this section in the same pass, and the number is the sum of both:
      //     −123 (slimming) the mount doctrine was stated TWICE — one paragraph
      //       gated on `manyRuntimes`, one on `hasDevices` — restating
      //       separate-machines, commands-through-their-own-namespace and
      //       mounts-show-native-paths in different words. One paragraph now
      //       carries every fact both did. `hasDevices` is the weaker gate and
      //       therefore loses no surface (manyRuntimes implied it: with 2+
      //       executors at most one is `workspace`), so a lone sandbox now reads
      //       doctrine it used to miss. 3051 → 2928.
      //     +73 (device identity) the laptop rows now name the machine the user
      //       named it and say whether this workspace already holds its access
      //       grant. 2928 → 3001.
      'Execution environments': 3050,
      'Persistence': 700,
      // 2026-08: −1 line. `execute_tools runs JavaScript against the active
      // executor/codemode namespaces` was the tool's own summary, restated.
      // 2026-08-12: +4 chars. Defect-B fix: the agent.jobResult bullet used to
      // read as a generic "read status and results" call; it now says a
      // settled job is what it reads, and that the wake already named the id
      // — the same "you don't need to check, you'll be told" doctrine as the
      // Background work section, stated where this tool is introduced.
      // 2026-08-25: LOWERED 1610 → 830, measured 801 (−425 on this surface,
      //   −777 with llm.query present). The six `agent.*` API bullets were a
      //   hand-maintained second copy of the `agent.*` codemode type block,
      //   which ships to the model inside the execute_tools description — and
      //   the weaker copy: the proposeScaffold bullet omitted the required
      //   `async function* run(rt, task)` export, the host-bridge restriction
      //   and the rationale floor that the declaration states. One pointer at
      //   the namespace replaced all six. Same lesson as SWARM_PRESET_DOCTRINE:
      //   prose that cannot read the declaration it describes will drift from it.
      'Code execution and learned capabilities': 830,
      // 2026-08: the old Research (1049) + Team (1435) sections collapsed into
      // ONE lifetime-keyed ladder.
      // 2026-08: +1 line naming the turn-cumulative tool-output budget — the
      // clamp tightens mechanically, and a model told WHY reaches for a rung
      // instead of re-running the command (core/src/context-budget.ts).
      // 2026-08: +1 line for `agents.*` in codemode — the rung ladder is also
      // a sandbox namespace, which is what makes a crafted tool a workflow,
      // and it carries the in-sandbox fork's non-resumable cost.
      // 2026-08: the rungs became a two-line INDEX. Their triggers were
      // byte-identical to the `agents` schema whenToUse (418 tok per request)
      // and were kept here only so a bare tool-name index (kimi) would still
      // get the decision — a rationale that never held, since schemas are
      // family-neutral. The index is gone and so is the duplication.
      // 2026-08-11: LOWERED 2250 → 1870. The section now teaches three things
      // it did not (the shape that calls for a fork, which settle each shape
      // wants, that a fork can carry its own model) and is 270 chars SMALLER,
      // because four passages left: the turn-budget explanation moved into the
      // clamp's own marker (tools/clamp.ts) where it fires at the trip; the
      // peer-addressing line was DELEGATION_CONVERSE paraphrased; the roster/
      // dismiss tail was DELEGATION_RUNGS.hire paraphrased; the report line
      // was the `report` schema's whenToUse/whenNotToUse paraphrased.
      // 2026-08-11: RAISED 1870 → 2250 (back to its pre-2026-08-11 ceiling).
      // A trigger alone did not move settle=mcts — 1 use in 89 trials — so the
      // section now states the MECHANISM: that mcts writes its own rival
      // approaches from the task (the call shape differs from merge), that it
      // varies their angles, that it runs rounds, and that execution fixes the
      // score band the judge then orders within. Plus the fork-visibility fact
      // that makes dependent fork tasks a mistake. Paid for in part by two
      // duplicates this pass created: the merge clause's restatement of the
      // rung's own 2+-angles trigger, and `workspace.createTool`'s output,
      // which the Code-execution section already describes.
      // 2026-08-17: RAISED 2250 → 2450 (+251 chars measured, ~58 o200k tokens).
      // The polarity flip: the first bullet was "- Do it yourself" (49 chars),
      // which put rung 0 first and made the section a classification the model
      // passes by doing nothing — doctrine converted 0% of eligible turns, a
      // mechanical splice 24%. It is replaced by a default sentence (300 chars)
      // that states delegation as the default and the three exemptions last, as
      // things to DO. This is the only increase in the section and it buys the
      // one property the 506 tokens above it never had: a direction.
      // 2026-08-17: RAISED 2450 → 2530 (+79 chars measured, ~19 o200k tokens).
      // The two settles take DIFFERENT arguments and the fork seam now refuses
      // the mismatch (agents-tool.ts forkSettleRefusal), so a model that hands
      // hand-authored briefs to settle=mcts, or asks for merge with none, loses
      // the call outright. Both facts are one clause each: `forks` is what merge
      // runs and is required there, and mcts takes none.
      // 2026-08-17: RAISED 2530 → 2597 (+67 chars NET measured, ~16 o200k
      // tokens). The ladder was keyed on lifetime alone, and the axis that
      // actually decides which rung a task wants — what context the helper
      // starts from — was in neither index bullet. Both now carry it: a fork
      // runs on the caller's context (so its brief is one line), a hire starts
      // blank (so its mission is the whole brief). Gross +174, of which 107 was
      // paid back by deleting "Forks cannot see each other's work and meet only
      // at the merge, so each fork's task has to stand on its own" — that fact
      // now rides `forks[].task` itself (DELEGATION_INHERITANCE.fork.brief),
      // where it is read as the brief is being written rather than thousands of
      // tokens earlier.
      'Delegation': 2597,
      // 2026-08-12: RAISED 260 → 680. Defect-B fix (background polling): the
      // section used to say only "stop the turn; the backend will wake you" —
      // one clause the owner's bench evidence shows the model reads as
      // optional and routes around (agent.jobResult polled in a loop despite
      // that exact promise already being there). It now says the work KEEPS
      // RUNNING unwatched (so starting it again is visibly wrong, not just
      // wasteful), and states the wake's TWO landing shapes (mid-turn / fresh
      // turn) so "you are woken" reads as a mechanism rather than a hope.
      'Background work': 680,
      // 2026-08: new section. Two of five benchmark failures were a solved
      // problem with a fumbled deliverable, and the prompt had no doctrine
      // that would have caught either. 2026-08: −1 framing sentence, which the
      // CompletionGate says mechanically and Opus 5 guidance says to delete.
      'Verification': 620,
      'Output format': 180,
    } satisfies Record<string, number>;
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      registeredExecutors: ['workspace', 'nimbus', 'sandbox', 'laptop'],
      currentDate: '2026-06-11',
      model: { id: 'anthropic/claude-sonnet-4.5' },
    });
    const sections = new Map(splitPromptSections(prompt).map((s) => [s.title, s.chars]));
    const problems: string[] = [];
    for (const [title, budget] of Object.entries(BUDGETS)) {
      const size = sections.get(title);
      if (size === undefined) problems.push(`section "${title}" missing from the prompt`);
      else if (size > budget) problems.push(`section "${title}" is ${size} chars — over its ${budget}-char budget`);
    }
    expect(problems).toEqual([]);
  });

  test('does NOT promise unimplemented or redundant strategies', () => {
    // Regression: the old think tool description once claimed support for
    // strategies that don't exist. There is no strategy id left for a caller to
    // type at all — a search measures and nothing else spawns — so naming one
    // would be that same defect. single-shot stays registered for eval harnesses
    // but is pure overhead for a chat model, so it is never advertised, and
    // `mcts` is registered for the durable search store and reaches neither surface.
    const { rt } = createTestRuntime();
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toMatch(/\bmcts\b/);
    expect(buildSystemPromptSync(rt)).not.toMatch(/\bmcts\b/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toMatch(/single-shot/);
    expect(buildSystemPromptSync(rt)).not.toMatch(/single-shot/);
  });

  test('the ladder renders identically for BOTH a Kimi and a non-Kimi agent', () => {
    // Every family now reads one prompt and one set of schemas. The Delegation
    // section is workflow doctrine in the agent-state block, so its
    // prompt-only lines reach every family, and the rung triggers reach them
    // through the family-neutral schema.
    const { rt } = createTestRuntime();
    for (const id of ['@cf/moonshotai/kimi-k2.6', 'anthropic/claude-sonnet-4.5']) {
      const prompt = buildSystemPromptSync(rt, { model: { id } });
      expect(prompt).toMatch(/## Delegation/);
      expect(prompt).toMatch(/- Ephemeral search \(action=swarm\) — /);
      expect(prompt).toMatch(/- Persistent subordinate \(action=hire\) — /);
      expect(prompt).toMatch(/A search writes its own competing candidates/);
    }
  });
});
