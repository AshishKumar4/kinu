import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@cloudflare/kumo';
import { BrainIcon, CaretRightIcon, CheckIcon, IdentificationCardIcon, MinusIcon, PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import {
  BUILTIN_ROLE_DEFINITIONS,
  BUILTIN_SKILL_HEADERS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_SPECS,
  DECISION_MODELS,
  DEFAULT_DECISION_MODEL,
  DEFAULT_PROVIDER_RETRIES,
  NAMED_SWARM_PRESETS,
  TIER_IDS,
  betaSwarms,
  deriveRoleLabel,
  isTierId,
  tierIdsOf,
  effectiveRoleCatalog,
  isValidRoleId,
  offeredReasoningEfforts,
  parseModelSpec,
  specWithoutAccount,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
  type RoleDefinition,
  type RoleCatalog,
  type RoleId,
  type TierAssignment,
  type TierId,
} from '@kinu.run/core';
import { Effect, type Exit } from 'effect';
import { hold, showing } from '@kinu.run/core/obs';
import { getProfileCatalog, listAvailableModels, testModel, updateProfileCatalog, type ModelMenu } from '../lib/user-api';
import { AccountPicker, ModelPicker, reasoningEffortLabel, specOnAccount } from './ModelPicker';
import { Card, Choice, Field, composing, inputCls, tabCls } from './ui/form';
import { FilledButton } from './ui/FilledButton';
import { Segmented } from './ui/Segmented';

const EMPTY_MENU: ModelMenu = { models: [], failures: [] };

interface CatalogOperation {
  promise: Promise<Exit.Exit<void>> | null;
}

interface TierWords {
  readonly name: string;
  readonly use: string;
}

/** The built-in tiers as a person picks them (`profiles/model-route.ts` says what runs on each); an added tier goes by
 *  its own name. */
const TIER_WORDS: ReadonlyMap<TierId, TierWords> = new Map([
  ['default', { name: 'Main', use: 'Every chat and every new workspace' }],
  ['deep', { name: 'Deep', use: 'Planning, reviews and judging work' }],
  ['fast', { name: 'Quick', use: 'Summaries, titles, reflection and research' }],
]);

function tierWords(id: TierId): TierWords {
  return TIER_WORDS.get(id) ?? { name: id, use: 'The roles that name this tier' };
}

/** `clef-flash` reads "Clef Flash". */
function decisionModelName(spec: string): string {
  return spec.slice(spec.lastIndexOf('/') + 1).split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Overrides `inputCls` to the combobox's `size="sm"` metrics; `!` because same-property
 *  utilities resolve by order, not intent. */
const selectSmCls = `${inputCls} !h-6.5 !px-2 !py-0 !text-xs`;

export function ProfileCatalogSettings() {
  const [envelope, setEnvelope] = useState<ProfileCatalogEnvelope | null>(null);
  const [draft, setDraft] = useState<ProfileCatalog | null>(null);
  const [menu, setMenu] = useState<ModelMenu>(EMPTY_MENU);
  const [selectedRole, setSelectedRole] = useState<RoleId>('task');
  const [newRoleId, setNewRoleId] = useState('');
  const [addingRole, setAddingRole] = useState(false);
  const [newTierId, setNewTierId] = useState('');
  const [newChainModel, setNewChainModel] = useState('');
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
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const [profile, models] = yield* Effect.promise(() => Promise.all([getProfileCatalog(), listAvailableModels()]));
      setEnvelope(profile);
      setDraft(profile.catalog);
      setMenu(models);
    }), showing(setError)), Effect.sync(() => {
      if (loadOperation.current === owner) {
        loadOperation.current = null;
        setBusy(false);
      }
    })));
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
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const updated = yield* Effect.promise(() => updateProfileCatalog(draft, envelope.version));
      setEnvelope(updated);
      setDraft(updated.catalog);
    }), showing(setError)), Effect.sync(() => {
      if (saveOperation.current === owner) {
        saveOperation.current = null;
        setBusy(false);
      }
    })));
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

  const editTier = (id: TierId, edit: (tier: TierAssignment) => TierAssignment) => {
    if (!draft) return;
    const tiers = { ...draft.tiers };
    const next = edit({ ...(id === 'default' ? tiers.default : tiers[id] ?? tiers.default) });

    if (id === 'default') tiers.default = next;
    else tiers[id] = next;
    setDraft({ ...draft, tiers });
  };

  const setTierEffort = (id: TierId, effort: ReasoningEffort | '') => editTier(id, (tier) => {
    const next = { ...tier };

    if (effort) next.reasoningEffort = effort;
    else delete next.reasoningEffort;

    return next;
  });

  const setTierFallbacks = (id: TierId, fallbacks: readonly string[]) => editTier(id, (tier) => {
    const next: TierAssignment = { ...tier, fallbacks: [...fallbacks] };

    if (fallbacks.length === 0) delete next.fallbacks;

    return next;
  });

  const setDecisionModel = (decisionModel: (typeof DECISION_MODELS)[number]) => {
    if (draft) setDraft({ ...draft, decisionModel });
  };

  const setRetries = (retries: number) => {
    if (!draft || !Number.isInteger(retries) || retries < 0 || retries > 10) return;
    setDraft({ ...draft, retries });
  };

  const setModelChain = (model: string, chain: readonly string[]) => {
    if (!draft) return;
    const modelFallbacks = { ...draft.modelFallbacks };

    if (chain.length === 0) delete modelFallbacks[model];
    else modelFallbacks[model] = [...chain];
    setDraft({ ...draft, modelFallbacks });
  };

  const editChain = (model: string, chain: readonly string[]) => {
    setModelChain(model, chain);

    if (model === newChainModel) setNewChainModel('');
  };

  const chainedModels = draft === null ? [] : [...new Set([...Object.keys(draft.modelFallbacks ?? {}), ...(newChainModel ? [newChainModel] : [])])];

  const tuning = (tierId: TierId, assignment: TierAssignment) => (
    <TierTuning tierId={tierId} assignment={assignment} menu={menu}
      onEffort={(effort) => setTierEffort(tierId, effort)} onFallbacks={(fallbacks) => setTierFallbacks(tierId, fallbacks)} />
  );

  const retries = draft?.retries ?? DEFAULT_PROVIDER_RETRIES;

  return (
    <>
      <Card title="Models" icon={BrainIcon}
        description="The models your agents think with, in every workspace you own. A change applies from the next turn.">
        {!draft || !envelope ? (
          <div className="flex items-center gap-2 p-row-text p-text-3">
            <span>{busy ? 'Loading account profiles…' : 'Profiles are unavailable.'}</span>
            {!busy && <Button size="xs" variant="secondary" onClick={load}>Retry</Button>}
            {error && <span className="p-danger">{error}</span>}
          </div>
        ) : (
          <>
            <div data-tier="default" className="space-y-3">
              <Field label="Main model" hint="Every chat and every new workspace runs on it.">
                <ModelPicker
                  models={menu.models}
                  failures={menu.failures}
                  accounts={menu.accounts}
                  value={draft.tiers.default.model}
                  onChange={(model) => setTier('default', model)}
                  placeholder={draft.tiers.default.model}
                  label="default model"
                  test={testModel}
                  className="w-full sm:w-80"
                />
              </Field>
              {tuning('default', draft.tiers.default)}
            </div>

            <div className="border-t p-border pt-4" data-section="tiers">
              <div className="p-row-text font-medium p-text">For particular work</div>
              <p className="mt-0.5 p-meta p-text-3">Left unset, each uses the main model.</p>
              <div className="mt-1">
                {tierIdsOf(draft).filter((tierId) => tierId !== 'default').map((tierId) => {
                  const assignment = draft.tiers[tierId];
                  const words = tierWords(tierId);

                  return (
                    <div key={tierId} data-tier={tierId}
                      className="grid gap-x-4 gap-y-2 border-t p-border py-3 first:border-t-0 md:grid-cols-[11rem_minmax(0,1fr)]">
                      <div className="flex items-start justify-between gap-2 md:pt-0.5">
                        <div className="min-w-0">
                          <div className="p-row-text p-text">{words.name}</div>
                          <div className="p-meta p-text-3">{words.use}</div>
                        </div>
                        {!TIER_IDS.some((id) => id === tierId) && (
                          <Button variant="ghost" size="sm" icon={<TrashIcon size={12} />}
                            aria-label={`Remove tier ${tierId}`} onClick={() => removeTier(tierId)} />
                        )}
                      </div>
                      <div className="min-w-0 space-y-2">
                        <ModelPicker
                          models={menu.models}
                          failures={menu.failures}
                          accounts={menu.accounts}
                          value={assignment?.model ?? ''}
                          onChange={(model) => setTier(tierId, model)}
                          clearable
                          placeholder={`Main model · ${labelOfSpec(menu, draft.tiers.default.model)}`}
                          label={`${tierId} model`}
                          test={testModel}
                          size="sm"
                        />
                        {assignment !== undefined && tuning(tierId, assignment)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Disclosure label="Advanced" summary="Retries, backups for one model, turn rating, more tiers" section="advanced">
              <Field inline label="Retries"
                hint="How many more times the last backup is asked after a failure that may pass. Earlier models hand over at once.">
                <div className="flex items-center gap-1" role="group" aria-label="Retries">
                  <Button size="sm" variant="secondary" icon={<MinusIcon size={12} />} aria-label="Fewer retries"
                    disabled={retries === 0} onClick={() => setRetries(retries - 1)} />
                  <span className="w-8 text-center p-num p-row-text p-text" data-retries>{retries}</span>
                  <Button size="sm" variant="secondary" icon={<PlusIcon size={12} />} aria-label="More retries"
                    disabled={retries === 10} onClick={() => setRetries(retries + 1)} />
                </div>
              </Field>

              <div data-section="retry-and-fallback" className="space-y-2">
                <Field label="Backups for one model"
                  hint="When a particular model fails, these run instead of its tier's backups, whichever tier runs it." />
                {chainedModels.map((model) => (
                  <div key={model} data-model-chain={model}
                    className="grid gap-x-4 gap-y-1.5 border-t p-border py-2.5 first:border-t-0 md:grid-cols-[11rem_minmax(0,1fr)] md:items-center">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate p-row-text p-text">{labelOfSpec(menu, model)}</span>
                      <Button variant="ghost" size="sm" icon={<TrashIcon size={12} />} aria-label={`Remove the ${model} chain`}
                        onClick={() => editChain(model, [])} />
                    </div>
                    <BackupChain label={model} chain={draft.modelFallbacks?.[model] ?? []} model={model} menu={menu}
                      onChange={(chain) => editChain(model, chain)} />
                  </div>
                ))}
                <ModelPicker
                  models={menu.models.filter((entry) => !chainedModels.includes(entry.spec))}
                  failures={menu.failures}
                  value=""
                  onChange={(spec) => setNewChainModel(spec)}
                  placeholder="Choose a model to give backups…"
                  label="Add a model chain"
                  test={testModel}
                  size="sm"
                  className="w-full md:w-72"
                />
              </div>

              <div data-section="decision-model">
                <Field inline label="Turn rating"
                  hint="Rates each turn from your reply to it, so agents learn what served you. Your thumbs override it.">
                  <Segmented label="Decision model"
                    segments={DECISION_MODELS.map((model) => ({ id: model, label: decisionModelName(model) }))}
                    value={draft.decisionModel ?? DEFAULT_DECISION_MODEL}
                    onChange={setDecisionModel} />
                </Field>
              </div>

              <Field inline label="Another tier" hint="Roles can name it. Lowercase letters, digits and hyphens.">
                <input
                  className={`${selectSmCls} w-40`}
                  placeholder="e.g. review"
                  value={newTierId}
                  aria-label="New tier id"
                  onChange={(event) => setNewTierId(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !composing(event.nativeEvent)) addTier(); }}
                />
                <Button size="sm" variant="secondary" disabled={!newTierId.trim()} onClick={addTier}>Add</Button>
              </Field>
            </Disclosure>
          </>
        )}
      </Card>

      {(draft && envelope) && (
        <Card title="Agent roles" icon={IdentificationCardIcon}
          description="What each kind of agent is for: its brief, its model and what it may use.">
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
                        {roleId in draft.roles && (
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
                      if (composing(event.nativeEvent)) return;

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
                swarms={betaSwarms(draft)}
                onChange={(next) => replaceRole(selectedRole, next)}
                onReset={removeRoleOverride}
              />
            )}
          </div>
        </Card>
      )}

      {(draft && envelope) && (
        <div className="sticky bottom-3 z-10 p-card p-surface px-4 py-3 shadow-[var(--shadow-composer)]">
          {error && <div className="mb-3 rounded-md px-3 py-2 text-xs p-notice-danger">{error}</div>}
          <div className="flex items-center justify-between gap-3">
            {dirty && <span className="p-meta p-warning">Unsaved changes</span>}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" disabled={!dirty || busy} onClick={() => setDraft(envelope.catalog)}>Discard</Button>
              <FilledButton disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</FilledButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function labelOfSpec(menu: ModelMenu, spec: string): string {
  const label = menu.models.find((entry) => entry.spec === specWithoutAccount(spec))?.label ?? spec;
  const account = spec === '' ? undefined : parseModelSpec(spec).account;

  return account === undefined ? label : `${label} · ${account}`;
}

/** A section the page opens on closed: `summary` says what is inside. */
function Disclosure(props: { label: string; summary: string; section: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t p-border pt-3" data-section={props.section}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 text-left">
        <CaretRightIcon size={12} className={`shrink-0 p-fold-turn p-text-3 ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 p-row-text font-medium p-text">{props.label}</span>
        <span className="min-w-0 truncate p-meta p-text-3">{props.summary}</span>
      </button>
      {open && <div className="mt-4 space-y-5 md:pl-5">{props.children}</div>}
    </div>
  );
}

/** How hard a tier's model thinks, and what runs when it fails. */
function TierTuning(props: {
  tierId: TierId;
  assignment: TierAssignment;
  menu: ModelMenu;
  onEffort: (effort: ReasoningEffort | '') => void;
  onFallbacks: (fallbacks: readonly string[]) => void;
}) {
  const entry = props.menu.models.find((model) => model.spec === specWithoutAccount(props.assignment.model));
  const efforts = offeredReasoningEfforts(entry?.reasoningEfforts, props.assignment.reasoningEffort);

  return (
    <div className="space-y-2">
      {efforts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="w-16 shrink-0 p-meta p-text-3">Thinking</span>
          <Segmented<ReasoningEffort | 'auto'>
            label={`${props.tierId} reasoning effort`}
            segments={[{ id: 'auto', label: 'Auto' }, ...efforts.map((effort) => ({ id: effort, label: reasoningEffortLabel(effort) }))]}
            value={props.assignment.reasoningEffort ?? 'auto'}
            onChange={(effort) => props.onEffort(effort === 'auto' ? '' : effort)}
          />
        </div>
      )}
      <BackupChain label={props.tierId} chain={props.assignment.fallbacks ?? []} model={props.assignment.model}
        menu={props.menu} onChange={props.onFallbacks} />
    </div>
  );
}

function BackupChain(props: {
  label: string;
  chain: readonly string[];
  model: string;
  menu: ModelMenu;
  onChange: (fallbacks: readonly string[]) => void;
}) {
  const taken = new Set([props.model, ...props.chain]);
  const accountsOf = (spec: string) => props.menu.accounts?.[parseModelSpec(spec).provider] ?? [];

  const variants = (spec: string) => [
    spec, ...(accountsOf(spec).length > 1 ? accountsOf(spec).map((account) => specOnAccount(spec, account)) : []),
  ];

  const freeVariant = (spec: string) => variants(spec).find((variant) => !taken.has(variant));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="group" aria-label={`${props.label} fallbacks`}>
      <span className="w-16 shrink-0 p-meta p-text-3">If it fails</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {props.chain.map((spec, index) => (
          <span key={spec} data-spec={spec} className="inline-flex items-center gap-1 rounded-md border p-border px-2 py-0.5 text-xs p-text">
            <span className="p-text-3">{index + 1}.</span>
            {labelOfSpec(props.menu, spec)}
            <AccountPicker spec={spec} accounts={accountsOf(spec)} label={`${props.label} fallback ${index + 1} account`}
              onChange={(next) => props.onChange(props.chain.map((entry, at) => (at === index ? next : entry)))} />
            <button type="button" className="p-text-3 hover:p-text" aria-label={`Remove ${spec} from the ${props.label} fallbacks`}
              onClick={() => props.onChange(props.chain.filter((entry) => entry !== spec))}>
              <XIcon size={11} />
            </button>
          </span>
        ))}
        <ModelPicker
          models={props.menu.models.filter((entry) => freeVariant(entry.spec) !== undefined)}
          failures={props.menu.failures}
          value=""
          onChange={(spec) => {
            const free = spec === '' ? undefined : freeVariant(spec);

            if (free !== undefined) props.onChange([...props.chain, free]);
          }}
          placeholder={props.chain.length === 0 ? 'Add a backup model…' : 'Add another…'}
          label={`${props.label} add fallback`}
          test={testModel}
          size="sm"
          className="w-48"
        />
      </div>
    </div>
  );
}

function RoleEditor(props: {
  id: RoleId;
  role: RoleDefinition;
  /** Every tier the catalog offers, so a role can name one the owner added. */
  tiers: readonly TierId[];
  roleIds: readonly RoleId[];
  customized: boolean;
  /** "Beta: swarms"; off, no preset. */
  swarms: boolean;
  onChange: (role: RoleDefinition) => void;
  onReset: () => void;
}) {
  const set = <Key extends keyof RoleDefinition>(key: Key, value: RoleDefinition[Key]) =>
    props.onChange({ ...props.role, [key]: value });

  const builtin = props.id in BUILTIN_ROLE_DEFINITIONS;
  const origin = builtin ? 'Built in' : 'Yours';

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="p-title p-text">{props.role.label ?? deriveRoleLabel(props.id)}</h3>
          <div className="p-meta p-text-3">
            {props.customized ? 'Customized' : origin} · <span className="p-annotation">{props.id}</span>
          </div>
        </div>
        <Button size="xs" variant="secondary" disabled={!props.customized} onClick={props.onReset}>
          {builtin ? 'Reset to built-in' : 'Delete role'}
        </Button>
      </div>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputCls} aria-label="Label"
            value={props.role.label ?? deriveRoleLabel(props.id)}
            onChange={(event) => set('label', event.target.value)} />
        </Field>
        <Field label="Model">
          <Choice label="Default tier"
            value={props.role.tier}
            options={props.tiers.map((tier) => ({ value: tier, label: `${tierWords(tier).name} model` }))}
            onChange={(tier) => set('tier', tier)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="When to use it" hint="Shown in the role list, and read by an agent deciding whom to hire.">
            <input className={inputCls} aria-label="Description"
              value={props.role.description}
              onChange={(event) => set('description', event.target.value)} />
          </Field>
        </div>
      </div>
      <label className="flex w-fit items-center gap-2 p-row-text p-text-2">
        <input type="checkbox" aria-label="Start in Plan mode"
          className="accent-[var(--c-accent)]"
          checked={props.role.plan === true}
          onChange={(event) => set('plan', event.target.checked ? true : undefined)} />
        Starts in Plan mode: it designs before it changes anything
      </label>
      {props.swarms && (
        <Field inline label="Swarm preset">
          <Choice label="Default swarm preset" size="sm" className="w-40"
            value={props.role.preset}
            options={NAMED_SWARM_PRESETS.map((preset) => ({ value: preset, label: preset }))}
            onChange={(preset) => set('preset', preset)} />
        </Field>
      )}
      <Field label="Instructions" hint="The standing brief this role works under, as the prompt reads it.">
        <textarea rows={8} aria-label="Instructions"
          className={`${inputCls} p-t-code max-h-[33rem] min-h-40 resize-y overflow-y-auto`}
          value={props.role.instructions}
          onChange={(event) => set('instructions', event.target.value)} />
      </Field>
      <div>
        <div className="p-row-text font-medium p-text">What it can use</div>
        <div className="mt-1">
          <Allowance
            label="Tools"
            options={BUILTIN_TOOLS.map((name) => ({ id: name, about: BUILTIN_TOOL_SPECS[name].summary }))}
            selected={props.role.allowedTools}
            onChange={(next) => set('allowedTools', next)}
          />
          <Allowance
            label="Skills"
            options={BUILTIN_SKILL_HEADERS.map((skill) => ({ id: skill.name, about: skill.description }))}
            selected={props.role.skills ?? []}
            onChange={(next) => set('skills', next !== undefined && next.length > 0 ? next : undefined)}
            emptyMeansNone
          />
          <Allowance
            label="Can hire"
            options={props.roleIds.map((id) => ({ id, about: null }))}
            selected={props.role.spawns === '*' ? undefined : props.role.spawns}
            onChange={(next) => set('spawns', next)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One row that says what a role may use and opens to change it. `selected` absent means the whole list (the
 * catalog's convention for `allowedTools` and `spawns`); turning the last one on restores absent. With
 * `emptyMeansNone`, absent is empty.
 */
function Allowance(props: {
  label: string;
  options: ReadonlyArray<{ id: string; about: string | null }>;
  selected: readonly string[] | undefined;
  onChange(next: readonly string[] | undefined): void;
  emptyMeansNone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const all = props.options.map((option) => option.id);
  const current = props.selected ?? (props.emptyMeansNone ? [] : all);

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...new Set([...current, id])] : current.filter((member) => member !== id);
    const whole = all.every((member) => next.includes(member));

    props.onChange(!props.emptyMeansNone && whole ? undefined : next);
  };

  const some = current.length === all.length ? `All ${String(all.length)}` : `${String(current.length)} of ${String(all.length)}`;
  const count = current.length === 0 ? 'None' : some;

  return (
    <div className="border-t p-border py-2 first:border-t-0" data-allowance={props.label}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-3 text-left">
        <span className="w-20 shrink-0 p-row-text p-text">{props.label}</span>
        <span className="min-w-0 flex-1 truncate p-meta p-text-3">
          {count}{current.length > 0 && current.length < all.length ? `: ${current.join(', ')}` : ''}
        </span>
        <CaretRightIcon size={12} className={`shrink-0 p-fold-turn p-text-3 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div role="group" aria-label={props.label} className="mt-2 flex flex-wrap gap-1.5">
          {props.options.map((option) => {
            const on = current.includes(option.id);

            return (
              <button key={option.id} type="button" aria-pressed={on} title={option.about ?? undefined}
                aria-label={`${props.label}: ${option.id}`}
                onClick={() => toggle(option.id, !on)}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                  on ? 'border-[var(--c-accent)] p-accent-bg p-accent' : 'p-border p-text-3 hover:p-text'
                }`}>
                {on && <CheckIcon size={11} />}
                {option.id}
              </button>
            );
          })}
          {props.options.length === 0 && <span className="p-meta p-text-3">none shipped</span>}
        </div>
      )}
    </div>
  );
}
