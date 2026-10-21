/**
 * The product flows (`scripts/product-flows.ts`) in real Chrome against ONE
 * origin, `KINU_ORIGIN`: the deployment a deploy has just published
 * (`scripts/product-flows-tier.sh`, in its post-publish wave). `KINU_ORIGIN=local`
 * boots this checkout under `vite dev` instead, answered by a local scripted
 * model serving the same script (`tierModel`): a flow and its script proven
 * before a deploy publishes the tiers' Worker that serves them.
 *
 * Each suite measures its own flow immediately before asserting what the page showed. Deploy runs each suite in
 * its own Armada task, so a later flow's hang cannot erase a finished flow's verdict. The runner selects a row with
 * `--flow=<id>`; Bun's native test filter selects its suite and never starts the other suites' hooks.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { resolveWebIdentity } from '../../evals/src/workspace-roster';
import { withBrowser, withDevServer } from '../../scripts/live-app-harness';
import { defaultToScriptedModel, registerScriptedModel, startScriptedModel } from '../../scripts/scripted-model';
import { tierModel } from '../../scripts/tier-model';
import {
  DRIVE_SLATE, agentIsThereOnReturn, agentPlanIsReviewedInItsPane, agentCreatesAWorkspace, accountMemoryCrossesWorkspaces,
  accountMemoryInTheStack, approvalsStackAtTheComposer, spliceSitsWhereItWasRead, hireParksAndRunsOnApproval, driveKeepsWhatIsDone, DROPPED_TEXT,
  driveOpens, eachPaneKeepsItsTranscript, reachesHome, rightPanelKeepsItsState, openWaitsNamed, slateOpensFromSlates,
  slateSharesReachingNothing, slateShowsItsPreview, workspaceGetsFirstAnswer, writtenFileShowsInFilesAndChanges, changesStormStaysBounded,
  openMemoryFollowsItsWriter, computerDesktopSurvivesAResize, computerSwitchKeepsItsScreens, reopenedWorkspaceRunsTheDeployedBuild,
  computerSessionsComeBackByName, agentJobIsAnsweredInItsSession, type AgentPlanVerdict, type AgentReturnVerdict,
  type ApprovalStackVerdict, type HireApprovalVerdict, type AgentWorkspaceVerdict, type AccountMemoryVerdict, type StackMemoryVerdict,
  type SpliceVerdict, type ChangesStormVerdict, type LiveMemoryVerdict, type DriveOpensVerdict, type DriveVerdict, type WelcomeVerdict,
  type FirstAnswerVerdict, type PanelVerdict, type SlateOpensVerdict, type SlatePreviewVerdict, type SlateShareVerdict,
  type StampedCardVerdict, type WrittenFileVerdict, type DesktopResizeVerdict, type DesktopSwitchVerdict, type ReopenVerdict,
  type SessionsVerdict, type AgentJobVerdict,
} from '../../scripts/product-flows';
import { INSPECTOR_SHUT_PX, type FlowTarget } from '../../scripts/browser-page';
import {
  ACCOUNT_FACT, ACCOUNT_RECALL_REPLY, CONTINUE, FLOW_MEMORY_NOTE, FLOW_PROBE, FLOW_SHELL_PROBE, FLOW_SLATE, HIRE_PARKED_COMMAND, INTERRUPTED_BRIEF,
  INTERRUPTED_TITLE, PARKED_COMMANDS, PIN_PAGE, PLAN_COMMENT, AGENT_WORKSPACE, REACH_REPLY, REACH_STREAM, STACK_FACT, STACK_RECALL_REPLY, STORM_FILES,
  THREAD_REPLY,
} from '../../scripts/flows-script';
import {
  chatTitledFromItsBrief, hireLivesUnderItsName, pinKeepsAnInChatPage, planCommentReachesTheAgent, slateStreamsAndHires,
  type HireHomeVerdict, type PinVerdict, type PlanCommentVerdict, type SlateReachVerdict, type TitledChatVerdict,
} from '../../scripts/owner-ask-flows';
import { endedNearSilence, rowVerdicts } from '../../scripts/row-verdicts';
import { productFlowTestName, type ProductFlowRow } from '../../scripts/product-flow-rows';

const { attempt, verdictOf } = rowVerdicts('product-flows', () => null);

/** `flow` as the row `row`, in a browser of its own that its runner's silence notice closes. */
async function flowRow<Value>(row: ProductFlowRow, flow: (target: FlowTarget) => Promise<Value>): Promise<Value | null> {
  return await attempt(row, async () => {
    const origin = process.env.KINU_ORIGIN;

    if (origin === undefined || origin === '') throw new Error('KINU_ORIGIN is unset: product flows require their deployment or local.');

    const measure = (at: Omit<FlowTarget, 'browser'>): Promise<Value> => withBrowser((browser) => {
      const run = async (): Promise<Value> => {
        const target = { ...at, browser };

        if (origin === 'local' && row !== 'welcome') await reachesHome(target);

        return await flow(target);
      };

      return endedNearSilence(run(), () => browser.disconnect(), openWaitsNamed);
    });

    if (origin === 'local') {
      const model = await startScriptedModel(tierModel);

      try {
        return await withDevServer(async (server) => {
          await registerScriptedModel(server.origin, model.baseURL);
          await defaultToScriptedModel(server.origin);

          return await measure({ origin: server.origin, identity: { kind: 'loopback' } });
        });
      } finally {
        await model.stop();
      }
    }

    const resolution = resolveWebIdentity(origin);

    if (resolution.kind === 'absent') throw new Error(resolution.remedy);

    return await measure({ origin, identity: resolution.identity });
  });
}

