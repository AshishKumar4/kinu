/**
 * Twin methods — the drift inventory of logic implemented once per backend.
 *
 * A method name that exists on BOTH a cf actor class and the CLI session class
 * with no shared implementation is a drift site: the two bodies start
 * identical — createTimerTrigger and markChangelogSeen were line-for-line
 * copies until they were hoisted — and diverge silently, because nothing ever
 * asserts they agree. Several of the "X never
 * worked on Y backend" defects were exactly a twin whose halves drifted — and
 * the halves need not even disagree loudly: emitHeadPhase fanned the same
 * split out to one place on cf and two on the CLI, where the second reached
 * no reader and duplicated the first in `kinu exec --json`.
 *
 * A shared NAME does not always mean unshared logic, though: once a driver is
 * hoisted, both backends keep the method as a transport over the one core
 * implementation. Those are recorded separately, in SHARED_TRANSPORTS, each
 * naming the core symbol it delegates to — and the gate CHECKS that claim
 * against both bodies, so an entry cannot be moved out of the twin count
 * without the delegation actually existing.
 *
 * Two delegation FORMS are checkable, and an entry declares which one it uses:
 *
 *   'symbol'   a free-function call — a hoisted driver, which is what most
 *              hoists produce.
 *   '.symbol'  a method call on a shared core OBJECT (a store, a session).
 *              Some transports are three lines over one core object rather
 *              than over a free function, and the gate used to be blind to
 *              them, so they sat in KNOWN_TWINS with a comment explaining they
 *              were not really twins. Declaring the form makes the claim
 *              machine-checked instead. `this.symbol(` never counts: a method
 *              must not prove itself by calling itself.
 *
 * This gate does not forbid the twins that exist — they are recorded below as
 * the measured baseline. It forbids the inventory from drifting in either
 * direction:
 *
 *   a NEW twin appears      → red. Hoist the logic to core instead, or record
 *                             it — as a twin, or as a transport that names its
 *                             core symbol. Either way, a visible decision.
 *   a recorded twin is gone → red. It was hoisted or renamed — delete its
 *                             entry, so the inventory only ever shrinks by
 *                             real hoists and the list stays the honest
 *                             measure of remaining duplication.
 *
 * Every future hoist's success criterion is an entry leaving KNOWN_TWINS.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { declaredClassMembers } from './helpers/declared-members';

const REPO = resolve(import.meta.dir, '../../..');

/**
 * The measured twin inventory at seeding time. Shrink by hoisting.
 *
 * Every entry below was re-verified against BOTH class bodies, one at a time,
 * and every one of them holds: none is a pair of bodies that would move to core
 * unmodified. The reason is written next to each, because an inventory whose
 * entries carry no reason is a list of TODOs rather than a record of decisions.
 * Grouped by that reason rather than alphabetically — the file-checkpoint four
 * share one.
 */
