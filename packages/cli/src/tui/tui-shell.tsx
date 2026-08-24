import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';

import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

import { AGENT_HOME, canonicalProjectRoot } from '../config';
import { agentWorkspaceKey, groupAgentWorkspaces, type ListedAgent } from '../agent-list';
import { agentDisplayLabel, clipText } from './format';
import {
  createKeybindingRegistry,
  createKeyDispatcher,
  KeybindingProvider,
  type KeybindingRegistry,
} from './actions';
import {
  createFileTuiPreferenceStore,
  type TuiPreferenceStore,
  type TuiPreferences,
} from './preferences';
import {
  BUILTIN_TUI_THEMES,
  createThemeRegistry,
  parseCustomTheme,
  TuiThemeProvider,
  useTuiTheme,
  type ThemeAppearance,
  type ThemeRegistry,
  type TerminalColorCapability,
} from './theme';

const WORKSPACE_SIDEBAR_COLUMNS = 28;
const MIN_CONVERSATION_COLUMNS = 68;
const PINNED_SIDEBAR_MIN_COLUMNS = WORKSPACE_SIDEBAR_COLUMNS + MIN_CONVERSATION_COLUMNS + 2;
const MEDIUM_LAYOUT_MIN_COLUMNS = 64;

export type TuiLayout = 'wide' | 'medium' | 'narrow';

export function tuiLayoutForWidth(width: number): TuiLayout {
  if (width >= PINNED_SIDEBAR_MIN_COLUMNS) return 'wide';
  return width >= MEDIUM_LAYOUT_MIN_COLUMNS ? 'medium' : 'narrow';
}

export type TuiAgentStatus = 'idle' | 'running' | 'needs-you' | 'failed';

/** A subordinate of one peer agent — display data under its parent's row. */
export interface TuiSubordinate {
  readonly id: string;
  readonly label: string;
  readonly status: TuiAgentStatus;
  readonly roleId?: string;
  readonly tierId?: string;
}

/** One selectable agent: a peer in a virtual workspace, or a cloud workspace. */
export interface TuiAgentSummary extends ListedAgent {
  readonly status?: TuiAgentStatus;
  readonly subordinates?: readonly TuiSubordinate[];
}

