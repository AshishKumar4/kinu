import { describe, expect, test } from 'bun:test';
import {
  agentIdentityPrompt,
  createAgentNameFromMission,
  fallbackAgentIdentity,
  parseAgentIdentityOutput,
} from '../src/index.ts';

describe('shared agent identity naming', () => {
  test('prefers a stated persona over copying the whole prompt', () => {
    expect(createAgentNameFromMission('You are Jarvis, my personal assistant', 'abcdef123456'))
      .toBe('jarvis-abcdef');
    expect(fallbackAgentIdentity('You are Jarvis, my personal assistant', 'abcdef123456')).toEqual({
      name: 'jarvis-abcdef',
      displayName: 'Jarvis',
      nameOrigin: 'auto',
    });
  });

  test('fallback identity does not derive names from prompt words', () => {
    expect(createAgentNameFromMission('Build a durable benchmark runner', 'abcdef123456'))
      .toBe('agent-abcdef');
    expect(fallbackAgentIdentity('Build a durable benchmark runner', 'abcdef123456')).toEqual({
      name: 'agent-abcdef',
      displayName: 'Agent',
      nameOrigin: 'auto',
    });
  });

  test('parses the model JSON title and slug through one shared parser', () => {
    expect(parseAgentIdentityOutput(
      '```json\n{"title":"OAuth Flow Auditor","slug":"oauth-flow-auditor"}\n```',
      '123456abcdef',
    )).toEqual({
      name: 'oauth-flow-auditor-123456',
      displayName: 'OAuth Flow Auditor',
      nameOrigin: 'auto',
    });
  });

  test('invalid model naming output returns null', () => {
    expect(parseAgentIdentityOutput('hello world', '123456abcdef')).toBe(null);
  });

  test('naming prompt asks for JSON instead of an ad hoc string format', () => {
    const prompt = agentIdentityPrompt('Build a durable benchmark runner');

    expect(prompt).toContain('Return a concise JSON object');
    expect(prompt).toContain('title');
    expect(prompt).toContain('slug');
    expect(prompt).toContain('Mission:');
  });
});
