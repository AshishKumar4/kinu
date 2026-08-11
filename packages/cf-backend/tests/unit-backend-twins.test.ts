/**
 * Twin methods — the drift inventory of logic implemented once per backend.
 *
 * A method name that exists on BOTH a cf actor class and the CLI session class
 * with no shared implementation is a drift site: the two bodies start
 * identical (createTimerTrigger, listScaffoldVersions and armCompactNow are
 * line-for-line copies today) and diverge silently, because nothing ever
 * asserts they agree. Several of the "X never worked on Y backend" defects
 * were exactly a twin whose halves drifted.
 *
 * This gate does not forbid the 54 twins that exist — they are recorded below
 * as the measured baseline. It forbids the inventory from drifting in either
 * direction:
 *
 *   a NEW twin appears      → red. Hoist the logic to core instead, or record
 *                             the twin here — a deliberate, visible decision.
 *   a recorded twin is gone → red. It was hoisted or renamed — delete its
 *                             entry, so the inventory only ever shrinks by
 *                             real hoists and the list stays the honest
 *                             measure of remaining duplication.
 *
 * Every future hoist's success criterion is an entry disappearing from this
 * list.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../..');

/** The measured twin inventory at seeding time. Shrink by hoisting. */
const KNOWN_TWINS: readonly string[] = [
  'applyScaffoldDecision',
  'armCompactNow',
  'cancelBackgroundJob',
  'cancelTrigger',
  'checkpointStatus',
  'createMCTSSession',
  'createTimerTrigger',
  'dynamicContextSnapshot',
  'effectiveModelSpec',
  'emitHeadPhase',
  'getAlwaysActiveSkills',
  'getEvolutionChangelog',
  'getReasoningEffort',
  'getReplayEvals',
  'getRunEvents',
  'getShadowStatus',
  'getShellApprovalMode',
  'getSkillsVfs',
  'getStoredModelSpec',
  'getWebSearchProvider',
  'jobResult',
  'latestAlternateTakes',
  'listBackgroundJobs',
  'listCurriculumTasks',
  'listFileCheckpoints',
  'listRecentEvents',
  'listRuns',
  'listScaffoldVersions',
  'listTriggers',
  'makeScaffoldCallTool',
  'makeScaffoldHistory',
  'makeScaffoldLLMStream',
  'markChangelogSeen',
  'pickAlternateTake',
  'planFileRestore',
  'proposeCurriculumTasks',
  'proposeScaffold',
  'readInheritedContext',
  'recordHeadsTake',
  'recordSystemPromptHash',
  'renderFactsForTurn',
  'restoreFileCheckpoint',
  'resumeBackgroundJob',
  'revertChangelogEntry',
  'runShadowEvalSampled',
  'sessionAcceptedMedia',
  'sessionContextWindow',
  'setAlwaysActiveSkills',
  'setCurriculumTaskStatus',
  'setModel',
  'setReasoningEffort',
  'setShellApprovalMode',
  'settlePendingBranches',
  'wrapToolsForBackground',
];

/** The class bodies that constitute each backend's composition surface. */
const CF_CLASSES = [
  ['packages/cf-backend/src/actor-agent.ts', 'ActorAgent'],
  ['packages/cf-backend/src/orchestrator.ts', 'OrchestratorAgent'],
  ['packages/cf-backend/src/subordinate-agent.ts', 'SubordinateAgent'],
] as const;
const CLI_CLASS = ['packages/cli-backend/src/local-session.ts', 'LocalAgentSession'] as const;

/** The brace-matched body of `class <name>` in `file`, or null. */
function classBody(file: string, name: string): string | null {
  const text = readFileSync(resolve(REPO, file), 'utf8');
  const head = new RegExp(`\\bclass\\s+${name}\\b[^{]*\\{`).exec(text);
  if (!head) return null;
  const open = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Member names declared at the top level of a class body. Nested braces
 *  (method bodies, object literals) are stripped first so closures and
 *  callback properties cannot masquerade as members. */
function methodNames(body: string): Set<string> {
  let depth = 0;
  let top = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    if (depth === 0) top += ch;
    if (ch === '}') depth--;
  }
  const names = new Set<string>();
  const member =
    /^ {2}(?:@[A-Za-z_][A-Za-z0-9_]*\((?:[^()]|\([^()]*\))*\)\s+)?(?:private |protected |public |readonly |override |static |async |get |set |\*)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>\n]*>)?\(/gm;
  for (const m of top.matchAll(member)) names.add(m[1]!);
  for (const keyword of ['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return', 'super']) {
    names.delete(keyword);
  }
  return names;
}

function scanTwins(): { cf: Set<string>; cli: Set<string>; twins: string[] } {
  const cf = new Set<string>();
  for (const [file, cls] of CF_CLASSES) {
    const body = classBody(file, cls);
    expect({ file, cls, found: body !== null }).toEqual({ file, cls, found: true });
    for (const name of methodNames(body!)) cf.add(name);
  }
  const cliBody = classBody(CLI_CLASS[0], CLI_CLASS[1]);
  expect(cliBody).not.toBeNull();
  const cli = methodNames(cliBody!);
  return { cf, cli, twins: [...cf].filter((n) => cli.has(n)).sort() };
}

describe('backend twin methods', () => {
  const { cf, cli, twins } = scanTwins();

  test('the extractor sees real class surfaces (guards the guard)', () => {
    // A broken extractor returning near-empty sets would make "no new twins"
    // pass vacuously; these floors pin it to reality.
    expect(cf.size).toBeGreaterThanOrEqual(80);
    expect(cli.size).toBeGreaterThanOrEqual(60);
    expect(twins.length).toBeGreaterThanOrEqual(40);
  });

  test('no NEW twin: logic added to both backends belongs in core', () => {
    const known = new Set(KNOWN_TWINS);
    expect(twins.filter((n) => !known.has(n))).toEqual([]);
  });

  test('no STALE entry: a hoisted twin leaves the inventory', () => {
    const seen = new Set(twins);
    expect(KNOWN_TWINS.filter((n) => !seen.has(n))).toEqual([]);
  });
});
