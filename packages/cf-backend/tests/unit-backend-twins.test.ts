/**
 * Twin methods: a name on both a cf actor class and the CLI session class with no shared
 * implementation is a drift site (emitHeadPhase once fanned out to two places on the CLI).
 * KNOWN_TWINS is the measured baseline; SHARED_TRANSPORTS names the core symbol each transport
 * reaches (`'symbol'` a free call, `'.symbol'` a method on a shared object, never `this.`), and the
 * gate verifies it. A new twin or a vanished recorded one is red: the inventory only shrinks by hoists.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import {
  agentDynamicContext, headMergeLLM, MergeOutputSchema, mintSubordinateName,
  renderDynamicContextBlock,
} from '@kinu.run/core';
import {
  MERGE_POLICY_BINDING, MERGE_POLICY_SPEND_SOURCE, mergePolicyProfile,
} from '@kinu.run/test-utils';
import { declaredClassMembers } from './helpers/declared-members';

const REPO = resolve(import.meta.dir, '../../..');

/** The twin inventory, each entry with its reason for staying per backend. Shrink by hoisting. */
const KNOWN_TWINS: readonly string[] = [
  // KINU-021's sanctioned adapter surface: core owns the terminal machinery
  // (orchestrator/terminal-{effects,transition,roster}.ts); backends supply the effect bodies...
  'terminalEffectTable',
  // ...and the wake: DO schedule rows its alarm fires vs a CLI `setTimeout(...).unref()`.
  'scheduleTerminalRetry',
  // cf overrides `Agent.broadcast` over connection tags; the CLI emits to its one listener.
  'broadcast',
  // The seam itself: each backend packs its scaffold inference surface; the ports are shared.
  'scaffoldControl',
  // The seam itself: ports from what each backend owns; policy is core's (evolution/refinement-lane.ts).
  'refinementDeps',
  // Where the name is read differs (UserDO registry vs local config); what it means is core's
  // (`PromptIdentity`, prompt.ts renderAgentNames).
  'promptIdentity',
  // `ChatSessionPorts.prepareTurn`: each answers from what it alone owns; the shape is core's.
  'prepareTurn',
];

/** Same name, one core implementation: each entry names the core symbol both bodies must reach. */
const SHARED_TRANSPORTS = {
  terminal: 'TerminalTransitions',
  // The carrier is the platform's (`runFiber` vs a tracked fiber); the close rule is core's.
  holdTerminalClose: '.closeFailed',
  owedTerminalEffects: 'declareTerminalRoster',
  readInheritedContext: 'inheritedContextFromTranscript',
  applyAutoTitle: 'applyWorkspaceTitle',
  applyScaffoldDecision: 'applyScaffoldDecision',
  checkpointStatus: 'checkpointAvailability',
  listFileCheckpoints: 'fileCheckpointListing',
  planFileRestore: '.plan',
  restoreFileCheckpoint: '.restore',
  cancelBackgroundJob: 'cancelBackgroundJob',
  cancelTrigger: 'cancelTrigger',
  decideDeferredApprovals: '.decide',
  createTimerTrigger: 'createTimerTrigger',
  // Refinement lane is core's evolution/refinement*; per backend only its deps struct remains.
  decideRefinement: 'decideRefinementRoute',
  // Each side passes only its memory tail and unreachable-MCP roster.
  dynamicContextSnapshot: 'collectDynamicContext',
  // When an auxiliary lane inherits the turn profile is policy; only fresh resolution is per backend.
  routingProfile: 'resolveRoutingProfile',
  revertConversation: '.revertTo',
  // One spelling: every model_call row is priced and grouped by it.
  effectiveModelSpec: 'resolveEffectiveModelSpec',
  getAlwaysActiveSkills: 'getAlwaysActiveSkills',
  getEvolutionChangelog: 'getEvolutionChangelog',
  getReasoningEffort: 'getReasoningEffort',
  getRunEvents: 'getRunEvents',
  getShadowStatus: 'getShadowStatus',
  getShellApprovalGrants: 'getShellApprovalGrants',
  getShellApprovalMode: 'getShellApprovalMode',
  // KINU-N028: one core InstructionApprovalDesk; each backend names only where AGENTS.md is found.
  approveInstruction: '.approve',
  revokeInstruction: '.revoke',
  listInstructionApprovals: '.list',
  readInstructionApproval: '.read',
  getStoredModelSpec: 'getStoredModelSpec',
  jobResult: 'jobResult',
  latestAlternateTakes: 'latestAlternateTakeSet',
  listBackgroundJobs: 'listBackgroundJobs',
  listDeferredApprovals: '.list',
  listRuns: 'listRuns',
  logActivity: 'writeActivityLog',
  listRefinements: 'listRefinements',

  makeScaffoldHistory: 'createScaffoldHistory',

  markChangelogSeen: 'markChangelogSeen',
  planActions: 'PlanReviewActions',
  submitPlanEdits: '.submit',
  getActivePlanReview: '.active',
  savePlanReviewAnnotations: '.saveAnnotations',
  decidePlanReview: '.decideAndHandOff',
  turnWorkMode: 'workModeUnderReview',
  pickAlternateTake: 'pickAlternateTake',
  requestRefinement: 'requestOwnerRefinement',
  recordSystemPromptHash: 'observeSystemPromptHash',
  resumeBackgroundJob: 'resumeBackgroundJob',
  revertChangelogEntry: 'revertChangelogEntryById',
  revokeShellApprovalGrants: 'revokeShellApprovalGrants',
  // Each backend states the client, the governor, and whether a completion gate exists (cf: `false`).
  runAdvisorReview: 'reviewRecordedTurn',
  suggestTitle: 'suggestWorkspaceTitle',
  showRefinement: 'showRefinementRoute',
  runScaffoldGepaOptimization: 'runScaffoldGepaOptimization',
  // Mid-turn splicing is core's `Inbox.send`; per backend only how an idle backend starts the turn.
  send: '.send',
  setAlwaysActiveSkills: 'setAlwaysActiveSkills',
  setModel: 'setModel',
  setRole: 'changeRoleAsOwner',
  setReasoningEffort: 'setReasoningEffort',
  setShellApprovalMode: 'setShellApprovalMode',
  wrapToolsForBackground: 'wrapToolsForBackground',
} satisfies Readonly<Record<string, string>>;

