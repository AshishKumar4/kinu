/**
 * What the product-flows rows ask, and the calls the scripted model answers them with. Pure, so the local server and
 * the deployed tiers' Worker (`scripted-model-worker.ts`) both serve it.
 */
import { SLATES_ROOT, workspacePath, WORKSPACE_ROOT } from '../packages/core/src/vfs/workspace-path';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

/** A file name no scaffold file can carry. */
export const FLOW_PROBE = 'flow-probe.txt';

/** The file the same turn's shell writes, so Changes is shown a write no file tool made. */
export const FLOW_SHELL_PROBE = 'flow-shell-probe.txt';

/** The storm row's asks: one file that raises the Changes tab, then a burst of files from one shell command. */
export const STORM_SEED_ASK = 'Flow storm: write the seed file.';

export const STORM_ASK = 'Flow storm: write the burst.';

/** The burst's size, and the folder it lands in. */
export const STORM_FILES = 50;

export const STORM_DIR = 'storm';

/** The agent-plan row's Plan-mode ask in an added agent's pane, and the plan its turn submits. */
export const AGENT_PLAN_ASK = 'Flow agent plan: plan the release checklist.';

export const AGENT_PLAN = '# Release checklist\n\n1. Tag the build.\n2. Write the notes.';

/** The proposed-workspace row's ask in the workspace's own pane, and the workspace its turn proposes. */
export const WORKSPACE_PROPOSAL_ASK = 'Flow proposal: propose the pricing workspace.';

export const PROPOSED_WORKSPACE = {
  name: 'Flow pricing watch',
  brief: 'Flow proposal brief: watch competitor pricing.',
  soul: 'You keep notes short.',
} as const;

/** What the wake says when the owner approves, before the new workspace's link; the turn repeats the link. */
export const PROPOSAL_APPROVED_WAKE = 'Your owner approved the workspace';

export const PROPOSAL_LINK_REPLY = 'NEW WORKSPACE';

/** The account-memory row: what the owner says in one workspace, the fact its agent proposes for the account, and the
 *  ask in another workspace whose agent recalls it and repeats the value. */
export const ACCOUNT_FACT_ASK = 'Flow account memory: I live in Lisbon. Remember that for every workspace.';

export const ACCOUNT_FACT = { key: 'flow_owner_city', value: 'Lisbon' } as const;

export const ACCOUNT_RECALL_ASK = 'Flow account memory: which city do I live in?';

export const ACCOUNT_RECALL_REPLY = 'YOU LIVE IN';

/** The stack row's own fact and asks, so it never meets the Settings row's on one account. */
export const STACK_FACT_ASK = 'Flow stack memory: my editor is Helix. Remember that for every workspace.';

export const STACK_FACT = { key: 'flow_owner_editor', value: 'Helix' } as const;

export const STACK_RECALL_ASK = 'Flow stack memory: which editor do I use?';

export const STACK_RECALL_REPLY = 'YOUR EDITOR IS';

/** The approvals row's ask: one turn whose two commands each reach outside the workspace, so each parks for its owner. */
export const APPROVALS_ASK = 'Flow approvals: push and publish the release.';

/** Each trips a gate rule that reaches out (git-force-push, package-publish); neither does anything if it ran. */
export const PARKED_COMMANDS = ['git push --force origin flow-release', 'npm publish --dry-run'] as const;

/** The agent's reply to a decision's wake, before what it was told; it re-issues nothing, so nothing the row approves runs. */
export const DECISION_HEARD = 'DECISION HEARD';

/** The hire row's ask, sent to a chat agent the owner made: its command parks as the hire's own. */
export const HIRE_APPROVAL_ASK = 'Flow hire approval: push the hire release.';

/** Gated (git-force-push) and harmless by construction: /dev/null is no repository, so git pushes nothing. */
export const HIRE_PARKED_COMMAND = 'git --git-dir=/dev/null push --force origin flow-hire-release';

/** The hire's reply once its re-issued command ran; the row reads it in the hire's chat. */
export const HIRE_RAN = 'HIRE RAN';

/** The live-memory row's ask, and the note its turn saves. */
export const MEMORY_ASK = 'Flow memory: save the release note.';

export const FLOW_MEMORY_NOTE = 'The release ships on Thursday.';

/** The written-file row's one turn. */
export const WRITE_FILE_ASK = `Use your file tool to write a new file named ${FLOW_PROBE} in the workspace, `
  + 'containing exactly the words browser flow probe. Then reply with one line: DONE.';

/** The slate the slate row asks for: its manifest title, its directory, and
 *  words its page serves that no scaffold carries. */
export const FLOW_SLATE = { title: 'Flow probe', id: 'flow', page: 'browser flow slate' } as const;

/** The slate row's one turn. */
export const SLATE_ASK = `Use the file tool to create a slate at ${SLATES_ROOT}/${FLOW_SLATE.id}/. `
  + `Write package.json with main "server.ts", browser "client.tsx" and slate {"title":"${FLOW_SLATE.title}","port":8788}. `
  + 'Write server.ts with a Slate whose bump(by) method adds to a count and returns it. '
  + `Write client.tsx as a React page headed <h1>${FLOW_SLATE.page}</h1> with a Bump button that calls slate.bump. `
  + 'Start its preview. Reply with the preview URL.';

