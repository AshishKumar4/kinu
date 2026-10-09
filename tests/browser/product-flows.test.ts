/**
 * The product flows (`scripts/product-flows.ts`) in real Chrome against ONE
 * origin, `KINU_ORIGIN`: the deployment a deploy has just published
 * (`scripts/product-flows-tier.sh`, in its post-publish wave). `KINU_ORIGIN=local`
 * boots this checkout under `vite dev` instead, answered by a local scripted
 * model serving the same script (`tierModel`): a flow and its script proven
 * before a deploy publishes the tiers' Worker that serves them.
 *
 * Every row runs in `beforeAll`, each in a browser of its own, and leaves a verdict or the reason it has none; the
 * tests below read only what the page showed. A row that hangs is ended when the tier's runner says its silence nears
 * the bound (`endedNearSilence`), and fails alone: on staging d930f2537 one row's hang ended the run, and no test of
 * any row ran. `KINU_FLOW_ROWS` (comma-separated row names) runs only those rows, to prove one before the rest: the
 * tests of a row not run then fail, so pick them with `-t`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveWebIdentity } from '../../evals/src/session';
import { withBrowser, withDevServer } from '../../scripts/live-app-harness';
import { defaultToScriptedModel, registerScriptedModel, startScriptedModel } from '../../scripts/scripted-model';
import { tierModel } from '../../scripts/tier-model';
import {
  DRIVE_SLATE, INSPECTOR_SHUT_PX,
  agentIsThereOnReturn, agentPlanIsReviewedInItsPane, agentProposesAWorkspace, accountMemoryCrossesWorkspaces, accountMemoryInTheStack, approvalsStackAtTheComposer, spliceSitsWhereItWasRead, hireParksAndRunsOnApproval, driveKeepsWhatIsDone, driveOpens, eachPaneKeepsItsTranscript, reachesHome, rightPanelKeepsItsState,
  openWaitsNamed, slateOpensFromMyStuff, slateSharesReachingNothing, slateShowsItsPreview, workspaceGetsFirstAnswer,
  writtenFileShowsInFilesAndChanges, changesStormStaysBounded, openMemoryFollowsItsWriter,
  type AgentPlanVerdict, type AgentReturnVerdict, type ApprovalStackVerdict, type HireApprovalVerdict, type WorkspaceProposalVerdict, type AccountMemoryVerdict, type StackMemoryVerdict, type SpliceVerdict, type ChangesStormVerdict, type LiveMemoryVerdict, type DriveOpensVerdict, type DriveVerdict, type WelcomeVerdict, type FirstAnswerVerdict,
  type FlowTarget, type PanelVerdict, type SlateOpensVerdict, type SlatePreviewVerdict, type SlateShareVerdict,
  type StampedCardVerdict, type WrittenFileVerdict,
} from '../../scripts/product-flows';
import {
  ACCOUNT_FACT, ACCOUNT_RECALL_REPLY, CONTINUE, FLOW_MEMORY_NOTE, FLOW_PROBE, FLOW_SHELL_PROBE, FLOW_SLATE, HIRE_PARKED_COMMAND, INTERRUPTED_BRIEF,
  INTERRUPTED_TITLE, PARKED_COMMANDS, PIN_PAGE, PLAN_COMMENT, PROPOSED_WORKSPACE, REACH_REPLY, REACH_STREAM, STACK_FACT, STACK_RECALL_REPLY, STORM_FILES,
  THREAD_REPLY,
} from '../../scripts/flows-script';
import {
  chatTitledFromItsBrief, hireLivesUnderItsName, pinKeepsAnInChatPage, planCommentReachesTheAgent, slateStreamsAndHires,
  type HireHomeVerdict, type PinVerdict, type PlanCommentVerdict, type SlateReachVerdict, type TitledChatVerdict,
} from '../../scripts/owner-ask-flows';
import { endedNearSilence, rowVerdicts } from '../../scripts/row-verdicts';

interface FlowVerdicts {
  welcome: WelcomeVerdict | null;
  firstAnswer: FirstAnswerVerdict | null;
  agentReturn: AgentReturnVerdict | null;
  agentPlan: AgentPlanVerdict | null;
  proposal: WorkspaceProposalVerdict | null;
  accountMemory: AccountMemoryVerdict | null;
  stackMemory: StackMemoryVerdict | null;
  splice: SpliceVerdict | null;
  approvals: ApprovalStackVerdict | null;
  hireApproval: HireApprovalVerdict | null;
  panel: PanelVerdict | null;
  stamped: StampedCardVerdict | null;
  writtenFile: WrittenFileVerdict | null;
  storm: ChangesStormVerdict | null;
  liveMemory: LiveMemoryVerdict | null;
  slate: SlatePreviewVerdict | null;
  drive: DriveVerdict | null;
  driveOpens: DriveOpensVerdict | null;
  slateOpens: SlateOpensVerdict | null;
  slateShare: SlateShareVerdict | null;
  pin: PinVerdict | null;
  titledChat: TitledChatVerdict | null;
  hireHome: HireHomeVerdict | null;
  slateReach: SlateReachVerdict | null;
  planComment: PlanCommentVerdict | null;
}

const observed: FlowVerdicts = {
  welcome: null, firstAnswer: null, agentReturn: null, agentPlan: null, proposal: null, accountMemory: null, stackMemory: null, splice: null, approvals: null, hireApproval: null, panel: null, stamped: null, writtenFile: null, storm: null, liveMemory: null, slate: null, drive: null,
  driveOpens: null, slateOpens: null, slateShare: null, pin: null, titledChat: null, hireHome: null, slateReach: null, planComment: null,
};

/** Why no row could start: no origin, or no identity for it. */
let setup: string | null = null;

