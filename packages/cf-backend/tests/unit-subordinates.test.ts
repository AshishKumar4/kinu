// How the Cloudflare backend WIRES core's subordinate module. The module's own
// behaviour is covered in core (core/tests/unit-subordinates.test.ts); what is
// backend-specific is which names this backend's source exposes where, so most
// of these read that source directly. The exception is the deps gate, which is
// exercised through the raw ToolSet each actor class builds.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPS_GATED_TOOLS, REPORT_TOOL } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';

const source = (path: string) => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8');

mockAgentsSdk();

describe('subordinate wiring', () => {
  /**
   * THE TEMPORARY RUNG'S CF WIRING — the three facts that make it the same
   * roster and the same child, and the one that makes it work at all.
   *
   * The rung's behaviour is core's (core/tests/unit-temporary-agents.test.ts)
   * and its end-to-end run is proved on the local substrate
   * (cli-backend/tests/agent-host.test.ts). What is BACKEND-SPECIFIC is
   * composition, which is what this reads.
   */
  /**
   * THE CHILD KNOWS ITS OWN LIFETIME, and reports terminally because of it.
   *
   * This is the half no parent can do: only the child sees its own turn end. A
   * temporary agent's caller is BLOCKED on one report, so every terminal state
   * has to produce one — and the endings that previously produced none are
   * exactly the ones the durable policy withholds.
   */
  test('a task child is seeded with its lifetime and reports on every terminal ending', () => {
    const actor = source('actor-agent.ts');
    const subordinate = source('subordinate-agent.ts');

    // Threaded at the SEED, because the child reads it back off its own
    // immutable identity row and must still know it after an eviction.
    expect(actor).toContain('lifetime: input.lifetime,');
    expect(subordinate).toContain('lifetime: input.lifetime,');
    expect(subordinate).toContain("return this.identity.read()?.lifetime ?? 'durable';");

    // EVERY ending is classified in one place and reported through the claimed
    // effect. The branch that used to return without reporting is gone, and so
    // is the second detached path an errored turn used to take — a failing turn
    // emits both an error and a turn-end, which is how one question got two
    // answers.
    expect(subordinate).toContain("const ending: TaskTurnEnding = completed\n"
      + "      ? 'answered'\n"
      + "      : result.status === 'aborted' ? 'interrupted' : 'errored';");
    // A task child reports even with nothing to say, which the durable relay
    // withholds — and the durable relay is still what runs for a hire.
    expect(subordinate).toContain('this.taskTerminalReport(ending, assistantText)');
    expect(subordinate).toContain('subordinateRelaysTurnEnd({');
    // The DECISION is core's closed map, never worded here — so the cloud child
    // and the local one cannot describe the same ending differently.
    expect(subordinate).toContain('return terminalTaskReport({ lifetime: this.ownLifetime(), ending, assistantText });');
    // The two facts stay SEPARATE. A mid-task `progress` note means the child
    // SPOKE without ANSWERING, so gating the answer on "spoke" parked the caller
    // forever; and only a run-settling report is the answer.
    expect(subordinate).toContain("this.settledRunThisTurn ||= temporaryRunSettles({ status: input.status, origin: 'report_tool' });");
    // Reset together at the top of the next settle, so neither leaks into it.
    expect(subordinate).toContain('    this.reportedThisTurn = false;\n    this.settledRunThisTurn = false;');
    // The completed branch is gated on the same bit, which is also what stops a
    // healthy report-tool answer emitting a second turn_end report the parent's
    // ingress can only refuse with a throw.
    expect(subordinate).toContain('const taskReport = this.settledRunThisTurn ? null : this.taskTerminalReport(');
    // The DURABLE policy still reads "spoke this turn", untouched.
    expect(subordinate).toContain('reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText,');
    // The ending an interrupted turn earns is now carried by its own CLAIMED
    // row rather than re-derived by a recovery hook: the roster declares a
    // parent report for every ending, so a replay sends the report the turn
    // actually owed instead of a generic 'recovered' one invented afterwards.
    expect(subordinate).toContain('status: parentReport.status,');
    expect(subordinate).not.toContain('relayTaskTerminal');
  });

  /** NO DEADLINES. A delegation is never cut off by a clock in this engine, so
   *  the rung must contain no timer at all — what makes the wait terminate is the
   *  child always reporting, not an elapsed bound. */
  test('the temporary rung carries no timer, deadline or elapsed bound', () => {
    const rung = readFileSync(
      join(import.meta.dir, '..', '..', 'core', 'src', 'subordinates', 'temporary.ts'), 'utf8');
    // Code shapes only: the module's prose explains WHY there is no deadline,
    // and banning the word would ban the explanation.
    for (const banned of ['setTimeout(', 'setInterval(', 'AbortSignal.timeout', 'timeoutMs', 'silenceLimit']) {
      expect({ banned, present: rung.includes(banned) }).toEqual({ banned, present: false });
    }
  });

  test('the temporary rung rides this actor\'s own roster, child runtime and report ingress', () => {
    const actor = source('actor-agent.ts');

    // ONE child substrate, memoized, shared by both rungs. Two copies would be
    // two `subAgent` paths to the same facets.
    expect(actor).toContain('protected subordinateRuntime(): SubordinateRuntime {');
    expect(actor).toContain('runtime: this.subordinateRuntime(),');

    // ONE ROSTER. The port is built over `subordinateRoster` — there is no
    // second store, and no table of its own to construct.
    expect(actor).toContain('roster: this.subordinateRoster,');
    expect(actor).not.toContain('TemporaryAgentStore');
    expect(actor).not.toContain('workspace_temporary_agents');

    // The port is built ONCE PER ACTOR, and that is load-bearing rather than a
    // caching nicety: `run` parks a waiter on it and the report ingress resolves
    // that waiter, and those are two different calls on the same isolate. A port
    // rebuilt per call would hand the ingress an empty waiter map and leave
    // every ask hanging on an answer that had already arrived.
    expect(actor).toContain('private _temporaryAgentPort: TemporaryAgentPort | null = null;');
    expect(actor).toContain('this._temporaryAgentPort ??= createTemporaryAgentPort({');
    expect(actor).toContain('temporary: this.temporaryAgentPort(),');
    // Both readers reach the SAME port: the deps the model dispatches through,
    // and the ingress a child reports into.
    expect(actor.match(/temporary: this\.temporaryAgentPort\(\),/gu)?.length).toBe(2);

    // A `context_ref` is AUTHORIZED here and never read here: the bytes are the
    // child's to fetch, which is the whole saving the channel exists for.
    expect(actor).toContain('statRef: async (path) => (await this.rt.storage.vfs.stat(path)) !== null,');
    expect(actor).not.toContain('vfs.readFile(path, { encoding: \'utf8\' })');

    // The roster store takes both sql forms, because the table has gained
    // columns and IF NOT EXISTS is a no-op on a workspace that already had it.
    expect(actor).toContain('new SubordinateRosterStore(this.ctx.storage.sql, this.boundSql)');
  });

  /** The standalone recursive-LM namespace is gone from this backend's sandbox
   *  and from its prompt flags — one delegation surface, no second lane. */
  test('no rlm provider, model spec or prompt flag survives in the cf composition', () => {
    const actor = source('actor-agent.ts');
    const execTools = source('execute-tools.ts');
    const exploration = source('exploration.ts');
    for (const [name, text] of [
      ['actor-agent.ts', actor],
      ['execute-tools.ts', execTools],
      ['exploration.ts', exploration],
    ] as const) {
      expect({ name, hit: /createRLMProvider|rlmAvailable|rlm\.query/u.test(text) })
        .toEqual({ name, hit: false });
    }
    // The sandbox tool no longer needs a model registry at all, because nothing
    // in it calls a model directly any more.
    expect(execTools).not.toContain('registry:');
    expect(execTools).not.toContain('modelSpec');
  });

  test('all user-level gates present the parent workspace name, never the facet name', () => {
    const actor = source('actor-agent.ts');
    const runtime = source('runtime.ts');
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    // MCP now identifies its caller by the workspace capability token rather
    // than by a name argument, so a facet dispatches as its parent workspace
    // and there is no name left to spoof.
    expect(actor).toContain('.userMcp_callTool(await this.userCaller(), serverId, mcpName, args)');
    expect(actor).not.toContain('callerAgentName');
    expect(runtime).toContain('agentName: actor.workspaceName');
    expect(subordinate).toContain('const bootstrap = await parent.getSubordinateBootstrapIdentity();');
    expect(subordinate).toContain('parentWorkspace: bootstrap.parentWorkspace');
    expect(subordinate).toContain('ownerUserId: bootstrap.ownerUserId');
    // The depth comes from the same answer, and from nowhere else: the child
    // supplies no depth to be trusted with.
    expect(subordinate).toContain('depth: bootstrap.depth');
    // The team runtime is ActorAgent's now — a subordinate tree is recursive, so
    // an actor that can hold a roster is every actor with depth left, not a kind.
    expect(actor).toContain('inheritedContext: () => this.readInheritedContext()');
    expect(orchestrator).not.toContain('createTeamToolDeps({');
  });

  test('a subordinate holds the parent workspace capability token, pushed never pulled', async () => {
    const actor = source('actor-agent.ts');
    const subordinate = source('subordinate-agent.ts');

    // One store, inherited by both actor classes: a facet's token IS the
    // parent's, so §B6 taint inheritance needs no per-facet bookkeeping.
    expect(actor).toContain('protected workspaceCapabilityToken(): string | null');
    expect(actor).toContain('async installWorkspaceCapability(token: string)');

    // Push, both at spawn and whenever the parent's token is (re)issued.
    expect(actor).toContain('const capabilityToken = this.workspaceCapabilityToken();');
    expect(actor).toContain('await stub.installWorkspaceCapability(token);');
    expect(subordinate).toContain('if (input.capabilityToken) await this.installWorkspaceCapability(input.capabilityToken);');

    // Never pull: the bootstrap RPC any stub-holder can reach must not carry a
    // secret. Driven rather than read, because the earlier source slice was
    // anchored on two members that had moved and passed over an empty string.
    // The harness root holds `harness-capability`, so a leak would be in the
    // answer itself.
    const { agent } = orchestratorHarness();
    const bootstrap = await agent.getSubordinateBootstrapIdentity();
    expect(Object.keys(bootstrap).sort()).toEqual(['depth', 'model', 'ownerUserId', 'parentWorkspace']);
    expect(JSON.stringify(bootstrap)).not.toContain('harness-capability');
    expect(actor).not.toMatch(/@callable\(\)\s*\n\s*(async )?(installWorkspaceCapability|workspaceCapabilityToken)/);
    for (const file of ['actor-agent.ts', 'orchestrator.ts', 'subordinate-agent.ts']) {
      expect(source(file)).not.toMatch(/get\w*CapabilityToken\w*\(\)/);
    }
  });

  test('a subordinate shares workspace bytes without overwriting workspace identity or duplicating the executor', () => {
    const actor = source('actor-agent.ts');
    const subordinate = source('subordinate-agent.ts');

    expect(actor).toContain('scaffoldPath: this.scaffoldPath()');
    expect(actor).toContain('shellId: this.shellId()');
    expect(subordinate).toContain('`.kinu/agents/${encodeURIComponent(this.name)}/scaffold/agent.js`');
    expect(subordinate).toContain('protected shellId(): string { return `subordinate:${this.name}`; }');
    expect(subordinate).toContain('renderSoulMarkdown({');
    expect(subordinate).not.toContain('seedSoul(');
    expect(subordinate).not.toContain('createParentExecutor');
    expect(subordinate).not.toContain("registerParentWorkspace");
  });

  test('subordinate tools are structurally confined to report, without team, peers, or release changes', () => {
    const subordinate = source('subordinate-agent.ts');
    const profile = subordinate.slice(
      subordinate.indexOf('protected actorToolDeps()'),
      subordinate.indexOf('protected notifyOwner'),
    );
    expect(profile).toContain('report:');
    expect(profile).not.toContain('team:');
    expect(profile).not.toContain('peers:');
    expect(profile).not.toContain('releases:');
    // Cross-workspace experience transfer is no longer a tool at all — it is
    // the owner's RPC on the orchestrator, and reaches no actor's profile.
    expect(profile).not.toContain('experience:');
    // …and absence is structural: a deps-gated name is dropped from the
    // built ToolSet too, not just from the prompt. `release` is not a
    // native tool at all (release.* is codemode-only), so it needs no
    // gate here. Asserted on the built ToolSet rather than on the gate
    // function: what ships is the surface each actor class builds — the
    // orchestrator wires no `report` deps while a subordinate does.
    const orchTools = Object.keys(orchestratorHarness().agent.observeRawTools());
    const subTools = Object.keys(subordinateHarness().agent.observeRawTools());
    expect(orchTools).not.toContain(REPORT_TOOL);
    expect(subTools).toContain(REPORT_TOOL);
    // Gating one name costs no other name.
    expect(orchTools.filter((name) => name !== REPORT_TOOL).sort())
      .toEqual(subTools.filter((name) => name !== REPORT_TOOL).sort());
  });

  test('every deps-gated tool core declares is answered by this backend', () => {
    // The compiler cannot hold this: core declares the set as
    // `readonly BuiltinToolName[]`, which is the right type for a shared list
    // and cannot key an exhaustive table. So a name added to DEPS_GATED_TOOLS
    // with no dep check here would silently stay advertised on every actor —
    // which is the whole failure the gate exists to prevent. This is that check.
    const orchToolNames = Object.keys(orchestratorHarness().agent.observeRawTools());
    const ungated = DEPS_GATED_TOOLS.filter((name) => orchToolNames.includes(name));
    expect(ungated).toEqual([]);
    // And the set is not vacuously empty, which would make the line above pass
    // for the wrong reason.
    expect(DEPS_GATED_TOOLS.length).toBeGreaterThan(0);
  });

  test('browser subordinate callables reuse the team policy and are not exposed by the facet', () => {
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    expect(orchestrator).toContain('return this.subordinateViews();');
    expect(orchestrator).toContain('const result = await this.getTeamToolDeps().create({});');
    expect(orchestrator).toContain('const result = await this.getTeamToolDeps().rename({ name, displayName });');
    expect(orchestrator).toContain("return this.getTeamToolDeps().dismiss({ name, requestedBy: 'user' });");
    expect(subordinate).not.toContain('spawnSubordinate(');
    expect(subordinate).not.toContain('dismissSubordinate(');
    expect(subordinate).not.toContain('listSubordinates(');
  });


  test('manual create, rename, and dismiss reconcile the roster from their successful RPC result', () => {
    const hook = source('hooks/use-kinu.ts');
    expect(hook).toContain('result.subordinate');
    expect(hook).toContain('entry.name !== result.subordinate.name');
    expect(hook).toContain('entry.name !== result.name');
    // Zero-argument create: the server owns identity; the client sends nothing.
    expect(hook).toContain('rpc<{');
    expect(hook).toContain('>("createSubordinateAgent", [])');
    expect(hook).toContain('("renameSubordinateAgent", [name, displayName])');
    const mutations = hook.slice(hook.indexOf('createSubordinateAgent'), hook.indexOf('\n  };', hook.indexOf('createSubordinateAgent')));
    expect(mutations).not.toContain('await refreshSubordinates()');
    // One generation bump per mutation — create, rename, dismiss — so a stale
    // in-flight roster read cannot overwrite any of their results.
    expect(mutations.match(/\+\+subordinateRefreshGeneration\.current;/g)).toHaveLength(3);
  });

  test('stale roster reads cannot overwrite a mutation, broadcast, or actor reset', () => {
    const hook = source('hooks/use-kinu.ts');
    const refresh = hook.slice(
      hook.indexOf('const refreshSubordinates = useCallback'),
      hook.indexOf('\n\n  useEffect(() => {', hook.indexOf('const refreshSubordinates = useCallback')),
    );
    expect(refresh).toContain('const generation = ++subordinateRefreshGeneration.current;');
    expect(refresh.match(/generation !== subordinateRefreshGeneration\.current/g)).toHaveLength(1);
    expect(refresh).toContain('thrown !== null && generation === subordinateRefreshGeneration.current');
    expect(hook).toContain('msg.type === "subordinates_changed"');
    expect(hook).toContain('++subordinateRefreshGeneration.current;');
  });

  // The ingress sequence itself is core's, and its ordering is proven there by
  // observation (core/tests/unit-subordinates.test.ts — the spill lands before
  // the transaction opens). What is this backend's is the transaction it hands
  // over: on a DO the admit + roster write must share one storage transaction.
  test('the parent ingress runs core’s sequence inside the DO storage transaction', () => {
    const actor = source('actor-agent.ts');
    const ingress = actor.slice(
      actor.indexOf('async receiveSubordinateEvent('),
      actor.indexOf('override maxSteps'),
    );
    expect(ingress).toContain('return receiveSubordinateEvent({');
    expect(ingress).toContain('transaction: (body) => this.ctx.storage.transactionSync(body),');
  });

  // The policy itself is core's, and its behaviour is proven there
  // (core/tests/unit-subordinates.test.ts). What is backend-specific is that
  // BOTH hops actually consult it, and that neither hop can be reached around.
  test('every upward channel is tagged with the origin the relay policy reads', () => {
    const subordinate = source('subordinate-agent.ts');
    // The fourth parameter is what makes a replayed report recognisable: the
    // sequence that owes it, and the mode it ran in, both TRAVEL rather than
    // being re-derived at either end.
    expect(subordinate).toContain(
      'private async sendReport(\n    status: SubordinateReportStatus,\n'
      + '    content: string,\n    origin: SubordinateReportOrigin,');
    expect(subordinate).toContain(
      'owedBy?: { readonly sequenceId: string; readonly mode: WorkMode },');
    // The three senders, and what each of them is: a deliberate choice, and two
    // automatic relays.
    expect(subordinate).toContain("await this.sendReport(input.status, input.content, 'report_tool')");
    // The turn-end relay is a CLAIMED terminal effect, so its send sits in that
    // effect's body and is awaited: the disposition is what the send reports. The
    // STATUS is recorded too — a task child's terminal answer and a durable
    // child's progress note are different words, and a cold replay must not
    // re-derive which one this turn owed.
    expect(subordinate).toContain(
      "await this.sendReport(\n            status, text, 'turn_end', { sequenceId, mode },\n          )");
    expect(subordinate).toContain("void this.sendReport('progress', `${subject}\\n\\n${body}`, 'turn_end')");
    // …and those are ALL of them: one declaration plus exactly three call sites,
    // so no upward channel can skip the origin. The temporary rung's two extra
    // sends are gone — a task child's terminal answer is the SAME claimed
    // `parent_report` effect a hire's progress note goes through, which is what
    // stopped one failing turn reaching the parent down two paths at once.
    expect(subordinate.match(/sendReport\(/g)).toHaveLength(4);
  });

  test('the subordinate withholds an owner-driven turn, and the parent drops what it is not waiting on', () => {
    const subordinate = source('subordinate-agent.ts');

    expect(subordinate).toContain(
      'const ownerDriven = !programmaticUserMessage && !this.lastUserTurnIsProgrammatic();');
    // Split across the claim: WHICH report is owed is decided when the sequence
    // is declared, and the send is the effect that owes it.
    //
    // A task child reports FIRST and on every ending, because an `agents.ask` is
    // blocked on it; a hire falls through to the SAME selective policy it always
    // had, which is what keeps durable behaviour exactly as it was. Both are
    // suppressed by a report that already settled the run.
    expect(subordinate).toContain(
      'const taskReport = this.settledRunThisTurn ? null : this.taskTerminalReport(ending, assistantText);');
    expect(subordinate).toContain('const parentReport = taskReport ?? (\n'
      + '      completed && subordinateRelaysTurnEnd({\n'
      + '        reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText,\n'
      + '      })');
    // A root has NO parentReport part — `undefined`, never a body that succeeds
    // over a parent nobody has. The spelling moved off the conditional spread
    // when anti-slop banned it; the invariant is the absent part itself.
    expect(subordinate).toContain('const parentReportPart = parentReport === null ? undefined : {');
    expect(subordinate).toContain('      parentReport: parentReportPart,');
    expect(subordinate).toContain('if (!this.lastUserTurnIsProgrammatic()) {');
    expect(subordinate).toContain('submitPlan: { submit: (edits) => this.submitPlanEdits(edits) }');
    expect(subordinate).toContain('return report ? [createReportCodemodeProvider(() => report)] : [];');

    // The parent half — the drop, and that it happens before any file is
    // written — is core's (core/tests/unit-subordinates.test.ts).
    expect(source('actor-agent.ts')).toContain('origin: SubordinateReportOrigin;');
  });

  test('the live roster stays a push channel; only the report rail is gated', () => {
    const actor = source('actor-agent.ts');
    // subordinates_changed is the webUI's roster feed and is emitted from the
    // team policy on every spawn/assign/message/dismiss, independently of
    // whether any report was admitted.
    expect(actor).toContain('broadcast: (event) => this.broadcastSubordinatesChanged(event),');
    const changed = actor.slice(
      actor.indexOf('protected broadcastSubordinatesChanged('),
      actor.indexOf('protected broadcastSubordinateEvent('),
    );
    expect(changed).not.toContain('parentAdmitsSubordinateReport');
  });
});
