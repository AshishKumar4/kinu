// The nightly sweeps' wiring: each part's shard denominator is its map's part count, and the timer runs both.
import { describe, expect, test } from 'bun:test';
import { mapArgv, sweepUnits, SWEEPS, WORKTREE } from './nightly-sweeps';

describe('the nightly sweeps on armada', () => {
  test('each sweep cuts its work into exactly as many shards as its map runs parts', () => {
    // `sweep:flakes` takes `--shard=k/n`, `bench.ts validate` takes `--shard k/n`.
    expect(SWEEPS.map((sweep) => [sweep.name, /--shard[= ]\{item\}\/(\d+)/u.exec(sweep.command.join(' '))?.[1]]))
      .toEqual([['flakes', '16'], ['bench', '20']]);
  });

  test('a sweep is one map at the commit, its parts on stdin, each part leaving its report', () => {
    const [flakes] = SWEEPS;

    if (flakes === undefined) throw new Error('no sweep is declared');
    const argv = mapArgv(flakes, 'abc123');

    expect(argv.slice(1, argv.indexOf('--'))).toEqual([
      'map', '--commit=abc123', '--items=-', '--pool=16', '--size=medium', '--timeout=3600', '--output', '--label=nightly flakes abc123',
    ]);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([...flakes.command]);
    expect(flakes.command.join(' ')).toContain('{out}');
  });

  test('the timer runs both sweeps each night at the fetched tip, from its own checkout', () => {
    const units = sweepUnits();

    expect(units.timer.text).toContain('OnCalendar=*-*-* 07:30:00 UTC');
    expect(units.timer.text).toContain(`Unit=${units.service.name.replace('@.', '@%i.')}`);
    expect(units.service.text).toContain(`WorkingDirectory=${WORKTREE}`);
    expect(units.service.text).toContain(`${WORKTREE}/scripts/nightly-sweeps.ts run FETCH_HEAD`);
  });
});