const { attempt, verdictOf, broken } = rowVerdicts('product-flows', () => setup);

/** The rows `KINU_FLOW_ROWS` names, or every row. */
const chosen = new Set((process.env.KINU_FLOW_ROWS ?? '').split(',').map((row) => row.trim()).filter((row) => row !== ''));

/** `flow` as the row `row`, in a browser of its own that its runner's silence notice closes. */
async function flowRow<Value>(row: string, at: Omit<FlowTarget, 'browser'>, flow: (target: FlowTarget) => Promise<Value>): Promise<Value | null> {
  if (chosen.size > 0 && !chosen.has(row)) return null;

  return await attempt(row, () => withBrowser((browser) => endedNearSilence(flow({ ...at, browser }), () => browser.disconnect(), openWaitsNamed)));
}

/** Every row, in order, against one origin as one identity. */
async function measureRows(at: Omit<FlowTarget, 'browser'>): Promise<void> {
  // Setup stands in front of every route until it is finished, so it goes first.
  observed.welcome = await flowRow('welcome', at, reachesHome);
  observed.firstAnswer = await flowRow('first-answer', at, workspaceGetsFirstAnswer);
  observed.agentReturn = await flowRow('agent-return', at, agentIsThereOnReturn);
  observed.agentPlan = await flowRow('agent-plan', at, agentPlanIsReviewedInItsPane);
  observed.proposal = await flowRow('workspace-proposal', at, agentProposesAWorkspace);
  observed.accountMemory = await flowRow('account-memory', at, accountMemoryCrossesWorkspaces);
  observed.stackMemory = await flowRow('stack-memory', at, accountMemoryInTheStack);
  observed.splice = await flowRow('splice', at, spliceSitsWhereItWasRead);
  observed.approvals = await flowRow('approval-stack', at, approvalsStackAtTheComposer);
  observed.hireApproval = await flowRow('hire-approval', at, hireParksAndRunsOnApproval);
  observed.panel = await flowRow('panel', at, rightPanelKeepsItsState);
  observed.stamped = await flowRow('stamped', at, eachPaneKeepsItsTranscript);
  observed.writtenFile = await flowRow('written-file', at, writtenFileShowsInFilesAndChanges);
  observed.storm = await flowRow('changes-storm', at, changesStormStaysBounded);
  observed.liveMemory = await flowRow('live-memory', at, openMemoryFollowsItsWriter);
  observed.slate = await flowRow('slate-preview', at, slateShowsItsPreview);
  observed.drive = await flowRow('drive', at, driveKeepsWhatIsDone);
  observed.driveOpens = await flowRow('drive-opens', at, driveOpens);
  observed.slateOpens = await flowRow('slate-opens', at, slateOpensFromMyStuff);
  observed.slateShare = await flowRow('slate-share', at, slateSharesReachingNothing);
  observed.pin = await flowRow('pin', at, pinKeepsAnInChatPage);
  observed.titledChat = await flowRow('titled-chat', at, chatTitledFromItsBrief);
  observed.hireHome = await flowRow('hire-home', at, hireLivesUnderItsName);
  observed.slateReach = await flowRow('slate-reach', at, slateStreamsAndHires);
  observed.planComment = await flowRow('plan-comment', at, planCommentReachesTheAgent);

  process.stderr.write(`product-flows at ${at.origin}: ${JSON.stringify({ observed, broke: broken() }, null, 2)}\n`);
}

