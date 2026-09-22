// The one preset catalog the UI and UserDO resolve against; endpoints are stored verbatim, so each must be https.
import { describe, expect, test } from 'bun:test';
import { MCP_PRESETS, mcpPresetById } from '../src/mcp/presets';

describe('MCP_PRESETS', () => {
  test('the id set is exactly github, cloudflare and google', () => {
    expect(MCP_PRESETS.map((preset) => preset.id)).toEqual(['github', 'cloudflare', 'google']);
  });

  test('every serverUrl parses and is https', () => {
    for (const preset of MCP_PRESETS) {
      const url = new URL(preset.serverUrl);

      expect(url.protocol).toBe('https:');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
    }
  });

  test('a token preset names its one field; oauth presets have none', () => {
    for (const preset of MCP_PRESETS) {
      if (preset.auth === 'token') {
        expect(preset.tokenLabel).toBeTruthy();
      } else {
        expect(preset.tokenLabel).toBeUndefined();
      }
    }
  });

  test('an oauth-app preset answers its deploy fallback and its scope', () => {
    // Env names are typed keys on `Env`, mapped by cf-backend's MCP_APP_ENV.
    const oauthApps = MCP_PRESETS.filter((preset) => preset.auth === 'oauth-app');

    for (const preset of oauthApps) {
      expect(preset.scope).toBeTruthy();
    }

    expect(oauthApps.find((p) => p.id === 'github')?.tokenFallback).toBeTruthy();
    expect(oauthApps.find((p) => p.id === 'google')?.tokenFallback).toBeUndefined();
  });

  test('titles are distinct — each is the name its row claims', () => {
    expect(new Set(MCP_PRESETS.map((preset) => preset.title)).size).toBe(MCP_PRESETS.length);
  });

  test('mcpPresetById resolves each id and refuses anything else', () => {
    for (const preset of MCP_PRESETS) {
      expect(mcpPresetById(preset.id)).toBe(preset);
    }

    expect(mcpPresetById('gitlab')).toBeUndefined();
    expect(mcpPresetById('')).toBeUndefined();
  });
});
