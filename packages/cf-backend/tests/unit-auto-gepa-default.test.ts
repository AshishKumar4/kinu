// Auto-GEPA autonomous-default honesty: pre-flip explicit disables DELETED
// the config row, so an absent row is indistinguishable from never-configured
// and the default supersedes both. The first default-driven tick must pin the
// default explicitly and document the activation in the evolution stream —
// never silently re-enable.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberBody } from '@proteus/test-utils';

describe('auto-GEPA default activation (wiring)', () => {
  test('the tick pins an absent cadence row and records the override note', () => {
    const orchestrator = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
    const body = memberBody(orchestrator, 'private maybeRunAutoGepa()', 'orchestrator.ts');
    expect(body).toContain('this.config.get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns) == null');
    expect(body).toContain('this.config.setAutoGepaEveryNTurns(everyN)');
    expect(body).toContain('evolution_events');
    expect(body).toContain('superseded by this default');
  });
});
