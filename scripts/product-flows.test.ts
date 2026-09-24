/**
 * The product flows (`scripts/product-flows.ts`) in real Chrome against ONE
 * origin, `KINU_ORIGIN`: the local dev server before a deploy
 * (`bun scripts/with-dev-server.ts bun test …`) and the deployment after it
 * (`scripts/product-flows-tier.sh`). Nothing here reads which one it is.
 *
 * Every row runs in `beforeAll` and leaves a verdict or the reason it has none;
 * the tests below read only what the page showed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveWebIdentity } from '../evals/src/session';
import { withBrowser } from './live-app-harness';
import {
  FLOW_PROBE, FLOW_SLATE, INSPECTOR_SHUT_PX,
  agentIsThereOnReturn, driveKeepsWhatIsDone, reachesHome, slateShowsItsPreview, workspaceGetsFirstAnswer,
  writtenFileShowsInFilesAndDiffs,
  type AgentReturnVerdict, type DriveVerdict, type WelcomeVerdict, type FirstAnswerVerdict, type FlowTarget,
  type SlatePreviewVerdict, type WrittenFileVerdict,
} from './product-flows';
import { rowVerdicts } from './row-verdicts';

interface FlowVerdicts {
  welcome: WelcomeVerdict | null;
  firstAnswer: FirstAnswerVerdict | null;
  agentReturn: AgentReturnVerdict | null;
  writtenFile: WrittenFileVerdict | null;
  slate: SlatePreviewVerdict | null;
  drive: DriveVerdict | null;
}

const observed: FlowVerdicts = {
  welcome: null, firstAnswer: null, agentReturn: null, writtenFile: null, slate: null, drive: null,
};

/** Why no row could start: no origin, or no identity for it. */
let setup: string | null = null;

const { attempt, verdictOf, broken } = rowVerdicts('product-flows', () => setup);

beforeAll(async () => {
  const origin = process.env.KINU_ORIGIN;

  if (origin === undefined || origin === '') {
    setup = 'KINU_ORIGIN is unset: these rows drive the product at that origin — the local dev server '
      + '(`bun scripts/with-dev-server.ts`) or the deployment (`scripts/product-flows-tier.sh`).';

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
    observed.writtenFile = await attempt('written-file', () => writtenFileShowsInFilesAndDiffs(target));
    observed.slate = await attempt('slate-preview', () => slateShowsItsPreview(target));
    observed.drive = await attempt('drive', () => driveKeepsWhatIsDone(target));
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

describe('a file the agent wrote shows where a reader looks for it', () => {
  test('the Files tab lists it', () => {
    expect(verdictOf(observed.writtenFile, 'written-file').filesListed).toContain(FLOW_PROBE);
  });

  test('the Diffs tab appears and lists it as a change', () => {
    const written = verdictOf(observed.writtenFile, 'written-file');

    expect(written.diffsTab).toBe(true);
    expect(written.diffPaths.some((path) => path.endsWith(FLOW_PROBE))).toBe(true);
  });
});

describe('a slate the agent built shows its running preview', () => {
  test('its tab appears under its title and its frame shows the page it serves', () => {
    const slate = verdictOf(observed.slate, 'slate-preview');

    expect(slate.slateTab).toBe(true);
    expect(slate.frameText).toContain(FLOW_SLATE.page);
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
