import { BUILTIN_ROLE_DEFINITIONS, type ProfileCatalogEnvelope } from './catalog';
import { changeActiveRole, roleChangeOutcomeText } from './role-change';
import type { RoleSwitch } from '../tools/tasks-tool';

/** `tasks.mode`; the authority is read per call. */
export function agentRoleSwitch(authority: () => ProfileCatalogEnvelope | null): RoleSwitch {
  return ({ config, to }) => {
    const envelope = authority();

    if (!envelope) return { kind: 'no-authority' };
    const outcome = changeActiveRole({ envelope, config, to, actor: 'agent' });

    if (outcome.kind === 'applied') return { kind: 'applied' };
    const text = roleChangeOutcomeText(to, outcome, config.getRoleSelection());

    if (outcome.reason !== 'unknown-role') return { kind: 'denied', text };

    return { kind: 'unknown-role', text, known: Object.keys({ ...BUILTIN_ROLE_DEFINITIONS, ...envelope.catalog.roles }).sort() };
  };
}
