// The one preset catalog the UI and UserDO resolve against; endpoints are stored verbatim, so each must be https.
import { describe, expect, test } from 'bun:test';
import { MCP_PRESETS, mcpPresetById } from '../src/mcp/presets';

describe('MCP_PRESETS', () => {
  test('every serverUrl parses and is https', () => {
    for (const preset of MCP_PRESETS) {
      const url = new URL(preset.serverUrl);

      expect(url.protocol).toBe('https:');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
    }
  });

  test('mcpPresetById resolves each id and refuses anything else', () => {
    for (const preset of MCP_PRESETS) {
      expect(mcpPresetById(preset.id)).toBe(preset);
    }

    expect(mcpPresetById('gitlab')).toBeUndefined();
    expect(mcpPresetById('')).toBeUndefined();
  });
});
