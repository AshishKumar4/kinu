/**
 * The behavioural weak labeler, and the harness that scores raters against it.
 *
 * No model is involved anywhere here: the labeler is mechanical by design, and
 * the eval's raters are scripted LLMs, so the whole file runs offline and free.
 * That is a property worth pinning, not just an implementation detail — a rule
 * that consulted a model would turn the corpus into a measurement of
 * model-versus-model agreement.
 */
import { describe, expect, test } from 'bun:test';
import { createScriptedLLM } from '@proteus/test-utils';
import {
  BEHAVIOR_RULES, corpusStats, renderCorpusReport, runCorpusEval, weakLabel,
  type CorpusTurn, type TurnSignals,
} from '../src/index.js';

function turn(over: {
  id?: string;
  project?: string;
  userMessage?: string;
  assistantResponse?: string;
  followup?: string | null;
  signals?: Partial<TurnSignals>;
} = {}): CorpusTurn {
  return {
    project: over.project ?? 'proj',
    sessionId: 'sess',
    item: {
      outcomeId: over.id ?? 'proj/sess/0',
      userMessage: over.userMessage ?? 'add a cache to the token store',
      assistantResponse: over.assistantResponse ?? 'Done — added an LRU in front of it.',
      followup: over.followup === undefined ? 'and now wire it into the resolver' : over.followup,
      createdAt: 1_750_000_000_000,
    },
    signals: {
      interrupted: false,
      toolRejected: false,
      nextTurnCommands: [],
      ...over.signals,
    },
  };
}

const firedNames = (t: CorpusTurn): string[] => weakLabel(t).rules;

