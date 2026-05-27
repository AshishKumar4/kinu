import { describe, test, expect } from 'bun:test';
import {
  createAgentConfigStore, initAgentConfigTable, AGENT_CONFIG_KEYS,
} from '../src/index.ts';
import { createTestSql } from '@proteus/test-utils';

function setup() {
  const { sql, execRaw } = createTestSql();
  initAgentConfigTable(execRaw);
  return createAgentConfigStore(sql);
}

describe('AgentConfigStore — generic get/set/delete', () => {
  test('round-trip + null on missing', () => {
    const c = setup();
    expect(c.get('missing')).toBeNull();
    c.set('x', 'one');
    expect(c.get('x')).toBe('one');
    c.set('x', 'two');
    expect(c.get('x')).toBe('two');
    c.delete('x');
    expect(c.get('x')).toBeNull();
  });

  test('all() returns every row as a plain object', () => {
    const c = setup();
    c.set('a', '1'); c.set('b', '2');
    expect(c.all()).toEqual({ a: '1', b: '2' });
  });
});

describe('AgentConfigStore — typed accessors', () => {
  test('model: get/set round-trip + canonical key', () => {
    const c = setup();
    expect(c.getModel()).toBeNull();
    c.setModel('codex/gpt-5.5');
    expect(c.getModel()).toBe('codex/gpt-5.5');
    // Confirm it writes to the canonical key (other readers depend on it).
    expect(c.get(AGENT_CONFIG_KEYS.model)).toBe('codex/gpt-5.5');
  });

  test('displayName: default null', () => {
    const c = setup();
    expect(c.getDisplayName()).toBeNull();
    c.setDisplayName('my agent');
    expect(c.getDisplayName()).toBe('my agent');
  });

  test('shellApprovalMode: defaults to strict, validates input', () => {
    const c = setup();
    expect(c.getShellApprovalMode()).toBe('strict');
    c.setShellApprovalMode('allow_all');
    expect(c.getShellApprovalMode()).toBe('allow_all');
    c.setShellApprovalMode('deny_all');
    expect(c.getShellApprovalMode()).toBe('deny_all');
    // Garbage in DB → strict fallback.
    c.set(AGENT_CONFIG_KEYS.shellApprovalMode, 'bogus');
    expect(c.getShellApprovalMode()).toBe('strict');
  });

  test('sleepTimeCompute: boolean coerces "true" / "false" strings', () => {
    const c = setup();
    expect(c.getSleepTimeComputeEnabled()).toBe(false);
    c.setSleepTimeComputeEnabled(true);
    expect(c.getSleepTimeComputeEnabled()).toBe(true);
    c.setSleepTimeComputeEnabled(false);
    expect(c.getSleepTimeComputeEnabled()).toBe(false);
  });

  test('autoPromoteScaffold: boolean from "true"/"false"', () => {
    const c = setup();
    expect(c.getAutoPromoteScaffold()).toBe(false);
    c.set(AGENT_CONFIG_KEYS.autoPromoteScaffold, 'true');
    expect(c.getAutoPromoteScaffold()).toBe(true);
  });

  test('shadowSampleRate: defaults 0.25, parses + clamps', () => {
    const c = setup();
    expect(c.getShadowSampleRate()).toBe(0.25);
    c.set(AGENT_CONFIG_KEYS.shadowSampleRate, '0.5');
    expect(c.getShadowSampleRate()).toBe(0.5);
    // Out-of-range / NaN → default.
    c.set(AGENT_CONFIG_KEYS.shadowSampleRate, '2.0');
    expect(c.getShadowSampleRate()).toBe(0.25);
    c.set(AGENT_CONFIG_KEYS.shadowSampleRate, 'not-a-number');
    expect(c.getShadowSampleRate()).toBe(0.25);
  });

  test('toolSurfacingMode: defaults all, validates input', () => {
    const c = setup();
    expect(c.getToolSurfacingMode()).toBe('all');
    c.set(AGENT_CONFIG_KEYS.toolSurfacingMode, 'relevant');
    expect(c.getToolSurfacingMode()).toBe('relevant');
    c.set(AGENT_CONFIG_KEYS.toolSurfacingMode, 'bogus');
    expect(c.getToolSurfacingMode()).toBe('all');
  });
});
