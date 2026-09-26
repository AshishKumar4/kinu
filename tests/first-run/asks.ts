/**
 * What the model-driven first-run cases say to the agent, in a module with no side effects. Each case sends its words
 * from here, and the tier's scripted model (`scripted.ts`) recognizes the same words: a case module resolves its live
 * plan at import, so the model cannot read them from the case.
 */

/** background-settle: the word the detached command prints after its sleep, which a settled wake must carry back to
 *  the assistant's transcript. */
export const SETTLE_MARKER = 'KINU_SETTLED_AFTER_DETACH';

export const SETTLE_ASK = `Use your shell tool with runtime 'sandbox' to execute exactly: sleep 45 && echo ${SETTLE_MARKER}. `
  + 'The command sleeps before it prints — let it run to completion, do not kill it. '
  + 'When it has finished, tell me the marker it printed.';

/** background-wake: the three commands the turn runs, one call each: what "no tool ran twice" is counted over. */
export const WAKE_STEPS = ['KINU_WAKE_STEP_ONE', 'KINU_WAKE_STEP_TWO', 'KINU_WAKE_STEP_THREE'] as const;

export const WAKE_ASK = `Use your run tool with runtime 'workspace' three times, one command per call, in this order, `
  + `and wait for each result before the next: echo ${WAKE_STEPS[0]}; then echo ${WAKE_STEPS[1]}; then echo ${WAKE_STEPS[2]}. `
  + 'Do not combine them into one command. When all three have printed, reply with exactly the three '
  + 'words they printed, one per line, and nothing else.';

/** capability-isolation: an address inside the private network, which every path must refuse. */
export const INTERNAL_URL = 'http://10.0.0.1/status';

/** capability-isolation: the eval program, which returns what its fetch threw. */
export const INTERNAL_FETCH_PROGRAM = `try { await fetch('${INTERNAL_URL}'); return 'reached'; } catch (e) { return 'threw: ' + e.message; }`;

/** capability-isolation: the hired helper's mission, the third path. */
export const INTERNAL_FETCH_MISSION = `With your web tool, fetch ${INTERNAL_URL} once, then reply with only the error text the tool gave you.`;

export const ISOLATION_ASK = 'This workspace must not reach addresses inside our private network, and I am checking that it cannot. '
  + 'Use each of these tools exactly once, in this order, and report what each one said. '
  + `1. With the web tool, fetch ${INTERNAL_URL} `
  + `2. With eval, run exactly this program: ${INTERNAL_FETCH_PROGRAM} `
  + '3. With your agents tool, hire one helper: action hire, lifetime task, role task, mission '
  + `"${INTERNAL_FETCH_MISSION}" `
  + 'When all three are done, reply with ONE line that starts with DONE.';

/** delegation: the one word the task helper is told to say and the root is told to relay. */
export const DELEGATION_WORD = 'bramblelight';

/** A helper's whole mission: say one word. The delegation cases hire helpers with it. */
export function sayWordMission(word: string): string {
  return `Reply with exactly the word ${word} and nothing else.`;
}

export const DELEGATION_TASK_ASK = 'Use your agents tool to hire one helper: action hire, lifetime task, role task, '
  + `mission "${sayWordMission(DELEGATION_WORD)}" `
  + 'The hire waits for its single answer and returns it in the call result. '
  + 'When it answers, reply with one line: HIRED <its answer>.';

/** delegation: the durable helper's mission. */
export const STANDBY_MISSION = 'Stand by for one question.';

export const DELEGATION_ROSTER_ASK = 'Use your agents tool to hire one durable helper: action hire, role task, '
  + `mission "${STANDBY_MISSION}" A durable hire omits the lifetime field and stays `
  + 'in the roster. Then list the roster (agents action list) and reply with one line: '
  + 'ROSTER <every name the roster shows>.';

/** delegation: retire the durable helper by the name the roster gave it. */
export function delegationDismissAsk(name: string): string {
  return `Dismiss the durable helper with your agents tool: action dismiss, agent ${JSON.stringify(name)}. `
    + 'Then list the roster (agents action list) and reply with one line: RETIRED.';
}

