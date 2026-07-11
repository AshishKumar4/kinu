import { describe, expect, test } from 'bun:test';
import {
  workspaceIdentityPrompt,
  createWorkspaceNameFromMission,
  fallbackWorkspaceIdentity,
  parseWorkspaceIdentityOutput,
} from '../src/index.ts';

describe('shared workspace identity naming', () => {
  test('prefers a stated persona over copying the whole prompt', () => {
    expect(createWorkspaceNameFromMission('You are Jarvis, my personal assistant', 'abcdef123456'))
      .toBe('jarvis-abcdef');
    expect(fallbackWorkspaceIdentity('You are Jarvis, my personal assistant', 'abcdef123456')).toEqual({
      name: 'jarvis-abcdef',
      displayName: 'Jarvis',
      nameOrigin: 'auto',
    });
  });

  test('fallback identity does not derive names from prompt words', () => {
    expect(createWorkspaceNameFromMission('Build a durable benchmark runner', 'abcdef123456'))
      .toBe('workspace-abcdef');
    expect(fallbackWorkspaceIdentity('Build a durable benchmark runner', 'abcdef123456')).toEqual({
      name: 'workspace-abcdef',
      displayName: 'Workspace',
      nameOrigin: 'auto',
    });
  });

  test('parses the model JSON title and slug through one shared parser', () => {
    expect(parseWorkspaceIdentityOutput(
      '```json\n{"title":"OAuth Flow Auditor","slug":"oauth-flow-auditor"}\n```',
      '123456abcdef',
    )).toEqual({
      name: 'oauth-flow-auditor-123456',
      displayName: 'OAuth Flow Auditor',
      nameOrigin: 'auto',
    });
  });

  test('invalid model naming output returns null', () => {
    expect(parseWorkspaceIdentityOutput('hello world', '123456abcdef')).toBe(null);
  });

  test('naming prompt asks for JSON instead of an ad hoc string format', () => {
    const prompt = workspaceIdentityPrompt('Build a durable benchmark runner');

    expect(prompt).toContain('Return a concise JSON object');
    expect(prompt).toContain('title');
    expect(prompt).toContain('slug');
    expect(prompt).toContain('Mission:');
  });
});