export interface TuiAgentPage {
  readonly items: readonly TuiAgentSummary[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface TuiAgentSource {
  load(cursor: string | null): TuiAgentPage | Promise<TuiAgentPage>;
}

export interface TuiAgentRoster {
  readonly page: TuiAgentPage;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): Promise<void>;
  /** Fire-and-forget by contract: a failure lands in `error` (with its whole
   *  cause chain) and the paging row stays, so paging is retryable and a failed
   *  page can never read as the end of the list. Implementations never reject. */
  loadMore(): void;
}

const EMPTY_AGENT_PAGE: TuiAgentPage = Object.freeze({ items: Object.freeze([]), total: 0, nextCursor: null });

export function agentSourceFromList(list: () => readonly ListedAgent[]): TuiAgentSource {
  return {
    load(cursor) {
      if (cursor !== null) throw new Error('The local agent list has no further page.');
      const items = list().map((agent) => Object.freeze({ ...agent }));
      return Object.freeze({ items: Object.freeze(items), total: items.length, nextCursor: null });
    },
  };
}

export function useAgentRoster(source: TuiAgentSource): TuiAgentRoster {
  const [page, setPage] = useState<TuiAgentPage>(EMPTY_AGENT_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = validateAgentPage(await sourceRef.current.load(null));
      if (request !== requestRef.current) return;
      setPage(next);
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError(renderThrownChain({ cause }));
      else {
        // A newer request owns the view; the superseded failure is background.
        diagnostics.failure(
          'tui.roster_reload_superseded',
          toKinuError({ doing: 'reloading the agent roster', cause, otherwise: 'unavailable' }),
        );
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = page.nextCursor;
    if (cursor === null || loading) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = validateAgentPage(await sourceRef.current.load(cursor));
      if (request !== requestRef.current) return;
      const byKey: Record<string, TuiAgentSummary> = {};
      for (const agent of [...page.items, ...next.items]) byKey[agentRowKey(agent)] = agent;
      setPage(Object.freeze({
        items: Object.freeze(Object.values(byKey)),
        total: next.total,
        nextCursor: next.nextCursor,
      }));
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError(renderThrownChain({ cause }));
      else {
        diagnostics.failure(
          'tui.roster_page_superseded',
          toKinuError({ doing: 'loading the next agent page', cause, otherwise: 'unavailable' }),
        );
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [loading, page]);

  useEffect(() => {
    void reload();
    return () => { requestRef.current += 1; };
  }, [reload, source]);

  return { page, loading, error, reload, loadMore };
}

export interface TuiRuntimeOptions {
  readonly preferenceStore?: TuiPreferenceStore;
  readonly themeRegistry?: ThemeRegistry;
  readonly customThemeDirectory?: string;
  readonly terminalAppearance?: ThemeAppearance;
  readonly colorCapability?: TerminalColorCapability;
}

interface TuiProductContextValue {
  readonly preferences: TuiPreferences;
  readonly keybindings: KeybindingRegistry;
  updatePreferences(update: (current: TuiPreferences) => TuiPreferences): void;
}

const TuiProductContext = createContext<TuiProductContextValue | null>(null);

export function TuiProductProvider(props: {
  readonly runtime?: TuiRuntimeOptions;
  readonly children: ReactNode;
}) {
  const [store] = useState(() => props.runtime?.preferenceStore ?? createFileTuiPreferenceStore());
  const [preferences, setPreferences] = useState(() => store.read());
  const [themeRegistry] = useState(() => props.runtime?.themeRegistry ?? loadThemeRegistry(
    props.runtime?.customThemeDirectory ?? join(AGENT_HOME, 'themes'),
  ));
  const keybindings = useMemo(() => createKeybindingRegistry({
    presetId: preferences.keymapPreset,
    overrides: preferences.keyOverrides,
  }), [preferences.keyOverrides, preferences.keymapPreset]);
  const updatePreferences = useCallback((update: (current: TuiPreferences) => TuiPreferences) => {
    setPreferences((current) => {
      const next = update(current);
      store.write(next);
      return next;
    });
  }, [store]);
  const value = useMemo<TuiProductContextValue>(() => ({
    preferences,
    keybindings,
    updatePreferences,
  }), [keybindings, preferences, updatePreferences]);
  return (
    <TuiThemeProvider
      registry={themeRegistry}
      selection={preferences.theme}
      terminalAppearance={props.runtime?.terminalAppearance}
      colorCapability={props.runtime?.colorCapability}
    >
      <KeybindingProvider registry={keybindings}>
        <TuiProductContext.Provider value={value}>{props.children}</TuiProductContext.Provider>
      </KeybindingProvider>
    </TuiThemeProvider>
  );
}

export function useTuiProduct(): TuiProductContextValue {
  const context = useContext(TuiProductContext);
  if (context === null) throw new Error('TUI product context is not available.');
  return context;
}

export interface ScrollAnchorController {
  remember(): void;
}

export function usePreservedScrollAnchor(
  scrollRef: RefObject<ScrollBoxRenderable | null>,
): ScrollAnchorController {
  useTerminalDimensions();
  const renderer = useRenderer();
  const savedScrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null && savedScrollTop.current !== null) scroll.scrollTo(savedScrollTop.current);
  }, [renderer.height, renderer.width, scrollRef]);
  return useMemo(() => ({
    remember() {
      savedScrollTop.current = scrollRef.current?.scrollTop ?? null;
    },
  }), [scrollRef]);
}

// ── Sidebar rows — the grouped projection the navigator renders ─────────────

type TuiSidebarRow =
  | {
      readonly kind: 'workspace';
      readonly key: string;
      readonly label: string;
      readonly expanded: boolean;
      readonly agentCount: number;
      readonly runningCount: number;
    }
  | { readonly kind: 'agent'; readonly key: string; readonly agent: TuiAgentSummary; readonly nested: boolean }
  | { readonly kind: 'remote'; readonly key: 'remote'; readonly expanded: boolean; readonly loaded: number }
  | { readonly kind: 'load-more'; readonly key: 'load-more'; readonly loaded: number; readonly total: number };

