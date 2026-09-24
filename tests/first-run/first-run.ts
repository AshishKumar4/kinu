/**
 * THE FIRST-RUN TIER: what a new user meets, checked on the deployed product
 * after every deploy.
 *
 * WHY IT EXISTS. Between 2026-09-01 and 2026-09-03 the owner found four product
 * defects by hand that 33 gates and an 11,531-test census never touched: a
 * crafted tool whose body would not run, an Approve button that re-ticked every
 * box it had just cleared, two connected machines flapping on one executor slot,
 * and Enter not sending in the TUI. Each had a green test. Each of those tests
 * exercised what its AUTHOR wrote — an `async (args) =>` body handed to the
 * executor, a fixture queue, one fake daemon, a CR byte — and a user brings the
 * model, the click, the second machine and the LF byte instead.
 *
 * Every other gate in this repository runs BEFORE a deploy, on THIS tree, over
 * author-written inputs. `behaviour.eval.ts` drives a real model and
 * deliberately refuses instructed crafting; `live-smoke` sends one turn to prove
 * the wire. So the whole ladder can be green while the product a person meets is
 * red, and AGENTS.md already names that failure for four other gates: a gate
 * that measures a smaller set than the one it governs. This tier is the fifth
 * and the largest, and it closes it from the other side — by driving the
 * DEPLOYED product the way a user drives it.
 *
 * THE STANDING RULE THIS TIER CREATES. A defect the owner finds by hand gets a
 * first-run row BEFORE its fix ships. The row is written against the deployed
 * build that still has the bug, so it is red on the mechanism rather than on the
 * author's idea of it; the fix is what turns it green. AGENTS.md § Build & Check
 * states the same rule for whoever reaches it from that side.
 *
 * WHAT EVERY CASE IN THIS TIER HAS TO BE:
 *
 *   FRESH.      Mutating cases create a fresh workspace and delete it in finally.
 *               Explicit owned-workspace read-only cases do not use that runner:
 *               they keep user data intact and record only their actual reads.
 *   DEPLOYED.   `resolveEvalTarget` / `workerSession` resolve the target and
 *               `KinuPublicSession` drives it — the same surfaces the trajectory
 *               arm uses, reused rather than forked.
 *   HARD.       Assertions only. No statistical score, no "the reply mentioned
 *               it", no `toBeGreaterThan(0)` over a count. A first-run case that
 *               can pass on a broken product is the thing this tier exists to
 *               stop being written.
 *   PAID FOR.   Spend is recorded before any assertion can throw — a turn that
 *               ran and then failed a subgoal still burned what it burned.
 *
 * This module is the half every case shares: the plan, the corpus declaration,
 * the fresh-workspace-per-case invariant, the spend recording, the record. The
 * six cases are the `*.first-run.ts` files beside it; the credential-free
 * assertions over this wiring are `wiring.test.ts`, which runs at every tier and
 * costs nothing.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REAL_CLOCK } from '../../packages/core/src/index';
import {
  createObservedModelAccumulator, EVAL_MODELS, ledgerTotalsFromEvents, outcomeRow, scoreToolOutcomes, toolOutcomes,
  projectRunEventProvenance, publishRunRecord,
  reportLiveModelSpend, retainEpisodeTranscript, subgoalsOutcome, withEpisodeEvidence,
  type EpisodeEvidenceReader, type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalSubgoal, type EvalTier,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { disposeFailedCase } from '../evals/episode-failure';
import {
  resolvePublicSessionPlan, type KinuPublicSession, type PublicSessionPlan,
} from '../evals/public-session';

/** The family every case's record is published under, so one tier's evidence is
 *  one family rather than six. */
export const FIRST_RUN_FAMILY = 'first-run';

/** Serving models the cases reported, noted before each workspace is torn down
 *  (teardown DELETES it). One suite per process, so module scope is suite scope. */
const observedModels = createObservedModelAccumulator();

/** Every case this tier declares, in the order the defects were found. The list
 *  is DATA and lives here rather than in the six files, because "the set this
 *  tier measures equals the set it governs" is the property `wiring.test.ts`
 *  asserts, and a set spread across six modules cannot be asserted at all. */
export const FIRST_RUN_CASES = [
  'codemode-craft',
  'approve-clears',
  'two-machines',
  'enter-sends',
  'files-outside-tree',
  'slate',
  'command-refusal',
  'preview-address',
  'workspace-title',
  'snapshot-after-turn',
  'every-tool',
  'sandbox-mount-write',
  'public-share',
  'share-capability-cut',
  'blueprint-fork',
  'drive',
  'device-link',
  'background-settle',
  'background-wake',
  'delegation',
  'agent-tab',
  'agent-chats-persist',
  'agent-dismissed-chat',
  'agent-confined',
  'web-search',
  'account-settings',
  'workspace-settings',
  'machine-consent',
  'workspace-panes',
  'delegation-tree',
  'exploration',
  'deploy-door',
  'capability-isolation',
] as const;

export type FirstRunCase = (typeof FIRST_RUN_CASES)[number];

/**
 * The defect each case is red on, in the words of the person who found it, with
 * the deployed sha the red direction was proved against.
 *
 * Written down because a first-run case whose mechanism lives only in its
 * assertions is one the next person deletes as flaky. `provedRedAt` is the
 * DEPLOYED BUILD the case was run against and failed on; `null` means the red
 * direction could not be proved by re-running history and the reason is in
 * `redDirection`.
 */
export interface FirstRunDefect {
  readonly id: FirstRunCase;
  /** What the user did, and what the product did instead. */
  readonly found: string;
  /** Why every pre-deploy gate stayed green over it. */
  readonly missedBecause: string;
  /** The sha whose deployed build makes this case fail, or null with a reason. */
  readonly provedRedAt: string | null;
  readonly redDirection: string;
}

