import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { BrainIcon, IdentificationCardIcon, PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
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
import { BrandMark, providerBrand } from './ui/BrandMark';
import { Card, Field, inputCls, tabCls } from './ui/form';
import { FilledButton } from './ui/FilledButton';

const EMPTY_MENU: ModelMenu = { models: [], failures: [] };

interface CatalogOperation {
  promise: Promise<void> | null;
}

/** Overrides `inputCls` to the combobox's `size="sm"` metrics; `!` because same-property
 *  utilities resolve by order, not intent. */
const selectSmCls = `${inputCls} !h-6.5 !px-2 !py-0 !text-xs`;

export function ProfileCatalogSettings({ tiersOnly = false }: { tiersOnly?: boolean }) {
  const [envelope, setEnvelope] = useState<ProfileCatalogEnvelope | null>(null);
  const [draft, setDraft] = useState<ProfileCatalog | null>(null);
  const [menu, setMenu] = useState<ModelMenu>(EMPTY_MENU);
  const [selectedRole, setSelectedRole] = useState<RoleId>('task');
  const [newRoleId, setNewRoleId] = useState('');
  const [addingRole, setAddingRole] = useState(false);
  const [newTierId, setNewTierId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleNav = useRef<HTMLElement>(null);

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

  // A deep selection the phone's strip hasn't scrolled to yet is invisible.
  useEffect(() => {
    roleNav.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [selectedRole, addingRole]);

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
    setAddingRole(false);
    setError(null);
  };

  const removeRoleOverride = () => {
    if (!draft) return;
    const next = { ...draft.roles };
    delete next[selectedRole];
    setDraft({ ...draft, roles: next });

    if (!(selectedRole in BUILTIN_ROLE_DEFINITIONS)) setSelectedRole('task');
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

  const saveWhat = tiersOnly ? 'Save tiers' : 'Save roles and tiers';

  return (
    <>
      <Card title="Model tiers" icon={BrainIcon}
        description="The default tier is the model this account runs on and the one a new workspace starts with. Tier changes apply account-wide next turn.">
        {!draft || !envelope ? (
          <div className="flex items-center gap-2 p-row-text p-text-3">
            <span>{busy ? 'Loading account profiles…' : 'Profiles are unavailable.'}</span>
            {!busy && <Button size="xs" variant="secondary" onClick={load}>Retry</Button>}
            {error && <span className="p-danger">{error}</span>}
          </div>
        ) : (
          <>
            {/* The top border sits on every row, first included: a gate reads the default row's
                borderTopColor. */}
            <div>
              {tierIdsOf(draft).map((tierId) => {
                const assignment = tierId === 'default' ? draft.tiers.default : draft.tiers[tierId];
                const resolved = assignment ?? draft.tiers.default;
                const builtin = TIER_IDS.some((id) => id === tierId);

                const entry = menu.models.find((model) => model.spec === resolved.model);

                // Levels come from the model's menu entry (#9).
                const efforts = offeredReasoningEfforts(
                  entry?.reasoningEfforts,
                  assignment?.reasoningEffort,
                );

                const brand = providerBrand(entry?.provider ?? '');

                return (
                  <div key={tierId} className="grid gap-x-3 gap-y-2 border-t p-border py-3 first:border-t-0 first:pt-0 md:grid-cols-[8rem_minmax(0,1fr)_9rem] md:items-center">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {brand !== undefined && <BrandMark brand={brand} size={13} bare />}
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs p-text">{tierId}</div>
                          {assignment === undefined && <div className="p-meta p-text-3">uses default</div>}
                          {tierId === 'default' && <div className="p-meta p-text-3">account default</div>}
                        </div>
                      </div>
                      {!builtin && (
                        <Button variant="ghost" size="sm"
                          icon={<TrashIcon size={12} />}
                          aria-label={`Remove tier ${tierId}`}
                          onClick={() => removeTier(tierId)} />
                      )}
                    </div>
                    <ModelPicker
                      models={menu.models}
                      failures={menu.failures}
                      value={assignment?.model ?? ''}
                      onChange={(model) => setTier(tierId, model)}
                      clearable={tierId !== 'default'}
                      placeholder={tierId === 'default' ? resolved.model : `Use default (${resolved.model})`}
                      label={`${tierId} model`}
                      size="sm"
                    />
                    <select
                      className={selectSmCls}
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
            </div>
            <Field inline label="Add a tier"
              hint="Lowercase letters, digits and hyphens. Roles refer to a tier by this name.">
              <input
                className={`${selectSmCls} w-56`}
                placeholder="e.g. review"
                value={newTierId}
                aria-label="New tier id"
                onChange={(event) => setNewTierId(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') addTier(); }}
              />
              <Button size="sm" variant="secondary" disabled={!newTierId.trim()} onClick={addTier}>Add</Button>
            </Field>
          </>
        )}
      </Card>

      {(draft && envelope && !tiersOnly) && (
        <Card title="Agent roles" icon={IdentificationCardIcon}
          description="Roles select instructions, tools, skills, a tier, and a swarm preset.">
          <div className="grid gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
            {/* A scrolling tab strip below md, the accent-tinted list row at md and up. */}
            <nav ref={roleNav} aria-label="Agent roles"
              className="p-tabstrip -mx-5 flex border-b p-border [--scroll-ground:var(--c-surface)] md:mx-0 md:flex-col md:gap-0.5 md:border-b-0 md:overflow-visible">
              {Object.keys(roles).sort().map((roleId) => {
                const current = roleId === selectedRole;
                const entry = roles[roleId];

                return (
                  <button
                    key={roleId}
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    className={`${tabCls} ${current ? 'p-tab-active' : ''} md:mb-0 md:w-full md:rounded-md md:border-b-0 md:px-3 md:py-2 ${
                      current
                        ? 'md:bg-[var(--c-accent-subtle)] md:text-[var(--c-accent-fg)]'
                        : 'md:text-[var(--c-text-2)] md:hover:bg-[var(--c-neutral-tint)] md:hover:text-[var(--c-text)]'
                    }`}
                    onClick={() => { setSelectedRole(roleId); setAddingRole(false); }}
                  >
                    <span className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{entry?.label ?? deriveRoleLabel(roleId)}</span>
                        {draft !== null && roleId in draft.roles && (
                          <span title="Customized" aria-label="Customized"
                            className="p-dot-accent inline-block size-1.5 shrink-0 rounded-full" />
                        )}
                      </span>
                      <span className="hidden truncate p-meta p-text-3 md:block">
                        {entry?.description ?? ''}
                      </span>
                    </span>
                  </button>
                );
              })}
              {addingRole ? (
                <div className="flex items-center gap-1.5 px-2.5 py-[9px] md:px-3">
                  <input
                    className={`${selectSmCls} min-w-0 flex-1`}
                    placeholder="new-role-id"
                    value={newRoleId}
                    aria-label="New role id"
                    autoFocus
                    onChange={(event) => setNewRoleId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addRole();

                      if (event.key === 'Escape') { setAddingRole(false); setNewRoleId(''); }
                    }}
                  />
                  <Button size="sm" variant="secondary" disabled={!newRoleId.trim()} onClick={addRole}>Add</Button>
                  <button type="button" aria-label="Cancel new role"
                    className="p-text-3 hover:p-text"
                    onClick={() => { setAddingRole(false); setNewRoleId(''); }}>
                    <XIcon size={12} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="p-btn-ghost flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-[13px] p-t-control md:mb-0 md:w-full md:rounded-md md:px-3 md:py-2"
                  onClick={() => setAddingRole(true)}
                >
                  <PlusIcon size={12} /> New role
                </button>
              )}
            </nav>

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
        </Card>
      )}

      {/* Docked (`sticky bottom-3`) on the settings page; in flow inside the wizard's scroll
          panel, where stickiness would float it over the providers. */}
      {(draft && envelope) && (
        <div className={tiersOnly
          ? "p-card p-surface px-4 py-3"
          : "sticky bottom-3 z-10 p-card p-surface px-4 py-3 shadow-[var(--shadow-composer)]"}>
          {error && <div className="mb-3 rounded-md px-3 py-2 text-xs p-notice-danger">{error}</div>}
          <div className="flex items-center justify-between gap-3">
            {dirty && <span className="p-meta p-warning">Unsaved changes</span>}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" disabled={!dirty || busy} onClick={() => setDraft(envelope.catalog)}>Discard</Button>
              <FilledButton disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : saveWhat}</FilledButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RoleEditor(props: {
  id: RoleId;
  role: RoleDefinition;
  /** Every tier the catalog offers, so a role can name one the owner added. */
  tiers: readonly TierId[];
  roleIds: readonly RoleId[];
  customized: boolean;
  onChange: (role: RoleDefinition) => void;
  onReset: () => void;
}) {
  const set = <Key extends keyof RoleDefinition>(key: Key, value: RoleDefinition[Key]) =>
    props.onChange({ ...props.role, [key]: value });

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <span className="p-annotation p-text-3">{props.id}</span>
        <Button size="xs" variant="secondary" disabled={!props.customized} onClick={props.onReset}>
          {props.id in BUILTIN_ROLE_DEFINITIONS ? 'Reset built-in role' : 'Delete custom role'}
        </Button>
      </div>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <Field label="Label">
          <input className={inputCls} aria-label="Label"
            value={props.role.label ?? deriveRoleLabel(props.id)}
            onChange={(event) => set('label', event.target.value)} />
        </Field>
        <Field label="Default tier" hint="The tier this role runs on.">
          <select className={inputCls} aria-label="Default tier"
            value={props.role.tier}
            onChange={(event) => {
              const tier = props.tiers.find((value) => value === event.target.value);

              if (tier) set('tier', tier);
            }}>
            {props.tiers.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" hint="One line in the role list: when an agent should use this role.">
            <input className={inputCls} aria-label="Description"
              value={props.role.description}
              onChange={(event) => set('description', event.target.value)} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Instructions" hint="The standing brief this role works under, as the prompt reads it.">
            <textarea rows={10} aria-label="Instructions"
              className={`${inputCls} p-t-code max-h-[33rem] min-h-56 resize-y overflow-y-auto`}
              value={props.role.instructions}
              onChange={(event) => set('instructions', event.target.value)} />
          </Field>
        </div>
        <Field label="Default swarm preset">
          <select className={inputCls} aria-label="Default swarm preset"
            value={props.role.preset}
            onChange={(event) => {
              const preset = NAMED_SWARM_PRESETS.find((value) => value === event.target.value);

              if (preset) set('preset', preset);
            }}>
            {NAMED_SWARM_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
          </select>
        </Field>
        <Field label="Plan mode" hint="This role opens its workspace in Plan mode.">
          <label className="flex w-fit items-center gap-2 p-row-text p-text-2">
            <input type="checkbox" aria-label="Start in Plan mode"
              className="accent-[var(--c-accent)]"
              checked={props.role.plan === true}
              onChange={(event) => set('plan', event.target.checked ? true : undefined)} />
            Start in Plan mode
          </label>
        </Field>
      </div>
      <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
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
      </div>
    </div>
  );
}

/**
 * `selected` absent means the whole list (the catalog's convention for `allowedTools` and
 * `spawns`); checking the last box restores absent. With `emptyMeansNone`, absent is empty.
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
    <div className={props.wide ? 'md:col-span-2' : 'min-w-0'}>
      <Field label={props.label} hint={props.about}>
        <div role="group" aria-label={props.label}
          className={`grid gap-x-3 gap-y-1 ${props.wide ? 'sm:grid-cols-2 md:grid-cols-3' : ''}`}>
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
                <span className="p-row-text p-text">{option.id}</span>
                {option.about && <span className="line-clamp-2 p-meta p-text-3">{option.about}</span>}
              </span>
            </label>
          ))}
          {props.options.length === 0 && <span className="p-meta p-text-3">none shipped</span>}
        </div>
      </Field>
    </div>
  );
}
