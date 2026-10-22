// A finished eval run's verdict and its comments: 2026-10-19, `gh: command not found` threw after 3.5 hours of trials,
// and the verdict never reached promote.ts.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from '../packages/test-utils/src/ambient-env';
import { scratchDir } from '../packages/test-utils/src/scratch';
import { resolveGh, settleEvalRun, type SettleStep } from './evals-post';
import { REPO_ROOT } from './repo-root';

/** A `gh` that answers what post-comment.sh asks of it, and writes each call's words to `log`. */
function fakeGh(dir: string, log: string): string {
  const gh = join(dir, 'gh');

  writeFileSync(gh, `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
case "$*" in
  "repo view"*) echo owner/repo ;;
  "api user"*) echo the-operator ;;
esac
`);
  chmodSync(gh, 0o755);

  return gh;
}

/** Each step a settle ran, by its first words; `exits` answers each by those words. */
function recordedSteps(exits: Readonly<Record<string, number>>) {
  const ran: string[] = [];

  return {
    ran,
    step: (async (argv) => {
      const words = argv[0] === 'bash' ? `post ${String(argv[4]).includes('why') ? 'why' : 'comparison'}` : 'record';

      ran.push(words);

      return exits[words] ?? 0;
    }) satisfies SettleStep,
  };
}

describe('a finished eval run', () => {
  test('records its verdict before any comment, and a comment that could not be posted is reported, never thrown', async () => {
    const { step, ran } = recordedSteps({ 'post comparison': 1, 'post why': 1 });

    const settled = await settleEvalRun({ dir: '/run/evals', record: true, post: 'abc1234', gh: '/usr/bin/gh', step });

    expect({ ran, settled }).toEqual({ ran: ['record', 'post comparison', 'post why'], settled: { unposted: ['comparison', 'why'] } });
  });

  test('with no gh it posts nothing, and still records its verdict', async () => {
    const { step, ran } = recordedSteps({});

    expect({ settled: await settleEvalRun({ dir: '/run/evals', record: true, post: 'abc1234', gh: null, step }), ran })
      .toEqual({ settled: { unposted: ['comparison', 'why'] }, ran: ['record'] });
  });

  test('a verdict that could not be recorded fails the run, and nothing is posted', async () => {
    const { step, ran } = recordedSteps({ record: 1 });

    await expect(settleEvalRun({ dir: '/run/evals', record: true, post: 'abc1234', gh: '/usr/bin/gh', step })).rejects.toThrow('recording this eval verdict failed');
    expect(ran).toEqual(['record']);
  });
});

describe('the gh a run posts through', () => {
  test('is GH when it names one, else the one on PATH, else none', () => {
    const dir = scratchDir('evals-gh');
    const gh = fakeGh(dir, join(dir, 'calls.log'));

    expect([resolveGh({ GH: gh, PATH: '/usr/bin' }), resolveGh({ PATH: dir }), resolveGh({ PATH: join(dir, 'nothing') })]).toEqual([gh, gh, null]);
  });

  test('is the one GH names, with none on the posting script\'s PATH', async () => {
    const dir = scratchDir('evals-post-comment');
    const log = join(dir, 'calls.log');
    const body = join(dir, 'comment.md');

    mkdirSync(dir, { recursive: true });
    writeFileSync(body, '<!-- kinu-evals-results -->\nunchanged\n');

    const posted = Bun.spawn(['bash', 'evals/scripts/post-comment.sh', 'abc1234', body, '<!-- kinu-evals-results -->'], {
      cwd: REPO_ROOT, env: childEnv({ GH: fakeGh(dir, log), PATH: '/usr/bin:/bin' }), stdout: 'pipe', stderr: 'pipe',
    });

    expect({ exit: await posted.exited, posted: readFileSync(log, 'utf8').split('\n').some((call) => call.startsWith('api --method POST repos/owner/repo/commits/abc1234/comments')) })
      .toEqual({ exit: 0, posted: true });
  });
});
