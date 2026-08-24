import { useEffect, useMemo, useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { IdentificationCardIcon } from '@phosphor-icons/react';
import {
  BUILTIN_ROLE_DEFINITIONS,
  NAMED_SWARM_PRESETS,
  TIER_IDS,
  deriveRoleLabel,
  effectiveRoleCatalog,
  isValidRoleId,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
  type RoleDefinition,
  type RoleCatalog,
  type RoleId,
  type TierId,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { getProfileCatalog, listAvailableModels, updateProfileCatalog, type ModelMenu } from '../lib/user-api';
import { ModelPicker } from './ModelPicker';
import { Card, inputCls } from './ui/form';
import { FilledButton } from './ui/FilledButton';

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
const EMPTY_MENU: ModelMenu = { models: [], failures: [] };

export function ProfileCatalogSettings() {
  const [envelope, setEnvelope] = useState<ProfileCatalogEnvelope | null>(null);
  const [draft, setDraft] = useState<ProfileCatalog | null>(null);
  const [menu, setMenu] = useState<ModelMenu>(EMPTY_MENU);
  const [selectedRole, setSelectedRole] = useState<RoleId>('general');
  const [newRoleId, setNewRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const [profile, models] = await Promise.all([getProfileCatalog(), listAvailableModels()]);
      setEnvelope(profile);
      setDraft(profile.catalog);
      setMenu(models);
    } catch (cause) {
      setError(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const roles: RoleCatalog = useMemo(
    () => draft ? effectiveRoleCatalog(draft) : BUILTIN_ROLE_DEFINITIONS,
    [draft],
  );
  const role = roles[selectedRole] ?? null;
  const dirty = envelope !== null && draft !== null
    && JSON.stringify(envelope.catalog) !== JSON.stringify(draft);

  const replaceRole = (id: RoleId, next: RoleDefinition) => {
    if (!draft) return;
    setDraft({ ...draft, roles: { ...draft.roles, [id]: next } });
  };

  const save = async () => {
    if (!draft || !envelope || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProfileCatalog(draft, envelope.version);
      setEnvelope(updated);
      setDraft(updated.catalog);
    } catch (cause) {
      setError(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  };

  const addRole = () => {
    const id = newRoleId.trim();
    if (!isValidRoleId(id)) {
      setError('Role IDs use lowercase letters, digits, and hyphens.');
      return;
    }
    if (roles[id]) {
      setError(`Role "${id}" already exists.`);
      return;
    }
    replaceRole(id, {
      label: deriveRoleLabel(id),
      description: 'Describe when an agent should use this role.',
      instructions: 'State how the agent works in this role.',
      tier: 'default',
      preset: 'ideate',
    });
    setSelectedRole(id);
    setNewRoleId('');
    setError(null);
  };

  const removeRoleOverride = () => {
    if (!draft) return;
    const next = { ...draft.roles };
    delete next[selectedRole];
    setDraft({ ...draft, roles: next });
    if (!(selectedRole in BUILTIN_ROLE_DEFINITIONS)) setSelectedRole('general');
  };

  const setTier = (id: TierId, model: string) => {
    if (!draft) return;
    const tiers = { ...draft.tiers };
    if (id === 'default') {
      if (model) tiers.default = { ...tiers.default, model };
    } else if (model) {
      tiers[id] = { ...(tiers[id] ?? tiers.default), model };
    } else {
      delete tiers[id];
    }
    setDraft({ ...draft, tiers });
  };

  const setTierEffort = (id: TierId, effort: ReasoningEffort | '') => {
    if (!draft) return;
    const tiers = { ...draft.tiers };
    const current = id === 'default' ? tiers.default : tiers[id] ?? tiers.default;
    const next = { ...current };
    if (effort) next.reasoningEffort = effort;
    else delete next.reasoningEffort;
    if (id === 'default') tiers.default = next;
    else tiers[id] = next;
    setDraft({ ...draft, tiers });
  };

  return (
    <Card title="Agent roles and model tiers" icon={IdentificationCardIcon}>
      <p className="text-xs p-text-3">
        Roles select instructions, tools, skills, a tier, and a swarm preset. Tier changes apply account-wide on the next turn.
      </p>
      {error && <div className="rounded-md border border-[var(--c-danger)]/30 bg-[var(--c-danger)]/5 px-3 py-2 text-xs p-danger">{error}</div>}
      {!draft || !envelope ? (
        <div className="flex items-center gap-2 text-xs p-text-3">
          <span>{busy ? 'Loading account profiles…' : 'Profiles are unavailable.'}</span>
          {!busy && <Button size="xs" variant="secondary" onClick={() => { void load(); }}>Retry</Button>}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="text-xs font-semibold p-text">Model tiers</div>
            {TIER_IDS.map((tierId) => {
              const assignment = tierId === 'default' ? draft.tiers.default : draft.tiers[tierId];
              const resolved = assignment ?? draft.tiers.default;
              return (
                <div key={tierId} className="grid gap-2 rounded-md border border-[var(--c-border-subtle)] p-2 md:grid-cols-[5rem_1fr_8rem] md:items-center">
                  <div>
                    <div className="text-xs font-medium p-text">{tierId}</div>
                    {assignment === undefined && <div className="text-[10px] p-text-3">uses default</div>}
                  </div>
                  <ModelPicker
                    models={menu.models}
                    failures={menu.failures}
                    value={assignment?.model ?? ''}
                    onChange={(model) => setTier(tierId, model)}
                    clearable={tierId !== 'default'}
                    placeholder={tierId === 'default' ? resolved.model : `Use default (${resolved.model})`}
                    size="sm"
                  />
                  <select
                    className={inputCls}
                    value={assignment?.reasoningEffort ?? ''}
                    onChange={(event) => {
                      const effort = EFFORTS.find((value) => value === event.target.value) ?? '';
                      setTierEffort(tierId, effort);
                    }}
                    aria-label={`${tierId} reasoning effort`}
                  >
                    <option value="">Model default</option>
                    {EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                  </select>
                </div>
              );
            })}
          </div>

          <div className="space-y-3 border-t border-[var(--c-border-subtle)] pt-4">
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(roles).sort().map((roleId) => (
                <button
                  key={roleId}
                  type="button"
                  className={`rounded px-2 py-1 text-xs ${selectedRole === roleId ? 'p-btn' : 'p-surface-2 p-text-2'}`}
                  onClick={() => setSelectedRole(roleId)}
                >
                  {roles[roleId]?.label ?? deriveRoleLabel(roleId)}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input className={inputCls} value={newRoleId} onChange={(event) => setNewRoleId(event.target.value)} placeholder="new-role-id" />
              <Button size="sm" variant="secondary" onClick={addRole}>Add role</Button>
            </div>

            {role && (
              <RoleEditor
                id={selectedRole}
                role={role}
                customized={selectedRole in draft.roles}
                onChange={(next) => replaceRole(selectedRole, next)}
                onReset={removeRoleOverride}
              />
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--c-border-subtle)] pt-4">
            <span className="text-[11px] p-text-3">Catalog version {envelope.version}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={!dirty || busy} onClick={() => setDraft(envelope.catalog)}>Discard</Button>
              <FilledButton disabled={!dirty || busy} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save roles and tiers'}</FilledButton>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function RoleEditor(props: {
  id: RoleId;
  role: RoleDefinition;
  customized: boolean;
  onChange(role: RoleDefinition): void;
  onReset(): void;
}) {
  const set = <Key extends keyof RoleDefinition>(key: Key, value: RoleDefinition[Key]) =>
    props.onChange({ ...props.role, [key]: value });
  const strings = (value: string): readonly string[] | undefined => {
    const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  };
  return (
    <div className="grid gap-3 rounded-md border border-[var(--c-border-subtle)] p-3 md:grid-cols-2">
      <label className="space-y-1 text-xs p-text-2">
        <span>Label</span>
        <input className={inputCls} value={props.role.label ?? deriveRoleLabel(props.id)} onChange={(event) => set('label', event.target.value)} />
      </label>
      <label className="space-y-1 text-xs p-text-2">
        <span>Default tier</span>
        <select className={inputCls} value={props.role.tier} onChange={(event) => {
          const tier = TIER_IDS.find((value) => value === event.target.value);
          if (tier) set('tier', tier);
        }}>
          {TIER_IDS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-xs p-text-2 md:col-span-2">
        <span>Description</span>
        <input className={inputCls} value={props.role.description} onChange={(event) => set('description', event.target.value)} />
      </label>
      <label className="space-y-1 text-xs p-text-2 md:col-span-2">
        <span>Instructions</span>
        <textarea className={`${inputCls} min-h-24 resize-y`} value={props.role.instructions} onChange={(event) => set('instructions', event.target.value)} />
      </label>
      <label className="space-y-1 text-xs p-text-2">
        <span>Default swarm preset</span>
        <select className={inputCls} value={props.role.preset} onChange={(event) => {
          const preset = NAMED_SWARM_PRESETS.find((value) => value === event.target.value);
          if (preset) set('preset', preset);
        }}>
          {NAMED_SWARM_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-xs p-text-2">
        <input type="checkbox" checked={props.role.plan === true} onChange={(event) => set('plan', event.target.checked ? true : undefined)} />
        Start in Plan mode
      </label>
      <label className="space-y-1 text-xs p-text-2">
        <span>Allowed tools</span>
        <input className={inputCls} value={props.role.allowedTools?.join(', ') ?? ''} onChange={(event) => set('allowedTools', strings(event.target.value))} placeholder="file, run, agents" />
      </label>
      <label className="space-y-1 text-xs p-text-2">
        <span>Skills</span>
        <input className={inputCls} value={props.role.skills?.join(', ') ?? ''} onChange={(event) => set('skills', strings(event.target.value))} placeholder="repository-review" />
      </label>
      <label className="space-y-1 text-xs p-text-2 md:col-span-2">
        <span>Roles this role can hire</span>
        <input
          className={inputCls}
          value={props.role.spawns === '*' ? '*' : props.role.spawns?.join(', ') ?? ''}
          onChange={(event) => set('spawns', event.target.value.trim() === '*' ? '*' : strings(event.target.value))}
          placeholder="* or researcher, auditor"
        />
      </label>
      <div className="md:col-span-2">
        <Button size="xs" variant="secondary" disabled={!props.customized} onClick={props.onReset}>
          {props.id in BUILTIN_ROLE_DEFINITIONS ? 'Reset built-in role' : 'Delete custom role'}
        </Button>
      </div>
    </div>
  );
}