/** delegation-tree: the word the deep helper says, two levels below the root. */
export const TREE_DEEP_WORD = 'emberfall';

/** delegation-tree: the word the shallow helper says, one level below the root. */
export const TREE_SHALLOW_WORD = 'tidewater';

/** delegation-tree: the first helper's mission, which hires the deep helper and relays its answer. */
export const RELAY_MISSION = 'Use your agents tool to hire one helper with action hire, lifetime task '
  + `and role task, whose mission is: ${sayWordMission(TREE_DEEP_WORD)} When it `
  + 'answers, reply with exactly its answer and nothing else.';

export const TREE_ASK = 'Use your agents tool to hire two helpers, each with action hire, lifetime task and role task. '
  + `The first helper's mission: "${RELAY_MISSION}" `
  + `The second helper's mission: "${sayWordMission(TREE_SHALLOW_WORD)}" `
  + 'When both have answered, reply with one line: TREE <first helper\'s answer> <second helper\'s answer>.';

/** exploration: what every node of the swarm is asked. */
export const SWARM_TASK = 'Name one fruit whose skin is yellow. Report only the fruit\'s name.';

export const SWARM_ASK = `Use your agents tool with action swarm and preset ideate, with this task: "${SWARM_TASK}" `
  + 'When the swarm settles, reply with one line: SWARM <the names it returned>.';

export const CONSENT_ASK = 'Use the shell tool with runtime "device" to run the command `hostname` on my computer, '
  + 'even if you expect it to fail. Then reply with one line: HOST <what it printed>, or NONE if nothing ran.';

/** sandbox-mount-write: the mounted path the defect named, and the bytes this case chose. */
export const MOUNT_TARGET = '/sandbox/workspace/first-run-mount.mjs';

export const MOUNT_BYTES = 'export const firstRun = "KINU_SANDBOX_MOUNT_OK";\n';

/** sandbox-mount-write: the turn's marker, so its own events can be picked out of the workspace's log; the genesis
 *  turn's events are not this case's evidence. */
export const MOUNT_MARK = 'MOUNT-WRITE-PROBE';

/** sandbox-mount-write: the empty-path namespace listing the failed run made. */
export const MOUNT_LISTING_PROGRAM = 'const ls = await sandbox.listFiles(\'\'); return ls;';

/** One turn that does the whole defect: the listing, the create, the read-back and the empty-path namespace
 *  listing, the same calls the failed run made. */
export const MOUNT_ASK = `This turn is identified by ${MOUNT_MARK}. Do all of this, in order, without `
  + 'narrating:\n'
  + `1. With the file tool, list ${MOUNT_TARGET.slice(0, MOUNT_TARGET.lastIndexOf('/'))} — it should be empty.\n`
  + `2. With the file tool, write ${MOUNT_TARGET} containing exactly these bytes:\n${MOUNT_BYTES}`
  + '3. With the file tool, read that path back.\n'
  + `4. With eval, run: ${MOUNT_LISTING_PROGRAM}\n`
  + 'Then answer with one line naming the file you wrote.';

/**
 * two-machines: the two machines, by the names a person would type.
 *
 * Deliberately unlike each other and unlike any hostname on the box: the reply
 * has to carry ONE of them, and two names that share a prefix would let a
 * substring check pass on the wrong machine.
 */
export const FLEET_ALPHA = 'kinu-first-run-alpha';

export const FLEET_BETA = 'kinu-first-run-beta';

/** two-machines: an ask that names no machine. */
export const UNNAMED_MACHINE_ASK = 'Run hostname on my device and reply with exactly what it printed. '
  + 'Do not run it on more than one machine: if my words do not settle which one, '
  + 'ask me which one.';

/** two-machines: an ask that names alpha. */
export const NAMED_MACHINE_ASK = `Run the command hostname on my machine called ${FLEET_ALPHA}, and reply with exactly what `
  + 'it printed and nothing else.';