beforeAll(async () => {
  const origin = process.env.KINU_ORIGIN;

  if (origin === undefined || origin === '') {
    setup = 'KINU_ORIGIN is unset: these rows drive the deployment at that origin '
      + '(`scripts/product-flows-tier.sh`, after a deploy publishes).';

    return;
  }

  if (origin === 'local') {
    const model = await startScriptedModel(tierModel);

    await withDevServer(async (server) => {
      await registerScriptedModel(server.origin, model.baseURL);
      await defaultToScriptedModel(server.origin);
      await measureRows({ origin: server.origin, identity: { kind: 'loopback' } });
    });
    await model.stop();

    return;
  }

  const resolution = resolveWebIdentity(origin);

  if (resolution.kind === 'absent') {
    setup = resolution.remedy;

    return;
  }

  await measureRows({ origin, identity: resolution.identity });
});

afterAll(() => {
  if (setup !== null) throw new Error(setup);
});

describe('the product reaches its home page', () => {
  test('through setup when the account has not done it, and straight there when it has', () => {
    expect(verdictOf(observed.welcome, 'welcome').landedAt).toBe('/');
  });
});

describe('a workspace made from the home page answers its mission', () => {
  test('its first turn draws a reply on screen', () => {
    expect(verdictOf(observed.firstAnswer, 'first-answer').answers.length).toBeGreaterThan(0);
  });

  test('and leaves the inspector shut: nothing it did asks the person for anything', () => {
    // #21: the panel opened by itself once a "hello" turn ended.
    expect(verdictOf(observed.firstAnswer, 'first-answer').inspectorWidth).toBeLessThanOrEqual(INSPECTOR_SHUT_PX);
  });

  test('the mission stays its brief, never replayed as a message the person sent', () => {
    expect(verdictOf(observed.firstAnswer, 'first-answer').missionSent).toBe(false);
  });
});

describe("an agent made with '+' has its plan reviewed beside its own pane", () => {
  test('its Plan turn brings the plan back for review there, and approving it records the decision', () => {
    const flow = verdictOf(observed.agentPlan, 'agent-plan');

    expect(flow.pane).toContain('/agents/');
    expect(flow.planReviewShown).toBeTrue();
    expect(flow.approveControl).toMatch(/approve/iu);
    expect(flow.planStatus).toBe('Approved');
  });
});

