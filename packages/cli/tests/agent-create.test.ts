import { describe, expect, test } from 'bun:test';
import { createAgentNameFromMission } from '../src/agent-create';

describe('CLI mission agent names', () => {
  test('uses the shared slug rule and a stable id suffix', () => {
    expect(createAgentNameFromMission('Research Rust web frameworks', 'abcdef123456'))
      .toBe('research-rust-web-framew-abcdef');
    expect(createAgentNameFromMission('!!!', '123456abcdef'))
      .toBe('agent-123456');
  });
});
