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

/** The splice row: one answer draws a page whose Ping tells the agent a word; the next turn sleeps while it is clicked. */
export const SPLICE_PAGE_ASK = 'Flow splice: draw a page with a Ping button.';

export const SPLICE_WORK_ASK = 'Flow splice: wait on the build, then say whether a ping came.';

/** What the page sends; built from two halves in the page, so its source never shows the word itself. */
export const SPLICE_SENT = 'flow-splice-ping-6b1e';

/** The work turn's words before it sleeps, and its answer once the ping reached it mid-turn. */
export const SPLICE_BEFORE = 'WAITING ON THE BUILD';

export const SPLICE_HEARD = 'PING HEARD';

/** Long enough to click the page while the turn waits on it. */
const SPLICE_SLEEP = 'sleep 25';

const SPLICE_PAGE = [
  '<slate-ui name="ping">',
  '<!doctype html><html><body><button id="ping">Ping</button><script type="module">',
  'import { workspace } from "kinu:slate";',
  `document.getElementById("ping").onclick = () => workspace.agent.send({ text: ${JSON.stringify(SPLICE_SENT.slice(0, 11))} + ${JSON.stringify(SPLICE_SENT.slice(11))} });`,
  '</script></body></html>',
  '</slate-ui>',
].join('\n');

/** The splice row's turns; a ping that reaches the agent ends its turn whether it came mid-turn or after. */
function spliceScript(request: ScriptedRequest, latest: string): ScriptedAnswer | null {
  if (latest.includes(SPLICE_SENT)) return { text: SPLICE_HEARD };

  if (latest.includes(SPLICE_PAGE_ASK)) return { text: `Here is the page.\n\n${SPLICE_PAGE}` };

  if (!latest.includes(SPLICE_WORK_ASK)) return null;

  return request.turn.length > 0
    ? { text: 'NO PING' }
    : { text: SPLICE_BEFORE, toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: SPLICE_SLEEP } } };
}

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

/** The pin row (1008-c): an answer drawing one page in the chat, whose pin keeps it as a slate of the workspace. */
export const PIN_ASK = 'Flow pin: draw the lamp list here.';

export const PIN_PAGE = { name: 'flow-lamps', title: 'Flow lamp list', body: 'flow lamp list body' } as const;

/** The interrupted-chat row (1008-e): a chat opened with this brief, its first turn stopped, then told Continue.
 *  The brief's turn runs long, so Stop is there to press; titled from the brief, it is `INTERRUPTED_TITLE`. */
export const INTERRUPTED_BRIEF = 'Flow lighthouse: log every lamp the keeper lights tonight.';

export const INTERRUPTED_TITLE = 'Flow Lamp Log';

export const CONTINUE = 'Continue';

export const CONTINUED = 'CONTINUED';

/** The hire-home row (1008-g): the owner's ask, the brief Main hires with, and the hire's own report of its home. */
export const HOME_ASK = 'Flow home: hire a keeper for the harbour lamps.';

export const HOME_BRIEF = 'Harbour lamps keeper: say where you live, then stop.';

export const HIRED = 'HIRED';

export const HOME_REPORTED = 'REPORTED HOME';

/** The reach row (1008-ac, 1008-ad): a slate whose page streams `ai.stream` and `agent.ask` answers as they are
 *  written, and hires a helper as its owner's own slate. Each answer leads with words, then pauses, then ends. */
export const REACH_SLATE = { title: 'Flow reach', id: 'flowreach' } as const;

export const REACH_SLATE_ASK = `Flow reach: build the ${REACH_SLATE.title} slate.`;

export const REACH_STREAM_PROMPT = 'Flow reach stream: count the lamps.';

export const REACH_ASK_TEXT = 'Flow reach ask: how many lamps are lit?';

export const REACH_HELPER_MISSION = 'Flow reach helper: reply DONE.';

/** Each streamed answer: its first words, then a pause long enough to read them alone, then its end. */
export const REACH_STREAM = { lead: 'Counting the lamps ', end: 'ALL TWELVE COUNTED' } as const;

export const REACH_REPLY = { lead: 'The keeper says ', end: 'TWELVE ARE LIT' } as const;

const REACH_PAUSE_MS = 8000;

/** The plan-comment row (1008-ao, 1008-ar): a plan, a comment on all of it, Request changes, and the agent's answer
 *  in that comment's thread, said before anything else. */
export const PLAN_COMMENT_ASK = 'Flow plan comment: plan the lamp rounds.';

export const PLAN_COMMENT = 'Flow global note: name who checks the lamps.';

export const THREAD_REPLY = 'The harbour keeper checks them at dusk.';

export const FEEDBACK_HEARD = 'FEEDBACK HEARD:';