const CF_CLASSES = [
  ['packages/cf-backend/src/actor-agent.ts', 'ActorAgent'],
  ['packages/cf-backend/src/orchestrator.ts', 'OrchestratorAgent'],
] as const;

const CLI_CLASS = ['packages/cli-backend/src/local-session.ts', 'LocalAgentSession'] as const;


interface TwinScan {
  cf: Set<string>;
  cli: Set<string>;
  twins: string[];
  cfBodies: string[];
  cliBody: string;
}

function scanTwins(): TwinScan {
  const cf = new Set<string>();
  const cfBodies: string[] = [];

  for (const [file, cls] of CF_CLASSES) {
    const source = readFileSync(resolve(REPO, file), 'utf8');
    expect({ file, cls, found: source.includes(`class ${cls}`) })
      .toEqual({ file, cls, found: true });
    cfBodies.push(source);

    for (const member of declaredClassMembers(source)) cf.add(member.name);
  }

  const cliBody = readFileSync(resolve(REPO, CLI_CLASS[0]), 'utf8');
  expect(cliBody).toContain(`class ${CLI_CLASS[1]}`);
  const cli = new Set(declaredClassMembers(cliBody).map((member) => member.name));

  return { cf, cli, twins: [...cf].filter((name) => cli.has(name)).sort(), cfBodies, cliBody };
}

/** A member declaration sits at exactly two spaces of indentation; calls are deeper. */
const DECLARATION_HEAD =
  /^ {2}(?:@[A-Za-z_][A-Za-z0-9_]*\((?:[^()]|\([^()]*\))*\)\s+)?(?:(?:private|protected|public|readonly|override|static|async|get|set)\s+)*$/;

/** A call matching `pattern` other than the method's own declaration header, which would self-prove. */
function containsCall(body: string, pattern: RegExp): boolean {
  for (const m of body.matchAll(pattern)) {
    const lineStart = body.lastIndexOf('\n', m.index) + 1;

    if (!DECLARATION_HEAD.test(body.slice(lineStart, m.index))) return true;
  }

  return false;
}

/** A free `symbol(` call, or for `.symbol` a method call on an object other than `this`. */
function delegatesTo(body: string, declared: string): boolean {
  if (declared.startsWith('.')) {
    const symbol = declared.slice(1);

    return containsCall(body, new RegExp(String.raw`(?<!\bthis)\.${symbol}\s*(?:<[^>\n]*>)?\(`, 'g'));
  }

  return containsCall(body, new RegExp(String.raw`(?<![.\w])${declared}\s*(?:<[^>\n]*>)?\(`, 'g'));
}

