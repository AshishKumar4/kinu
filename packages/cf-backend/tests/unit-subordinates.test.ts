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
    expect(orchestrator).toContain('inheritedContext: () => orchestrator.readInheritedContext()');
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
    expect(orchestrator).toContain('const capabilityToken = await orchestrator.workspaceCapabilityToken();');
    expect(orchestrator).toContain('await stub.installWorkspaceCapability(token);');
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
    // advertised surface too, not just from the ToolSet.
    expect(source('actor-agent.ts'))
      .toContain("const DEPS_GATED_TOOLS = ['report', 'release'] as const;");
  });

  test('browser subordinate callables reuse the team policy and are not exposed by the facet', () => {
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    expect(orchestrator).toContain('return this.getTeamToolDeps().list();');
    expect(orchestrator).toContain("return this.getTeamToolDeps().spawn({ role, mission, createdBy: 'user' });");
    expect(orchestrator).toContain('return this.getTeamToolDeps().dismiss({ name });');
    expect(subordinate).not.toContain('spawnSubordinate(');
    expect(subordinate).not.toContain('dismissSubordinate(');
    expect(subordinate).not.toContain('listSubordinates(');
  });

  test('the parent ingress spills before opening its storage transaction', () => {
    const orchestrator = source('orchestrator.ts');
    const ingress = orchestrator.slice(
      orchestrator.indexOf('async receiveSubordinateEvent('),
      orchestrator.indexOf('// ── Mission Inbox'),
    );
    expect(ingress.indexOf('await spillEventContent(this.rt.storage.vfs, content)'))
      .toBeLessThan(ingress.indexOf('transactionSync'));
    expect(ingress).toContain('const content = normalizeReportContent(input.content);');
    expect(ingress).toContain('...(contentPath ? { contentPath } : {}),');
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
    const orchestrator = source('orchestrator.ts');

    expect(subordinate).toContain(
      'const ownerDriven = !programmaticUserMessage && !this.lastUserTurnIsProgrammatic();');
    expect(subordinate).toContain(
      'if (subordinateRelaysTurnEnd({ reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText }))');

    const ingress = orchestrator.slice(
      orchestrator.indexOf('async receiveSubordinateEvent('),
      orchestrator.indexOf('// ── Mission Inbox'),
    );
    expect(ingress).toContain(
      'if (!parentAdmitsSubordinateReport({ origin: input.origin, entry: subordinate }))');
    // Dropped before the spill: a relay the parent is not the audience for
    // leaves no file on its plane either.
    expect(ingress.indexOf('parentAdmitsSubordinateReport'))
      .toBeLessThan(ingress.indexOf('await spillEventContent'));
  });

  test('the live roster stays a push channel; only the report rail is gated', () => {
    const orchestrator = source('orchestrator.ts');
    // subordinates_changed is the webUI's roster feed and is emitted from the
    // team policy on every spawn/assign/message/dismiss, independently of
    // whether any report was admitted.
    expect(orchestrator).toContain('broadcast: (event) => orchestrator.broadcastSubordinatesChanged(event),');
    const changed = orchestrator.slice(
      orchestrator.indexOf('private broadcastSubordinatesChanged('),
      orchestrator.indexOf('private broadcastSubordinateEvent('),
    );
    expect(changed).not.toContain('parentAdmitsSubordinateReport');
  });
});
