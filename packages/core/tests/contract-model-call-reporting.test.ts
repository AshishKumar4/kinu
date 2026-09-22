// Spend total reads a producer's absence of rows as "never ran"; that holds only while every file
// invoking a model accepts a `reportModelCall` sink or is exempted below with a reason.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../..');

/** Model entry points: the AI SDK text calls plus the Workers AI bindings the SDK never sees. */
const INVOCATIONS = [
  /\bgenerateText\s*\(/,
  /\bstreamText\s*\(/,
  /\baiBinding\.run\s*\(/,
  /\bai\.toMarkdown\s*\(/,
];

/** Each reason must be a property of the code, not a plan. */
const EXEMPT = {
  // A hand-rolled LanguageModelV2 transport (`claude-cli-provider.ts`) needs no entry: its driver
  // is the producer, and the stale-exemption check rejects one.
  // A `model_call` row here would double-count every step.
  'packages/core/src/chat.ts':
    'the turn loop reports through step_finish, which the total reads as `agent`',
  'packages/core/src/mcts/rollout.ts':
    'the one toolless rollout for every substrate returns its usage to the caller; mcts/engine.ts reports it over reportModelCall on both backends (CLI over IPC from the branch worker, hosted inline)',
  'packages/cli/src/agent-create.ts':
    'names a workspace before that workspace exists — CLI-process spend, not workspace spend',
} as const satisfies Readonly<Record<string, string>>;

/** Comments and imports stripped: a mention in prose is not a call site. */
function callableSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, '');
}

/** Shipped sources only; a test calling a model is not a workspace-spend producer. */
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
    // A pattern list matching nothing would make every assertion vacuous.
    expect(sources.size).toBeGreaterThan(200);
    expect(invokers.length).toBeGreaterThanOrEqual(10);
  });

  test('no exemption names a file that stopped invoking a model', () => {
    // A stale exemption would let the next spender added there inherit the excuse.
    expect(Object.keys(EXEMPT).filter((f) => !invokers.includes(f))).toEqual([]);
  });

  /** A seam either names `reportModelCall` or takes a `ModelCallSpend` named `spend`. */
  const REPORTS = /\breport(?:Facet)?ModelCall\b|\bspend:\s*\{|\bModelCallSpend\b/;

  const exempted: readonly string[] = Object.keys(EXEMPT);

  test('every invoking file accepts a sink or is exempted with a reason', () => {
    const unreported = invokers.filter(
      (rel) => !exempted.includes(rel) && !REPORTS.test(sources.get(rel) ?? ''),
    );

    expect(unreported).toEqual([]);
  });
});