describe("a fact about the owner said in one workspace is every workspace's once the owner accepts it", () => {
  test('it is offered in Settings → Memory, another workspace knows nothing of it before, and recalls it after', () => {
    const flow = verdictOf(observed.accountMemory, 'account-memory');

    expect(flow.offered).toContain(ACCOUNT_FACT.value);
    expect(flow.before).toBe(`${ACCOUNT_RECALL_REPLY} nowhere I know of`);
    expect(flow.after).toBe(`${ACCOUNT_RECALL_REPLY} ${ACCOUNT_FACT.value}`);
  });

  test("a request without the owner's session reads none of it", () => {
    expect([401, 403]).toContain(verdictOf(observed.accountMemory, 'account-memory').viewerStatus);
  });
});

describe('what reaches the agent while it answers sits where it was read, amber until read, green after', () => {
  const ordered = (order: readonly number[]) => order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at > (order[i - 1] ?? -1));

  test('while the agent works, the card waits amber', () => {
    const { waited } = verdictOf(observed.splice, 'splice');

    expect(waited.tone).toBe('p-warning');
    expect(['pending', 'shown']).toContain(waited.state ?? 'none');
  });

  test('once read, it sits inside the answer between the words before it and the answer after it, green', () => {
    const { answered } = verdictOf(observed.splice, 'splice');

    expect({ spliced: answered.spliced, state: answered.state, tone: answered.tone, ordered: ordered(answered.order) })
      .toEqual({ spliced: true, state: 'seen', tone: 'p-success', ordered: true });
  });

  test('a reload draws it there still', () => {
    const { reloaded } = verdictOf(observed.splice, 'splice');

    expect({ spliced: reloaded.spliced, state: reloaded.state, tone: reloaded.tone, ordered: ordered(reloaded.order) })
      .toEqual({ spliced: true, state: 'seen', tone: 'p-success', ordered: true });
  });
});

describe("an account fact an agent proposes waits in the chat's stack, and kept there it is recalled", () => {
  test('the stack offers it with its value, the agent knows nothing of it before, and recalls it after', () => {
    const flow = verdictOf(observed.stackMemory, 'stack-memory');

    expect(flow.offered).toContain(STACK_FACT.value);
    expect(flow.before).toBe(`${STACK_RECALL_REPLY} nowhere I know of`);
    expect(flow.after).toBe(`${STACK_RECALL_REPLY} ${STACK_FACT.value}`);
  });
});

describe('a workspace the agent proposes exists only once its owner approves it', () => {
  test('the owner sees its name and the SOUL.md approving writes, and nothing exists before the approval', () => {
    const flow = verdictOf(observed.proposal, 'workspace-proposal');

    expect(flow.cardTitle).toContain(PROPOSED_WORKSPACE.name);
    expect(flow.cardSoul).toContain(PROPOSED_WORKSPACE.brief);
    expect(flow.cardSoul).toContain(PROPOSED_WORKSPACE.soul);
    expect(flow.existedBeforeApproval).toBeFalse();
  });

  test('approved, it is on the account under its proposed name, and the agent that asked has its link', () => {
    const flow = verdictOf(observed.proposal, 'workspace-proposal');

    expect(flow.created?.displayName).toBe(PROPOSED_WORKSPACE.name);
    expect(flow.link).toContain(`/workspace/${flow.created?.name ?? '(none)'}`);
  });
});

describe('two commands a turn parks wait as a stack docked to the composer', () => {
  test('both stack, the newer open with its command, and approving it opens the other', () => {
    const flow = verdictOf(observed.approvals, 'approval-stack');

    expect(flow.stacked).toHaveLength(2);
    expect(flow.openWords).toContain(PARKED_COMMANDS[1]);
    expect(flow.afterFirst).toEqual([flow.stacked[1]]);
  });

  test('each answer reaches the agent: its wake shows in the chat as an event, and the agent answers each', () => {
    const flow = verdictOf(observed.approvals, 'approval-stack');

    expect(flow.heard).toEqual({ approvedEvent: true, deniedEvent: true, approvedReply: true, deniedReply: true });
  });
});