interface TuiSidebarExpansion {
  /** Collapsed virtual-workspace keys; groups start expanded. */
  readonly collapsedWorkspaces: readonly string[];
  /** The remote cloud section starts collapsed. */
  readonly remoteExpanded: boolean;
}

function agentRowKey(agent: Pick<ListedAgent, 'name' | 'mode'>): string {
  return `agent:${agent.mode}:${agent.name}`;
}

function workspaceRowKey(agent: ListedAgent, projectRoot: string): string {
  return agent.mode === 'cloud' ? 'remote' : `ws:${agentWorkspaceKey(agent, projectRoot)}`;
}

/**
 * Project one loaded page into navigator rows: the current project's virtual
 * workspaces first (each header followed by its peer agents when expanded),
 * then unplaced legacy agents, then the cloud section, then the explicit
 * paging row. Every row is selectable; subordinates render under their peer
 * agent's row and are not rows themselves.
 */
function buildSidebarRows(
  page: TuiAgentPage,
  projectRoot: string,
  expansion: TuiSidebarExpansion,
): TuiSidebarRow[] {
  const grouped = groupAgentWorkspaces(page.items, projectRoot);
  const rows: TuiSidebarRow[] = [];
  const pushGroup = (key: string, label: string, agents: readonly TuiAgentSummary[]) => {
    const expanded = !expansion.collapsedWorkspaces.includes(key);
    rows.push({
      kind: 'workspace',
      key,
      label,
      expanded,
      agentCount: agents.length,
      runningCount: agents.filter((agent) => agent.status === 'running').length,
    });
    if (!expanded) return;
    for (const agent of agents) rows.push({ kind: 'agent', key: agentRowKey(agent), agent, nested: true });
  };
  for (const group of grouped.workspaces) {
    pushGroup(`ws:${group.cwd}\u0000${group.workspaceId}`, group.workspaceId, group.agents);
  }
  if (grouped.unplaced.length > 0) pushGroup('ws:unplaced', 'Unplaced', grouped.unplaced);
  if (grouped.remote.length > 0) {
    rows.push({ kind: 'remote', key: 'remote', expanded: expansion.remoteExpanded, loaded: grouped.remote.length });
    if (expansion.remoteExpanded) {
      for (const agent of grouped.remote) rows.push({ kind: 'agent', key: agentRowKey(agent), agent, nested: true });
    }
  }
  if (page.nextCursor !== null) {
    rows.push({ kind: 'load-more', key: 'load-more', loaded: page.items.length, total: page.total });
  }
  return rows;
}

function rowLineCount(row: TuiSidebarRow): number {
  return row.kind === 'agent' ? 1 + (row.agent.subordinates?.length ?? 0) : 1;
}

