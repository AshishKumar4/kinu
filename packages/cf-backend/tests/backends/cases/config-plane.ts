/** The agent's stored settings: each write validated once, in core's config plane. */
import { expect } from 'bun:test';
import type { SharedCase } from '../cases';

export const CONFIG_PLANE_CASES: readonly SharedCase[] = [
  {
    title: 'a reasoning effort set is the effort read back; null clears it; an unknown level is refused',
    covers: ['setReasoningEffort', 'getReasoningEffort'],
    async run({ surface }) {
      expect(await surface.getReasoningEffort()).toEqual({ effort: null });
      expect(await surface.setReasoningEffort('high')).toEqual({ ok: true, effort: 'high' });
      expect(await surface.getReasoningEffort()).toEqual({ effort: 'high' });
      expect<unknown>(await surface.setReasoningEffort(null)).toEqual({ ok: true, effort: null });
      expect(await surface.getReasoningEffort()).toEqual({ effort: null });
      // A transport can deliver any JSON; the setter is the boundary that refuses it.
      await expect((async () => surface.setReasoningEffort(JSON.parse('"extreme"')))())
        .rejects.toThrow('Invalid reasoning effort: extreme');
      expect(await surface.getReasoningEffort()).toEqual({ effort: null });
    },
  },
  {
    title: 'a pinned model is stored in its canonical spelling and read back',
    covers: ['setModel', 'getStoredModelSpec'],
    async run({ surface }) {
      expect(await surface.getStoredModelSpec()).toEqual({ spec: null });
      // A bare `@cf/` id names no provider; both backends store the provider it runs on.
      expect(await surface.setModel('@cf/zai-org/glm-5.3')).toEqual({ ok: true, spec: 'workers-ai/@cf/zai-org/glm-5.3' });
      expect(await surface.getStoredModelSpec()).toEqual({ spec: 'workers-ai/@cf/zai-org/glm-5.3' });
    },
  },
  {
    title: 'the account a workspace pays a provider with is read back; null clears it; a bad name is refused',
    covers: ['getProviderAccounts', 'setProviderAccount'],
    async run({ surface }) {
      expect(await surface.getProviderAccounts()).toEqual({ accounts: {} });
      expect(await surface.setProviderAccount('openai', 'work')).toEqual({ ok: true, accounts: { openai: 'work' } });
      expect(await surface.getProviderAccounts()).toEqual({ accounts: { openai: 'work' } });
      await expect(surface.setProviderAccount('openai', 'Work!')).rejects.toThrow('Invalid account name: Work!');
      expect(await surface.setProviderAccount('openai', null)).toEqual({ ok: true, accounts: {} });
      expect(await surface.getProviderAccounts()).toEqual({ accounts: {} });
    },
  },
  {
    title: 'a role the catalog holds becomes the selection; one it does not is refused',
    covers: ['setRole'],
    async run({ surface }) {
      expect(await surface.setRole('auditor')).toEqual({ role: 'auditor' });
      await expect(surface.setRole('no-such-role')).rejects.toThrow('no-such-role');
    },
  },
  {
    title: 'the shell approval mode is strict until set; a mode outside the three is refused',
    covers: ['getShellApprovalMode', 'setShellApprovalMode'],
    async run({ surface }) {
      expect(await surface.getShellApprovalMode()).toEqual({ mode: 'strict' });
      expect(await surface.setShellApprovalMode('deny_all')).toMatchObject({ ok: true, mode: 'deny_all' });
      expect(await surface.getShellApprovalMode()).toEqual({ mode: 'deny_all' });
      await expect((async () => surface.setShellApprovalMode(JSON.parse('"sometimes"')))())
        .rejects.toThrow('invalid mode: sometimes');
      expect(await surface.getShellApprovalMode()).toEqual({ mode: 'deny_all' });
    },
  },
  {
    title: 'revoking a standing shell grant removes exactly that grant',
    covers: ['getShellApprovalGrants', 'revokeShellApprovalGrants'],
    async run({ surface, actor }) {
      expect(await surface.getShellApprovalGrants()).toEqual({ grants: [] });
      // Two grants as the gate stores them when the owner answers "always".
      const stored = [{ rule: 'git-force-push', executor: 'workspace' }, { rule: 'sudo', executor: 'workspace' }];
      actor.config.grantShellApproval(stored);
      expect((await surface.getShellApprovalGrants()).grants).toEqual(stored);

      expect((await surface.revokeShellApprovalGrants([{ rule: 'git-force-push', executor: 'workspace' }])).grants)
        .toEqual([{ rule: 'sudo', executor: 'workspace' }]);
      expect(await surface.getShellApprovalGrants()).toEqual({ grants: [{ rule: 'sudo', executor: 'workspace' }] });
    },
  },
  {
    title: 'always-active skills are the names set; an empty list clears the pin',
    covers: ['setAlwaysActiveSkills', 'getAlwaysActiveSkills'],
    async run({ surface }) {
      expect(await surface.getAlwaysActiveSkills()).toEqual({ names: [] });
      await surface.setAlwaysActiveSkills(['deploy-checklist', 'release-notes']);
      expect(await surface.getAlwaysActiveSkills()).toEqual({ names: ['deploy-checklist', 'release-notes'] });
      await surface.setAlwaysActiveSkills([]);
      expect(await surface.getAlwaysActiveSkills()).toEqual({ names: [] });
    },
  },
];