const KNOWN_TWINS: readonly string[] = [
  // KINU-021's SANCTIONED adapter surface. Core owns the terminal-transition
  // vocabulary, declaration, state machine, schema, replay and disposition read
  // model (orchestrator/terminal-{effects,transition,roster}.ts); what a backend
  // supplies is exactly two things, and these are them.
  //
  // The effect BODIES: what "reply to this delivery" or "title this workspace"
  // means is the backend's, because the surfaces differ — a device tunnel and an
  // SMTP channel are not one implementation.
  'terminalEffectTable',
  // The WAKE: a Durable Object writes a schedule row the platform fires; a CLI
  // process has no alarm at all and its carrier is the next start. Neither can be
  // expressed in the other's terms, which is the whole reason the port exists.
  'scheduleTerminalRetry',
  // What keeps the runtime alive for a detached close: a durable fiber on the DO,
  // the process lifetime on the CLI. Core decides WHEN the transition may close;
  // this decides what is still running when it does.
  'holdTerminalClose',
  // The file-checkpoint quartet: two transports to two DIFFERENT stores — a
  // device tunnel to the user's machine on cf, a local git engine on the CLI —
  // not two implementations of one. Their shared vocabulary
  // (FileCheckpointEntry, FileRestorePlan, CheckpointAvailability) is already
  // core, which is why neither body carries logic; what does not move is cf's
  // owner check, its device-RPC method names and its not-connected mapping,
  // which is exactly the platform dependency. Not expected to shrink.
  'checkpointStatus',
  'listFileCheckpoints',
  'planFileRestore',
  'restoreFileCheckpoint',
  // Genuinely different resolutions: cf normalizes the stored spec through its
  // provider registry (an unset model resolving to "" was the 41%-of-Kimi
  // context-window bug); the CLI's resolver has already normalized by the time
  // the spec is cached. Same answer, two legitimate routes to it — the two
  // backends cache at different points of the same normalization pipeline.
  'effectiveModelSpec',
  // Both build core's default key-less provider, but from different platform
  // material: cf's owned model services (env + the owner's auth) vs node fetch
  // + the local auth store. Only the memoisation is common, and memoisation is
  // not a module.
  'getWebSearchProvider',
  // Both already read the one core EventLog.query; what differs after it is
  // cf's ten-field allowlist over the row, which drops the log's own plumbing
  // (schema_version, dedupe_key, reply_channel) before it leaves the
  // workspace. Both answer a bare list — the shape is NOT part of the
  // divergence, and was only ever divergent by accident: cf wrapped its rows in
  // `{ events: [...] }` and `kinu inspect events` silently stopped
  // formatting them. A core symbol here would be a passthrough, and `.query` is
  // too generic a name for the delegation check to prove anything with. Not
  // expected to shrink.
  'listRecentEvents',
  // One shaper, two sources — the divergence is real: cf digests its durable
  // assistant_messages rows (inheritedContextFromRows), the CLI reads live
  // history (inheritedContextFromHistory). Both are core; SHARED_TRANSPORTS
  // names a single symbol, so this cannot be recorded there honestly.
  'readInheritedContext',
  // The seam itself, not duplication: each backend describes the inference
  // surface a candidate scaffold runs on (its ToolSet, its history, its
  // default loop). Its four ports are already SHARED_TRANSPORTS entries; what
  // is left here is the struct that packs them. This entry is not expected to
  // shrink.
  'scaffoldControl',
  // Same shape as scaffoldControl: the seam itself. Each backend packs the
  // refinement lane's ports from what it alone owns — its SQL executor, its
  // temporary-agent port, its facts store, its skills VFS — and every port's
  // POLICY is already core's (evolution/refinement-lane.ts). This entry is not
  // expected to shrink.
  'refinementDeps',
];

/**
 * Same name on both backends, one implementation in core: the method is the
 * backend's transport for it. Each entry names the core symbol both bodies
 * must call, and a leading `.` says the call is a method on a shared core
 * object rather than a free function — asserted below either way, so this list
 * cannot launder a real twin.
 */