const REACH_SERVER = [
  'import { SlateObject } from "kinu:slate";',
  '',
  'export class Slate extends SlateObject {',
  '  async hire() {',
  `    return await this.env.workspace.agents.hire("task", ${JSON.stringify(REACH_HELPER_MISSION)});`,
  '  }',
  '',
  '  async fetch(request: Request) {',
  '    const asked = new URL(request.url).pathname === "/ask";',
  '    const stream = asked',
  `      ? (await this.env.workspace.agent.ask({ text: ${JSON.stringify(REACH_ASK_TEXT)} })).reply`,
  `      : await this.env.workspace.ai.stream({ prompt: ${JSON.stringify(REACH_STREAM_PROMPT)} });`,
  '',
  '    return new Response(stream.pipeThrough(new TextEncoderStream()), {',
  '      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },',
  '    });',
  '  }',
  '}',
  '',
].join('\n');

const REACH_CLIENT = [
  'import { useState } from "react";',
  'import { slate } from "kinu:slate";',
  '',
  'async function read(path: string, piece: (text: string) => void) {',
  '  const response = await fetch(path);',
  '',
  '  if (!response.ok || response.body === null) throw new Error(`${path} answered ${String(response.status)}: ${await response.text()}`);',
  '  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();',
  '',
  '  for (let next = await reader.read(); !next.done; next = await reader.read()) piece(next.value);',
  '}',
  '',
  'export default function App() {',
  '  const [text, setText] = useState("");',
  '  const [state, setState] = useState("idle");',
  '  const [hired, setHired] = useState("");',
  '',
  '  const stream = (path: string) => {',
  '    setText("");',
  '    setState("streaming");',
  '    read(path, (piece) => { setText((held) => held + piece); })',
  '      .then(() => { setState("done"); }, (error: Error) => { setState("failed"); setText(error.message); });',
  '  };',
  '',
  '  const hire = () => {',
  '    slate.hire().then((value: unknown) => { setHired(`hired ${JSON.stringify(value)}`); }, (error: Error) => { setHired(`refused ${error.message}`); });',
  '  };',
  '',
  '  return (',
  '    <main>',
  `      <h1>${REACH_SLATE.title}</h1>`,
  '      <button type="button" data-stream-ai onClick={() => { stream("/ai"); }}>Stream</button>',
  '      <button type="button" data-stream-ask onClick={() => { stream("/ask"); }}>Ask</button>',
  '      <button type="button" data-hire onClick={hire}>Hire</button>',
  '      <p data-stream-state>{state}</p>',
  '      <p data-stream-text>{text}</p>',
  '      <output data-hire-result>{hired}</output>',
  '    </main>',
  '  );',
  '}',
  '',
].join('\n');

/** The reach slate's build turn, one call per request of its turn, then its end. */
function reachSlateAnswer(request: ScriptedRequest): ScriptedAnswer {
  const root = `${SLATES_ROOT}/${REACH_SLATE.id}`;
  const manifest = { name: REACH_SLATE.id, main: 'server.ts', browser: 'client.tsx', slate: { title: REACH_SLATE.title } };

  const calls: readonly ScriptedAnswer[] = [
    { toolCall: { name: 'file', arguments: { op: 'write', path: `${root}/package.json`, content: JSON.stringify(manifest, null, 2) } } },
    { toolCall: { name: 'file', arguments: { op: 'write', path: `${root}/server.ts`, content: REACH_SERVER } } },
    { toolCall: { name: 'file', arguments: { op: 'write', path: `${root}/client.tsx`, content: REACH_CLIENT } } },
    { toolCall: { name: 'eval', arguments: { code: `return await workspace.slates.${REACH_SLATE.id}.$preview();` } } },
  ];

  return calls[request.turn.length] ?? { text: `The ${REACH_SLATE.title} slate is running.` };
}

/** The owner-ask rows: each keyed by its latest ask, so a later turn of the same conversation is not replayed. */
function ownerAskAnswer(request: ScriptedRequest, latest: string): ScriptedAnswer | undefined {
  if (latest.includes(PIN_ASK)) {
    return { text: `Here it is.\n\n<slate-ui name="${PIN_PAGE.name}">\n<!doctype html><html><head><title>${PIN_PAGE.title}</title></head>`
      + `<body><h1>${PIN_PAGE.body}</h1></body></html>\n</slate-ui>` };
  }

  // A chat's titling: one completion, no tools, the mission last. The brief titles it; were Continue to, it shows.
  if (!request.streamed && request.available.length === 0 && latest.includes('Mission:\n')) {
    if (latest.includes(`Mission:\n${INTERRUPTED_BRIEF}`)) return { text: JSON.stringify({ title: INTERRUPTED_TITLE }) };

    if (latest.includes(`Mission:\n${CONTINUE}`)) return { text: JSON.stringify({ title: CONTINUE }) };
  }

  if (latest.includes(INTERRUPTED_BRIEF)) return { text: 'LAMPS LOGGED', pace: { firstTokenMs: 60_000, lead: '\n\n', leadMs: 0 } };

  if (latest === CONTINUE && request.userTexts.some((text) => text.includes(INTERRUPTED_BRIEF))) return { text: CONTINUED };

  return homeAnswer(request, latest) ?? reachAnswer(request, latest) ?? planCommentAnswer(request, latest);
}