describe('a hire\'s gated command parks as its own, is approved from its pane, and runs', () => {
  test('the hire\'s pane stacks its one ask, open with the command', () => {
    const flow = verdictOf(observed.hireApproval, 'hire-approval');

    expect(flow.paneStacked).toHaveLength(1);
    expect(flow.openWords).toContain(HIRE_PARKED_COMMAND);
  });

  test('approved there, the hire is woken and its re-issue runs', () => {
    expect(verdictOf(observed.hireApproval, 'hire-approval').ran).toBe(true);
  });
});

describe("an agent made with '+', messaged and renamed is all there on return", () => {
  // #13: every agent was present over the API and a reloaded page showed none.
  test('its tab and its sidebar entry show again under the name it was given', () => {
    const back = verdictOf(observed.agentReturn, 'agent-return');

    expect(back.before.tab).toContain(back.renamed);
    expect(back.before.sidebar).toContain(back.renamed);
    expect(back.after).toEqual(back.before);
  });

  test('its conversation is there too', () => {
    const back = verdictOf(observed.agentReturn, 'agent-return');

    expect(back.conversation).toContain(back.said);
  });
});

describe('the right panel keeps its Work, Files and Env state when the chat tab changes', () => {
  test('the Files surface DOM node identity and scroll position survive', () => {
    const panel = verdictOf(observed.panel, 'panel');

    expect(panel.nodeSurvives).toBe(true);
    expect(panel.scrollSurvives).toBe(true);
  });

  test('no refetch of the workspace-scoped reads occurs on either switch', () => {
    const panel = verdictOf(observed.panel, 'panel');

    expect(panel.workspaceReadsOnSwitch).toBe(0);
    expect(panel.workspaceReadsOnBack).toBe(0);
  });

  test("the '+' tab's own actor socket answered its pane", () => {
    expect(verdictOf(observed.panel, 'panel').agentSocketFrames).toBeGreaterThan(0);
  });
});

describe("a pane renders its own transcript and no other actor's", () => {
  test("the root's own turn stays out of a new actor's pane", () => {
    expect(verdictOf(observed.stamped, 'stamped').rootMarkerInActorPane).toBe(0);
  });

  test("words sent on the actor's tab stay out of the root transcript", () => {
    expect(verdictOf(observed.stamped, 'stamped').actorMarkerInRootPane).toBe(0);
  });
});

describe('a file the agent wrote shows where a reader looks for it', () => {
  test('the Files tab lists it', () => {
    expect(verdictOf(observed.writtenFile, 'written-file').filesListed).toContain(FLOW_PROBE);
  });

  test('the Changes tab appears and lists it as a change', () => {
    expect(verdictOf(observed.writtenFile, 'written-file').changedPaths.some((path) => path.endsWith(FLOW_PROBE))).toBe(true);
  });

  test('a file the shell wrote is a change too, and marking the set reviewed clears both', () => {
    const flow = verdictOf(observed.writtenFile, 'written-file');

    expect(flow.changedPaths.some((path) => path.endsWith(FLOW_SHELL_PROBE))).toBe(true);
    expect(flow.afterReview).toEqual([]);
  });
});

describe('a slate the agent built shows its running preview', () => {
  test('its tab appears under its title and its frame shows the page it serves', () => {
    const slate = verdictOf(observed.slate, 'slate-preview');

    expect(slate.slateTab).toBe(true);
    expect(slate.frameText).toContain(FLOW_SLATE.page);
  });

  // The page is the agent's own React through the vendored bundle and `kinu:slate`; Bump goes to the slate's method.
  test('its React page runs, hears its host, and its button reaches the slate\'s own method', () => {
    const slate = verdictOf(observed.slate, 'slate-preview');

    expect(slate.bumped).toBe('2');
    expect(slate.hosted).toBe(true);
  });

  // 1008-f: its tab read "workspace :20000", the port its preview serves on.
  test('its tab is named by its title, and no tab by its preview\'s port', () => {
    const { pageTabs } = verdictOf(observed.slate, 'slate-preview');

    expect(pageTabs).toContain(FLOW_SLATE.title);
    expect(pageTabs.filter((tab) => /:\d{2,5}\b/u.test(tab))).toEqual([]);
  });
});