describe('the rules read acts, not opinions', () => {
  test('an interrupt the user came back from is a correction', () => {
    const label = weakLabel(turn({ signals: { interrupted: true }, followup: 'no, use the resolver cache' }));
    expect(label.label).toBe('corrected');
    expect(label.rules).toEqual(['interrupted']);
  });

  test('an interrupt with no follow-up settles nothing', () => {
    // Abandonment, and the classifier under test has no `abandoned` verdict to
    // be scored against — so a label here would manufacture a disagreement.
    const label = weakLabel(turn({ signals: { interrupted: true }, followup: null }));
    expect(label.label).toBeNull();
    expect(label.rules).toEqual([]);
  });

  test('a refused tool call is a correction even with no follow-up', () => {
    expect(weakLabel(turn({ signals: { toolRejected: true }, followup: null })).label).toBe('corrected');
  });

  test('a documented steer opens the follow-up, and only there', () => {
    expect(firedNames(turn({ followup: 'Wait, why are we deploying already?' }))).toContain('steering');
    expect(firedNames(turn({ followup: 'NO WAIT! roll that back' }))).toContain('steering');
    expect(firedNames(turn({ followup: 'I had to wait, but it finished' }))).not.toContain('steering');
  });

  test('shouting is two long uppercase words outside code', () => {
    expect(firedNames(turn({ followup: 'this is something we DONT WANT EVER' }))).toContain('shouted');
    // Adjacent acronyms are vocabulary, not volume — the reason the run
    // requires four letters per word.
    expect(firedNames(turn({ followup: 'should we move to the flax NNX API?' }))).not.toContain('shouted');
    expect(firedNames(turn({ followup: 'it printed `EXPECTED ACTUAL DIFF` again' }))).not.toContain('shouted');
    expect(firedNames(turn({ followup: 'the ROLLBACK never ran' }))).not.toContain('shouted');
  });

  test('a re-pasted request is a correction; a related one is not', () => {
    const ask = 'can you put everything on the dl-course repo with setup instructions?';
    expect(firedNames(turn({ userMessage: ask, followup: ask }))).toContain('repeat_ask');
    expect(firedNames(turn({
      userMessage: ask,
      followup: 'now add a section about flow matching to the same repo',
    }))).not.toContain('repeat_ask');
    // Two short messages share their few words by coincidence too often.
    expect(firedNames(turn({ userMessage: 'fix the test', followup: 'fix the test' })))
      .not.toContain('repeat_ask');
  });

  test('a revert needs both the ask and the command that ran', () => {
    const asked = { followup: 'revert that, it broke the build' };
    expect(firedNames(turn(asked))).not.toContain('reverted');
    expect(firedNames(turn({
      ...asked,
      signals: { nextTurnCommands: ['git status', 'git reset --hard HEAD~1'] },
    }))).toContain('reverted');
    // The command alone is ordinary work.
    expect(firedNames(turn({
      followup: 'now add the migration',
      signals: { nextTurnCommands: ['git restore packages/core/src/x.ts'] },
    }))).not.toContain('reverted');
  });

  test('approval is a whole message of approval, never a keyword in one', () => {
    expect(weakLabel(turn({ followup: 'perfect, thanks' })).label).toBe('accepted');
    expect(weakLabel(turn({ followup: 'Yes please' })).label).toBe('accepted');
    expect(firedNames(turn({ followup: 'great, but the tests fail' }))).not.toContain('approved');
    expect(firedNames(turn({ followup: 'not good' }))).not.toContain('approved');
  });

  test('a bare resume request vetoes rather than decides', () => {
    // The corpus's biggest confounder: an Escape for a rate limit or a reboot,
    // followed by "continue". Read naively that is a correction and it is the
    // exact opposite.
    const resumed = weakLabel(turn({ signals: { interrupted: true }, followup: 'limits were reset, continue' }));
    expect(resumed.label).toBeNull();
    expect(resumed.conflicted).toBe(true);
    expect(resumed.rules).toEqual(['interrupted', 'resumed']);

    // Alone it is still not a verdict.
    const alone = weakLabel(turn({ followup: 'please continue' }));
    expect(alone.label).toBeNull();
    expect(alone.conflicted).toBe(false);

    // An admitted mistake overrides the length bound.
    expect(weakLabel(turn({
      signals: { interrupted: true },
      followup: 'I stopped them mistakenly, please continue. Also make sure the chapters are audited ' +
        'for accuracy and the whole narrative reads cleanly end to end.',
    })).conflicted).toBe(true);
  });

  test('rules that disagree abstain rather than pick a winner', () => {
    const label = weakLabel(turn({ signals: { interrupted: true }, followup: 'perfect thanks' }));
    expect(label.rules).toEqual(['interrupted', 'approved']);
    expect(label.label).toBeNull();
    expect(label.conflicted).toBe(true);
  });

  test('rule names are unique — they are a report key across runs', () => {
    const names = BEHAVIOR_RULES.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('an ordinary follow-up fires nothing at all', () => {
    // Precision over recall: the ambiguous middle is the corpus's majority and
    // it must abstain rather than guess.
    const label = weakLabel(turn({ followup: 'now wire it into the resolver and add a test' }));
    expect(label.rules).toEqual([]);
    expect(label.label).toBeNull();
    expect(label.conflicted).toBe(false);
  });
});

describe('corpusStats counts what fired and what did not', () => {
  const turns = [
    turn({ id: 'a/s/0', project: 'a', signals: { interrupted: true }, followup: 'no, do it differently' }),
    turn({ id: 'a/s/1', project: 'a', followup: 'perfect' }),
    turn({ id: 'b/s/0', project: 'b', followup: 'and then add the index' }),
    turn({ id: 'b/s/1', project: 'b', signals: { interrupted: true }, followup: 'continue' }),
  ];
  const stats = corpusStats(turns, turns.map(weakLabel));

  test('labeled, abstained and conflicted are three distinct findings', () => {
    expect(stats.turns).toBe(4);
    expect(stats.labeled).toBe(2);
    expect(stats.abstained).toBe(1);
    expect(stats.conflicted).toBe(1);
    expect(stats.labeled + stats.abstained + stats.conflicted).toBe(stats.turns);
  });

  test('a rule reports what it fired on AND what survived the aggregate', () => {
    const interrupted = stats.byRule.find((row) => row.rule === 'interrupted');
    expect(interrupted).toMatchObject({ fired: 2, decided: 1 });
    expect(stats.byRule.find((row) => row.rule === 'resumed')).toMatchObject({ fired: 1, decided: 0 });
  });

  test('projects carry their own denominators', () => {
    expect(stats.byProject).toEqual([
      { project: 'a', turns: 2, labeled: 2, negative: 1 },
      { project: 'b', turns: 2, labeled: 0, negative: 0 },
    ]);
  });
});

// ── The eval harness ─────────────────────────────────────────────

/** Six labeled turns: three the rules called corrected, three accepted. */
const scoredTurns: CorpusTurn[] = [
  turn({ id: 'p/s/0', signals: { interrupted: true }, followup: 'no, that is wrong' }),
  turn({ id: 'p/s/1', signals: { toolRejected: true } }),
  turn({ id: 'p/s/2', followup: 'Wait, that broke the build' }),
  turn({ id: 'p/s/3', followup: 'perfect' }),
  turn({ id: 'p/s/4', followup: 'lgtm thanks' }),
  turn({ id: 'p/s/5', followup: 'nice, ship it' }),
];

describe('runCorpusEval scores raters against the rules', () => {
  test('a rater that agrees on every turn scores κ = 1', async () => {
    const labels = scoredTurns.map(weakLabel);
    const answers = labels.map((label) => `{"outcome":"${label.label}","confidence":0.9,"evidence":"x"}`);
    const report = await runCorpusEval({
      turns: scoredTurns,
      labels,
      classifier: { name: 'scripted', llm: createScriptedLLM(answers) },
      judges: [],
    });

    expect(report.classifier?.answered).toBe(6);
    expect(report.classifier?.failed).toBe(0);
    expect(report.classifier?.kappa?.value).toBeCloseTo(1, 6);
    expect(report.classifier?.accuracy?.sensitivity.mean).toBeCloseTo(1, 6);
    expect(report.classifier?.accuracy?.specificity.mean).toBeCloseTo(1, 6);
  });

  test('a rater that says "accepted" to everything scores κ = 0, not 50%', async () => {
    // Raw agreement would flatter it at 50% here. κ is the number precisely
    // because a constant rater carries no information.
    const labels = scoredTurns.map(weakLabel);
    const report = await runCorpusEval({
      turns: scoredTurns,
      labels,
      classifier: {
        name: 'always-accepted',
        llm: createScriptedLLM(labels.map(() => '{"outcome":"accepted","confidence":0.9,"evidence":"x"}')),
      },
      judges: [],
    });
    expect(report.classifier?.kappa?.value).toBeCloseTo(0, 6);
    expect(report.classifier?.accuracy?.sensitivity.mean).toBeCloseTo(0, 6);
  });

  test('only labeled turns are put to a rater', async () => {
    // The budget is spent where an answer can be checked; an abstention is not
    // a question. A scripted LLM with exactly six answers throws on a seventh.
    const withAbstentions = [...scoredTurns, turn({ id: 'p/s/6', followup: 'and now the docs' })];
    const labels = withAbstentions.map(weakLabel);
    const report = await runCorpusEval({
      turns: withAbstentions,
      labels,
      classifier: {
        name: 'scripted',
        llm: createScriptedLLM(labels.filter((l) => l.label !== null)
          .map((l) => `{"outcome":"${l.label}","confidence":0.9,"evidence":"x"}`)),
      },
      judges: [],
    });
    expect(report.stats.turns).toBe(7);
    expect(report.classifier?.answered).toBe(6);
  });

  test('a panel is unanimous or unclear, and a split is counted', async () => {
    const labels = scoredTurns.map(weakLabel);
    const agree = labels.map((l) => `{"verdict":"${l.label}"}`);
    const disagreeOnFirst = [`{"verdict":"accepted"}`, ...agree.slice(1)];
    const report = await runCorpusEval({
      turns: scoredTurns,
      labels,
      classifier: null,
      judges: [
        { spec: 'vendor-a/model', llm: createScriptedLLM(agree) },
        { spec: 'vendor-b/model', llm: createScriptedLLM(disagreeOnFirst) },
      ],
    });

    expect(report.panelSplit).toBe(1);
    expect(report.panel?.answered).toBe(6);
    expect(report.judges.map((j) => j.name)).toEqual(['vendor-a/model', 'vendor-b/model']);
    // The member that agreed with the rules everywhere beats the panel it
    // belongs to — visible, which is the point of scoring members separately.
    expect(report.judges[0].kappa?.value).toBeGreaterThan(report.panel?.kappa?.value ?? 1);
  });

  test('a rater that fails on a turn is counted, not scored as a disagreement', async () => {
    const labels = scoredTurns.map(weakLabel);
    const report = await runCorpusEval({
      turns: scoredTurns,
      labels,
      classifier: {
        name: 'flaky',
        llm: createScriptedLLM(['not json at all', ...labels.slice(1)
          .map((l) => `{"outcome":"${l.label}","confidence":0.9,"evidence":"x"}`)]),
      },
      judges: [],
    });
    expect(report.classifier?.failed).toBe(1);
    expect(report.classifier?.answered).toBe(5);
    expect(report.classifier?.kappa?.value).toBeCloseTo(1, 6);
  });

  test('one judge is not a panel', async () => {
    const labels = scoredTurns.map(weakLabel);
    const report = await runCorpusEval({
      turns: scoredTurns,
      labels,
      classifier: null,
      judges: [{ spec: 'vendor-a/model', llm: createScriptedLLM(labels.map((l) => `{"verdict":"${l.label}"}`)) }],
    });
    expect(report.panel).toBeNull();
    expect(report.judges).toHaveLength(1);
  });

  test('the pass reports what it spent, per rater', async () => {
    const labels = scoredTurns.map(weakLabel);
    const report = await runCorpusEval({
      turns: scoredTurns,
      labels,
      classifier: {
        name: 'classifier',
        llm: createScriptedLLM(labels.map((l) => `{"outcome":"${l.label}","confidence":0.9,"evidence":"x"}`)),
      },
      judges: [
        { spec: 'a/m', llm: createScriptedLLM(labels.map((l) => `{"verdict":"${l.label}"}`)) },
        { spec: 'b/m', llm: createScriptedLLM(labels.map((l) => `{"verdict":"${l.label}"}`)) },
      ],
    });

    expect(report.cost.map((row) => row.name)).toEqual(['classifier', 'a/m', 'b/m']);
    for (const row of report.cost) {
      expect(row.usage.calls).toBe(6);
      expect(row.usage.promptChars).toBeGreaterThan(0);
      expect(row.usage.responseChars).toBeGreaterThan(0);
      expect(row.estimatedTokens).toBeGreaterThan(0);
      expect(row.estimatedUsd).toBeGreaterThan(0);
    }
  });
});

describe('the report says what it cannot say', () => {
  test('every rendering carries the selection-bias and off-distribution caveats', () => {
    const labels = scoredTurns.map(weakLabel);
    const markdown = renderCorpusReport({
      stats: corpusStats(scoredTurns, labels),
      classifier: null, panel: null, judges: [], panelSplit: 0, cost: [],
    }, { title: 'T', provenance: ['- 3 session files'] });

    expect(markdown).toContain('Selection bias');
    expect(markdown).toContain('Off-distribution');
    expect(markdown).toContain('- 3 session files');
    expect(markdown).toContain('No rater was run');
    // A corrected rate is exactly what this corpus may not license.
    expect(markdown).not.toContain('per 100 turns');
  });
});
