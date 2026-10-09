/** Exercise the real suite's reporting order: the first flow answers, the second blocks until the runner ends it. */
import { mock } from 'bun:test';
import * as flows from '../product-flows';

process.env.KINU_ORIGIN = 'http://127.0.0.1';

await mock.module('../product-flows', () => ({
  ...flows,
  reachesHome: async (): Promise<flows.WelcomeVerdict> => ({ welcomed: false, landedAt: '/' }),
  workspaceGetsFirstAnswer: (): Promise<flows.FirstAnswerVerdict> => {
    process.stderr.write('fixture: second flow blocked\n');

    return Promise.withResolvers<flows.FirstAnswerVerdict>().promise;
  },
}));