/** The hire-home row: Main hires with the brief and names the hire; the hire runs pwd and says it; Main repeats it. */
function homeAnswer(request: ScriptedRequest, latest: string): ScriptedAnswer | undefined {
  if (latest.includes(HOME_ASK)) {
    const hired = request.turn.find((call) => call.name === 'agents');

    if (hired === undefined) return { toolCall: { name: 'agents', arguments: { op: 'hire', role: 'task', mission: HOME_BRIEF } } };

    return { text: `${HIRED} ${/"name"\s*:\s*"([^"]+)"/u.exec(hired.result)?.[1] ?? `nobody: ${hired.result.slice(0, 200)}`}` };
  }

  if (latest.includes(HOME_BRIEF)) {
    const shell = request.turn.find((call) => call.name === 'shell');

    if (shell === undefined) return { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: 'pwd' } } };

    return { text: `HOME ${/\/home\/[\w.-]+/u.exec(shell.result)?.[0] ?? `unknown: ${shell.result.slice(0, 200)}`}` };
  }

  const home = /\bHOME (\/home\/[\w.-]+)/u.exec(latest)?.[1];

  return home === undefined || latest.includes(HOME_REPORTED) ? undefined : { text: `${HOME_REPORTED} ${home}` };
}

/** The reach row: the slate's build, its `ai.stream` prompt, its `agent.ask` message, and the helper it hires. */
function reachAnswer(request: ScriptedRequest, latest: string): ScriptedAnswer | undefined {
  if (latest.includes(REACH_SLATE_ASK)) return reachSlateAnswer(request);

  if (latest.includes(REACH_STREAM_PROMPT)) return { text: REACH_STREAM.end, pace: { firstTokenMs: 0, lead: REACH_STREAM.lead, leadMs: REACH_PAUSE_MS } };

  if (latest.includes(REACH_ASK_TEXT)) return { text: REACH_REPLY.end, pace: { firstTokenMs: 0, lead: REACH_REPLY.lead, leadMs: REACH_PAUSE_MS } };

  return latest.includes(REACH_HELPER_MISSION) ? { text: 'DONE' } : undefined;
}

/** The plan-comment row: the plan, then the request for changes, answered in the comment's thread before anything. */
function planCommentAnswer(request: ScriptedRequest, latest: string): ScriptedAnswer | undefined {
  if (latest.includes(PLAN_COMMENT_ASK)) {
    if (request.turn.some((call) => call.name === 'submit_plan')) return { text: 'DONE' };

    return request.available.includes('submit_plan')
      ? { toolCall: { name: 'submit_plan', arguments: { edits: [{ start: 1, content: '# Lamp rounds\n\n1. Light the lamps.\n2. Log them.' }] } } }
      : { text: `NO PLAN: offered ${request.available.join(', ') || 'no tools'}.` };
  }

  if (!latest.startsWith('The owner requested changes to plan ')) return undefined;
  // What the feedback says of the whole plan: `- Comment <id> on the whole plan: <text>` (core plans/review.ts).
  const comment = /^- Comment (\S+) on the whole plan: (.*)$/mu.exec(latest);

  if (comment === null) return { text: `${FEEDBACK_HEARD} no comment on the whole plan` };

  if (request.turn.some((call) => call.name === 'reply_to_comment')) return { text: `${FEEDBACK_HEARD} ${comment[2] ?? ''}` };

  return request.available.includes('reply_to_comment')
    ? { toolCall: { name: 'reply_to_comment', arguments: { comment: comment[1], text: THREAD_REPLY } } }
    : { text: `${FEEDBACK_HEARD} ${comment[2] ?? ''}, but no reply_to_comment: offered ${request.available.join(', ')}` };
}

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

  const proposed = proposalAnswer(latest, request) ?? accountMemoryAnswer(latest, request) ?? ownerAskAnswer(request, latest);

  if (proposed !== undefined) return proposed;

  const approvals = approvalsScript(request, latest) ?? spliceScript(request, latest);

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
