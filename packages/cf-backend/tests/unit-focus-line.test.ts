// The focus bar's line under its main agent's name (docs/HOME-EXPLORE.md §2; 1018-xao, Muse's status and Upcoming):
// the step a live turn is on, else what the agent watches and the next one due.
import { describe, expect, test } from 'bun:test';
import type { ToolUIPart } from 'ai';
import { clockTime, liveStep, watchingLine, type Watch } from '@kinu.run/core';

const RUNNING: ToolUIPart = { type: 'tool-file', toolCallId: 'c1', state: 'input-available', input: { op: 'read', path: '/workspace/workers/api/src/db.ts' } };

const NOW = new Date(2026, 9, 23, 14, 0).getTime();

const watch = (state: string, next: number | null, label?: string): Watch => ({ state, spec: label === undefined ? {} : { label }, next_fire_at: next });

describe("a focus bar's line", () => {
  test('while a turn is live it names the step: the call running in its own words, else its writing or thinking', () => {
    const steps = [liveStep({ kind: 'tool', part: RUNNING }), liveStep({ kind: 'text', part: { type: 'text', text: 'So far' } }), liveStep({ kind: 'thinking' })];

    expect(steps[0]).toContain('db.ts');
    expect(new Set(steps).size).toBe(3);
    expect(liveStep(null)).toBeNull();
  });

  test('at rest it counts the armed watches and names the next one due, by its label and when', () => {
    const later = new Date(2026, 9, 23, 18, 30).getTime();
    const tomorrow = new Date(2026, 9, 24, 8, 0).getTime();
    const line = watchingLine([watch('active', tomorrow, 'Daily brief'), watch('active', later, 'GitHub check'), watch('paused', NOW + 60e3, 'Paused one'), watch('active', null)], NOW);

    expect(line).toContain('3');
    expect(line).toContain('GitHub check');
    expect(line).not.toContain('Paused');
  });

  test('a next look on a later day says which day; one today says only its time', () => {
    const due = (day: number) => new Date(2026, 9, day, 18, 30).getTime();
    const [today, tomorrow, later] = [23, 24, 27].map((day) => watchingLine([watch('active', due(day), 'Daily brief')], NOW) ?? '');

    expect([today, tomorrow, later].every((line) => line.endsWith(clockTime(due(23))))).toBe(true);
    expect(new Set([today, tomorrow, later]).size).toBe(3);
    expect(tomorrow.length).toBeGreaterThan(today.length);
  });

  test('nothing armed says nothing, so the bar keeps the agent\'s activity; watches that fire on arrival are counted', () => {
    expect(watchingLine([], NOW)).toBeNull();
    expect(watchingLine([watch('revoked', NOW + 1)], NOW)).toBeNull();
    expect(watchingLine([watch('active', null)], NOW)).toContain('1');
  });
});
