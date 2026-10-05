// An agent's debounced-drain timer is a caller that never awaits: a failure past its own handler must reach
// diagnostics, never an unhandled rejection.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { WORKSPACE_ROOT } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink, type Logger } from '@kinu.run/core/obs';

import { AgentDatabase } from '../src/agent-facet/agent-database';
import { makeCtx } from './helpers/actor-harness';

function unreachable(): never {
  throw new Error('the timer test reached the workspace');
}

describe("an agent's debounced timer", () => {
  test('a failure its handler cannot report becomes one diagnostic, not an unhandled rejection', async () => {
    const recording = createRecordingLogger();
    // The handler's own report fails: the case a timer's runner must still contain.

    const breaking: Logger = {
      ...recording,
      failure: (event, ...rest) => {
        if (event === 'agent.timer_failed') throw new Error('the diagnostics sink refused the timer failure');
        recording.failure(event, ...rest);
      },
    };

    const restore = setDiagnosticsSink(breaking);
    const unhandled: unknown[] = [];

    const onUnhandled = (...rejected: [unknown]): void => { unhandled.push(rejected[0]); };

    process.on('unhandledRejection', onUnhandled);

    try {
      const database = new AgentDatabase(makeCtx(new Database(':memory:'), 'timer-agent').storage, {
        agent: unreachable, home: WORKSPACE_ROOT, state: unreachable, enqueueTurn: unreachable, memory: unreachable, program: unreachable, sayToParent: unreachable,
      });

      database.backendHost().setTimer(async () => { throw new Error('the drain failed'); }, 0);
      await recording.until((lines) => lines.some((line) => line.event === 'effect.detached_defect'));
      await new Promise((resolve) => { setImmediate(resolve); });

      expect(recording.emitted.map((line) => line.event)).toEqual(['effect.detached_defect']);
      expect(recording.emitted[0]?.cause).toContain('the diagnostics sink refused the timer failure');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      restore();
    }
  });
});