function rowLineOffset(rows: readonly TuiSidebarRow[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += rowLineCount(rows[i]!);
  return offset;
}

interface TuiShellProps {
  readonly scene: 'onboarding' | 'home' | 'chat';
  readonly roster: TuiAgentRoster;
  /** The open agent, highlighted and kept visible; its section auto-expands. */
  readonly currentAgent?: { readonly name: string; readonly mode: ListedAgent['mode'] };
  readonly navigationOverlayOpen: boolean;
  readonly onNavigationOverlayChange: (open: boolean) => void;
  readonly navigationFocused?: boolean;
  readonly onNavigationFocusChange?: (focused: boolean) => void;
  readonly onAgentSelect?: (agent: TuiAgentSummary) => void;
  readonly children: ReactNode;
}

export function TuiShell(props: TuiShellProps) {
  useTerminalDimensions();
  const width = useRenderer().width;
  const layout = tuiLayoutForWidth(width);
  const { colors } = useTuiTheme();
  const { keybindings, preferences, updatePreferences } = useTuiProduct();
  const projectRoot = useMemo(() => canonicalProjectRoot(), []);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<readonly string[]>([]);
  const [remoteExpanded, setRemoteExpanded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const syncedCurrentAgent = useRef<string | undefined>(undefined);
  const navScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const dispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  const sidebarPinned = layout === 'wide' && preferences.wideSidebarOpen;
  const overlayOpen = layout !== 'wide' && props.navigationOverlayOpen;
  const page = props.roster.page;
  const rows = useMemo(
    () => buildSidebarRows(page, projectRoot, { collapsedWorkspaces, remoteExpanded }),
    [collapsedWorkspaces, page, projectRoot, remoteExpanded],
  );
  const selectedIndex = selectedKey === null ? -1 : rows.findIndex((row) => row.key === selectedKey);
  const lastSelectedIndex = useRef(0);
  if (selectedIndex >= 0) lastSelectedIndex.current = selectedIndex;
  // Handler-side mirrors: keypresses arrive in bursts between renders, so
  // selection reads and writes go through refs and re-render follows.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectionRef = useRef<string | null>(null);
  selectionRef.current = selectedKey;
  const applySelection = useCallback((key: string | null) => {
    selectionRef.current = key;
    setSelectedKey(key);
  }, []);
  const selectedRowNow = useCallback((): { row: TuiSidebarRow; index: number } | null => {
    const rowsNow = rowsRef.current;
    if (rowsNow.length === 0) return null;
    const found = selectionRef.current === null
      ? -1
      : rowsNow.findIndex((row) => row.key === selectionRef.current);
    const index = found >= 0 ? found : Math.min(lastSelectedIndex.current, rowsNow.length - 1);
    return { row: rowsNow[index]!, index };
  }, []);

  // First selection lands on the first openable agent, not a group header; a
  // vanished selection (collapse, reload, shrink) lands on the row that took
  // its place, never silently back at the top.
  useEffect(() => {
    if (rows.length === 0 || selectedIndex >= 0) return;
    const fallback = selectedKey === null
      ? rows.find((row) => row.kind === 'agent') ?? rows[0]!
      : rows[Math.min(lastSelectedIndex.current, rows.length - 1)]!;
    applySelection(fallback.key);
  }, [applySelection, rows, selectedIndex, selectedKey]);

  useEffect(() => {
    const current = props.currentAgent;
    if (current === undefined) return;
    const currentKey = agentRowKey(current);
    if (currentKey === syncedCurrentAgent.current) return;
    const item = page.items.find((agent) => agentRowKey(agent) === currentKey);
    if (item === undefined) return;
    syncedCurrentAgent.current = currentKey;
    const container = workspaceRowKey(item, projectRoot);
    if (container === 'remote') setRemoteExpanded(true);
    else setCollapsedWorkspaces((collapsed) => collapsed.filter((key) => key !== container));
    applySelection(currentKey);
  }, [page.items, projectRoot, props.currentAgent]);

  useLayoutEffect(() => {
    if (overlayOpen) {
      props.onNavigationFocusChange?.(true);
      return;
    }
    props.onNavigationFocusChange?.(false);
  }, [overlayOpen, props.onNavigationFocusChange]);

  // Keep the selected row visible inside whichever navigator is mounted.
  useLayoutEffect(() => {
    const scroll = navScrollRef.current;
    if (scroll === null || selectedIndex < 0) return;
    const top = rowLineOffset(rows, selectedIndex);
    const lines = rowLineCount(rows[selectedIndex]!);
    const viewport = scroll.viewport.height;
    if (top < scroll.scrollTop) scroll.scrollTo(top);
    else if (viewport > 0 && top + lines > scroll.scrollTop + viewport) scroll.scrollTo(top + lines - viewport);
  }, [rows, selectedIndex]);

  const toggleWorkspace = useCallback((key: string) => {
    setCollapsedWorkspaces((collapsed) => collapsed.includes(key)
      ? collapsed.filter((entry) => entry !== key)
      : [...collapsed, key]);
    applySelection(key);
  }, [applySelection]);

  const activateRow = useCallback((row: TuiSidebarRow) => {
    applySelection(row.key);
    switch (row.kind) {
      case 'workspace':
        toggleWorkspace(row.key);
        return;
      case 'remote':
        setRemoteExpanded((expanded) => !expanded);
        return;
      case 'agent':
        props.onAgentSelect?.(row.agent);
        return;
      case 'load-more':
        props.roster.loadMore();
        return;
    }
  }, [applySelection, props.onAgentSelect, props.roster, toggleWorkspace]);

  const moveSelection = useCallback((delta: number) => {
    const selected = selectedRowNow();
    if (selected === null) return;
    const rowsNow = rowsRef.current;
    const next = Math.max(0, Math.min(rowsNow.length - 1, selected.index + delta));
    applySelection(rowsNow[next]!.key);
  }, [applySelection, selectedRowNow]);

  /** Page by the navigator's own viewport, in rows measured through row heights. */
  const pageRows = useCallback((direction: -1 | 1) => {
    const selected = selectedRowNow();
    if (selected === null) return;
    const rowsNow = rowsRef.current;
    const viewport = navScrollRef.current?.viewport.height ?? 8;
    const start = selected.index;
    const startOffset = rowLineOffset(rowsNow, start);
    let target = start;
    while (
      target + direction >= 0
      && target + direction < rowsNow.length
      && Math.abs(rowLineOffset(rowsNow, target + direction) - startOffset) < Math.max(1, viewport - 1)
    ) {
      target += direction;
    }
    if (target === start) target = Math.max(0, Math.min(rowsNow.length - 1, start + direction));
    applySelection(rowsNow[target]?.key ?? null);
    if (direction === 1 && start === rowsNow.length - 1 && page.nextCursor !== null) props.roster.loadMore();
  }, [applySelection, page.nextCursor, props.roster, selectedRowNow]);

  useKeyboard((event) => {
    const pinnedFocused = sidebarPinned && props.navigationFocused === true;
    if (!overlayOpen && !pinnedFocused) return;
    const result = dispatcher.feed(event, ['modal']);
    if (result.pending) {
      event.preventDefault();
      return;
    }
    const selected = selectedRowNow()?.row;
    switch (result.actionId) {
      case 'modal.close':
        if (!overlayOpen) return;
        event.preventDefault();
        props.onNavigationOverlayChange(false);
        return;
      case 'modal.previous':
        event.preventDefault();
        moveSelection(-1);
        return;
      case 'modal.next':
        event.preventDefault();
        moveSelection(1);
        return;
      case 'modal.page-previous':
        event.preventDefault();
        pageRows(-1);
        return;
      case 'modal.page-next':
        event.preventDefault();
        pageRows(1);
        return;
      case 'modal.collapse': {
        if (selected === undefined) return;
        event.preventDefault();
        if (selected.kind === 'agent') applySelection(workspaceRowKey(selected.agent, projectRoot));
        else if (selected.kind === 'workspace' && selected.expanded) toggleWorkspace(selected.key);
        else if (selected.kind === 'remote' && selected.expanded) setRemoteExpanded(false);
        return;
      }
      case 'modal.expand': {
        if (selected === undefined) return;
        event.preventDefault();
        if (selected.kind === 'workspace' && !selected.expanded) toggleWorkspace(selected.key);
        else if (selected.kind === 'remote' && !selected.expanded) setRemoteExpanded(true);
        return;
      }
      case 'modal.activate': {
        if (selected === undefined) return;
        event.preventDefault();
        activateRow(selected);
        return;
      }
      default:
        return;
    }
  });

  const navigator = (
    <WorkspaceNavigator
      rows={rows}
      page={page}
      loading={props.roster.loading}
      error={props.roster.error}
      projectLabel={basename(projectRoot)}
      current={props.currentAgent}
      selectedIndex={overlayOpen || (sidebarPinned && props.navigationFocused === true) ? selectedIndex : undefined}
      onActivate={activateRow}
      scrollRef={navScrollRef}
    />
  );

  return (
    <box
      flexDirection="row"
      style={{ width: '100%', height: '100%', backgroundColor: colors.background.canvas }}
    >
      <box
        key="workspace-sidebar"
        style={{
          width: sidebarPinned ? WORKSPACE_SIDEBAR_COLUMNS : 0,
          overflow: 'hidden',
          border: sidebarPinned ? ['right'] : false,
          borderColor: colors.border.default,
        }}
      >
        {sidebarPinned ? navigator : null}
      </box>
      <box key="scene-content" style={{ flexGrow: 1, minWidth: 0, height: '100%' }}>{props.children}</box>
      {layout === 'wide' && (
        <box
          key="sidebar-toggle"
          style={{ position: 'absolute', right: 1, top: 0 }}
          onMouseDown={() => updatePreferences((current) => ({ ...current, wideSidebarOpen: !current.wideSidebarOpen }))}
        >
          <text><span fg={colors.text.muted}>{sidebarPinned ? `${keybindings.hint('workspace.toggle')} hide workspaces` : `${keybindings.hint('workspace.toggle')} workspaces`}</span></text>
        </box>
      )}
      {overlayOpen && (
        <box
          key="workspace-overlay"
          style={{
            position: 'absolute',
            zIndex: 80,
            left: 0,
            top: 0,
            width: Math.min(WORKSPACE_SIDEBAR_COLUMNS + 4, width),
            height: '100%',
            border: true,
            borderColor: colors.border.focus,
            backgroundColor: colors.background.chrome,
          }}
          title="Workspaces · Esc close"
        >
          {navigator}
        </box>
      )}
    </box>
  );
}

function WorkspaceNavigator(props: {
  readonly rows: readonly TuiSidebarRow[];
  readonly page: TuiAgentPage;
  readonly loading: boolean;
  readonly error: string | null;
  readonly projectLabel: string;
  readonly current?: { readonly name: string; readonly mode: ListedAgent['mode'] };
  readonly selectedIndex?: number;
  readonly onActivate: (row: TuiSidebarRow) => void;
  readonly scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const { colors } = useTuiTheme();
  const currentKey = props.current === undefined ? null : agentRowKey(props.current);
  return (
    <box flexDirection="column" style={{ width: '100%', height: '100%', paddingLeft: 1, paddingRight: 1, backgroundColor: colors.background.chrome }}>
      <box flexDirection="column" style={{ height: 2, flexShrink: 0 }}>
        <text><strong fg={colors.text.strong}>Workspaces</strong></text>
        <text><span fg={colors.text.muted}>{clipText(`${props.page.items.length} of ${props.page.total} · ${props.projectLabel}`, WORKSPACE_SIDEBAR_COLUMNS - 4)}</span></text>
      </box>
      {props.error !== null && <text style={{ flexShrink: 0 }}><span fg={colors.intent.danger}>{props.error}</span></text>}
      <scrollbox
        ref={(value) => { props.scrollRef.current = value; }}
        stickyScroll={false}
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: colors.background.chrome },
          viewportOptions: { backgroundColor: colors.background.chrome },
          contentOptions: { backgroundColor: colors.background.chrome },
          scrollbarOptions: {
            trackOptions: { foregroundColor: colors.border.strong, backgroundColor: colors.background.chrome },
          },
        }}
      >
        {props.rows.map((row, index) => (
          <NavigatorRow
            key={row.key}
            row={row}
            selected={index === props.selectedIndex}
            active={row.kind === 'agent' && row.key === currentKey}
            onActivate={props.onActivate}
          />
        ))}
      </scrollbox>
      {props.loading && <text style={{ flexShrink: 0 }}><span fg={colors.text.muted}>Loading…</span></text>}
      {props.page.items.length === 0 && !props.loading && props.error === null && (
        <text style={{ flexShrink: 0 }}><span fg={colors.text.muted}>Create a workspace from a mission.</span></text>
      )}
    </box>
  );
}