export const FIRST_RUN_DEFECTS = {
  'codemode-craft': {
    id: 'codemode-craft',
    found: 'A tool the agent built for itself would not run: the crafted body reached the '
      + 'executor and failed instead of answering.',
    missedBecause: 'every crafted-tool test hands the executor a body the TEST author wrote — an '
      + '`async (args) => …` that is valid by construction — so the one thing a user depends on, '
      + 'a body the MODEL wrote, was never executed by any suite.',
    provedRedAt: null,
    redDirection: 'RED against the deployed build at the time of writing, and it stays red until '
      + "the CraftValidation lane's rebuild on codemode's modules+prelude lands. It is written "
      + 'first and deliberately: this is the tier\'s own rule applied to itself.',
  },
  'snapshot-after-turn': {
    id: 'snapshot-after-turn',
    found: 'After the first answer, the workspace would not open: "Couldn\'t open this workspace. '
      + 'SQL query failed: no such column: actor_id", and the composer showed no model beside a '
      + 'turn that had just run.',
    missedBecause: 'the transcript table is the Agents SDK\'s, created and written by Think with no '
      + 'actor column, and Kinu read it with one. Every suite built the table from Kinu\'s own '
      + 'copy of the DDL, so the reads were never run over the shape the deployment has; nothing '
      + 'sent a turn through the product and then made the read the web app makes on open.',
    provedRedAt: '3d6edb212',
    redDirection: 'one real turn over the public socket, then `getWorkspaceSnapshot` as the web app '
      + 'calls it: it must answer, count both messages, and name a model. RED at 3d6edb212 on the '
      + 'first of the three.',
  },
  'approve-clears': {
    id: 'approve-clears',
    found: 'Approving the parked commands re-ticked every checkbox instead of clearing them, so '
      + 'the queue looked like it had refilled itself.',
    missedBecause: 'the queue\'s own tests drive the RPC and the read model, where the decided '
      + 'row does disappear. Nothing clicked the button, and the re-tick is in the component: '
      + 'selection is `null`-means-everything and the decision resets it to `null`.',
    provedRedAt: null,
    redDirection: 'both halves are asserted — the RPC half (the decided row is gone and the '
      + 'approved command then runs) and the UI half (no checkbox is left checked after the '
      + 'click). The UI half is the one that was red by hand.',
  },
  'two-machines': {
    id: 'two-machines',
    found: 'With two machines connected, two calls in one turn landed on different machines: the '
      + 'executor answered as if the account had one.',
    missedBecause: 'every device test attaches ONE fake daemon, so "the first live socket" and '
      + '"the machine the user named" are the same machine in the fixture and different machines '
      + 'in the account.',
    provedRedAt: 'd894de564',
    redDirection: 'the parent of d894de564 resolves no name: an unnamed call lands on whichever '
      + 'machine map iteration yields, and a NAMED call is not routed at all.',
  },
  'enter-sends': {
    id: 'enter-sends',
    found: 'Enter did not send in the composer on a real terminal: the draft stayed put and no '
      + 'turn ran.',
    missedBecause: 'the in-process renderer negotiates no keyboard protocol and delivered CR '
      + 'only. A tty can deliver Enter as LF, and the LF spelling hit opentui\'s default table, '
      + 'which opens a line.',
    provedRedAt: '4e1122d2d',
    redDirection: 'the parent of 4e1122d2d binds `return` only, so the LF run submits nothing '
      + 'and the deployed workspace records no user turn.',
  },
  'files-outside-tree': {
    id: 'files-outside-tree',
    found: 'Opening a hosted file in the Files tab answered EIO — "Code generation from strings '
      + 'disallowed for this context".',
    missedBecause: 'the ranged read ran `node -e` through the box\'s exec, and `node -e` compiles '
      + 'its source with `new Function`, which workerd forbids and every Node-hosted test '
      + 'allows. The whole bun suite was green over it.',
    provedRedAt: '675444233',
    redDirection: 'the parent of 675444233 has no native ranged read on the box file plane, so '
      + 'the first read of a path outside the workspace tree answers EIO on the deployment.',
  },
  'slate': {
    id: 'slate',
    found: 'An agent-built slate appears in the tab strip but its HTTP preview cannot answer.',
    missedBecause: 'Lower-level suites run projects written by test authors. They do not check '
      + 'whether files authored by the model produce a working preview.',
    provedRedAt: null,
    redDirection: 'Not proved red against a deployed sha. The first deployed tier run must '
      + 'measure listing, preview startup, and the authored HTTP response.',
  },
  'command-refusal': {
    id: 'command-refusal',
    found: 'A production slate binding and workspace executor reported a command that never ran as ordinary exit-one prose, losing the denied or waiting-for-approval class.',
    missedBecause: 'Tests checked NOT RUN prose and queue state rather than structural producer refusals; generic stdout interpretation also mistakes successful business data for errors.',
    provedRedAt: '53ba25348',
    redDirection: 'Non-model CLI REST and AgentClient calls require producer-owned refusal metadata and no execution for denied/parked commands. Executed exit-one failures and successful JSON-looking stdout are independent controls. Original 53ba25348 RED receipts remain retained unchanged.',
  },
  'public-share': {
    id: 'public-share',
    found: 'The owner asked for a live share a stranger can open without an account and call one read-only member of, with every mutating member refused unless approved by name.',
    missedBecause: 'No deployed route served a share origin: the share label parser, the grant cut and the viewer path existed in no build, so every unit and workerd proof ran against code production never had.',
    provedRedAt: 'e060e360f',
    redDirection: 'RED against the deployed e060e360f on 2026-09-15: the `share` slate op was refused as bad_input ("Expected (list | preview | … | shares) but received share"), so no URL existed to open and every later subgoal missed. Green requires the op to answer a URL a signed-out fetch serves, `probe()` to answer over a Cap\'n Web batch, and `mutate()` to be refused with the share\'s own "does not grant" reason.',
  },
  'share-capability-cut': {
    id: 'share-capability-cut',
    found: 'A public live share under a cut admitting one read member answered the read, refused the mutation with the grant code, left no owner-side effect, and refused an agent-namespace call outright.',
    missedBecause: 'Unit and harness proofs cover the grant cut and the agent refusal in isolation; nothing drove the share origin signed out and read the owner tree plus the audit row for the same episode.',
    provedRedAt: null,
    redDirection: 'Green requires the share op to answer a URL a signed-out fetch serves, probe() to answer, mutate() to refuse denied with no mark file on the owner side, ctrl() on an agents-namespace slate to refuse denied, and the audit to record the admitted read and the refused mutation. '
      + 'No deployed build carried a hole and there is no staging, so the red direction is proved at the grant itself: '
      + '`grantAdmits` admitting every member lets the viewer\'s mutate() run in packages/cf-backend/tests/workerd/slate-share.test.ts.',
  },
  'blueprint-fork': {
    id: 'blueprint-fork',
    found: 'A blueprint published from a slate carried no mapped bindings; a second workspace imported it with bindings unmapped in the read model, and mapping one to its own MCP server made the slate serve.',
    missedBecause: 'Unit proofs cover publish and admit in isolation; nothing drove the app-host publish, public read, fork, and forker-side serve for the same bytes on the deployed product.',
    provedRedAt: null,
    redDirection: 'Green requires publish to answer inspection plus link, the owner\'s Drive library to list the slate and the blueprint, the public blueprint read to name both bindings credentialed, the fork to answer two requirements with an unmapped graph problem, and hello() to answer, and the importer\'s own MCP roster to answer a list the mapping would read from.',
  },
  'drive': {
    id: 'drive',
    found: 'The Drive shipped with no live proof: its unit proofs run the SDK\'s in-memory fake and the workerd tier binds no Mossaic object, so the real tenant store, the /shared mount and the /api/drive routes had never been driven on the deployed product.',
    missedBecause: 'Every Drive suite is green over the fake; nothing opened the live tenant, put a file through the route, and read it back at /shared from a workspace shell.',
    provedRedAt: null,
    redDirection: 'Green requires GET /api/drive to list the reserved skills folder, a made folder and a put file to list back at their size and download as the same bytes, two workspaces of the owner to cat the file at /shared, a pasted skill to land under /skills as a skill on the listing and the mount, and the deletes to leave the root as found.',
  },
  'preview-address': {
    id: 'preview-address',
    found: 'Production admitted a workspace name whose length prevented every workspace preview URL.',
    missedBecause: 'Creation tests used short names; preview-only tests refused the long name after the unusable workspace already existed.',
    provedRedAt: '53ba25348',
    redDirection: 'Non-model CLI creation must reject a fresh 32-character address with the 31-character limit, while a fresh 31-character address must serve actual preview HTTP.',
  },
  'workspace-title': {
    id: 'workspace-title',
    found: 'The owned workspace registry held its generated display title, but the loaded actor status returned the workspace ID.',
    missedBecause: 'Warm or locally initialized status fixtures did not read a generated title from the real owner registry on a cold actor.',
    provedRedAt: 'b48b9bba4',
    redDirection: 'Read-only production mismatch retained by the title owner in workspace-title-production-before.json. This case selects an explicitly owned workspace with a distinct registry title, reads its loaded snapshot first, and compares without writes, eviction or model/spend claims.',
  },
  'every-tool': {
    id: 'every-tool',
    found: 'The owner asked for one fast row proving every native tool answers on the deployed '
      + 'is read back.',
    missedBecause: 'every tool has unit coverage over inputs its author wrote, and no row ever '
      + 'asked the deployed agent to use each one and then read what it left behind, so a tool '
      + 'that fails only when the MODEL calls it on the deployment was invisible to every gate.',
    provedRedAt: '234ed5d7d',
    redDirection: 'RED against the deployed 234ed5d7d on 2026-09-12: the retained transcript '
      + '(bench-artifacts/first-run-flash-1789196459812/every-tool) shows the model\'s request '
      + 'for the listing turn carrying ONE user message, the genesis signal, and none of the '
      + 'text the turn was started with, so every check but `no-agents-call` missed. '
      + 'One check per tool, each off durable state: `sees-every-tool` reds when the '
      + 'prompt hides a root tool; `file-wrote` when `file` writes nothing or the wrong bytes; '
      + '`shell-ran` when `shell` errors or drops stdout; `codemode-tool-ran` when codemode cannot '
      + 'return a string; `memory-saved-and-found` when a save or the search that should find it '
      + 'errors or comes back empty; `tasks-written` when `tasks` refuses an add; `web-fetched` '
      + 'when `web` cannot reach the health route; `every-tool-answered` names any call that '
      + 'closed with an error or a refusal; `no-unexpected-tool-failure` names any failure the '
      + 'census calls unexpected, a codemode call inside `eval` included; `reported` when the '
      + 'agent never says DONE.',
  },
  'sandbox-mount-write': {
    id: 'sandbox-mount-write',
    found: 'Writing a new file through the /sandbox mount was refused `io` — '
      + '"FileNotFoundError: File not found: /workspace/broken.mjs" — while the same '
      + 'container write through sandbox.writeFile in a program succeeded, and '
      + 'sandbox.listFiles(\'\') refused on the SDK\'s ValidationFailedError.',
    missedBecause: 'the conformance double answered a missing read with an exit code, the SDK\'s '
      + 'old contract; the deployed SDK throws FileNotFoundError, which the file view passed '
      + 'through unclassified, so the write path\'s create-vs-overwrite probe read a create as an '
      + 'I/O failure. No test ever called listFiles with an empty path.',
    provedRedAt: 'b4d2c6001',
    redDirection: 'retained run bench-artifacts/trajectory-product-1789381033344/'
      + 'public-failure-recovery/events.jsonl on 2026-09-14: event 9 is the refused create '
      + '(reason io, FileNotFoundError on a path the list at event 7 showed absent), event 12 is '
      + 'the namespace write succeeding where the mount write failed and listFiles(\'\') refusing '
      + 'on ValidationFailedError.',
  },
  'device-link': {
    id: 'device-link',
    found: 'A linked machine\'s socket dropped about forty seconds after connect, every time: '
      + 'the daemon\'s keepalive pings and the deployed hub never answers, so the daemon closes '
      + 'the live socket and redials — and a command that lands in the gap is answered with a '
      + '"needs a computer of yours" card no reconnect retires.',
    missedBecause: 'every device test asserts the link at the moment it forms — connectDevice '
      + 'waits for the first connected and stops — so a hub that cannot answer `ping` drops the '
      + 'socket at +40 s in a window nothing ever measured.',
    provedRedAt: 'c9a43fdb8',
    redDirection: 'RED against the deployed c9a43fdb8 on 2026-09-15: a real daemon under this '
      + 'repo\'s bun, a real `POST /api/cli/devices` registration, and the devices route\'s own '
      + 'stamps — `lastSeenAt` moves when the second accept lands and `connected` flickers '
      + 'through the redial gap. Green requires the link to hold the whole 50 s window, a '
      + 'command to reach the machine through a `once` consent answer, and revoke to end the '
      + 'socket and the credential.',
  },
  'background-settle': {
    id: 'background-settle',
    found: 'A `run` on the sandbox that outlived the 30s foreground window detached to a '
      + 'background job and replied with the handle — and the episode closed there. The job\'s '
      + 'settled result either never woke the agent or woke it where nothing downstream could '
      + 'see it: public-failure-recovery on c9a43fdb8 recorded the detach and no reply carrying '
      + 'the test\'s outcome.',
    missedBecause: 'the detach half is asserted in isolation everywhere the threshold is '
      + 'tested, and the wake half never was: no row asked the deployed product what a detached '
      + 'run\'s settlement does to the transcript, so a wake that never lands reads the same as '
      + 'a command still running.',
    provedRedAt: 'f1da0985f',
    redDirection: 'RED live 2026-09-15 on deployed build f1da0985f: a sleep-45-then-echo row '
      + 'against https://kinu.run held in-flight 20 min with no wake run closing and no marker '
      + 'reply — killed by the row\'s own 10 min budget at '
      + '/home/mrwhite0racle/kinu-logs/failure-recovery-live/background-settle-live.log. The '
      + 'retained c9a43fdb8 episode (bench-artifacts/trajectory-product-1789455120159/'
      + 'public-failure-recovery/events.jsonl) shows the same shape: the detached handle at '
      + 'event 20 and a ledger that closed over a still-running job.',
  },
  'background-wake': {
    id: 'background-wake',
    found: 'A multi-step turn whose activation ended mid-turn — an isolate killed, an alarm-boundary '
      + 'reset — sat un-driven: the run row stayed open with nothing scheduled to notice it. The '
      + 'turn-open wake added at 346bdced7 was released by the first tick that fired inside the turn, '
      + 'so an ordinary turn held a wake for about one second (REVIEW-chat-loop C2).',
    missedBecause: 'the wake-chain suite listed schedules right after a turn opened and never fired a '
      + 'tick with the turn parked; the workerd background-wake case holds the turn in-process and '
      + 'ends no activation; and the deployed product had no way to end one, so no row could ask it.',
    provedRedAt: 'cba44dcb9',
    redDirection: 'RED by reading on build cba44dcb9: `_kinuTerminalRetryTick` cancelled its armed row '
      + 'whenever `nextOwedAt()` was null, and an open run row is untimed, so every mid-turn tick left '
      + 'the registry empty (packages/cf-backend/src/actor-agent.ts:1929-1932 at that build). '
      + 'Unit red: unit-alarm-wake-chain "a tick that fires inside a parked turn keeps a wake row" '
      + 'found 0 rows before 154893baa. This row is the live proof; it needs the eval-only abort '
      + '(ARCHITECTURE-DECISIONS C3) to end an activation on the deployed build, so its first live '
      + 'run is on the build that carries both.',
  },
  'delegation': {
    id: 'delegation',
    found: 'A lead was asked for a helper that says one word and reports back. The owner saw the '
      + 'conversation keep gaining "system, to be shown to the agent" cards as delegation ran — '
      + 'growth with no bound anyone could name.',
    missedBecause: 'every-tool deliberately EXCLUDES hire and asserts the agents tool was never '
      + 'called; the unit proofs drive that tool against fixtures the test author wrote. Nothing '
      + 'asked the deployed agent to hire and then read back the settle, the relay, and the retire.',
    provedRedAt: 'cba44dcb9',
    redDirection: 'RED by reading on build cba44dcb9, measured 2026-09-17: the workspace\'s '
      + 'opening turn never closed inside the 20-minute case budget, no `hire` call ever '
      + 'settled, no model call was accounted, and the ledger reads hung on the unresponsive '
      + 'object until the row\'s own test bound ended it. The card ceiling never reached '
      + 'counting — the product was dead before a second turn could be sent.',
  },
  'agent-tab': {
    id: 'agent-tab',
    found: 'The "+" tab created the agent and then sat on "Disconnected · Untitled agent" over a '
      + 'skeleton: the two reads the tab makes on mount, getActorSnapshot and listAgentTasks, '
      + 'never answered.',
    missedBecause: 'the workerd proof drives hosted actors through the object and the routing '
      + 'pin proves the grammar over literals the test writes; nothing opens the actor\'s own '
      + 'socket path the way the browser does, so a client-built dead facet path stayed invisible.',
    provedRedAt: 'cba44dcb9',
    redDirection: 'RED by reading on build cba44dcb9, measured 2026-09-17, on a different link of '
      + 'the chain than reported: the transport-admitted actor path `/actor/<name>` upgraded and '
      + 'BOTH mount reads answered — proving the socket grammar was never the server\'s defect and '
      + 'B1 lives entirely in the client\'s address — but the hosted actor was already inside a '
      + 'turn when the tab\'s message landed, the send spliced mid-turn and was never answered, '
      + 'and the ledger recorded zero model calls. That is B10\'s self-feeding reactor keeping a '
      + 'hosted actor permanently busy, which is also why the owner\'s tab showed a skeleton.',
  },
  'agent-chats-persist': {
    id: 'agent-chats-persist',
    found: 'Two subagents were told to build a chess app; coming back to the workspace, the chat '
      + 'had been cleared and only the original message remained, and after visiting another '
      + 'workspace every subagent chat had disappeared. Reopened: back in the workspace only Main '
      + 'showed, in the tabs and the sidebar, until creating another agent brought the old one back.',
    missedBecause: 'reachability was derived from employability — the roster read every chat '
      + "surface makes filtered `status != 'dismissed'`, so a child's only route to a conversation "
      + 'the dismiss copy promises to keep went with its employment — and `newestId()` returned a '
      + 'stored `conversation_heads` row without asking whether it still named an entry. Reopened '
      + 'because this row read the roster over the socket, which answered in full, while the page '
      + 'threw that answer away: its reset effect bumped the roster read\'s generation after the '
      + 'sibling effect had sent it.',
    provedRedAt: 'a39effc66',
    redDirection: 'the row drops EVERY socket between the sends and the reads, so the answers come '
      + 'from durable rows rather than a live activation, then loads the page. RED by reading on '
      + 'build a39effc66, measured 2026-09-23: roster-survives and chats-reachable green, and with '
      + 'every read the page sent answered its strip and sidebar drew no agent at all.',
  },
  'agent-dismissed-chat': {
    id: 'agent-dismissed-chat',
    found: 'A subagent dismissed with its conversation kept, the Dismiss dialog\'s default, kept '
      + 'its tab but its chat never loaded: the pager refused the dismissed agent with "The actor '
      + 'is not registered in this workspace.", while the dialog promises "Its conversation is '
      + 'kept, not deleted".',
    missedBecause: '`agent-chats-persist` proves EMPLOYED agents keep their chats and never '
      + 'dismisses one, so it passes with the fix (e29da7f01) reverted. The pre-deploy half '
      + 'arrived with the fix, in packages/cf-backend/tests/workerd/public-surface.test.ts; no '
      + 'deployed row read a dismissed agent\'s kept chat the way its pane reads it.',
    provedRedAt: '5e53b4248',
    redDirection: 'Run against 5e53b4248, the parent of e29da7f01, served by `vite dev` on '
      + 'loopback (the Worker the deploy ships, with local state): `kept-chat-reads` misses on '
      + 'the refusal above. Green on e29da7f01 served the same way.',
  },
  'agent-confined': {
    id: 'agent-confined',
    found: 'Subagents were meant to be "other agents confined to the workspace itself" (the owner, '
      + '2026-07-13), and no deployed row asked any workspace but the one that made an agent about it.',
    missedBecause: 'every subagent row reads the agent from the workspace that made it, so a roster, '
      + 'a pager or a hosted room that answered another workspace\'s agent passes all of them.',
    provedRedAt: null,
    redDirection: 'Planted on a loopback `vite dev` build of this tree: a pager that falls back to '
      + 'the calling workspace\'s own chat for an actor id it never issued answers the other '
      + 'workspace, and `unreadable-elsewhere` misses. Not re-run against a deployed build: '
      + 'confinement has held on every deployed build this row could name.',
  },
  'web-search': {
    id: 'web-search',
    found: 'The owner asked for an end-to-end pass of the web search capability, and no deployed row '
      + 'ever asked the agent to search: `every-tool` fetches the product\'s own health route.',
    missedBecause: 'the search provider (Tavily with a key, DuckDuckGo without) is unit-tested over '
      + 'fixture pages, so a provider the deployment cannot reach, or a layout it no longer parses, '
      + 'is invisible until a user asks the agent to look something up.',
    provedRedAt: '41494531d',
    redDirection: 'RED on the deployed build: DuckDuckGo answers the Worker 522 or rate-limits it, so every '
      + 'search fails; it stays red until the search provider serves Worker egress. Also planted on '
      + 'loopback `vite dev`: an endpoint that does not answer leaves `searched` and `results-returned` missed.',
  },
  'account-settings': {
    id: 'account-settings',
    found: 'The welcome flow and the account settings page read and write the account itself, and no '
      + 'deployed row read or wrote it: every row opens a workspace.',
    missedBecause: 'a profile route that stopped answering, a rename that did not persist or an onboarding '
      + 'stamp that did not stick strands a person on /welcome or shows a stale name, and passed '
      + 'every workspace row.',
    provedRedAt: null,
    redDirection: 'Planted on a loopback `vite dev` build of this tree: a rename the account object '
      + 'acknowledges and does not write leaves `rename-persisted` missed.',
  },
  'workspace-settings': {
    id: 'workspace-settings',
    found: 'A workspace\'s settings page writes its name, SOUL.md, shell approval mode and advisor '
      + 'setting and exports the workspace, and no deployed row wrote a setting.',
    missedBecause: 'the chat rows read what a turn left, so a write the workspace acknowledged and then '
      + 'dropped, or a snapshot that stopped carrying the soul the page shows, passed them all.',
    provedRedAt: null,
    redDirection: 'Planted on a loopback `vite dev` build of this tree: a soul write that is acknowledged '
      + 'and never stored leaves `soul-persisted` missed.',
  },
  'machine-consent': {
    id: 'machine-consent',
    found: 'MA-041 asked for both consent branches of a cloud workspace\'s first use of the owner\'s '
      + 'machine, and no deployed row let the agent reach for a machine that was not connected, '
      + 'or let its own call raise the consent card.',
    missedBecause: 'device-link drives the Environment pane\'s RPC against a machine already attached, and '
      + 'approve-clears and two-machines grant consent before their first command, so a card that '
      + 'never showed, or a connect prompt that never came, passed them all.',
    provedRedAt: null,
    redDirection: 'Planted on a loopback `vite dev` build of this tree: a device call that skips the '
      + 'owner\'s consent leaves `consent-requested` missed.',
  },
  'workspace-panes': {
    id: 'workspace-panes',
    found: 'The Diffs, Supervise and Releases panes read a workspace\'s review baseline, run list, '
      + 'triggers and release board, and no deployed row asked any of them anything.',
    missedBecause: 'the rows that write files read them back through the Files pane and the ledger, so a '
      + 'baseline that stopped seeing a write, a run list that lost a settled turn or a board '
      + 'that stopped answering passed them all.',
    provedRedAt: null,
    redDirection: 'Planted on a loopback `vite dev` build of this tree: a review diff that reports no files '
      + 'leaves `diff-shows-the-write` missed.',
  },
  'delegation-tree': {
    id: 'delegation-tree',
    found: 'Hosted subordinates that delegate in turn, settling a tree whose branches end at '
      + 'different depths, had no deployed row: `delegation` hires at one level only.',
    missedBecause: 'a nested hire runs in a subordinate the same workspace object hosts, one delegation '
      + 'level down, and its answer reaches the root only through the middle helper\'s settlement, '
      + 'none of which a one-level hire exercises.',
    provedRedAt: '41494531d',
    redDirection: 'RED on the deployed build: a task hire settles at its helper\'s first turn end, so a helper '
      + 'that hires its own and waits for the wake reports "has been hired" upward and the nested answer never '
      + 'climbs; it stays red until a task hire waits for its helper\'s own delegated work. Also planted on '
      + 'loopback `vite dev`: a delegation budget that refuses the nested hire leaves `nested-hire-settled` missed.',
  },
  'exploration': {
    id: 'exploration',
    found: 'Exploration on the deployed product had no row that read the Swarms pane or asked '
      + 'whether a swarm\'s nodes, which run as agents of the workspace, settled.',
    missedBecause: 'the eval tier\'s swarm arm asserts a search row exists on the cloud target and reads '
      + 'neither the pane nor the nodes\' settlement, so a canvas that lost the node transcripts, '
      + 'or a node left running, passed it.',
    provedRedAt: '41494531d',
    redDirection: 'RED on the deployed build: every node errored at its 60 s budget while waiting out the '
      + 'provider\'s rate-limit backoff, which the budget counts; it stays red until a node\'s budget '
      + 'stops counting provider-mandated waits. Also planted on loopback `vite dev`: a canvas read that '
      + 'drops the node transcripts leaves `pane-shows-the-run` and `every-node-an-agent-that-settled` missed.',
  },
  'deploy-door': {
    id: 'deploy-door',
    found: 'The Cloudflare door is new surface, so no owner has driven it by hand yet. What the '
      + 'row exists for is the failure it would hide: a deployed door whose authorize URL is '
      + 'missing `code_challenge_method`, or carries an empty `client_id`, renders a working '
      + 'sign-in button and dies on Cloudflare\'s own page, where nothing of ours can see it.',
    missedBecause: 'the authorize URL is built from a deployment VAR. Every pre-deploy proof '
      + 'supplies that var itself — the unit rows call `authorizeUrl` with a literal, and the '
      + 'workerd rows bind a fake authorization server — so no gate reads the URL the deployed '
      + 'build actually mints, nor what it answers when the var is unset.',
    provedRedAt: null,
    redDirection: 'Not proved red against a deployed sha: the door has never been deployed. The '
      + 'red direction is the URL, parameter by parameter — drop `code_challenge_method` from '
      + '`authorizeUrl`, or leave `CLOUDFLARE_DEPLOY_CLIENT_ID` set to a blank string, and the '
      + 'row fails on the shape while the page still renders. The first deployed run of this '
      + 'tier is what turns that into a measurement.',
  },
  'capability-isolation': {
    id: 'capability-isolation',
    found: 'The owner asked for an object-capability model and a security verdict on it: one forbidden '
      + 'operation, tried through native tools, codemode, a child agent and a slate, refused on all four '
      + 'paths. No run had tried the same operation through all four on the product.',
    missedBecause: 'each path is proved on its own tier: bun drives the web tool and a hired child\'s, '
      + 'workerd drives `eval` and a slate\'s global fetch. A deployment whose eval sandbox or slate '
      + 'loader was composed without the egress binding would pass every one of them.',
    provedRedAt: null,
    redDirection: 'A planted hole cannot be deployed, and there is no staging. The red direction is '
      + 'proved at each enforcement point on the tier that hosts it: `assertSafeUrl` skipped in '
      + '`web/provider.ts` turns packages/cf-backend/tests/unit-capability-isolation.test.ts red on '
      + 'both web paths, and `refusedHostname` skipped in `codemode-egress.ts` turns the workerd '
      + 'codemode-sandbox and slate-egress rows red.',
  },
} satisfies Record<FirstRunCase, FirstRunDefect>;

