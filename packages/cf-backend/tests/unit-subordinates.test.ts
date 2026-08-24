// How the Cloudflare backend WIRES core's subordinate module. The module's own
// behaviour is covered in core (core/tests/unit-subordinates.test.ts); what is
// backend-specific is which names this backend's source exposes where, so these
// read that source directly.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8');

describe('subordinate wiring', () => {
  test('all user-level gates present the parent workspace name, never the facet name', () => {
    const actor = source('actor-agent.ts');
    const runtime = source('runtime.ts');
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    // MCP now identifies its caller by the workspace capability token rather
    // than by a name argument, so a facet dispatches as its parent workspace
    // and there is no name left to spoof.
    expect(actor).toContain('userDOStub.userMcp_callTool(caller, serverId, mcpName, args)');
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

  test('a subordinate holds the parent workspace capability token, pushed never pulled', () => {
    const actor = source('actor-agent.ts');
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');

    // One store, inherited by both actor classes: a facet's token IS the
    // parent's, so §B6 taint inheritance needs no per-facet bookkeeping.
    expect(actor).toContain('protected async workspaceCapabilityToken(): Promise<string | null>');
    expect(actor).toContain('async installWorkspaceCapability(token: string)');

    // Push, both at spawn and whenever the parent's token is (re)issued.
    expect(actor).toContain('const capabilityToken = await this.workspaceCapabilityToken();');
    expect(actor).toContain('await stub.installWorkspaceCapability(token);');
    expect(subordinate).toContain('if (input.capabilityToken) await this.installWorkspaceCapability(input.capabilityToken);');

    // Never pull: the bootstrap RPC any stub-holder can reach must not carry a
    // secret, and nothing reads the token back out of a workspace DO.
    const bootstrap = orchestrator.slice(
      orchestrator.indexOf('async getSubordinateBootstrapIdentity()'),
      orchestrator.indexOf('async receiveSubordinateEvent('),
    );
    expect(bootstrap).not.toContain('capabilityToken');
    expect(actor).not.toMatch(/@callable\(\)\s*\n\s*async (installWorkspaceCapability|workspaceCapabilityToken)/);
    for (const file of ['actor-agent.ts', 'orchestrator.ts', 'subordinate-agent.ts']) {
      expect(source(file)).not.toMatch(/async get\w*CapabilityToken\w*\(\)/);
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
    expect(source('orchestrator.ts')).toContain('async experienceAction(input: ExperienceActionInput)');
    expect(source('actor-agent.ts')).not.toContain('experience');
    // …and absence is structural: a deps-gated name is dropped from the
    // advertised surface too, not just from the ToolSet. `release` is not a
    // native tool at all anymore (release.* is codemode-only), so it no
    // longer needs a gate here.
    expect(source('actor-agent.ts'))
      .toContain("const DEPS_GATED_TOOLS = ['report'] as const;");
  });

  test('browser subordinate callables reuse the team policy and are not exposed by the facet', () => {
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    expect(orchestrator).toContain('return this.getTeamToolDeps().list();');
    expect(orchestrator).toContain('return this.getTeamToolDeps().create({});');
    expect(orchestrator).toContain('return this.getTeamToolDeps().rename({ name, displayName });');
    expect(orchestrator).toContain("return this.getTeamToolDeps().dismiss({ name, requestedBy: 'user' });");
    expect(subordinate).not.toContain('spawnSubordinate(');
    expect(subordinate).not.toContain('dismissSubordinate(');
    expect(subordinate).not.toContain('listSubordinates(');
  });

  test('manual creation is one click, identity-only, and opens the conversation directly', () => {
    const tabs = source('components/SubordinateTabs.tsx');
    const page = source('pages/WorkspacePage.tsx');
    // No form stands between the click and the agent. WorkspacePage owns the
    // identity-only action because it stays mounted on both Run and Supervise.
    expect(tabs).not.toContain('SpawnSubordinateDialog');
    expect(tabs).toContain('onCreate(): Promise<void>');
    expect(page).toContain('window.addEventListener("kinu:new-agent", open)');
    expect(page).toContain('navigate(`/workspace/${agentId}/agents/${created.name}`)');
    expect(tabs).toContain('if (dismissTarget.name === activeName) navigate(mainPath);');
    expect(source('components/Sidebar.tsx')).toContain('new CustomEvent("kinu:new-agent")');
    // A blank name renders as the provisional title everywhere, never as ''.
    expect(tabs).toContain('NEW_AGENT_TITLE = "New agent"');
    expect(tabs).not.toContain('sends the mission as its first turn');
    expect(tabs).not.toContain('permanently deletes its conversation');
  });

  test('the additional-agent conversation hides its inherited mission and identity internals', () => {
    const page = source('pages/WorkspacePage.tsx');
    const column = page.slice(
      page.indexOf('function SubordinateChatColumn'),
      page.indexOf('/* ── Main page'),
    );
    // An ordinary conversation: no purpose line under the name, no SOUL text
    // in the empty state — the mission a one-click agent inherits is the
    // machinery's business, and the empty state says only where things start.
    expect(column).not.toContain('as?.purpose');
    expect(column).not.toContain('as?.soul');
    // The same composer contract as the main column: this agent's own mode…
    expect(column).toContain('mode={{ value: effectiveMode, onChange: ui.setMode, locked: planAwaitingDecision }}');
    // …and the same rename affordance the workspace bar carries.
    expect(column).toContain('<InlineRenameTitle title={title} onRename={onRename} subject="agent"');
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
    expect(refresh.match(/generation !== subordinateRefreshGeneration\.current/g)).toHaveLength(2);
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
    expect(subordinate).toContain(
      'private async sendReport(\n    status: SubordinateReportStatus,\n'
      + '    content: string,\n    origin: SubordinateReportOrigin,\n  )');
    // The three senders, and what each of them is: a deliberate choice, and two
    // automatic relays.
    expect(subordinate).toContain("await this.sendReport(input.status, input.content, 'report_tool')");
    expect(subordinate).toContain("void this.sendReport('progress', assistantText, 'turn_end')");
    expect(subordinate).toContain("void this.sendReport('progress', `${subject}\\n\\n${body}`, 'turn_end')");
    // …and those three are all of them: one declaration plus exactly the three
    // call sites above, so no upward channel can skip the origin.
    expect(subordinate.match(/sendReport\(/g)).toHaveLength(4);
  });

  test('the subordinate withholds an owner-driven turn, and the parent drops what it is not waiting on', () => {
    const subordinate = source('subordinate-agent.ts');

    expect(subordinate).toContain(
      'const ownerDriven = !programmaticUserMessage && !this.lastUserTurnIsProgrammatic();');
    expect(subordinate).toContain(
      'if (subordinateRelaysTurnEnd({ reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText }))');
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
