import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { budgetBoard } from './budget-board';
import { requestLogs } from './request-logs';

defineTaskEval(defineEvalTask({
  id: 'dashboards',
  mission: "Northwind Studio's operations workspace. We track what each team spends against its monthly budget, and keep "
    + "the API gateway's request logs here to dig through when something is slow.",
  parts: [budgetBoard, requestLogs],
}));
