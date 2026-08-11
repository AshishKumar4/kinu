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
 * A shared NAME does not always mean unshared logic, though: once a driver is
 * hoisted, both backends keep the method as a transport over the one core
 * implementation. Those are recorded separately, in SHARED_TRANSPORTS, each
 * naming the core symbol it delegates to — and the gate CHECKS that claim
 * against both bodies, so an entry cannot be moved out of the twin count
 * without the delegation actually existing.
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

const REPO = resolve(import.meta.dir, '../../..');

/** The measured twin inventory at seeding time. Shrink by hoisting. */
const KNOWN_TWINS: readonly string[] = [
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
  'listTriggers',
  'makeScaffoldCallTool',
  'makeScaffoldHistory',
  'makeScaffoldLLMStream',
  'markChangelogSeen',
  'pickAlternateTake',
  'planFileRestore',
  'proposeCurriculumTasks',
  'readInheritedContext',
  'recordHeadsTake',
  'recordSystemPromptHash',
  'renderFactsForTurn',
  'restoreFileCheckpoint',
  'resumeBackgroundJob',
  'revertChangelogEntry',
  'runShadowEvalSampled',
  // The seam itself, not duplication: each backend describes the inference
  // surface a candidate scaffold runs on (its ToolSet, its history, its
  // default loop). This entry is not expected to shrink.
  'scaffoldControl',
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

/**
 * Same name on both backends, one implementation in core: the method is the
 * backend's transport for it. Each entry names the core symbol both bodies
 * must call — asserted below, so this list cannot launder a real twin.
 */
const SHARED_TRANSPORTS: Readonly<Record<string, string>> = {
  applyScaffoldDecision: 'applyScaffoldDecision',
  getGepaRuns: 'listGepaRuns',
  getShadowStatus: 'getShadowStatus',
  listScaffoldVersions: 'listScaffoldVersions',
  previewScaffoldLive: 'previewScaffoldLive',
  proposeScaffold: 'proposeScaffold',
  runScaffoldGepaOptimization: 'runScaffoldGepaOptimization',
  runScaffoldOnce: 'runScaffoldOnce',
};

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

function scanTwins(): {
  cf: Set<string>; cli: Set<string>; twins: string[]; cfBodies: string[]; cliBody: string;
} {
  const cf = new Set<string>();
  const cfBodies: string[] = [];
  for (const [file, cls] of CF_CLASSES) {
    const body = classBody(file, cls);
    expect({ file, cls, found: body !== null }).toEqual({ file, cls, found: true });
    cfBodies.push(body!);
    for (const name of methodNames(body!)) cf.add(name);
  }
  const cliBody = classBody(CLI_CLASS[0], CLI_CLASS[1]);
  expect(cliBody).not.toBeNull();
  const cli = methodNames(cliBody!);
  return { cf, cli, twins: [...cf].filter((n) => cli.has(n)).sort(), cfBodies, cliBody: cliBody! };
}

/** A bare `symbol(` call — not `this.symbol(`, not `store.symbol(`. */
function callsFreeFunction(body: string, symbol: string): boolean {
  return new RegExp(String.raw`(?<![.\w])${symbol}\s*\(`).test(body);
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

  test('every declared transport really delegates to its core symbol', () => {
    // Without this, SHARED_TRANSPORTS would be a way to assert duplication
    // away. Both sides must actually reach the named core implementation.
    const unproven = Object.entries(SHARED_TRANSPORTS)
      .filter(([, symbol]) =>
        !callsFreeFunction(cliBody, symbol) || !cfBodies.some((b) => callsFreeFunction(b, symbol)))
      .map(([name]) => name);
    expect(unproven).toEqual([]);
  });
});
