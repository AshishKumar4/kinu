import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { helperReport } from './helper-report';
import { launchPrep, proofreading } from './launch-prep';

// The report part comes first: its chart checks that the workspace holds no file slate, and the launch builds two.
await defineTaskEval(defineEvalTask({
  id: 'delegation',
  modelCallPeak: {
    calls: 3,
    source: "GitHub run37880718948 candidate delegation-trial-3/ledger.jsonl: peak3 recorded Muse model_operation intervals, paired by runId+operationId and fenced at that run_end. Missing child intervals/unmatched ends are not inferred from call totals.",
  },
  mission: "Paperwing Studio's workspace. We make a notes app, launching on Friday, 12 March 2027, and answer customer "
    + 'support for Larkspur Cycles.',
  parts: [helperReport, launchPrep, proofreading],
}));
