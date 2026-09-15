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
