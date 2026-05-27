// Pure unit test for the URL parser. The full handleAuthRequest depends on
// the `agents` package (CF Workers runtime), so it's only testable in
// integration via miniflare / wrangler dev — not in pure Bun.
import { describe, test, expect } from 'bun:test';
import { parseAuthPath, AUTH_PATH_PATTERN } from '../src/auth/path.ts';

describe('auth route URL parser', () => {
  test('matches /api/agents/<name>/auth', () => {
    const r = parseAuthPath('/api/agents/foo/auth');
    expect(r).toEqual({ agentName: 'foo', rest: '' });
  });

  test('captures subpaths', () => {
    expect(parseAuthPath('/api/agents/foo/auth/codex/start'))
      .toEqual({ agentName: 'foo', rest: '/codex/start' });
    expect(parseAuthPath('/api/agents/foo/auth/credentials/openai'))
      .toEqual({ agentName: 'foo', rest: '/credentials/openai' });
  });

  test('handles URL-safe agent names', () => {
    expect(parseAuthPath('/api/agents/agent-with-dash/auth/codex')?.agentName)
      .toBe('agent-with-dash');
    expect(parseAuthPath('/api/agents/AgEnT_123/auth/codex/poll')?.agentName)
      .toBe('AgEnT_123');
  });

  test('returns null for non-auth paths', () => {
    expect(parseAuthPath('/api/agents/foo/runs')).toBeNull();
    expect(parseAuthPath('/health')).toBeNull();
    expect(parseAuthPath('/api/agents')).toBeNull();
    expect(parseAuthPath('/api/agents/foo')).toBeNull();
  });

  test('does NOT match agent names with slashes', () => {
    expect(parseAuthPath('/api/agents/path/with/slashes/auth')).toBeNull();
  });

  test('exported pattern is the same one used internally', () => {
    expect(AUTH_PATH_PATTERN.test('/api/agents/foo/auth/codex')).toBe(true);
    expect(AUTH_PATH_PATTERN.test('/api/agents/foo/runs')).toBe(false);
  });
});