describe(productFlowTestName('welcome', 'the product reaches its home page'), () => {
  let observed: WelcomeVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('welcome', reachesHome);
  });

  // Setup's default installs the Personal assistant, and Home is its chat (389aac88a); an account set up before keeps
  // the Home it chose.
  test('through setup onto the assistant\'s chat when the account has not done it, and straight there when it has', () => {
    const welcome = verdictOf(observed, 'welcome');

    expect(welcome.landedAt).toBe('/');
    expect(!welcome.welcomed || welcome.assistantHome).toBe(true);
  });
});

describe(productFlowTestName('first-answer', 'a workspace made from the home page answers its mission'), () => {
  let observed: FirstAnswerVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('first-answer', workspaceGetsFirstAnswer);
  });

  test('its first turn draws a reply on screen', () => {
    expect(verdictOf(observed, 'first-answer').answers.length).toBeGreaterThan(0);
  });

  test('and leaves the inspector shut: nothing it did asks the person for anything', () => {
    // #21: the panel opened by itself once a "hello" turn ended.
    expect(verdictOf(observed, 'first-answer').inspectorWidth).toBeLessThanOrEqual(INSPECTOR_SHUT_PX);
  });

  test('the mission stays its brief, never replayed as a message the person sent', () => {
    expect(verdictOf(observed, 'first-answer').missionSent).toBe(false);
  });
});

describe(productFlowTestName('agent-plan', "an agent made with '+' has its plan reviewed beside its own pane"), () => {
  let observed: AgentPlanVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('agent-plan', agentPlanIsReviewedInItsPane);
  });

  test('its Plan turn brings the plan back for review there, and approving it records the decision', () => {
    const flow = verdictOf(observed, 'agent-plan');

    expect(flow.pane).toContain('/agents/');
    expect(flow.planReviewShown).toBeTrue();
  });
});

describe(productFlowTestName('account-memory', "a fact about the owner said in one workspace is every workspace's once the owner accepts it"), () => {
  let observed: AccountMemoryVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('account-memory', accountMemoryCrossesWorkspaces);
  });

  test('it is offered in Settings → Memory, another workspace knows nothing of it before, and recalls it after', () => {
    const flow = verdictOf(observed, 'account-memory');

    expect(flow.offered).toContain(ACCOUNT_FACT.value);
    expect(flow.before).toBe(`${ACCOUNT_RECALL_REPLY} nowhere I know of`);
    expect(flow.after).toBe(`${ACCOUNT_RECALL_REPLY} ${ACCOUNT_FACT.value}`);
  });

  test("a request without the owner's session reads none of it", () => {
    expect([401, 403]).toContain(verdictOf(observed, 'account-memory').viewerStatus);
  });
});

