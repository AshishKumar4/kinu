/**
 * The product flows (`scripts/product-flows.ts`) in real Chrome against ONE
 * origin, `KINU_ORIGIN`: the deployment a deploy has just published
 * (`scripts/product-flows-tier.sh`, in its post-publish wave).
 *
 * Every row runs in `beforeAll` and leaves a verdict or the reason it has none;
 * the tests below read only what the page showed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveWebIdentity } from '../../evals/src/session';
import { withBrowser } from '../../scripts/live-app-harness';
import {
  DRIVE_SLATE, INSPECTOR_SHUT_PX,
  agentIsThereOnReturn, agentPlanIsReviewedInItsPane, agentProposesAWorkspace, accountMemoryCrossesWorkspaces, driveKeepsWhatIsDone, driveOpens, eachPaneKeepsItsTranscript, reachesHome, rightPanelKeepsItsState,
  slateOpensFromMyStuff, slateSharesReachingNothing, slateShowsItsPreview, workspaceGetsFirstAnswer,
  writtenFileShowsInFilesAndChanges, changesStormStaysBounded, openMemoryFollowsItsWriter,
  type AgentPlanVerdict, type AgentReturnVerdict, type WorkspaceProposalVerdict, type AccountMemoryVerdict, type ChangesStormVerdict, type LiveMemoryVerdict, type DriveOpensVerdict, type DriveVerdict, type WelcomeVerdict, type FirstAnswerVerdict,
  type FlowTarget, type PanelVerdict, type SlateOpensVerdict, type SlatePreviewVerdict, type SlateShareVerdict,
  type StampedCardVerdict, type WrittenFileVerdict,
} from '../../scripts/product-flows';
import { ACCOUNT_FACT, ACCOUNT_RECALL_REPLY, FLOW_MEMORY_NOTE, FLOW_PROBE, FLOW_SHELL_PROBE, FLOW_SLATE, PROPOSED_WORKSPACE, STORM_FILES } from '../../scripts/flows-script';
import { rowVerdicts } from '../../scripts/row-verdicts';

interface FlowVerdicts {
  welcome: WelcomeVerdict | null;
  firstAnswer: FirstAnswerVerdict | null;
  agentReturn: AgentReturnVerdict | null;
  agentPlan: AgentPlanVerdict | null;
  proposal: WorkspaceProposalVerdict | null;
  accountMemory: AccountMemoryVerdict | null;
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
}

const observed: FlowVerdicts = {
  welcome: null, firstAnswer: null, agentReturn: null, agentPlan: null, proposal: null, accountMemory: null, panel: null, stamped: null, writtenFile: null, storm: null, liveMemory: null, slate: null, drive: null,
  driveOpens: null, slateOpens: null, slateShare: null,
};

/** Why no row could start: no origin, or no identity for it. */
let setup: string | null = null;

const { attempt, verdictOf, broken } = rowVerdicts('product-flows', () => setup);

beforeAll(async () => {
  const origin = process.env.KINU_ORIGIN;

  if (origin === undefined || origin === '') {
    setup = 'KINU_ORIGIN is unset: these rows drive the deployment at that origin '
      + '(`scripts/product-flows-tier.sh`, after a deploy publishes).';

    return;
  }

  const resolution = resolveWebIdentity(origin);

  if (resolution.kind === 'absent') {
    setup = resolution.remedy;

    return;
  }

  await withBrowser(async (browser) => {
    const target: FlowTarget = { browser, origin, identity: resolution.identity };

    // Setup stands in front of every route until it is finished, so it goes first.
    observed.welcome = await attempt('welcome', () => reachesHome(target));
    observed.firstAnswer = await attempt('first-answer', () => workspaceGetsFirstAnswer(target));
    observed.agentReturn = await attempt('agent-return', () => agentIsThereOnReturn(target));
    observed.agentPlan = await attempt('agent-plan', () => agentPlanIsReviewedInItsPane(target));
    observed.proposal = await attempt('workspace-proposal', () => agentProposesAWorkspace(target));
    observed.accountMemory = await attempt('account-memory', () => accountMemoryCrossesWorkspaces(target));
    observed.panel = await attempt('panel', () => rightPanelKeepsItsState(target));
    observed.stamped = await attempt('stamped', () => eachPaneKeepsItsTranscript(target));
    observed.writtenFile = await attempt('written-file', () => writtenFileShowsInFilesAndChanges(target));
    observed.storm = await attempt('changes-storm', () => changesStormStaysBounded(target));
    observed.liveMemory = await attempt('live-memory', () => openMemoryFollowsItsWriter(target));
    observed.slate = await attempt('slate-preview', () => slateShowsItsPreview(target));
    observed.drive = await attempt('drive', () => driveKeepsWhatIsDone(target));
    observed.driveOpens = await attempt('drive-opens', () => driveOpens(target));
    observed.slateOpens = await attempt('slate-opens', () => slateOpensFromMyStuff(target));
    observed.slateShare = await attempt('slate-share', () => slateSharesReachingNothing(target));
  });

  process.stderr.write(`product-flows at ${origin}: ${JSON.stringify({ observed, broke: broken() }, null, 2)}\n`);
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