/** The slate's page: React state, a form action and the host's context, so the vendored React and `kinu:slate` both run. */
const FLOW_SLATE_CLIENT = [
  'import { useActionState, useState } from "react";',
  'import { slate, useHostContext } from "kinu:slate";',
  '',
  'export default function App() {',
  '  const host = useHostContext();',
  '  const [by] = useState(2);',
  '  const [count, bump] = useActionState(async () => slate.bump(by), 0);',
  '',
  '  return (',
  '    <form action={bump}>',
  `      <h1>${FLOW_SLATE.page}</h1>`,
  '      <output data-count>{String(count)}</output>',
  '      <p data-host>{typeof host.origin === "string" ? "hosted" : "no host"}</p>',
  '      <button type="submit">Bump</button>',
  '    </form>',
  '  );',
  '}',
  '',
].join('\n');

/** The slate turn's calls, in the order the scripted model plays them: the two files the ask names, then its preview. */
const FLOW_SLATE_CALLS: readonly ScriptedAnswer[] = [
  {
    text: 'Writing the slate.',
    toolCall: { name: 'file', arguments: { op: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/package.json`, content: JSON.stringify({
      name: FLOW_SLATE.id, main: 'server.ts', browser: 'client.tsx', slate: { title: FLOW_SLATE.title, port: 8788 },
    }, null, 2) } },
  },
  {
    toolCall: { name: 'file', arguments: { op: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/server.ts`, content: [
      'import { SlateObject } from "kinu:slate";',
      '',
      'export class Slate extends SlateObject {',
      '  count = 0;',
      '',
      '  async bump(by: number) {',
      '    this.count += by;',
      '',
      '    return this.count;',
      '  }',
      '}',
      '',
    ].join('\n') } },
  },
  { toolCall: { name: 'file', arguments: { op: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/client.tsx`, content: FLOW_SLATE_CLIENT } } },
  {
    text: 'Starting its preview.',
    toolCall: { name: 'eval', arguments: { code: `return await workspace.slates.${FLOW_SLATE.id}.$preview();` } },
  },
];

/** The hire row: its ask parks the command; the owner's approval wakes it to re-issue that once, which then runs. */
function hireApprovalScript(request: ScriptedRequest, latest: string): ScriptedAnswer | null {
  const asked = latest.includes(HIRE_APPROVAL_ASK);
  const woken = latest.includes('still not run: re-issue once') && latest.includes(HIRE_PARKED_COMMAND);

  if (!asked && !woken) return null;
  const [done] = request.turn.filter((call) => call.name === 'shell');

  if (done === undefined) return { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: HIRE_PARKED_COMMAND } } };

  if (asked) return { text: 'HIRE PARKED' };

  // Ran is git's own refusal in the result; any other answer, an empty one included, is not proof it ran.
  return { text: done.result.includes('not a git repository') ? HIRE_RAN : 'HIRE STILL BLOCKED' };
}

/** The approvals row: its turn parks both commands, and each decision's wake is answered without re-issuing anything. */
function approvalsScript(request: ScriptedRequest, latest: string): ScriptedAnswer | null {
  // The hire row's first: both answer a decision's wake, and the hire's is told by its own command.
  const hire = hireApprovalScript(request, latest);

  if (hire !== null) return hire;

  // A decision's wake names what was approved and what denied (core safety/deferred-approval.ts `decisionWakeMessage`).
  const approvedHeard = latest.includes('still not run: re-issue once');
  const deniedHeard = latest.includes('DENIED: do not re-issue');

  if (approvedHeard || deniedHeard) {
    return { text: [DECISION_HEARD, ...(approvedHeard ? ['approved'] : []), ...(deniedHeard ? ['denied'] : [])].join(' ') };
  }

  if (!latest.includes(APPROVALS_ASK)) return null;
  const next = PARKED_COMMANDS[request.turn.filter((call) => call.name === 'shell').length];

  return next === undefined ? { text: 'BOTH PARKED' } : { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: next } } };
}

/**
 * The flows' own calls, so the rows test the product and not a model's compliance: asked for a slate at /slates/flow/,
 * the real model wrote none, or wrote a React slate the ask did not name, in 2 of 6 runs (2026-09-25). Each ask gets
 * the calls it names, in order; null for every other request (titles, the mission, a one-word reply).
 */
/** The proposed-workspace row's turns: the proposal, and the reply to the wake that brings its link. */
function proposalAnswer(latest: string, request: ScriptedRequest): ScriptedAnswer | undefined {
  // The workspace's own agent proposes; the owner's approval wakes it with the link, which its reply repeats.
  const approved = latest.includes(PROPOSAL_APPROVED_WAKE) ? /\bhttps?:\/\/\S+\/workspace\/\S+/u.exec(latest)?.[0] : undefined;

  if (approved !== undefined) return { text: `${PROPOSAL_LINK_REPLY} ${approved}` };

  if (!latest.includes(WORKSPACE_PROPOSAL_ASK)) return undefined;

  return request.turn.length > 0
    ? { text: 'PROPOSED' }
    : { toolCall: { name: 'eval', arguments: { code: `return await agent.proposeWorkspace(${[PROPOSED_WORKSPACE.name, PROPOSED_WORKSPACE.brief, PROPOSED_WORKSPACE.soul].map((arg) => JSON.stringify(arg)).join(', ')});` } } };
}

/** An account-memory row's turns: propose a fact for the account, and recall it. */
interface AccountFactRow {
  readonly ask: string;
  readonly fact: { readonly key: string; readonly value: string };
  readonly recall: string;
  readonly reply: string;
}

const ACCOUNT_FACT_ROWS: readonly AccountFactRow[] = [
  { ask: ACCOUNT_FACT_ASK, fact: ACCOUNT_FACT, recall: ACCOUNT_RECALL_ASK, reply: ACCOUNT_RECALL_REPLY },
  { ask: STACK_FACT_ASK, fact: STACK_FACT, recall: STACK_RECALL_ASK, reply: STACK_RECALL_REPLY },
];

function accountMemoryAnswer(latest: string, request: ScriptedRequest): ScriptedAnswer | undefined {
  const proposing = ACCOUNT_FACT_ROWS.find((row) => latest.includes(row.ask));

  if (proposing !== undefined) {
    const { key, value } = proposing.fact;

    return request.turn.length > 0
      ? { text: 'PROPOSED FOR YOUR ACCOUNT' }
      : { toolCall: { name: 'memory', arguments: { op: 'remember', key, value, scope: 'account' } } };
  }

  const recalling = ACCOUNT_FACT_ROWS.find((row) => latest.includes(row.recall));

  if (recalling === undefined) return undefined;
  const recalled = request.turn.find((call) => call.name === 'memory');

  if (recalled === undefined) return { toolCall: { name: 'memory', arguments: { op: 'recall', key: recalling.fact.key } } };

  return { text: `${recalling.reply} ${recalled.result.includes(recalling.fact.value) ? recalling.fact.value : 'nowhere I know of'}` };
}

export function flowsScript(request: ScriptedRequest): ScriptedAnswer | null {
  const asked = (ask: string): boolean => request.userTexts.some((text) => text.includes(ask));

  if (asked(WRITE_FILE_ASK) && request.available.includes('file')) {
    if (!request.called.includes('file')) {
      return { text: 'Writing the file.', toolCall: { name: 'file', arguments: { op: 'write', path: workspacePath(FLOW_PROBE, WORKSPACE_ROOT), content: 'browser flow probe' } } };
    }

    return request.called.includes('shell') || !request.available.includes('shell')
      ? { text: 'DONE' }
      : { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: `echo from the shell > ${workspacePath(FLOW_SHELL_PROBE, WORKSPACE_ROOT)}` } } };
  }

  const latest = request.userTexts.at(-1) ?? '';

  const proposed = proposalAnswer(latest, request) ?? accountMemoryAnswer(latest, request);

  if (proposed !== undefined) return proposed;

  const approvals = approvalsScript(request, latest);

  if (approvals !== null) return approvals;

  if (latest.includes(MEMORY_ASK)) {
    return request.turn.length > 0 ? { text: 'DONE' } : { toolCall: { name: 'memory', arguments: { op: 'note', content: FLOW_MEMORY_NOTE } } };
  }

  if (latest.includes(STORM_SEED_ASK) || latest.includes(STORM_ASK)) {
    if (request.turn.length > 0) return { text: 'DONE' };

    return latest.includes(STORM_SEED_ASK)
      ? { toolCall: { name: 'file', arguments: { op: 'write', path: workspacePath('storm-seed.txt', WORKSPACE_ROOT), content: 'seed' } } }
      : { toolCall: { name: 'shell', arguments: {
        runtime: 'workspace',
        command: `mkdir -p ${STORM_DIR} && for i in $(seq 1 ${String(STORM_FILES)}); do echo $i > ${STORM_DIR}/f$i.txt; done`,
      } } };
  }

  // The agent's own Plan turn submits its plan, then says so and ends. A turn offered no submit_plan names the tools
  // it was offered, which is what a row waiting on a plan that never came needs to read (staging, 2026-10-08).
  if (latest.includes(AGENT_PLAN_ASK)) {
    if (request.called.includes('submit_plan')) return { text: 'DONE' };

    return request.available.includes('submit_plan')
      ? { toolCall: { name: 'submit_plan', arguments: { edits: [{ start: 1, content: AGENT_PLAN }] } } }
      : { text: `NO PLAN: this turn was offered no submit_plan, only ${request.available.join(', ') || 'no tools'}.` };
  }

  if (asked(SLATE_ASK) && request.available.includes('file')) {
    return FLOW_SLATE_CALLS[request.called.length] ?? { text: `The ${FLOW_SLATE.title} slate is running in its tab.` };
  }

  return null;
}