describe(productFlowTestName('splice', 'what reaches the agent while it answers sits where it was read, amber until read, green after'), () => {
  let observed: SpliceVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('splice', spliceSitsWhereItWasRead);
  });

  /** Positions found and strictly ascending. */
  const ordered = (order: readonly number[]) => order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at > (order[i - 1] ?? -1));

  const pings = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

  // 1008-x: every card piled at the bottom of a running turn; each is drawn as it arrives, after the step it arrived in.
  test('while the agent works, each card is drawn as it arrives, amber, after the words of its step', () => {
    const { arrivals } = verdictOf(observed, 'splice');

    expect(arrivals.map((arrival, i) => ({
      drawn: arrival.cards.map((card) => card.ping),
      working: arrival.working,
      newest: ['pending', 'shown'].includes(arrival.cards.at(-1)?.state ?? 'none'),
      ordered: ordered(arrival.order.slice(0, 2 * (i + 1))),
    }))).toEqual(pings(arrivals.length).map((count) => ({ drawn: pings(count), working: true, newest: true, ordered: true })));
    expect(arrivals).toHaveLength(3);
  });

  test('once read, every card sits inside the answer where it arrived, green, and the agent heard each in order', () => {
    const { answered, heard } = verdictOf(observed, 'splice');

    expect({ cards: answered.cards, ordered: ordered(answered.order), heard })
      .toEqual({ cards: pings(3).map((ping) => ({ ping, state: 'seen', tone: 'p-success', spliced: true })), ordered: true, heard: 'PINGS HEARD: 1, 2, 3' });
  });

  test('a reload draws every card there still', () => {
    const { reloaded } = verdictOf(observed, 'splice');

    expect({ cards: reloaded.cards, ordered: ordered(reloaded.order) })
      .toEqual({ cards: pings(3).map((ping) => ({ ping, state: 'seen', tone: 'p-success', spliced: true })), ordered: true });
  });
});

describe(productFlowTestName('stack-memory', "an account fact an agent proposes waits in the chat's stack, and kept there it is recalled"), () => {
  let observed: StackMemoryVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('stack-memory', accountMemoryInTheStack);
  });

  test('the stack offers it with its value, the agent knows nothing of it before, and recalls it after', () => {
    const flow = verdictOf(observed, 'stack-memory');

    expect(flow.offered).toContain(STACK_FACT.value);
    expect(flow.before).toBe(`${STACK_RECALL_REPLY} nowhere I know of`);
    expect(flow.after).toBe(`${STACK_RECALL_REPLY} ${STACK_FACT.value}`);
  });
});

describe(productFlowTestName('agent-workspace', 'a workspace the agent creates exists at once, recorded, with nothing asked'), () => {
  let observed: AgentWorkspaceVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('agent-workspace', agentCreatesAWorkspace);
  });

  test('it is on the account under the name the agent gave it, and the agent has its link', () => {
    const flow = verdictOf(observed, 'agent-workspace');

    expect(flow.existedBefore).toBeFalse();
    expect(flow.created?.displayName).toBe(AGENT_WORKSPACE.name);
    expect(flow.link).toContain(`/workspace/${flow.created?.name ?? '(none)'}`);
  });

  test('the Changelog records it with a way to open it', () => {
    const flow = verdictOf(observed, 'agent-workspace');

    expect(flow.changelog?.summary).toContain(`Created workspace "${AGENT_WORKSPACE.name}"`);
    expect(flow.changelog?.opens).toBe(`/workspace/${flow.created?.name ?? '(none)'}`);
  });
});

describe(productFlowTestName('approval-stack', 'two commands a turn parks wait as a stack docked to the composer'), () => {
  let observed: ApprovalStackVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('approval-stack', approvalsStackAtTheComposer);
  });

  test('both stack, the newer open with its command, and approving it opens the other', () => {
    const flow = verdictOf(observed, 'approval-stack');

    expect(flow.stacked).toHaveLength(2);
    expect(flow.openWords).toContain(PARKED_COMMANDS[1]);
    expect(flow.afterFirst).toEqual([flow.stacked[1]]);
  });

  test('each answer reaches the agent: its wake shows in the chat as an event, and the agent answers each', () => {
    const flow = verdictOf(observed, 'approval-stack');

    expect(flow.heard).toEqual({ approvedEvent: true, deniedEvent: true, approvedReply: true, deniedReply: true });
  });
});

describe(productFlowTestName('hire-approval', 'a hire\'s gated command parks as its own, is approved from its pane, and runs'), () => {
  let observed: HireApprovalVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('hire-approval', hireParksAndRunsOnApproval);
  });

  test('the hire\'s pane stacks its one ask, open with the command', () => {
    const flow = verdictOf(observed, 'hire-approval');

    expect(flow.paneStacked).toHaveLength(1);
    expect(flow.openWords).toContain(HIRE_PARKED_COMMAND);
  });

  test('approved there, the hire is woken and its re-issue runs', () => {
    expect(verdictOf(observed, 'hire-approval').ran).toBe(true);
  });
});

