/**
 * The slates API lives in the slates skill, which an agent reads before it builds one. eval's declaration only
 * says where, so the tool definition every request carries holds none of it.
 */
import { expect, test } from 'bun:test';
import { present } from '@kinu.run/test-utils';
import { BUILTIN_SKILLS } from '../src/skills/builtins';
import { SLATE_PROGRAM_MEMBERS } from '../src/slates/rpc';
import { createInlineExecutor } from '../src/tools/inline-executor';
import { createTestRuntime } from './helpers';

const MEMBERS = Object.keys(SLATE_PROGRAM_MEMBERS).map((op) => `$${op}(`);

test('the slates skill names every lifecycle member eval accepts, and eval declares none', () => {
  const { rt } = createTestRuntime();

  const provider = createInlineExecutor({
    filesOwner: 'agent', vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql, actor: rt.actor,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    slate: async () => ({ ok: true, value: null }),
  });

  const skill = present(BUILTIN_SKILLS.find((entry) => entry.name === 'slates'), 'the slates skill');
  const types = present(provider.types, "eval's declaration");

  expect(MEMBERS.filter((member) => !skill.body.includes(member))).toEqual([]);
  expect(MEMBERS.filter((member) => types.includes(member))).toEqual([]);
  expect(types).toContain('/skills/slates/SKILL.md');
});