describe('backend twin methods', () => {
  const { cf, cli, twins, cfBodies, cliBody } = scanTwins();
  const recorded = new Set([...KNOWN_TWINS, ...Object.keys(SHARED_TRANSPORTS)]);

  test('the extractor sees real class surfaces (guards the guard)', () => {
    // Floors so a broken extractor cannot pass "no new twins" vacuously.
    expect(cf.size).toBeGreaterThanOrEqual(80);
    expect(cli.size).toBeGreaterThanOrEqual(60);
    expect(twins.length).toBeGreaterThanOrEqual(40);
  });

  test('no NEW twin: logic added to both backends belongs in core', () => {
    expect(twins.filter((n) => !recorded.has(n))).toEqual([]);
  });

  test('no STALE entry: a hoisted twin leaves the inventory', () => {
    const seen = new Set(twins);
    expect([...recorded].filter((n) => !seen.has(n)).sort()).toEqual([]);
  });

  test('a name is recorded once: a transport is not also a twin', () => {
    expect(KNOWN_TWINS.filter((n) => n in SHARED_TRANSPORTS)).toEqual([]);
  });

  test('the delegation check cannot be satisfied by a method calling itself', () => {
    // Guards the guard: self-calls prove nothing, and the method form makes that easy.
    expect(delegatesTo('  armCompactNow(): void {\n    this.armForceCompaction();\n  }', '.armForceCompaction'))
      .toBe(false);
    expect(delegatesTo('  armCompactNow(): void {\n    this.state.armForceCompaction(k);\n  }', '.armForceCompaction'))
      .toBe(true);
    // A declaration header is not a call, in either form.
    expect(delegatesTo('  setModel(spec: string) {\n    return 1;\n  }', 'setModel')).toBe(false);
    expect(delegatesTo('  setModel(spec: string) {\n    return setModel(this.config, spec);\n  }', 'setModel'))
      .toBe(true);
    // A method form never accepts a bare free-function call, and vice versa.
    expect(delegatesTo('    return acceptedMedia();', '.acceptedMedia')).toBe(false);
    expect(delegatesTo('    return this.catalog.acceptedMedia();', 'acceptedMedia')).toBe(false);
  });

  test('every declared transport really delegates to its core symbol', () => {
    // Coarse by design: searches the whole class body, not the member (regex member extraction
    // was defeated by several signature shapes).
    const unproven = Object.entries(SHARED_TRANSPORTS)
      .filter(([, symbol]) =>
        !delegatesTo(cliBody, symbol) || !cfBodies.some((b) => delegatesTo(b, symbol)))
      .map(([name]) => name);

    expect(unproven).toEqual([]);
  });
});

/**
 * Logic wired into only one backend: the DO reached the job-registry resume only via a surviving
 * `bg:*` fiber, so interrupted searches were retired as `aborted` while the CLI resumed them.
 */
describe('interrupted work is reconciled at start of life on BOTH backends', () => {
  const { cfBodies, cliBody } = scanTwins();

  // Without a resume gate the reconciler retires every interrupted run.
  const reached = [
    {
      name: 'each composition surface settles the fork journal through the one core reconciler',
      callee: 'reconcileInterruptedForks',
    },
    {
      name: 'each surface hands that reconciler a RESUME GATE, so neither retires what can resume',
      callee: 'jobRedriveResumeGate',
    },
  ];

  for (const { name, callee } of reached) {
    test(name, () => {
      expect(delegatesTo(cliBody, callee)).toBe(true);
      expect(cfBodies.some((body) => delegatesTo(body, callee))).toBe(true);
    });
  }

  test('neither surface sweeps the job registry outside that gate', () => {
    // The reconciler orders mark, gate, retire; a sweep beside the gate would re-drive jobs before the
    // marking. `onFiberRecovered` is a different entry point, hence the recovery method only.
    const cliRecovery = methodBody(cliBody, 'recoverBackgroundJobs');
    expect(cliRecovery).not.toBe('');
    // The sweep must be a thunk the reconciler calls, not awaited at the call site.
    expect(cliRecovery).toContain('jobRedriveResumeGate({');
    expect(cliRecovery).not.toContain('await this.jobRunner.recoverOrphans()');
  });
});

/** One method's body by brace depth; empty when absent. */
function methodBody(body: string, name: string): string {
  const start = body.indexOf(`async ${name}(`);

  if (start < 0) return '';
  const open = body.indexOf('{', start);

  if (open < 0) return '';
  let depth = 0;

  for (let i = open; i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') {
      depth -= 1;

      if (depth === 0) return body.slice(open, i + 1);
    }
  }

  return body.slice(open);
}