const SHARED_TRANSPORTS = {
  // Both construct core's one lifecycle object over their own storage, effect
  // table, clock and wake. The state machine inside it is shared by definition.
  terminal: 'TerminalTransitions',
  // Both gather their own readings — an accumulator's takes, a pending branch
  // list, a scaffold candidate — and hand them to core's ONE declaration, which
  // owns the order, the lanes, the keys and the gates.
  owedTerminalEffects: 'declareTerminalRoster',
  // Both resolve the same core naming policy over their own persistence.
  applyAutoTitle: 'applyWorkspaceTitle',
  acceptWebhookDelivery: 'acceptWebhookDelivery',
  applyScaffoldDecision: 'applyScaffoldDecision',
  // Three lines each over ONE core store (CompactionStateStore). No duplicated
  // logic — only the session key differs, which is what a backend knows and
  // core does not.
  armCompactNow: '.armForceCompaction',
  cancelBackgroundJob: 'cancelBackgroundJob',
  cancelTrigger: 'cancelTrigger',
  createDurableWebhook: 'registerDurableWebhook',
  createTimerTrigger: 'createTimerTrigger',
  // KINU continual refinement: the whole lane — stage machine, claim fencing,
  // owner routing, staged-skill promotion — is core's evolution/refinement*.
  // Each backend method is a transport over one core symbol; what stays per
  // backend is only its own deps struct (recorded in KNOWN_TWINS) and, on the
  // CLI, dropping model-bound state after a step lands.
  decideRefinement: 'decideRefinementRoute',
  // Both bodies were the SAME eight-field literal binding each live plane to the
  // store that answers it — `agentDynamicContext` owned which planes exist, but
  // which store fed each one was stated once per backend. state/dynamic-context.ts
  // now holds that binding, so each side passes only what it alone knows: its
  // turn's memory tail and its own unreachable-MCP roster.
  dynamicContextSnapshot: 'collectDynamicContext',
  getAlwaysActiveSkills: 'getAlwaysActiveSkills',
  getEvolutionChangelog: 'getEvolutionChangelog',
  getGepaRuns: 'listGepaRuns',
  getReasoningEffort: 'getReasoningEffort',
  getReplayEvals: 'listReplayEvals',
  getRunEvents: 'getRunEvents',
  getShadowStatus: 'getShadowStatus',
  // Both are one-line delegations to read-models/config-plane.ts, exactly like
  // the approval MODE beside them: the logic is in core, the twin is only the
  // RPC surface each backend has to expose in its own transport.
  getShellApprovalGrants: 'getShellApprovalGrants',
  getShellApprovalMode: 'getShellApprovalMode',
  // KINU-N028's instruction-trust surface. Every decision the owner makes and
  // every byte either side reads is core's: the store (safety/instruction-trust.ts)
  // holds the digest rule, and read-models/instruction-approvals.ts holds the
  // paging, the on-demand open and the preview sanitizer. What each backend
  // spells for itself is only the transport: a cf `@callable` against a stub, a
  // local method behind LocalSessionControls. Both approve/revoke admit the
  // owner's request through core's `admitInstructionDecision`, so the two sides
  // share one rule for what counts as a valid decision rather than sharing only
  // a name — which is the difference this gate is asking about.
  approveInstruction: 'admitInstructionDecision',
  revokeInstruction: 'admitInstructionDecision',
  listInstructionApprovals: 'listInstructionApprovals',
  readInstructionApproval: 'openInstructionSource',
  // The migration policy lives in InstructionApprovalStore; each backend only
  // supplies its own filesystem snapshot before calling it.
  ensureInstructionApprovalMigration: 'snapshotExistingInstructions',
  getSkillsVfs: 'skillsVfsOver',
  getStoredModelSpec: 'getStoredModelSpec',
  jobResult: 'jobResult',
  latestAlternateTakes: 'latestAlternateTakeSet',
  listBackgroundJobs: 'listBackgroundJobs',
  listCurriculumTasks: 'listProposedTasks',
  listRuns: 'listRuns',
  listScaffoldVersions: 'listScaffoldVersions',
  listTriggers: 'listTriggers',
  // `refinementDebt` is the direct call the delegation check can see; the row
  // view beside it (`refinementRequestView`) is passed by reference into map.
  listRefinements: 'refinementDebt',
  makeScaffoldCallTool: 'createScaffoldCallTool',
  makeScaffoldHistory: 'createScaffoldHistory',
  makeScaffoldLLMStream: 'createScaffoldLLMStream',
  markChangelogSeen: 'markChangelogSeen',
  pickAlternateTake: 'pickAlternateTake',
  // Core builds the durable steer rows (fallback id + both metadata keys,
  // inseparable); what stays per backend is transport — DO messages vs SQLite
  // rows — and each side's own broadcast channel.
  recordLandedSteers: 'describeLandedSteers',
  previewScaffoldLive: 'previewScaffoldLive',
  proposeCurriculumTasks: 'proposeCurriculumTasks',
  proposeScaffold: 'proposeScaffold',
  requestRefinement: 'requestRefinement',
  runRefinementLane: 'advanceRefinementLane',
  recordSystemPromptHash: 'observeSystemPromptHash',
  resumeBackgroundJob: 'resumeBackgroundJob',
  revertChangelogEntry: 'revertChangelogEntryById',
  revokeShellApprovalGrants: 'revokeShellApprovalGrants',
  // The whole turn-end policy — enabled, review, the four suppression rules,
  // deliver-or-record — is core's `runAdvisorLane`. What each body states is
  // only what its own backend knows: where the governor lives, and whether a
  // completion gate exists at all (it is the one-shot CLI surface's mechanism,
  // so cf passes `gateOpen: false` by construction).
  reviewTurnInBackground: 'runAdvisorLane',
  // One review, from a snapshot: the single body each backend's live lane and its
  // recovery both run. The verdict policy is the same `runAdvisorLane`; each body
  // states only which model answers, where the governor lives, and whether a
  // completion gate exists at all.
  runAdvisorReview: 'runAdvisorLane',
  // The prompt pair and the parse are core's; each body states only which
  // model answers (its routed 'fast' lane) and its own spend/operation framing.
  suggestTitle: 'suggestWorkspaceTitle',
  showRefinement: 'showRefinementRoute',
  runScaffoldGepaOptimization: 'runScaffoldGepaOptimization',
  runScaffoldOnce: 'runScaffoldOnce',
  // Accessors over ONE core object (ModelCatalogSession), three lines each.
  sessionAcceptedMedia: '.acceptedMedia',
  sessionContextWindow: '.contextWindow',
  setAlwaysActiveSkills: 'setAlwaysActiveSkills',
  setCurriculumTaskStatus: 'updateProposedTaskStatus',
  setModel: 'setModel',
  setRole: 'changeActiveRole',
  setReasoningEffort: 'setReasoningEffort',
  setShellApprovalMode: 'setShellApprovalMode',
  wrapToolsForBackground: 'wrapToolsForBackground',
} satisfies Readonly<Record<string, string>>;