/** Which arm this process is — the same split every sibling eval arm declares. */
export const FIRST_RUN_TIER: EvalTier = process.env.KINU_EVAL_TIER === 'pro' ? 'pro' : 'flash';

/**
 * The arm, recorded because a measurement whose mechanism was switched off is
 * not a measurement of that mechanism.
 *
 * `tools` is empty and `evolution` false for the reason the device arm states:
 * this tier drives DEPLOYED surfaces and a deployed workspace's tool surface and
 * evolution are its own durable config. Reporting a setting this tier never
 * applied would be a claim about a knob nobody turned.
 */
export const FIRST_RUN_ARM: EvalArmState = { evolution: false, settle: 'none', tools: [] };

const REPO_ROOT = join(import.meta.dirname, '../..');

/** Retained beside the record, never under a swept root — the same
 *  `resolveArtifactRoot` rule every other family states. ONE directory per
 *  suite process, resolved at import: every case retains its ledger and its
 *  transcript under it before its subgoals are asserted, and the record this
 *  process publishes names the same directory. Minting it at publish time
 *  instead makes the record point at a directory nothing has ever written
 *  into. */
const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `first-run-${FIRST_RUN_TIER}-${String(Date.now())}`,
);

/**
 * The live plan for one case, or the reason this environment has none.
 *
 * The resolution is the eval seam's, not this tier's: cloud-gated first, then
 * `resolveEvalTarget`, then the browser plane's identity. Resolved ONCE per
 * module at import so the reason is printed on the line above the skip rather
 * than inside a test nobody ran.
 */
