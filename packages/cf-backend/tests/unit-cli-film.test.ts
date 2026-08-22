/**
 * The film cannot quietly become fiction.
 *
 * The full player's rows are held against the raw recording by the browser
 * suite's ancestor gates; this file holds the LANDING's condensed cut to the
 * same standard without booting a browser: every row it renders must be one
 * of the full projection's rows, verbatim, and the rails must quote the
 * recording's own session facts. A row that is reworded, paraphrased, or
 * invented fails here — the exact failure mode his mock's sample transcript
 * would have shipped silently (its numbers do not all match the session).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cliFilmFigure, condensedCliFilm } from '../src/lib/cli-film';

const RECORDING = readFileSync(
  join(import.meta.dir, '../../../scripts/fixtures/cli-film-run.jsonl'), 'utf8');

const ELIDED = ' …';

function unescape(html: string): string {
  return html
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The full projection's rows, as plain text — the proven set any condensed
 *  row must be a member of. */
const proven = (): string[] => {
  const pre = /<pre class="term" id="cli-film">(.*?)<\/pre>/s.exec(cliFilmFigure());
  expect(pre, 'the full film no longer renders a terminal').not.toBeNull();
  return (pre?.[1] ?? '').split('<span class="line"').slice(1)
    .map((chunk) => chunk.slice(chunk.indexOf('>') + 1))
    .map((chunk) => unescape(chunk.replace(/<b>.*?<\/b>/gs, '').replace(/<[^>]+>/g, '')).trim());
};

describe('the condensed cut stays footage', () => {
  const pre = /<pre class="term" id="cli-film-condensed">(.*?)<\/pre>/s.exec(condensedCliFilm());
  const rows = (pre?.[1] ?? '').split('<span class="line"').slice(1)
    .map((chunk) => chunk.slice(chunk.indexOf('>') + 1))
    .map((chunk) => unescape(chunk.replace(/<b>.*?<\/b>/gs, '').replace(/<[^>]+>/g, '')).trim());

  test('it ships a short excerpt, in his shape', () => {
    // Five rows: command, the timed suite, the scaling proof (one line — its
    // segments are recorded verbatim and gated individually below), the
    // verdict, the named fix.
    expect(rows.length).toBe(5);
  });

  test('every row is verbatim one of the full projection\u2019s rows', () => {
    const full = proven();
    for (const row of rows) {
      const candidate = row.endsWith(ELIDED) ? row.slice(0, -ELIDED.length) : row;
      expect(full.some((line) => line === candidate || line.startsWith(candidate)),
        `not a recorded row: ${candidate.slice(0, 60)}`).toBeTrue();
    }
  });

  test('every row is therefore inside the raw recording', () => {
    for (const row of rows) {
      // The typed command names the session's turn_start, where the mission
      // rides without the binary prefix — the same allowance the recording
      // gate for the full film has always made.
      const candidate = row.replace(/^kinu run \S+ "(.*)"$/, '$1');
      const escaped = JSON.stringify(candidate).slice(1, -1);
      expect(RECORDING.includes(candidate) || RECORDING.includes(escaped),
        `not in the recording: ${candidate.slice(0, 60)}`).toBeTrue();
    }
  });

  test('the rails quote the session, not a legend', () => {
    const fig = condensedCliFilm();
    const rows_ = RECORDING.split('\n').filter((r) => r !== '').map((r) => JSON.parse(r));
    const session = rows_.find((r) => r.type === 'session');
    const turnEnd = rows_.find((r) => r.type === 'turn_end');
    expect(fig).toContain(session.workspace.toUpperCase());
    expect(fig).toContain(session.backend.toUpperCase());
    expect(fig).toContain(`${String(turnEnd.steps)} steps`);
    expect(fig).toContain(`${String(Math.round(turnEnd.durationMs / 1000))} s`);
  });
});