/** The class bodies that constitute each backend's composition surface. */
const CF_CLASSES = [
  ['packages/cf-backend/src/actor-agent.ts', 'ActorAgent'],
  ['packages/cf-backend/src/orchestrator.ts', 'OrchestratorAgent'],
  ['packages/cf-backend/src/subordinate-agent.ts', 'SubordinateAgent'],
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

/** A member declaration sits at exactly two spaces of indentation (the same
 *  shape methodNames extracts); anything calling one is deeper than that. */
const DECLARATION_HEAD =
  /^ {2}(?:@[A-Za-z_][A-Za-z0-9_]*\((?:[^()]|\([^()]*\))*\)\s+)?(?:(?:private|protected|public|readonly|override|static|async|get|set)\s+)*$/;

/** Whether `body` contains a call matching `pattern` that is not the method's
 *  own declaration header. Without that exclusion a transport whose name
 *  matches its core symbol would prove itself by existing, which is exactly
 *  the laundering this gate exists to stop. */
function containsCall(body: string, pattern: RegExp): boolean {
  for (const m of body.matchAll(pattern)) {
    const lineStart = body.lastIndexOf('\n', m.index) + 1;
    if (!DECLARATION_HEAD.test(body.slice(lineStart, m.index))) return true;
  }
  return false;
}

/**
 * Whether `body` delegates to `declared` — a free-function `symbol(` call, or,
 * when the entry is written `.symbol`, a method call on some object OTHER than
 * `this`.
 *
 * The `this` exclusion is what keeps the method form honest: `this.foo(` inside
 * `foo` proves nothing, while `this.store.foo(` reaches a shared object and
 * does. Member chains are fine — the check looks only at what sits immediately
 * before the dot.
 */
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
    // A broken extractor returning near-empty sets would make "no new twins"
    // pass vacuously; these floors pin it to reality.
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
    // Guards the guard. Both forms exist to prove a body reaches a SHARED
    // implementation; a body that only reaches itself proves nothing, and the
    // method form is the one where that mistake is easy to make.
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
    // Without this, SHARED_TRANSPORTS would be a way to assert duplication
    // away. Both sides must actually reach the named core implementation.
    //
    // Scope caveat, measured rather than assumed: this searches the whole class
    // body, not the named method's, so it proves the class reaches the core
    // symbol somewhere. Narrowing it to the member body needs a real member
    // extractor — three regex attempts at one were each defeated by a different
    // TypeScript signature shape (an object parameter, a single-line body, a
    // generic return type containing an object literal), and a stricter gate
    // whose extractor silently mis-parses is worse than an honest coarse one.
    const unproven = Object.entries(SHARED_TRANSPORTS)
      .filter(([, symbol]) =>
        !delegatesTo(cliBody, symbol) || !cfBodies.some((b) => delegatesTo(b, symbol)))
      .map(([name]) => name);
    expect(unproven).toEqual([]);
  });
});

