/**
 * The film cannot quietly become fiction.
 *
 * This file holds the LANDING's condensed cut against the raw recording
 * without booting a browser: every row must appear in the recording, and the
 * rails must quote that recording's own session facts. A row that is reworded,
 * paraphrased or invented fails here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { condensedCliFilm } from '../src/lib/cli-film';

const RECORDING = readFileSync(
  join(import.meta.dir, '../../../scripts/fixtures/cli-film-run.jsonl'), 'utf8');


function unescape(html: string): string {
  return html
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}


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