export function firstRunPlan(suite: string): PublicSessionPlan | null {
  const resolution = resolvePublicSessionPlan(suite, EVAL_MODELS[FIRST_RUN_TIER]);

  if (resolution.kind === 'unavailable') {
    console.warn(`[skip] ${suite} — ${resolution.remedy}`);

    return null;
  }

  console.warn(`[live] ${suite} — ${resolution.plan.describe}`);

  return resolution.plan;
}


/**
 * The plan every first-run case opens, with the workspace name kept short
 * enough to delete.
 *
 * The deployment tears a workspace down through its sandbox, whose ids are
 * capped at 63 characters by the substrate itself — a longer workspace name
 * CREATES fine and then cannot be torn down, which is exactly what a tier that
 * promises "teardown in a finally" must not discover late. The resolver composes
 * `first-run-<case>-<subject>-<random>`; this wrapper trims the subject to the
 * case id alone, which keeps every case's name under the cap with room.
 */
export function firstRunCasePlan(suite: string, caseId: FirstRunCase): PublicSessionPlan | null {
  const plan = firstRunPlan(suite);

  if (plan === null) return null;

  return {
    ...plan,
    open: (request) => plan.open({ ...request, subject: SHORT_SUBJECT[caseId] }),
  };
}

/**
 * The subject each case opens its workspace under, kept to one short word.
 *
 * The resolver composes `eval-<suite-slug>-<subject>-<random>`, and the suite
 * slug alone (`first-run-files-outside-tree`) is already 26 characters — with
 * the case id repeated as the subject, every name lands at 59-63 and the longest
 * tip over the substrate's 63-character sandbox-id cap, which CREATES fine and
 * then cannot be torn down. One short word keeps the attribution (the suite
 * slug says which tier, the record says which case) and every name short.
 */