/**
 * Start-of-life reconciliation, which is the OTHER half of this file's subject:
 * not logic duplicated across backends, but logic wired into only one of them.
 *
 * Both defect classes have the same cause — nothing asserts the two composition
 * surfaces agree — and both have hit this repo. Twice, now, in the same place.
 *
 * The first: `head_journal.status = 'running'` had a single writer that cleared
 * it (the happy-path report), so an interrupted fork's heads stayed 'running'
 * forever and the dynamic-context block told the model "N of M heads running" on
 * every step for the life of the workspace, while the job registry said
 * `cancelled by operator`.
 *
 * The second: the fix for the first retired those heads, and the RESUME that
 * could have continued them was wired into one backend's start of life and not
 * the other's. The CLI swept its job registry unconditionally; the Durable Object
 * reached that sweep only from `onFiberRecovered` for a surviving `bg:*` fiber,
 * and a fiber row can die with the activation that owned it. So the retirement
 * was guaranteed and the re-entry was conditional, and a live search was recorded
 * `aborted` with "nothing left that could run it".
 */
describe('interrupted work is reconciled at start of life on BOTH backends', () => {
  const { cfBodies, cliBody } = scanTwins();

  test('each composition surface settles the fork journal through the one core reconciler', () => {
    expect(delegatesTo(cliBody, 'reconcileInterruptedForks')).toBe(true);
    expect(cfBodies.some((body) => delegatesTo(body, 'reconcileInterruptedForks'))).toBe(true);
  });

  test('each surface hands that reconciler a RESUME GATE, so neither retires what can resume', () => {
    // The parity that was missing. Without a gate the reconciler retires every
    // interrupted run, which is correct only for a caller with no durable resume
    // path — and both of these have one.
    expect(delegatesTo(cliBody, 'jobRedriveResumeGate')).toBe(true);
    expect(cfBodies.some((body) => delegatesTo(body, 'jobRedriveResumeGate'))).toBe(true);
  });

  test('neither surface sweeps the job registry outside that gate', () => {
    // The ordering used to be asserted on SOURCE POSITION here — reconcile before
    // resume, within one method — because no runtime observation distinguished
    // them. It is now structural instead: the reconciler marks the stale rows,
    // calls the gate, and retires what the gate refused, so the order is one
    // function's control flow and cannot be got wrong by an edit at a call site.
    // What a composition surface must NOT do is sweep the registry beside the
    // gate, because a job re-driven before the marking is a job the gate then has
    // nothing to report, and the run it was continuing gets retired.
    //
    // `onFiberRecovered` is exempt and is why this reads the recovery method
    // rather than the whole file: that callback delivers a wake only the fiber row
    // knows was lost, and it is a different entry point from start of life.
    const cliRecovery = methodBody(cliBody, 'recoverBackgroundJobs');
    expect(cliRecovery).not.toBe('');
    // Inside the gate the sweep is a THUNK the reconciler calls. Awaiting it at
    // the call site is the shape that runs it beside the marking instead of after
    // it, and it is the only shape that can get the order wrong.
    expect(cliRecovery).toContain('jobRedriveResumeGate({');
    expect(cliRecovery).not.toContain('await this.jobRunner.recoverOrphans()');
  });
});

/** One method's body out of a scanned composition surface, by brace depth.
 *  Empty when the surface declares no such method. */
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