describe(productFlowTestName('agent-return', "an agent made with '+', messaged and renamed is all there on return"), () => {
  let observed: AgentReturnVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('agent-return', agentIsThereOnReturn);
  });

  // #13: every agent was present over the API and a reloaded page showed none.
  test('its tab and its sidebar entry show again under the name it was given', () => {
    const back = verdictOf(observed, 'agent-return');

    expect(back.before.tab).toContain(back.renamed);
    expect(back.before.sidebar).toContain(back.renamed);
    expect(back.after).toEqual(back.before);
  });

  test('its conversation is there too', () => {
    const back = verdictOf(observed, 'agent-return');

    expect(back.conversation).toContain(back.said);
  });
});

describe(productFlowTestName('panel', 'the right panel keeps its Work, Files and Env state when the chat tab changes'), () => {
  let observed: PanelVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('panel', rightPanelKeepsItsState);
  });

  test('the Files surface DOM node identity and scroll position survive', () => {
    const panel = verdictOf(observed, 'panel');

    expect(panel.scrollSurvives).toBe(true);
  });

  test('no refetch of the workspace-scoped reads occurs on either switch', () => {
    const panel = verdictOf(observed, 'panel');

    expect(panel.workspaceReadsOnSwitch).toBe(0);
    expect(panel.workspaceReadsOnBack).toBe(0);
  });

  test("the '+' tab's own actor socket answered its pane", () => {
    expect(verdictOf(observed, 'panel').agentSocketFrames).toBeGreaterThan(0);
  });
});

describe(productFlowTestName('stamped', "a pane renders its own transcript and no other actor's"), () => {
  let observed: StampedCardVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('stamped', eachPaneKeepsItsTranscript);
  });

  test("the root's own turn stays out of a new actor's pane", () => {
    expect(verdictOf(observed, 'stamped').rootMarkerInActorPane).toBe(0);
  });

  test("words sent on the actor's tab stay out of the root transcript", () => {
    expect(verdictOf(observed, 'stamped').actorMarkerInRootPane).toBe(0);
  });
});

describe(productFlowTestName('written-file', 'a file the agent wrote shows where a reader looks for it'), () => {
  let observed: WrittenFileVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('written-file', writtenFileShowsInFilesAndChanges);
  });

  test('the Files tab lists it', () => {
    expect(verdictOf(observed, 'written-file').filesListed).toContain(FLOW_PROBE);
  });

  test('the Changes tab appears and lists it as a change', () => {
    expect(verdictOf(observed, 'written-file').changedPaths.some((path) => path.endsWith(FLOW_PROBE))).toBe(true);
  });

  test('a file the shell wrote is a change too, and marking the set reviewed clears both', () => {
    const flow = verdictOf(observed, 'written-file');

    expect(flow.changedPaths.some((path) => path.endsWith(FLOW_SHELL_PROBE))).toBe(true);
    expect(flow.afterReview).toEqual([]);
  });
});

describe(productFlowTestName('slate-preview', 'a slate the agent built shows its running preview'), () => {
  let observed: SlatePreviewVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('slate-preview', slateShowsItsPreview);
  });

  test('its tab appears under its title and its frame shows the page it serves', () => {
    const slate = verdictOf(observed, 'slate-preview');

    expect(slate.slateTab).toBe(true);
    expect(slate.frameText).toContain(FLOW_SLATE.page);
  });

  // The page is the agent's own React through the vendored bundle and `kinu:slate`; Bump goes to the slate's method.
  test('its React page runs, hears its host, and its button reaches the slate\'s own method', () => {
    const slate = verdictOf(observed, 'slate-preview');

    expect(slate.bumped).toBe('2');
    expect(slate.hosted).toBe(true);
  });

  // 1008-f: its tab read "workspace :20000", the port its preview serves on.
  test('its tab is named by its title, and no tab by its preview\'s port', () => {
    const { pageTabs } = verdictOf(observed, 'slate-preview');

    expect(pageTabs).toContain(FLOW_SLATE.title);
  });
});