const SHORT_SUBJECT = {
  'codemode-craft': 'craft',
  'approve-clears': 'approve',
  'two-machines': 'fleet',
  'enter-sends': 'enter',
  'files-outside-tree': 'files',
  'slate': 'slate',
  'command-refusal': 'command',
  'preview-address': 'address',
  'workspace-title': 'title',
  'snapshot-after-turn': 'snapshot',
  'every-tool': 'tools',
  'sandbox-mount-write': 'mount',
  'public-share': 'public',
  'share-capability-cut': 'cut',
  'blueprint-fork': 'fork',
  'drive': 'drive',
  'device-link': 'link',
  'background-settle': 'wake',
  'background-wake': 'bgwake',
  'delegation': 'deleg',
  'agent-tab': 'tab',
  'agent-chats-persist': 'chats',
  'agent-dismissed-chat': 'kept',
  'agent-confined': 'confined',
  'web-search': 'search',
  'account-settings': 'account',
  'workspace-settings': 'settings',
  'machine-consent': 'consent',
  'workspace-panes': 'panes',
  'delegation-tree': 'tree',
  'exploration': 'swarm',
  'deploy-door': 'door',
  'capability-isolation': 'isolation',
} satisfies Record<FirstRunCase, string>;

/** What a case's body is handed, and what it hands back. */
export interface FirstRunSession extends EpisodeEvidenceReader {
  readonly describe: string;
  teardown(): Promise<void>;
}