// The owner's asks of 2026-10-08 (docs/research/REQUESTS-LEDGER.md), each as the owner meets it.
describe('a page an answer draws in the chat is kept by its pin (1008-c)', () => {
  test('the pin keeps it as a slate, one of the workspace\'s pages under the page\'s own title', () => {
    const pin = verdictOf(observed.pin, 'pin');

    expect(pin.kept).not.toBeNull();
    expect(pin.keptName).toContain(PIN_PAGE.title);
    expect(pin.listed).toContain(`${pin.kept ?? ''} ${PIN_PAGE.title}`);
  });
});

describe('a chat is named from its brief (1008-e)', () => {
  test('even when its first turn is stopped and the owner says Continue', () => {
    const chat = verdictOf(observed.titledChat, 'titled-chat');

    expect(chat.continued).toBe(true);
    expect([INTERRUPTED_BRIEF, INTERRUPTED_TITLE]).toContain(chat.title);
    expect(chat.title).not.toBe(CONTINUE);
  });
});

describe('a hire lives in a home of its own name (1008-g)', () => {
  // Its name is its brief's first telling words (`mintAgentName`): "Harbour lamps keeper: …".
  test('it is named from its brief, and its shell starts in /home/<that name>, not /home/sub-<id>', () => {
    const hire = verdictOf(observed.hireHome, 'hire-home');

    expect(hire.hired).toBe('harbour-lamps-keeper');
    expect(hire.home).toBe(`/home/${hire.hired}`);
  });
});

describe("a slate streams answers as they are written, and its owner's slate hires (1008-ac, 1008-ad)", () => {
  test("ai.stream's answer shows its start before its end", () => {
    const { modelStream } = verdictOf(observed.slateReach, 'slate-reach');

    expect(modelStream.partway).toContain(REACH_STREAM.lead.trim());
    expect([modelStream.state, modelStream.final]).toEqual(['done', `${REACH_STREAM.lead}${REACH_STREAM.end}`]);
  });

  test("agent.ask streams the agent's own reply into the slate", () => {
    const { agentStream } = verdictOf(observed.slateReach, 'slate-reach');

    expect(agentStream.partway).toContain(REACH_REPLY.lead.trim());
    expect(agentStream.state).toBe('done');
    expect(agentStream.final).toContain(REACH_REPLY.end);
  });

  test("the owner's own slate hires a helper, and the same slate opened from its share link cannot", () => {
    const reach = verdictOf(observed.slateReach, 'slate-reach');

    expect(reach.ownerHire).toMatch(/^hired /u);
    expect(reach.viewerHire).toMatch(/^refused /u);
  });
});

describe('a comment on the whole plan reaches the agent, which answers it in its thread (1008-ao, 1008-ar)', () => {
  test('the review admits it and Request changes carries it to the agent', () => {
    const plan = verdictOf(observed.planComment, 'plan-comment');

    expect(plan.commentAdmitted).toBe(true);
    expect(plan.heard).toContain(PLAN_COMMENT);
  });

  test("the agent's answer shows in the comment's own thread", () => {
    expect(verdictOf(observed.planComment, 'plan-comment').threadReplies.some((reply) => reply.includes(THREAD_REPLY))).toBe(true);
  });
});

describe('what a person does in the Drive page is kept', () => {
  test('a folder made and a file uploaded are listed', () => {
    const drive = verdictOf(observed.drive, 'drive');

    expect(drive.afterCreate).toContain(drive.folder);
    expect(drive.afterCreate).toContain(drive.file);
  });

  test('a rename survives a reload', () => {
    const drive = verdictOf(observed.drive, 'drive');

    expect(drive.afterRename).toContain(drive.renamed);
    expect(drive.afterRename).not.toContain(drive.folder);
    expect(drive.afterRename).toContain(drive.file);
  });

  test('a confirmed Delete removes each', () => {
    const drive = verdictOf(observed.drive, 'drive');

    expect(drive.afterDelete).not.toContain(drive.renamed);
    expect(drive.afterDelete).not.toContain(drive.file);
  });
});