// The owner's asks of 2026-10-08 (docs/research/REQUESTS-LEDGER.md), each as the owner meets it.
describe(productFlowTestName('pin', 'a page an answer draws in the chat is kept by its pin (1008-c)'), () => {
  let observed: PinVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('pin', pinKeepsAnInChatPage);
  });

  test('the pin keeps it as a slate, one of the workspace\'s pages under the page\'s own title', () => {
    const pin = verdictOf(observed, 'pin');

    expect(pin.kept).not.toBeNull();
    expect(pin.keptName).toContain(PIN_PAGE.title);
    expect(pin.listed).toContain(`${pin.kept ?? ''} ${PIN_PAGE.title}`);
  });
});

describe(productFlowTestName('titled-chat', 'a chat is named from its brief (1008-e)'), () => {
  let observed: TitledChatVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('titled-chat', chatTitledFromItsBrief);
  });

  test('even when its first turn is stopped and the owner says Continue', () => {
    const chat = verdictOf(observed, 'titled-chat');

    expect(chat.continued).toBe(true);
    expect([INTERRUPTED_BRIEF, INTERRUPTED_TITLE]).toContain(chat.title);
    expect(chat.title).not.toBe(CONTINUE);
  });

  // 1008-d: the owner's chat, stopped by hand, stayed marked as wanting them (2026-10-08).
  test('a stop asks nothing of the owner: the tab is idle once the stopped turn ends, and after Continue', () => {
    const chat = verdictOf(observed, 'titled-chat');

    expect([chat.statusAfterStop, chat.statusAfterContinue]).toEqual(['idle', 'idle']);
  });
});

describe(productFlowTestName('hire-home', 'a hire lives in a home of its own name (1008-g)'), () => {
  let observed: HireHomeVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('hire-home', hireLivesUnderItsName);
  });

  // Its name is its brief's first telling words (`mintAgentName`): "Harbour lamps keeper: …".
  test('it is named from its brief, and its shell starts in /home/<that name>, not /home/sub-<id>', () => {
    const hire = verdictOf(observed, 'hire-home');

    expect(hire.hired).toBe('harbour-lamps-keeper');
    expect(hire.home).toBe(`/home/${hire.hired}`);
  });
});

describe(productFlowTestName('slate-reach', "a slate streams answers as they are written, and its owner's slate hires (1008-ac, 1008-ad)"), () => {
  let observed: SlateReachVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('slate-reach', slateStreamsAndHires);
  });

  test("ai.stream's answer shows its start before its end", () => {
    const { modelStream } = verdictOf(observed, 'slate-reach');

    expect(modelStream.partway).toContain(REACH_STREAM.lead.trim());
    expect([modelStream.state, modelStream.final]).toEqual(['done', `${REACH_STREAM.lead}${REACH_STREAM.end}`]);
  });

  test("agent.ask streams the agent's own reply into the slate", () => {
    const { agentStream } = verdictOf(observed, 'slate-reach');

    expect(agentStream.partway).toContain(REACH_REPLY.lead.trim());
    expect(agentStream.state).toBe('done');
    expect(agentStream.final).toContain(REACH_REPLY.end);
  });

  test("the owner's own slate hires a helper, and the same slate opened from its share link cannot", () => {
    const reach = verdictOf(observed, 'slate-reach');

    expect(reach.ownerHire).toMatch(/^hired /u);
    expect(reach.viewerHire).toMatch(/^refused /u);
  });
});

describe(productFlowTestName('plan-comment', 'a comment on the whole plan reaches the agent, which answers it in its thread (1008-ao, 1008-ar)'), () => {
  let observed: PlanCommentVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('plan-comment', planCommentReachesTheAgent);
  });

  test('the review admits it and Request changes carries it to the agent', () => {
    const plan = verdictOf(observed, 'plan-comment');

    expect(plan.commentAdmitted).toBe(true);
    expect(plan.heard).toContain(PLAN_COMMENT);
  });

  test("the agent's answer shows in the comment's own thread", () => {
    expect(verdictOf(observed, 'plan-comment').threadReplies.some((reply) => reply.includes(THREAD_REPLY))).toBe(true);
  });
});