export interface FirstRunPlan<Session extends FirstRunSession> {
  open(request: { subject: string; purpose: string; genesis?: boolean }): Promise<Session>;
}

export interface FirstRunRun<Session extends FirstRunSession = KinuPublicSession, Plan = PublicSessionPlan> {
  readonly session: Session;
  readonly plan: Plan;
  /** Aborted when the case's `budgetMs` is spent: a wait the product may
   *  never end reads this and stops, so the verdict is read off the ledger
   *  as found rather than lost to the runner's own timeout. */
  readonly budget: AbortSignal;
}

export interface FirstRunCaseSpec<Session extends FirstRunSession = KinuPublicSession, Plan = PublicSessionPlan> {
  readonly id: FirstRunCase;
  /** The mission the REST create is given — what this workspace is FOR. */
  readonly purpose: string;
  /** Omit the autonomous opening turn when the fixture needs an untouched fleet. */
  readonly genesis?: boolean;
  /** Whether the case drives the model. `expected` fails the case when its
   *  store accounted for no call, because a green over zero calls is the
   *  vacuous tier this suite was rebuilt to remove; `none` records a measured
   *  zero and fails the case if the store disagrees. */
  readonly modelCalls: 'expected' | 'none';
  /** The most wall time the case may take once its session is open. When it
   *  is spent the evidence is retained as it stands and the case fails on
   *  the budget, with `failure.json` saying so. */
  readonly budgetMs?: number;
  /** The case, driven the way a user drives it. Returns the subgoals it
   *  checked; every one of them is asserted by {@link runFirstRunCase}. */
  run(input: FirstRunRun<Session, Plan>): Promise<readonly EvalSubgoal[]>;
  /** Calls outside the workspace ledger, added to its observed tool-call count. */
  calls?(): number;
  /** The retained episode's own name, when one row runs more than once under
   *  one defect id. Each case keeps its events, history, and subgoals under
   *  `TRANSCRIPTS/<episode>/`, and two runs sharing `id` would otherwise
   *  overwrite each other's evidence — the device-link row's three cases are
   *  exactly that shape. Omit it for a row's single case; the task id remains
   *  the record's join either way. */
  readonly episode?: string;
}

