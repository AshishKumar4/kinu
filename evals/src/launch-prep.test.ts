import { expect, test } from 'bun:test';
import { keptFor } from '../tasks/launch-prep';

// Each run as rc22 recorded it (2620e7c05, data.json): newest first, its start and the brief's naming of each file.
const run = (startedAt: number, userMessage: string) => ({ startedAt, endedAt: startedAt + 1, status: 'completed', userMessage });

const ANN = '/home/main/launch/announcement.md', FAQ = '/home/main/launch/faq.md';

test('the second brief naming the first file too is still the second assignment (delegation trials 1 and 4 of rc22)', () => {
  const runs = [run(2, `Task 1 note: \`${ANN}\` is read-only from your environment... Next: fix ${FAQ}.`), run(1, `Task 1: Fix spelling in \`${ANN}\`.`)];

  expect(keptFor({ name: 'proofreader-week-durable', status: 'dismissed', runs }, 'announcement.md', 'faq.md')).toBe(true);
});

test('a first brief that names the second file to forbid it is still the first assignment (delegation trial 2 of rc22)', () => {
  const runs = [run(2, `TASK 2 (same rules): Fix spelling in ${FAQ}, as with announcement.md.`), run(1, `Fix ${ANN}. Do NOT touch faq.md yet.`)];

  expect(keptFor({ name: 'proofreader-week-durable', status: 'dismissed', runs }, 'announcement.md', 'faq.md')).toBe(true);
});

test('one run naming both files, or the files given in the wrong order, is not a subagent kept on for a second job', () => {
  expect(keptFor({ name: 'p', status: 'dismissed', runs: [run(1, `Fix ${ANN} and then ${FAQ}.`)] }, 'announcement.md', 'faq.md')).toBe(false);
  expect(keptFor({ name: 'p', status: 'dismissed', runs: [run(2, `Fix ${ANN}.`), run(1, `Fix ${FAQ}.`)] }, 'announcement.md', 'faq.md')).toBe(false);
  expect(keptFor({ name: 'p', status: 'dismissed', runs: [{ ...run(2, `Fix ${FAQ}.`), status: 'failed' }, run(1, `Fix ${ANN}.`)] }, 'announcement.md', 'faq.md')).toBe(false);
});
