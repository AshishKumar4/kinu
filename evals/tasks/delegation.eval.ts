import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { helperReport } from './helper-report';
import { launchPrep, proofreading } from './launch-prep';

// The report part comes first: its chart checks that the workspace holds no file slate, and the launch builds two.
await defineTaskEval(defineEvalTask({
  id: 'delegation',
  mission: "Paperwing Studio's workspace. We make a notes app, launching on Friday, 12 March 2027, and answer customer "
    + 'support for Larkspur Cycles.',
  parts: [helperReport, launchPrep, proofreading],
}));