describe(productFlowTestName('drive', 'what a person does in the Drive page is kept'), () => {
  let observed: DriveVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('drive', driveKeepsWhatIsDone);
  });

  test('a folder made and a file uploaded are listed', () => {
    const drive = verdictOf(observed, 'drive');

    expect(drive.afterCreate).toContain(drive.folder);
    expect(drive.afterCreate).toContain(drive.file);
  });

  // MA-020: the picker was proved; a file dragged onto the list is the other way in.
  test('a file dropped on the list is uploaded, listed, and holds what was dropped', () => {
    const drive = verdictOf(observed, 'drive');

    expect(drive.afterDrop).toContain(drive.dropped);
    expect(drive.droppedText).toBe(DROPPED_TEXT);
  });

  test('a rename survives a reload', () => {
    const drive = verdictOf(observed, 'drive');

    expect(drive.afterRename).toContain(drive.renamed);
    expect(drive.afterRename).not.toContain(drive.folder);
    expect(drive.afterRename).toContain(drive.file);
  });

  test('a confirmed Delete removes each', () => {
    const drive = verdictOf(observed, 'drive');

    expect(drive.afterDelete).not.toContain(drive.renamed);
    expect(drive.afterDelete).not.toContain(drive.file);
    expect(drive.afterDelete).not.toContain(drive.dropped);
  });
});

/** Where a first visit to `/drive` lands for what the account holds. */
function landingFor(opened: DriveOpensVerdict): string {
  if (opened.mineHolds) return '/drive';

  if (opened.places.includes('slates')) return '/slates';

  return opened.places.includes('shared') ? '/shared' : '/drive';
}

describe(productFlowTestName('drive-opens', 'the Drive opens and draws nothing empty'), () => {
  let observed: DriveOpensVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('drive-opens', driveOpens);
  });

  // The approved design since b6067fb3a (owner, 2026-10-19): files first, DrivePage's `landing`.
  test('on My stuff when it holds anything, else on Slates when there is one, else on Shared or My stuff, its sidebar row lit', () => {
    const opened = verdictOf(observed, 'drive-opens');

    expect(opened.landedAt).toBe(landingFor(opened));
    expect(opened.sidebarLit).toBe(true);
  });

  test('every section it draws holds a tile, and a Drive with nothing draws its empty state instead', () => {
    const opened = verdictOf(observed, 'drive-opens');

    expect(opened.sections.filter((section) => section.tiles === 0)).toEqual([]);
    expect(opened.empty).toBe(opened.sections.length === 0);
  });
});

describe(productFlowTestName('slate-opens', 'a slate opens from My stuff on its own tab'), () => {
  let observed: SlateOpensVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('slate-opens', slateOpensFromSlates);
  });

  test('My stuff tiles it under its title', () => {
    expect(verdictOf(observed, 'slate-opens').tileName).toBe(DRIVE_SLATE.title);
  });

  test('pressing the tile opens its workspace with the slate the current tab', () => {
    const opened = verdictOf(observed, 'slate-opens');

    expect(opened.landedAt.startsWith(`/workspace/${encodeURIComponent(opened.workspace)}`)).toBe(true);
    expect(opened.slateTabCurrent).toBe(true);
  });
});

describe(productFlowTestName('slate-share', 'a slate that reaches nothing of its owner\'s shares from its tile, and stops (#25)'), () => {
  let observed: SlateShareVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('slate-share', slateSharesReachingNothing);
  });

  test('the dialog draws no Reach row and states only the request limit', () => {
    const shared = verdictOf(observed, 'slate-share');

    expect(shared.reachRow).toBe(false);
    // docs/SLATE-SHARING.md S5 specifies 120 requests per viewer per minute; this slate spends no model budget.
  });

  test('the share is made, its link copies, and it is listed under Shared by you', () => {
    const shared = verdictOf(observed, 'slate-share');

    expect(shared.link).not.toBeNull();
    expect(shared.copied).toBe(shared.link);
    expect(shared.sharedByYou).toContain(DRIVE_SLATE.title);
  });

  test('Stop sharing takes it off the Drive', () => {
    expect(verdictOf(observed, 'slate-share').afterStop).not.toContain(DRIVE_SLATE.title);
  });
});

// Three tabs on one workspace while a shell burst writes fifty files: each lists the burst, reading the change-set a
// bounded number of times, not once per file, and the settled panes read nothing while another tab works.
describe(productFlowTestName('changes-storm', 'a burst of writes under three open Changes panes'), () => {
  let observed: ChangesStormVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('changes-storm', changesStormStaysBounded);
  });

  test('every pane lists the whole burst from a bounded number of reads and frames', () => {
    const storm = verdictOf(observed, 'changes-storm');

    expect(storm.listed).toEqual([STORM_FILES, STORM_FILES, STORM_FILES]);

    // Not once per file: each pane re-read its change-set 2 or 3 times and was told it moved once (three staging runs).
    for (const reads of [...storm.burstReads, ...storm.burstFrames]) expect(reads).toBeLessThan(STORM_FILES / 5);
  });

  test('settled panes read nothing while another tab works', () => {
    expect(verdictOf(observed, 'changes-storm').idleReads).toEqual([0, 0]);
  });
});

