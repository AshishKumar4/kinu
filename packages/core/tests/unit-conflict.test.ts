/**
 * Unit tests: CraftStore conflict detection.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { checkConflictsBeforeAdding } from '../src/craft/conflict.js';

describe('CraftStore conflict detection', () => {
  test('detects exact name conflict', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'parse_csv', description: 'Parse CSV files', params: null, code: 'fn()', scope: 'local' });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'parse_csv', description: 'Different desc', code: 'other()', score: 0.9,
    });
    expect(result.conflicting).toContain('parse_csv');
  });

  test('detects semantic conflict (>85% word overlap)', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'extract_csv', description: 'parse and extract CSV data from files with headers',
      params: null, code: 'fn()', scope: 'local',
    });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'csv_parser',
      description: 'parse and extract CSV data from files with headers and delimiters',
      code: 'other()', score: 0.9,
    });
    // High word overlap → should detect conflict
    expect(result.conflicting.length).toBeGreaterThan(0);
  });

  test('no conflict for unrelated tools', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'parse_csv', description: 'parse CSV files',
      params: null, code: 'fn()', scope: 'local',
    });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'send_email', description: 'send transactional email via SMTP',
      code: 'other()', score: 0.9,
    });
    expect(result.conflicting).toHaveLength(0);
  });
});
