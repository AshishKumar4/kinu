// The preset catalog is the one source the UI and the UserDO both resolve
// against — these pin what makes a preset a preset: the id set is the three
// the feature shipped with, every endpoint is a parseable https URL (the add
// path stores it verbatim), and a token preset cannot render its one field
// without a label.
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
    // Core owns the catalog shape, never the env names — those are typed keys
    // on `Env`, which cf-backend's MCP_APP_ENV maps each oauth-app id onto.
    const oauthApps = MCP_PRESETS.filter((preset) => preset.auth === 'oauth-app');

    for (const preset of oauthApps) {
      expect(preset.scope).toBeTruthy();
    }

    // GitHub carries a token fallback so the card works without the app;
    // Gmail has none — the card renders only when the app is configured.
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
