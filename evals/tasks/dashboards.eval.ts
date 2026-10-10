import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { budgetBoard } from './budget-board';
import { requestLogs } from './request-logs';

await defineTaskEval(defineEvalTask({
  id: 'dashboards',
  modelCallPeak: {
    calls: 1,
    source: "GitHub run37880718948 candidate dashboards-trial-5/ledger.jsonl: Muse model_operation start/end overlap; peak1 across five retained trials.",
  },
  mission: "Northwind Studio's operations workspace. We track what each team spends against its monthly budget, and keep "
    + "the API gateway's request logs here to dig through when something is slow.",
  parts: [budgetBoard, requestLogs],
}));
