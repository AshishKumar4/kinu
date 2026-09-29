import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Plan mode browser contract', () => {
  test('ships the selected upstream license text with the integration', () => {
    const notice = readFileSync(join(import.meta.dir, '../../../THIRD_PARTY_NOTICES.md'), 'utf8');
    const license = readFileSync(join(import.meta.dir, '../../../third_party/plannotator-LICENSE-MIT'), 'utf8');
    expect(notice).toContain('third_party/plannotator-LICENSE-MIT');
    expect(license).toContain('Copyright (c) 2025 backnotprop');
    expect(license).toContain('Permission is hereby granted');
  });
});
