import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { IdentificationCardIcon } from '@phosphor-icons/react';
import {
  BUILTIN_ROLE_DEFINITIONS,
  BUILTIN_SKILL_HEADERS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_SPECS,
  NAMED_SWARM_PRESETS,
  TIER_IDS,
  deriveRoleLabel,
  isTierId,
  tierIdsOf,
  effectiveRoleCatalog,
  isReasoningEffort,
  isValidRoleId,
  offeredReasoningEfforts,
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

const EMPTY_MENU: ModelMenu = { models: [], failures: [] };

interface CatalogOperation {
  promise: Promise<void> | null;
}

export function ProfileCatalogSettings() {
  const [envelope, setEnvelope] = useState<ProfileCatalogEnvelope | null>(null);
  const [draft, setDraft] = useState<ProfileCatalog | null>(null);
  const [menu, setMenu] = useState<ModelMenu>(EMPTY_MENU);
  const [selectedRole, setSelectedRole] = useState<RoleId>('general');
  const [newRoleId, setNewRoleId] = useState('');
  const [newTierId, setNewTierId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOperation = useRef<CatalogOperation | null>(null);
  const saveOperation = useRef<CatalogOperation | null>(null);

  const load = (): void => {
    if (loadOperation.current !== null) return;
    setBusy(true);
    setError(null);
    const owner: CatalogOperation = { promise: null };
    // Install the owner before a synchronous RPC fake can settle this load.
    loadOperation.current = owner;
    owner.promise = (async () => {
      try {
        const [profile, models] = await Promise.all([getProfileCatalog(), listAvailableModels()]);
        setEnvelope(profile);
        setDraft(profile.catalog);
        setMenu(models);
      } catch (cause) {
        setError(renderThrownChain({ cause }));
      } finally {
        if (loadOperation.current === owner) {
          loadOperation.current = null;
          setBusy(false);
        }
      }
    })();
  };

  useEffect(() => {
    load();
  }, []);

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

  const save = (): void => {
    if (!draft || !envelope || !dirty || saveOperation.current !== null) return;
    setBusy(true);
    setError(null);
    const owner: CatalogOperation = { promise: null };
    // Install the owner before a synchronous RPC fake can settle this save.
    saveOperation.current = owner;
    owner.promise = (async () => {
      try {
        const updated = await updateProfileCatalog(draft, envelope.version);
        setEnvelope(updated);
        setDraft(updated.catalog);
      } catch (cause) {
        setError(renderThrownChain({ cause }));
      } finally {
        if (saveOperation.current === owner) {
          saveOperation.current = null;
          setBusy(false);
        }
      }
    })();
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

  const addTier = () => {
    if (!draft) return;
    const id = newTierId.trim();

    if (!isTierId(id)) {
      setError('Tier IDs use lowercase letters, digits, and hyphens.');

      return;
    }

    if (tierIdsOf(draft).includes(id)) {
      setError(`Tier "${id}" already exists.`);

      return;
    }

    setDraft({ ...draft, tiers: { ...draft.tiers, [id]: { ...draft.tiers.default } } });
    setNewTierId('');
    setError(null);
  };

  const removeTier = (id: TierId) => {
    if (!draft) return;
    const tiers = { ...draft.tiers };
    delete tiers[id];
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
        The default tier is the model this account runs on and the one a new workspace starts with. Roles select instructions, tools, skills, a tier, and a swarm preset. Tier changes apply account-wide next turn.
      </p>
      {error && <div className="rounded-md border border-[var(--c-danger)]/30 bg-[var(--c-danger)]/5 px-3 py-2 text-xs p-danger">{error}</div>}
      {!draft || !envelope ? (
        <div className="flex items-center gap-2 text-xs p-text-3">
          <span>{busy ? 'Loading account profiles…' : 'Profiles are unavailable.'}</span>
          {!busy && <Button size="xs" variant="secondary" onClick={load}>Retry</Button>}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="text-xs font-semibold p-text">Model tiers</div>
            {tierIdsOf(draft).map((tierId) => {
              const assignment = tierId === 'default' ? draft.tiers.default : draft.tiers[tierId];
              const resolved = assignment ?? draft.tiers.default;
              const builtin = TIER_IDS.some((id) => id === tierId);

              // The levels are the MODEL's, read off its menu entry: a model
              // that declares xhigh offers it, one that declares only low and
              // high offers no medium (#9).
              const efforts = offeredReasoningEfforts(
                menu.models.find((model) => model.spec === resolved.model)?.reasoningEfforts,
                assignment?.reasoningEffort,
              );

              return (
                <div key={tierId} className="grid gap-2 rounded-md border border-[var(--c-border)] p-2 md:grid-cols-[7rem_1fr_8rem] md:items-center">
                  <div className="flex items-center gap-2">
                    <div>
                      <div className="text-xs font-medium p-text">{tierId}</div>
                      {assignment === undefined && <div className="text-[10px] p-text-3">uses default</div>}
                      {tierId === 'default' && <div className="text-[10px] p-text-3">account default</div>}
                    </div>
                    {!builtin && (
                      <button type="button" className="text-[10px] p-text-3 hover:p-danger" aria-label={`Remove tier ${tierId}`} onClick={() => removeTier(tierId)}>
                        remove
                      </button>
                    )}
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
                      const effort = event.target.value;
                      setTierEffort(tierId, isReasoningEffort(effort) ? effort : '');
                    }}
                    aria-label={`${tierId} reasoning effort`}
                    title={efforts.length === 0 ? 'This model takes no reasoning effort setting.' : undefined}
                  >
                    <option value="">Model default</option>
                    {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                  </select>
                </div>
              );
            })}
            <div className="flex items-center gap-2">
              <input
                className={`${inputCls} max-w-[14rem]`}
                placeholder="new tier id, e.g. review"
                value={newTierId}
                aria-label="New tier id"
                onChange={(event) => setNewTierId(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') addTier(); }}
              />
              <Button size="xs" variant="secondary" disabled={!newTierId.trim()} onClick={addTier}>Add tier</Button>
            </div>
          </div>

          <div className="space-y-3 border-t border-[var(--c-border)] pt-4">
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
                tiers={tierIdsOf(draft)}
                roleIds={Object.keys(roles).sort()}
                customized={selectedRole in draft.roles}
                onChange={(next) => replaceRole(selectedRole, next)}
                onReset={removeRoleOverride}
              />
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--c-border)] pt-4">
            <span className="text-[11px] p-text-3">Catalog version {envelope.version}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={!dirty || busy} onClick={() => setDraft(envelope.catalog)}>Discard</Button>
              <FilledButton disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save roles and tiers'}</FilledButton>
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
  /** Every tier the catalog offers, so a role can name one the owner added. */
  tiers: readonly TierId[];
  /** Every role the catalog holds, for the hire list. */
  roleIds: readonly RoleId[];
  customized: boolean;
  onChange(role: RoleDefinition): void;
  onReset(): void;
}) {
  const set = <Key extends keyof RoleDefinition>(key: Key, value: RoleDefinition[Key]) =>
    props.onChange({ ...props.role, [key]: value });

  return (
    <div className="grid gap-3 rounded-md border border-[var(--c-border)] p-3 md:grid-cols-2">
      <label className="space-y-1 text-xs p-text-2">
        <span>Label</span>
        <input className={inputCls} value={props.role.label ?? deriveRoleLabel(props.id)} onChange={(event) => set('label', event.target.value)} />
      </label>
      <label className="space-y-1 text-xs p-text-2">
        <span>Default tier</span>
        <select className={inputCls} value={props.role.tier} onChange={(event) => {
          const tier = props.tiers.find((value) => value === event.target.value);

          if (tier) set('tier', tier);
        }}>
          {props.tiers.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-xs p-text-2 md:col-span-2">
        <span>Description</span>
        <input className={inputCls} value={props.role.description} onChange={(event) => set('description', event.target.value)} />
      </label>
      <label className="space-y-1 text-xs p-text-2 md:col-span-2">
        <span>Instructions</span>
        <textarea rows={16} className={`${inputCls} resize-y`} value={props.role.instructions} onChange={(event) => set('instructions', event.target.value)} />
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
      <MemberSet
        label="Tools"
        about="Every tool unless narrowed. Unchecking one takes it away from this role."
        options={BUILTIN_TOOLS.map((name) => ({ id: name, about: BUILTIN_TOOL_SPECS[name].summary }))}
        selected={props.role.allowedTools}
        onChange={(next) => set('allowedTools', next)}
      />
      <MemberSet
        label="Skills"
        about="Shipped skills this role loads. A workspace's own skills are enabled in that workspace."
        options={BUILTIN_SKILL_HEADERS.map((skill) => ({ id: skill.name, about: skill.description }))}
        selected={props.role.skills ?? []}
        onChange={(next) => set('skills', next !== undefined && next.length > 0 ? next : undefined)}
        emptyMeansNone
      />
      <MemberSet
        label="Roles this role can hire"
        about="Every role unless narrowed."
        options={props.roleIds.map((id) => ({ id, about: null }))}
        selected={props.role.spawns === '*' ? undefined : props.role.spawns}
        onChange={(next) => set('spawns', next)}
        wide
      />
      <div className="md:col-span-2">
        <Button size="xs" variant="secondary" disabled={!props.customized} onClick={props.onReset}>
          {props.id in BUILTIN_ROLE_DEFINITIONS ? 'Reset built-in role' : 'Delete custom role'}
        </Button>
      </div>
    </div>
  );
}

/**
 * A set over a known list, as checkboxes: what a role may use, drawn from
 * what exists, so the owner never types a name the runtime will not know.
 *
 * `selected` absent means the whole list (the catalog's own convention for
 * `allowedTools` and `spawns`), so every box reads checked and the stored
 * value stays absent until one is cleared; checking the last one back
 * restores absent rather than storing the full list by hand. With
 * `emptyMeansNone` (skills) absent is the empty set instead.
 */
function MemberSet(props: {
  label: string;
  about: string;
  options: ReadonlyArray<{ id: string; about: string | null }>;
  selected: readonly string[] | undefined;
  onChange(next: readonly string[] | undefined): void;
  emptyMeansNone?: boolean;
  wide?: boolean;
}) {
  const all = props.options.map((option) => option.id);
  const current = props.selected ?? (props.emptyMeansNone ? [] : all);

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...new Set([...current, id])] : current.filter((member) => member !== id);
    const whole = all.every((member) => next.includes(member));

    props.onChange(!props.emptyMeansNone && whole ? undefined : next);
  };

  return (
    <fieldset className={`min-w-0 space-y-1 text-xs p-text-2 ${props.wide ? 'md:col-span-2' : ''}`}>
      <legend className="min-w-0">
        <span>{props.label}</span>
        <span className="block text-[10px] p-text-3">{props.about}</span>
      </legend>
      <div className={`grid gap-x-3 gap-y-1 ${props.wide ? 'md:grid-cols-3' : ''}`}>
        {props.options.map((option) => (
          <label key={option.id} className="flex min-w-0 items-start gap-2 py-0.5" title={option.about ?? undefined}>
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-[var(--c-accent)]"
              checked={current.includes(option.id)}
              onChange={(event) => toggle(option.id, event.target.checked)}
              aria-label={`${props.label}: ${option.id}`}
            />
            <span className="min-w-0 flex-1">
              <span className="p-text">{option.id}</span>
              {option.about && <span className="block truncate text-[10px] p-text-3">{option.about}</span>}
            </span>
          </label>
        ))}
        {props.options.length === 0 && <span className="text-[10px] p-text-3">none shipped</span>}
      </div>
    </fieldset>
  );
}