/**
 * The twin differential: halves that both delegate to core can still disagree (the local
 * `headMergeLLM` passed the chat model at `'low'` and filed it as `judge`). Each seam's suites on
 * both backends must pin one shared fixture, which is executed here. The CLI session is not built
 * in-process; `gate:capability-parity` covers the residual.
 */

/** One core seam both backends implement, and how a divergence is observable. */
interface DifferentialSeam {
  readonly seam: string;
  readonly coreSymbol: string;
  readonly fixture: readonly string[];
  /** At least one cf-backend and one cli-backend/cli suite, plus any third implementing surface. */
  readonly suites: readonly string[];
}

const DIFFERENTIAL_SEAMS: readonly DifferentialSeam[] = [
  {
    // Model, effort and spend label are one core decision.
    seam: 'head-merge policy',
    coreSymbol: 'headMergeLLM',
    fixture: ['mergePolicyProfile', 'MERGE_POLICY_BINDING'],
    suites: [
      'packages/cf-backend/tests/unit-head-runtime-operations.test.ts',
      'packages/cli-backend/tests/head-runtime.test.ts',
    ],
  },
  {
    seam: 'workspace planes',
    coreSymbol: 'collectDynamicContext',
    // No CLI-side plane suite exists, so the pin is that both surfaces name the core assembler.
    fixture: ['collectDynamicContext'],
    suites: [
      'packages/cf-backend/src/actor-agent.ts',
      'packages/cli-backend/src/local-session.ts',
    ],
  },
  {
    seam: 'name minting',
    coreSymbol: 'mintSubordinateName',
    fixture: ['mintSubordinateName'],
    suites: [
      'packages/cf-backend/src/actor-agent.ts',
      'packages/cli-backend/src/agent-host/host.ts',
    ],
  },
  {
    // Takes, branches, turn record, event drain, shadow trial: each drifted as two near-copies.
    seam: 'terminal effect bodies',
    coreSymbol: 'takesTerminalEffect',
    fixture: [
      'takesTerminalEffect', 'branchesTerminalEffect', 'turnRecordTerminalEffect',
      'eventDrainTerminalEffect', 'shadowTrialTerminalEffect',
    ],
    suites: [
      'packages/cf-backend/src/orchestrator.ts',
      'packages/cli-backend/src/local-session.ts',
    ],
  },
  {
    // cf walked directory rows while the CLI read a birth-time config number; one walk now.
    seam: 'delegation depth',
    coreSymbol: 'delegationBudgetOf',
    fixture: ['delegationBudgetOf'],
    suites: [
      'packages/cf-backend/src/subordinate-hosting.ts',
      'packages/cli-backend/src/agent-host/host.ts',
    ],
  },
  {
    // cf refused replacement over any non-`auto` origin, the CLI only over `user`; one predicate now.
    seam: 'auto-title replacement',
    coreSymbol: 'AutoTitle',
    fixture: ['autoTitleMayReplace', 'persistAutoTitle'],
    suites: [
      'packages/cf-backend/src/user/user-do.ts',
      'packages/cli-backend/src/local-session.ts',
      'packages/cli/src/local-agent-client.ts',
    ],
  },
] as const;