describe('the Drive opens and draws nothing empty', () => {
  test('on My stuff, or on Shared for an account that owns nothing yet, with its sidebar row lit', () => {
    const opened = verdictOf(observed.driveOpens, 'drive-opens');

    expect(['/drive', '/shared']).toContain(opened.landedAt);
    expect(opened.sidebarLit).toBe(true);
  });

  test('every section it draws holds a tile, and a Drive with nothing draws its empty state instead', () => {
    const opened = verdictOf(observed.driveOpens, 'drive-opens');

    expect(opened.sections.filter((section) => section.tiles === 0)).toEqual([]);
    expect(opened.empty).toBe(opened.sections.length === 0);
  });
});

describe('a slate opens from My stuff on its own tab', () => {
  test('My stuff tiles it under its title', () => {
    expect(verdictOf(observed.slateOpens, 'slate-opens').tileName).toBe(DRIVE_SLATE.title);
  });

  test('pressing the tile opens its workspace with the slate the current tab', () => {
    const opened = verdictOf(observed.slateOpens, 'slate-opens');

    expect(opened.landedAt.startsWith(`/workspace/${encodeURIComponent(opened.workspace)}`)).toBe(true);
    expect(opened.slateTabCurrent).toBe(true);
  });
});

describe('a slate that reaches nothing of its owner\'s shares from its tile, and stops (#25)', () => {
  test('the dialog draws no Reach row and states only the request limit', () => {
    const shared = verdictOf(observed.slateShare, 'slate-share');

    expect(shared.reachRow).toBe(false);
    // docs/SLATE-SHARING.md S5 specifies 120 requests per viewer per minute; this slate spends no model budget.
    expect(shared.limitsStated).toEqual([120]);
  });

  test('the share is made, its link copies, and it is listed under Shared by you', () => {
    const shared = verdictOf(observed.slateShare, 'slate-share');

    expect(shared.link).not.toBeNull();
    expect(shared.copied).toBe(shared.link);
    expect(shared.sharedByYou).toContain(DRIVE_SLATE.title);
  });

  test('Stop sharing takes it off the Drive', () => {
    expect(verdictOf(observed.slateShare, 'slate-share').afterStop).not.toContain(DRIVE_SLATE.title);
  });
});

// Three tabs on one workspace while a shell burst writes fifty files: each lists the burst, reading the change-set a
// bounded number of times, not once per file, and the settled panes read nothing while another tab works.
describe('a burst of writes under three open Changes panes', () => {
  test('every pane lists the whole burst from a bounded number of reads and frames', () => {
    const storm = verdictOf(observed.storm, 'changes-storm');

    expect(storm.listed).toEqual([STORM_FILES, STORM_FILES, STORM_FILES]);

    for (const reads of [...storm.burstReads, ...storm.burstFrames]) expect(reads).toBeLessThan(STORM_FILES / 5);
  });

  test('settled panes read nothing while another tab works', () => {
    expect(verdictOf(observed.storm, 'changes-storm').idleReads).toEqual([0, 0]);
  });
});

// A pane open on another tab follows a write made by a turn it did not send, from the write's own frame.
describe("an open memory pane follows another tab's turn", () => {
  test('it shows the saved note without a reload, and reads nothing more while the other tab works', () => {
    const memory = verdictOf(observed.liveMemory, 'live-memory');

    expect(memory.shown).toContain(FLOW_MEMORY_NOTE);
    expect(memory.turnReads).toBeGreaterThan(0);
    expect(memory.idleReads).toBe(0);
  });
});
