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

  test('fallback identity is a deterministic memorable name from the workspace id', () => {
    const id = '7f159a00-1234-4567-89ab-cdef01234567';

    expect(createWorkspaceNameFromMission('Build a durable benchmark runner', id))
      .toBe('brisk-heron-7f15');
    expect(createWorkspaceNameFromMission('Build a durable benchmark runner', id))
      .toBe('brisk-heron-7f15');
    expect(fallbackWorkspaceIdentity('Build a durable benchmark runner', id)).toEqual({
      name: 'brisk-heron-7f15',
      displayName: 'Brisk Heron',
      nameOrigin: 'auto',
    });
  });

  test('blank missions never fall back to a generic workspace slug', () => {
    const identity = fallbackWorkspaceIdentity('', '7f159a00-1234-4567-89ab-cdef01234567');

    expect(identity.name).toBe('brisk-heron-7f15');
    expect(identity.name.startsWith('workspace-')).toBe(false);
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