function NavigatorRow(props: {
  readonly row: TuiSidebarRow;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onActivate: (row: TuiSidebarRow) => void;
}) {
  const { colors } = useTuiTheme();
  const { row } = props;
  const rowBackground = props.selected || props.active ? colors.background.selectionStrong : colors.background.chrome;
  const marker = <span fg={props.selected ? colors.intent.accentStrong : colors.text.muted}>{props.selected ? '› ' : '  '}</span>;
  if (row.kind === 'workspace' || row.kind === 'remote') {
    const label = row.kind === 'remote' ? 'Cloud' : row.label;
    const count = row.kind === 'remote' ? row.loaded : row.agentCount;
    const running = row.kind === 'workspace' && row.runningCount > 0;
    return (
      <box style={{ backgroundColor: rowBackground }} onMouseDown={() => props.onActivate(row)}>
        <text>
          {marker}
          <span fg={colors.text.muted}>{row.expanded ? '▾ ' : '▸ '}</span>
          <strong fg={props.selected ? colors.text.strong : colors.text.primary}>{clipText(label, 14)}</strong>
          <span fg={colors.text.muted}> · {count}</span>
          {running && <span fg={colors.intent.accent}> ●</span>}
        </text>
      </box>
    );
  }
  if (row.kind === 'load-more') {
    return (
      <box style={{ backgroundColor: rowBackground }} onMouseDown={() => props.onActivate(row)}>
        <text>
          {marker}
          <span fg={colors.intent.accent}>Load more</span>
          <span fg={colors.text.muted}> · {row.loaded} of {row.total}</span>
        </text>
      </box>
    );
  }
  const { agent } = row;
  return (
    <box flexDirection="column">
      <box style={{ backgroundColor: rowBackground }} onMouseDown={() => props.onActivate(row)}>
        <text>
          {marker}
          <span fg={colors.text.muted}>{row.nested ? '  ' : ''}</span>
          <span fg={agent.status === 'running' ? colors.intent.accent : colors.text.muted}>{agent.status === 'running' ? '● ' : '○ '}</span>
          <span fg={props.selected || props.active ? colors.text.strong : colors.text.primary}>{clipText(agentDisplayLabel(agent.label), 16)}</span>
        </text>
      </box>
      {agent.subordinates?.map((subordinate) => (
        <text key={subordinate.id}>
          <span fg={colors.border.strong}>{row.nested ? '    └ ' : '  └ '}</span>
          <span fg={subordinate.status === 'running' ? colors.intent.success : colors.text.muted}>
            {clipText(subordinate.roleId === undefined ? agentDisplayLabel(subordinate.label) : `${agentDisplayLabel(subordinate.label)} · ${subordinate.roleId}`, 18)}
          </span>
        </text>
      ))}
    </box>
  );
}

function loadThemeRegistry(directory: string): ThemeRegistry {
  if (!existsSync(directory)) return createThemeRegistry(BUILTIN_TUI_THEMES);
  const custom = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => parseCustomTheme(readFileSync(join(directory, entry.name), 'utf8'), entry.name));
  return createThemeRegistry([...BUILTIN_TUI_THEMES, ...custom]);
}

function validateAgentPage(page: TuiAgentPage): TuiAgentPage {
  if (!Number.isInteger(page.total) || page.total < page.items.length) {
    throw new Error('Agent roster total must cover every returned row.');
  }
  const keys: Record<string, true> = {};
  for (const agent of page.items) {
    const key = agentRowKey(agent);
    if (agent.name.trim() === '' || keys[key] === true) {
      throw new Error(`Agent roster contains an invalid or duplicate entry: ${key}`);
    }
    keys[key] = true;
  }
  return Object.freeze({
    items: Object.freeze(page.items.map((agent) => agent.subordinates === undefined
      ? Object.freeze({ ...agent })
      : Object.freeze({
          ...agent,
          subordinates: Object.freeze(agent.subordinates.map((subordinate) => Object.freeze({ ...subordinate }))),
        }))),
    total: page.total,
    nextCursor: page.nextCursor,
  });
}