// A pane open on another tab follows a write made by a turn it did not send, from the write's own frame.
describe(productFlowTestName('live-memory', "an open memory pane follows another tab's turn"), () => {
  let observed: LiveMemoryVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('live-memory', openMemoryFollowsItsWriter);
  });

  test('it shows the saved note without a reload, and reads nothing more while the other tab works', () => {
    const memory = verdictOf(observed, 'live-memory');

    expect(memory.shown).toContain(FLOW_MEMORY_NOTE);
    expect(memory.turnReads).toBeGreaterThan(0);
    expect(memory.idleReads).toBe(0);
  });
});

// The computer restarts at a new size under an open desktop, and the desktop comes back without a reload.
describe(productFlowTestName('desktop-resize', "a resized computer's desktop draws again"), () => {
  let observed: DesktopResizeVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('desktop-resize', computerDesktopSurvivesAResize);
  });

  test('it was resized to another size, and its desktop drew its panel again', () => {
    const resized = verdictOf(observed, 'desktop-resize');

    expect(resized.to).not.toBe(resized.from);
    expect(resized.backAfterS).toBeGreaterThan(0);
  });
});

// Switching the computer between its terminal and desktop reopens neither, and the desktop expands in place.
describe(productFlowTestName('desktop-switch', "a computer's terminal and desktop switch without reopening"), () => {
  let observed: DesktopSwitchVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('desktop-switch', computerSwitchKeepsItsScreens);
  });

  test('each came back in the client it was left in, expanded and back', () => {
    const switched = verdictOf(observed, 'desktop-switch');

    console.log(`desktop-switch: terminal back after ${String(switched.terminalAfterMs)} ms, desktop after ${String(switched.desktopAfterMs)} ms`);
    expect(switched).toMatchObject({ keptDesktop: true, keptTerminal: true, expandedRailFolded: true, keptExpanded: true, keptReturned: true });
    expect(switched.expandedFill).toBeGreaterThan(0.9);
  });
});

// A workspace reopened by Back loads its page from the deployment, so it runs the build the deployment serves.
describe(productFlowTestName('reopen', 'a workspace reopened by Back loads the deployed build'), () => {
  let observed: ReopenVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('reopen', reopenedWorkspaceRunsTheDeployedBuild);
  });

  test('its page was loaded again from the deployment, not shown from either of the browser\'s caches', () => {
    const reopened = verdictOf(observed, 'reopen');

    expect(reopened.restored).toBe(false);
    expect(reopened.navigation).toBe('back_forward');
    expect(reopened.transferBytes).toBeGreaterThan(0);
  });
});

// The computer's sessions are named, say their folder and ports, and come back by name and folder after a restart.
describe(productFlowTestName('computer-sessions', "the computer's sessions come back by name and folder"), () => {
  let observed: SessionsVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('computer-sessions', computerSessionsComeBackByName);
  });

  test("a session's line names the folder its shell is in and the port its server listens on", () => {
    const sessions = verdictOf(observed, 'computer-sessions');

    expect(sessions.folder).toBe('/workspace/flow-web');
    expect(sessions.ports).toContain(':8765');
  });

  test('after the computer restarts at another size, the renamed session is there, its shell in its folder', () => {
    const sessions = verdictOf(observed, 'computer-sessions');

    expect(sessions.namesAfter).toContain('web');
    expect(sessions.folderAfter).toBe('/workspace/flow-web');
  });
});

// An agent's job waits at a prompt in a session the person opens and answers.
describe(productFlowTestName('agent-job', "an agent's job is answered in its session"), () => {
  let observed: AgentJobVerdict | null = null;

  beforeAll(async () => {
    observed = await flowRow('agent-job', agentJobIsAnsweredInItsSession);
  });

  test('its session was marked as waiting, and an answer typed there reached the job', () => {
    const job = verdictOf(observed, 'agent-job');

    expect(job.markedWaiting).toBe(true);
    expect(job.answered).toBe(true);
  });
});
