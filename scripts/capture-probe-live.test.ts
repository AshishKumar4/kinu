import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  PROBE_SANDBOX_IMAGE,
  TeardownLedger,
  lastNonEmptyLine,
  materializeConfig,
  parseProbeReply,
  planLiveRun,
  removeGeneratedConfig,
  renderWranglerConfig,
  verifyIdempotentDestroy,
  type TeardownStep,
} from './fixtures/capture-probe/live-run';

const WORKER_SOURCE = readFileSync(new URL('./fixtures/capture-probe/worker.ts', import.meta.url), 'utf8');

describe('the ephemeral live probe run', () => {
  test('two plans never collide and each carries its own temp config home', () => {
    const first = planLiveRun();
    const second = planLiveRun();
    try {
      expect(first.workerName).not.toBe(second.workerName);
      expect(first.token).not.toBe(second.token);
      expect(first.configPath).not.toBe(second.configPath);
      expect(first.workerName.startsWith('kinu-capture-probe-')).toBe(true);
      expect(first.containerAppName).toBe(`${first.workerName}-captureprobebox`);
      expect(first.token.startsWith('capture-probe-')).toBe(true);
    } finally {
      removeGeneratedConfig(first);
      removeGeneratedConfig(second);
    }
  });
  test('the generated config pins the platform, names the run, and holds NO secret', () => {
    const plan = planLiveRun();
    const repoRoot = new URL('../', import.meta.url).pathname;
    const rendered = renderWranglerConfig(plan, repoRoot, '/abs/worker.ts');
    expect(rendered).toContain(plan.workerName);
    expect(rendered).toContain(PROBE_SANDBOX_IMAGE);
    expect(rendered).toContain('"new_sqlite_classes"');
    expect(rendered).toContain('"workers_dev": true');
    expect(rendered).toContain('"memory_mib": 6144');
    // The bearer token travels through --var; a token in the file would be a
    // secret that outlives a crash.
    expect(rendered.includes(plan.token)).toBe(false);

    materializeConfig(plan, repoRoot, '/abs/worker.ts');
    expect(readFileSync(plan.configPath, 'utf8')).toBe(rendered);
    removeGeneratedConfig(plan);
  });

  test('the teardown ledger runs every step twice and reports second-pass failures', async () => {
    const calls: string[] = [];
    const ledger = new TeardownLedger();
    ledger.register({ name: 'a', run: async () => { calls.push('a'); return 'gone'; } });
    ledger.register({ name: 'b', run: async () => { calls.push('b'); return 'gone'; } });

    const report = await ledger.executeAndVerify(() => {});
    expect(calls).toEqual(['b', 'a', 'b', 'a']); // reverse order, then again
    expect(report.failures).toEqual([]);
    expect(report.passes.map((row) => row.name)).toEqual(['b', 'a', 'again/b', 'again/a']);

    // The once-guard: signal-path re-entry after executeAndVerify is a no-op.
    await ledger.executeAndVerify(() => {});
    expect(calls).toEqual(['b', 'a', 'b', 'a']);
  });

  test('registered fixture resources teardown in app, Worker, config order on both passes', async () => {
    const calls: string[] = [];
    const ledger = new TeardownLedger();
    ledger.register({ name: 'generated-config', run: async () => { calls.push('config'); return 'removed'; } });
    ledger.register({ name: 'fixture-worker', run: async () => { calls.push('worker'); return 'deleted'; } });
    ledger.register({ name: 'container-application', run: async () => { calls.push('app'); return 'absent'; } });
    const report = await ledger.executeAndVerify(() => {});
    expect(calls).toEqual(['app', 'worker', 'config', 'app', 'worker', 'config']);
    expect(report.failures).toEqual([]);
  });
  test('runtime destruction executes twice before account-side deletion', async () => {
    let calls = 0;
    const failures = await verifyIdempotentDestroy(async () => {
      calls += 1;
      return calls === 1 ? null : 'second destroy failed';
    });
    expect(calls).toBe(2);
    expect(failures).toEqual(['idempotence/second destroy failed']);
  });


  test('cleanup failure in EITHER pass surfaces as a failure demanding nonzero exit', async () => {
    let invocations = 0;
    const flaky: TeardownStep = {
      name: 'container-application',
      run: async () => {
        invocations++;
        if (invocations === 1) return 'deleted';
        throw new Error('second pass could not confirm absence');
      },
    };
    const ledger = new TeardownLedger();
    ledger.register(flaky);
    const report = await ledger.executeAndVerify(() => {});
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('idempotence/');
    expect(report.failures[0]).toContain('could not confirm absence');

    const alwaysFails = new TeardownLedger();
    alwaysFails.register({
      name: 'fixture-worker',
      run: async () => { throw new Error('wrangler unreachable'); },
    });
    const failed = await alwaysFails.executeAndVerify(() => {});
    expect(failed.failures).toHaveLength(2); // both passes
  });

  test('the Worker reconciles Sandbox startup, verifies actual image identity, and destroys rather than stops', () => {
    expect(WORKER_SOURCE).toContain('await super.onStart()');
    expect(WORKER_SOURCE).toContain('STALE_IMAGE:$actual');
    expect(WORKER_SOURCE).toContain('CAPTURE_IMAGE_VERSION:');
    expect(WORKER_SOURCE).toContain('await this.destroy()');
    expect(WORKER_SOURCE).toContain('await this.ctx.storage.deleteAll()');
    expect(WORKER_SOURCE).not.toContain('await box.stop()');
  });

  test('the in-container probe reply contract is parsed, not cast', () => {
    expect(parseProbeReply('{"exitCode":0,"stdout":"ok\\n","stderr":"","imageVersion":"0.12.8"}')).toEqual({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
      imageVersion: '0.12.8',
    });
    expect(() => parseProbeReply('not json')).toThrow('not JSON');
    expect(() => parseProbeReply('{"exitCode":"zero"}')).toThrow('contract');
  });

  test('report extraction takes the LAST stdout line so banners cannot poison it', () => {
    expect(lastNonEmptyLine('banner\n{ "probeVersion": 1 }\n')).toBe('{ "probeVersion": 1 }');
    expect(() => lastNonEmptyLine('\n \n')).toThrow('no stdout');
  });
});