/**
 * Run one first-run case against the deployed product and record it.
 *
 * THE ORDER IS THE CONTRACT, and every line of it was a defect in some sibling
 * arm before it was a rule here:
 *
 *   1. A FRESH workspace, through the public REST. Never reused between cases.
 *   2. SPEND FIRST — recorded before any assertion can throw, because what a run
 *      cost is a fact about the run rather than a reward for passing.
 *   3. THE LEDGER, READ. Turns, tool calls and tokens come off the workspace's
 *      own run-event routes, the same read the trajectory arm scores from.
 *      `turns: 0, tokensIn: 0` as literals makes every record this tier
 *      publishes INADMISSIBLE — "zero graded turns" — beside a spend line
 *      showing the eight calls it just made.
 *   4. THE EVIDENCE, RETAINED: ledger, transcript and verdicts under the
 *      directory the record names, before any verdict on them.
 *   5. THE OBSERVATION before the assertions, so a missed subgoal still reaches
 *      the record with what the case actually saw. A record that only
 *      accumulates successes is not evidence.
 *   6. EVERY subgoal asserted, each in its own failure message.
 *   7. TEARDOWN on every path — this DELETES the workspace, so a case that
 *      threw must not leave a row on the account.
 */
export async function runFirstRunCase<Session extends FirstRunSession, Plan>(
  plan: FirstRunPlan<Session> & Plan,
  spec: FirstRunCaseSpec<Session, Plan>,
  observations: EvalObservation[],
): Promise<void> {
  const startedAt = Date.now();
  let opened: Session | undefined;
  let failure: Error | null = null;

  const episode = spec.episode ?? spec.id;

  try {
    await withEpisodeEvidence(async () => {
      opened = await plan.open({ subject: spec.id, purpose: spec.purpose, genesis: spec.genesis });

      return opened;
    }, { transcripts: TRANSCRIPTS, taskId: episode, modelCalls: spec.modelCalls, clock: REAL_CLOCK, ...(spec.budgetMs !== undefined && { budgetMs: spec.budgetMs }) }, async (session, collect, budget) => {
    console.warn(`    [first-run] ${spec.id} on ${session.describe}`);
    const subgoals = await spec.run({ session, plan, budget });

    const { events, history } = await collect();
    observedModels.note(events);
    const totals = ledgerTotalsFromEvents(events);
    const retained = retainEpisodeTranscript(TRANSCRIPTS, episode, { events, history, subgoals });

    const outcome = subgoalsOutcome(subgoals, { turns: totals.turns, toolCalls: totals.toolCalls });
    // The census every other family records, off the same ledger: a subgoal met over a broken call stays visible.
    const tools = { ...scoreToolOutcomes(events), name: toolOutcomes.name, asserts: toolOutcomes.asserts };
    const scores: EvalScoreRow[] = [outcomeRow(outcome), tools];
    observations.push({
      taskId: spec.id, repetition: 0, outcome: 'scored', scores,
      turns: totals.turns, toolCalls: totals.toolCalls + (spec.calls?.() ?? 0),
      toolNames: totals.toolNames,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, reasoningOut: totals.reasoningOut,
      provenance: projectRunEventProvenance(events),
      ms: Date.now() - startedAt,
    });
    console.warn(`    [first-run] ${spec.id}: ${String(totals.turns)} turn(s), `
      + `${String(totals.toolCalls)} tool call(s), ${String(outcome.reached)}/${String(outcome.total)} `
      + `subgoals — retained at ${retained}`);

    for (const subgoal of subgoals) {
      console.warn(`    [first-run] ${spec.id}/${subgoal.what}: `
        + `${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
    }

    for (const subgoal of subgoals) {
      expectReached(spec.id, subgoal);
    }
    });
  } catch (error) {
    // THREE CAUSES AND ONE VALUE THAT NAMES WHICH — the behaviour arm's own
    // classification, reused rather than re-derived: `inert` is the product
    // producing nothing, `errored` is this harness failing, and a case the
    // ENVIRONMENT killed is neither and stays resumable.
    //
    // ONE ROW PER CASE. A case that was already scored carries its verdict
    // above — the throw after it is `expectReached` naming the miss, which the
    // outcome row holds as partial credit — so a second row here would count one
    // attempt twice and file the product's shortcoming as this harness failing.
    // Measured on 2026-09-06: the `slate` record carried `scored` (3/4) AND
    // `errored: slate/replied …` for the same pairing key.
    const thrown = error instanceof Error ? error : new Error(String(error));

    if (!observations.some((o) => o.taskId === spec.id)) {
      observations.push({
        taskId: spec.id, repetition: 0,
        outcome: disposeFailedCase(thrown).outcome,
        reason: thrown.message,
      });
    }

    failure = thrown;
  }

  // A teardown that fails is reported beside the case's own failure, never in
  // its place: on 2026-09-23 a DELETE the host never delivered replaced the
  // turn's own verdict, and the run printed only the teardown.
  try {
    await opened?.teardown();
  } catch (teardown) {
    if (failure === null) throw teardown;
    throw new AggregateError([failure, teardown], failure.message, { cause: teardown });
  }

  if (failure !== null) throw failure;
}

/**
 * A subgoal's verdict as a THROW rather than a matcher.
 *
 * This module is imported by the case files and by nothing that runs under
 * a test runner's globals, so it raises rather than reaching for `expect`: the
 * failure text is the whole point, and a plain `Error` carries it identically in
 * every runner.
 */
export function expectReached(caseId: FirstRunCase, subgoal: EvalSubgoal): void {
  if (subgoal.reached) return;
  throw new Error(`${caseId}/${subgoal.what}: ${subgoal.detail}`);
}

/** Publish with the actual selected model; an operator-only case names none. */
export function publishFirstRunRecord(
  suite: string, modelId: string | undefined, declared: readonly FirstRunCase[], observations: EvalObservation[],
): void {
  const spend = reportLiveModelSpend(suite);
  publishRunRecord({
    family: FIRST_RUN_FAMILY, tier: FIRST_RUN_TIER, modelId: modelId ?? 'no-model',
    modelObserved: observedModels.observed,
    repeats: 1, seed: 1, arm: FIRST_RUN_ARM, declaredTasks: [...declared], observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
}