export const SEARCH_QUERY = 'Cloudflare Durable Objects documentation';

export const SEARCH_ASK = `With the web tool, search the web for "${SEARCH_QUERY}". Then reply with ONE line: `
  + 'the URL of the FIRST result, exactly as the search gave it.';

/** workspace-panes: the file the turn writes, named so no scaffold file can be it. */
export const PANES_PROBE = 'panes-probe.txt';

export const PANES_ASK = `Use your file tool to write a new file named ${PANES_PROBE} in the workspace, `
  + 'containing exactly the words panes probe. Then reply with one line: DONE.';

/** every-tool: what each call leaves where the case reads it back. */
export const TOOLS_PROBE_PATH = '/home/main/tools-probe.txt';

export const TOOLS_PROBE_BYTES = 'KINU-EVERY-TOOL';

export const TOOLS_RUN_MARK = 'tools-probe-ok';

export const TOOLS_CODEMODE_MARK = 'codemode-ok';

export const TOOLS_FACT = 'every-tool probe: ok';

export const TOOLS_TASK_TITLE = 'every-tool probe';

export const TOOLS_HEALTH_URL = 'https://kinu.run/api/health';

export const TOOLS_LIST_ASK = 'List every tool you can call right now, one per line, names only, nothing else.';

export const TOOLS_USE_ASK = 'Use each of these tools exactly once, in this order, then answer. '
  + `1. With the file tool, write ${TOOLS_PROBE_PATH} containing exactly ${TOOLS_PROBE_BYTES} and nothing else. `
  + `2. With the shell tool in the workspace runtime, run: echo ${TOOLS_RUN_MARK} `
  + `3. With eval, run a one-line program that returns the string "${TOOLS_CODEMODE_MARK}". `
  + `4. With the memory tool, save the fact "${TOOLS_FACT}", then search memory for "${TOOLS_TASK_TITLE}". `
  + `5. With the tasks tool, add one task titled "${TOOLS_TASK_TITLE}". `
  + `6. With the web tool, fetch ${TOOLS_HEALTH_URL} and read its "ok" field. `
  + 'Do not use the agents tool. When all six are done, reply with ONE line that starts with DONE '
  + 'followed by the six results in order.';

/** slate: the slate the turn builds, by its id. */
export const HELLO_SLATE_ID = 'hello';

export const HELLO_SLATE_ASK = `Use the file tool to create a slate at /slates/${HELLO_SLATE_ID}/. `
  + 'Write package.json with main "server.ts" and slate {"title":"Hello","port":8787,"bindings":{}}. '
  + 'Write server.ts so the slate answers GET /ping with JSON '
  + '{"message":"pong","method":request.method,"path":new URL(request.url).pathname} '
  + 'and HTTP 404 for other paths. Start its preview yourself and verify GET /ping. '
  + 'Reply with pong on its own line and the working preview URL.';

/**
 * codemode-craft: the input, and the answer computed without the product.
 *
 * Not something a model can produce by pattern rather than by running the tool,
 * and colliding with no number the surrounding prose contains. The tool is
 * asked for a SUM OF DIGITS, which is a real loop — a body with no branch or
 * accumulator cannot answer it.
 */
export const CRAFT_INPUT = '4827516390';

/** 4+8+2+7+5+1+6+3+9+0 = 45, computed here from the string above, never read back off the deployment. */
export const CRAFT_ANSWER = CRAFT_INPUT.split('').reduce((sum, digit) => sum + Number(digit), 0);

/**
 * The ask, in the words a person uses.
 *
 * It names the CAPABILITY ("a reusable tool of your own") and the OUTCOME ("the
 * number on its own line"), and nothing else: no function signature, no
 * `createTool`, no mention of codemode.
 */
export const CRAFT_ASK = 'Build yourself a small reusable tool that adds up the digits of a number, then '
  + `use that tool on ${CRAFT_INPUT} and reply with the resulting number on its own line. `
  + 'Do the arithmetic with the tool rather than in your head.';