describe('the twin differential — one seam, one fixture, both backends', () => {
  const read = (file: string): string => readFileSync(resolve(REPO, file), 'utf8');

  test('every declared seam names a real core symbol, reached from BOTH backends', () => {
    // The denominator: a seam no backend reaches is stale.
    expect(DIFFERENTIAL_SEAMS.length).toBeGreaterThan(0);
    const unreached: string[] = [];

    for (const entry of DIFFERENTIAL_SEAMS) {
      const cf = [
        ...CF_CLASSES.map(([file]) => read(file)), read('packages/cf-backend/src/head-runtime.ts'),
        ...entry.suites.filter((file) => file.startsWith('packages/cf-backend/src/')).map(read),
      ];

      const cli = [
        read(CLI_CLASS[0]), read('packages/cli-backend/src/head-runtime.ts'),
        read('packages/cli-backend/src/agent-host/host.ts'),
        ...entry.suites.filter((file) => file.startsWith('packages/cli')).map(read),
      ];

      if (!cf.some((body) => body.includes(entry.coreSymbol))) {
        unreached.push(`${entry.seam} — no cf surface names \`${entry.coreSymbol}\``);
      }

      if (!cli.some((body) => body.includes(entry.coreSymbol))) {
        unreached.push(`${entry.seam} — no CLI surface names \`${entry.coreSymbol}\``);
      }
    }

    expect(unreached).toEqual([]);
  });

  test('both sides of every seam pin the SAME shared fixture, never a local literal', () => {
    // Two hand-kept expectations is how the merge policy drifted.
    const drifted: string[] = [];

    for (const entry of DIFFERENTIAL_SEAMS) {
      for (const suite of entry.suites) {
        const body = read(suite);
        const pinned = entry.fixture.filter((name) => body.includes(name));

        if (pinned.length === 0) {
          drifted.push(
            `${entry.seam} — ${suite} pins none of [${entry.fixture.join(', ')}], so its `
            + 'expectation is its own and can drift from the other backend\'s silently',
          );
        }
      }
    }

    expect(drifted).toEqual([]);
  });

  test('every shared effect body is constructed through its core factory on BOTH backends', () => {
    // Stricter than the fixture check: each of the five factories is its own drift site.
    const seam = DIFFERENTIAL_SEAMS.find((entry) => entry.seam === 'terminal effect bodies');

    if (!seam) throw new Error('the terminal effect bodies seam is not declared');
    const cf = [read('packages/cf-backend/src/actor-agent.ts'), read('packages/cf-backend/src/orchestrator.ts')].join('\n');
    const cli = read(CLI_CLASS[0]);

    const missing = seam.fixture.flatMap((factory) => [
      ...(delegatesTo(cf, factory) ? [] : [`cf does not construct ${factory}`]),
      ...(delegatesTo(cli, factory) ? [] : [`cli does not construct ${factory}`]),
    ]);

    expect(missing).toEqual([]);
  });

  test('the shared merge fixture still resolves to the policy core produces', async () => {
    // Executed, so the shared fixture cannot rot away from what core produces.
    const profile = mergePolicyProfile();
    const asked: { spec: string | null | undefined; effort: string }[] = [];
    const reports: { source: string }[] = [];

    const merge = headMergeLLM({
      profile: async () => profile,
      bindMergeModel: (route) => {
        asked.push({ spec: route.model, effort: route.reasoningEffort });

        return { model: mergeFixtureModel() };
      },
      reportModelCall: (report) => reports.push({ source: report.source }),
    });

    const output = await merge('merging two heads', MergeOutputSchema);

    expect(asked).toEqual([MERGE_POLICY_BINDING]);
    expect(reports.map((report) => report.source)).toEqual([MERGE_POLICY_SPEND_SOURCE]);
    expect(output.narrative).toContain('one narrative');
  });

  test('the shared plane assembler answers every plane a backend hands it', () => {
    // A plane the assembler drops is invisible to both backends' suites.
    const block = renderDynamicContextBlock(agentDynamicContext({
      factsBlock: 'FACTS: the parser is sound',
      memoryTail: 'MEMORY: the reader survives a reopen',
      recoveryFindings: [],
      executors: [],
      runningJobs: { items: [{ id: 'bgjob-1', kind: 'agents', label: 'search: prior art' }], total: 1 },
      openTasks: {
        items: [{ id: 'task-1', title: 'finish the differential', status: 'open', subtasks: [] }],
        total: 1,
      },
      liveHeadRuns: { items: [{ rootId: 'root-1', rationale: 'four angles', running: 2, total: 4 }], total: 1 },
      subordinateDelegates: [{ kind: 'subordinate', name: 'aria', phase: 'active', task: 'read the spec' }],
      approvals: { items: [], total: 0 },
      missingCapabilities: [],
    }));

    expect(block).not.toBeNull();

    for (const plane of ['the parser is sound', 'survives a reopen', 'prior art', 'four angles', 'aria']) {
      expect(String(block)).toContain(plane);
    }
  });

  test('the shared minter answers one name shape for every role either backend hires', () => {
    const roles = ['researcher', 'Data Analyst', '', 'ünïcodé', 'a'.repeat(120), 'with/slash'];
    const minted = roles.map((role) => mintSubordinateName(role));

    for (const name of minted) {
      expect(name).toMatch(/^[a-z0-9-]+-[A-Za-z0-9_-]{6}$/);
    }

    // Distinct per call, which is what makes a roster row addressable.
    expect(new Set(minted.map((name) => name)).size).toBe(minted.length);
    expect(mintSubordinateName('')).toStartWith('subordinate-');
  });
});

/** Valid `MergeOutputSchema` JSON, so the route and spend are measured, not a parse. */
function mergeFixtureModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{
        type: 'text' as const,
        text: '{"narrative":"Both heads agree: one narrative.","selected_decisions":[],'
          + '"unresolved_questions":[],"recommendations":["ship it"]}',
      }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}
