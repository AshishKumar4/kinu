// Every model caller reports, or is named here with a reason.
//
// The workspace spend total encodes a positive claim as an ABSENCE: a producer
// with no rows never ran, rather than a producer nobody wired. That inference is
// only sound while every model-invoking seam actually reports, and the two are
// indistinguishable from the outside exactly when it matters most — a newly
// unwired spender makes the total look correct while under-counting it, which is
// the reassuring-but-wrong number this whole change exists to remove.
//
// A comment cannot hold that invariant. This does: it finds every file in the
// repo that invokes a model, and asserts each one either accepts a
// `reportModelCall` sink or is on the exemption list below with a stated reason.
// Adding a `generateText` call to a file that does neither fails here, at the
// commit that adds it, instead of silently widening the gap between the total
// and the truth.
//
// FILE granularity, deliberately. A per-function assertion needs a parse of
// every call's enclosing scope and breaks on every refactor; a per-file one
// catches the defect it is aimed at (a spender added with no sink) and survives
// the code moving around inside its module.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../..');

/**
 * The ways a model gets invoked in this repo.
 *
 * `generateText`/`streamText` are the AI SDK's text entry points and the only
 * two with call sites (`generateObject`/`streamObject`/`embedMany`: zero, and
 * `prompts/structured.ts` documents why `generateObject` is avoided on Workers
 * AI). `aiBinding.run`/`ai.toMarkdown` are the Workers AI platform bindings,
 * which the SDK never sees and which a search for SDK names alone would miss —
 * that omission is how the memory embedder stayed invisible.
 */
const INVOCATIONS = [
  /\bgenerateText\s*\(/,
  /\bstreamText\s*\(/,
  /\baiBinding\.run\s*\(/,
  /\bai\.toMarkdown\s*\(/,
];

/**
 * Files that invoke a model and legitimately do not report it.
 *
 * Every entry states WHY, and the why must be a property of the code rather
 * than a plan: "not done yet" is not an exemption, it is a failing test.
 */
const EXEMPT = {
  // A hand-rolled LanguageModelV2 transport needs no entry here and must not get
  // one: it never names an AI-SDK entry point, so the scan does not see it, and
  // the caller that drives it is the producer. `claude-cli-provider.ts` was
  // listed here until this test's own stale-exemption check rejected it.
  // `heads/head-inference.ts` was listed here and no longer is: it stopped
  // invoking a model at all when the fork/node loop was collapsed onto the turn
  // loop below, so it is out of this gate's scope rather than excused by it. Head
  // usage is still aggregated from `head_journal`, which is still its one durable
  // record.
  // THE turn loop. Its spend reaches the same log as `step_finish`, which the
  // total reads as the `agent` producer — a `model_call` row here would count
  // every step twice, and would drop a judge's cold prompt into the prefix-cache
  // window that only means something over one prompt lineage.
  'packages/core/src/chat.ts':
    'the turn loop reports through step_finish, which the total reads as `agent`',
  // The toolless rollout runs where the search runs: in the CLI's branch worker
  // process, which ships the usage back over IPC, and inline on the hosted
  // backend. Neither site holds the run-event log; `mcts/engine.ts`, the one
  // consumer, reports what comes back.
  'packages/core/src/mcts/rollout.ts':
    'the one toolless rollout for every substrate returns its usage to the caller; mcts/engine.ts reports it over reportModelCall on both backends (CLI over IPC from the branch worker, hosted inline)',
  // Runs in the CLI process BEFORE the workspace exists: `home-app.tsx:176`
  // suggests the identity, `:177` then creates the agent, so at the moment of
  // this call there is no database and no run-event log to attribute it to. Not
  // deferred work — there is no workspace whose total it belongs to.
  'packages/cli/src/agent-create.ts':
    'names a workspace before that workspace exists — CLI-process spend, not workspace spend',
} as const satisfies Readonly<Record<string, string>>;

/** Source with comments and imports removed — a mention in prose or an unused
 *  import is not a call site. Same predicate as contract-workspace-schema. */
function callableSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, '');
}

/** Every shipped source file. Tests, scripts and fixtures are excluded: a test
 *  that calls a model is not a producer of workspace spend. */
function shippedSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pattern of ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx']) {
    for (const rel of new Glob(pattern).scanSync(REPO)) {
      if (rel.includes('/tests/') || rel.endsWith('.test.ts')) continue;
      out.set(rel, callableSource(readFileSync(resolve(REPO, rel), 'utf8')));
    }
  }
  return out;
}

const sources = shippedSources();
const invokers = [...sources]
  .filter(([, text]) => INVOCATIONS.some((re) => re.test(text)))
  .map(([rel]) => rel)
  .sort();

describe('every model caller reports its usage', () => {
  test('the scan sees a real set (guards the guard)', () => {
    // A pattern list that matched nothing would make every assertion below
    // vacuous — the exact failure mode of the deleted actor-schema.ts.
    expect(sources.size).toBeGreaterThan(200);
    expect(invokers.length).toBeGreaterThanOrEqual(10);
  });

  test('no exemption names a file that stopped invoking a model', () => {
    // A stale exemption is a hole with a note on it: the file it excused is
    // gone or refactored, and the next spender added there inherits the excuse.
    expect(Object.keys(EXEMPT).filter((f) => !invokers.includes(f))).toEqual([]);
  });

  /**
   * The two shapes a reporting seam can wear, and nothing else counts.
   *
   * A seam that IS one producer names the field `reportModelCall`; a seam several
   * producers share names `spend` and takes a `ModelCallSpend`, which pairs the
   * sink with the label so neither can arrive alone. Matching the names rather
   * than parsing the call graph is deliberate: this test is aimed at "a spender
   * was added and wired to nothing", which a name check catches, and not at
   * proving a given call's attribution, which only a real workload can.
   */
  const REPORTS = /\breport(?:Facet)?ModelCall\b|\bspend:\s*\{|\bModelCallSpend\b/;

  /** Exempted paths as a membership set — the REASONS are for the reader of the
   *  map above, not for this predicate. */
  const exempted: readonly string[] = Object.keys(EXEMPT);

  test('every invoking file accepts a sink or is exempted with a reason', () => {
    const unreported = invokers.filter(
      (rel) => !exempted.includes(rel) && !REPORTS.test(sources.get(rel) ?? ''),
    );
    expect(unreported).toEqual([]);
  });
});
