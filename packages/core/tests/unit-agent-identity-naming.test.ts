import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SOUL_MD,
  workspaceTitlePrompt,
  applyWorkspaceTitle,
  fallbackWorkspaceIdentity,
  parseWorkspaceTitle,
  planWorkspaceTitle,
  renderSoulMarkdown,
  summarizeSoul,
  workspaceSlug,
  workspaceTitleFromMission,
  type WorkspaceTitleState,
} from '../src/index.ts';

// The slug is the workspace's PERMANENT address (its URL, and the Durable
// Object name on the cloud backend); the display name is what anyone reads and
// can be regenerated or renamed at will. Both start from the SAME deterministic
// reading of the mission, so the address says what the workspace is for from its
// first millisecond, and the id suffix is what keeps it unique and stable when
// the title is later regenerated or the owner renames the workspace.
//
// The previous contract here was the inverse — "a mission cannot leak into it" —
// and that assertion is why the owner reported `sunlit-stone-4a20` four times
// over five weeks and got a title fix each time: the gate said the address was
// supposed to be meaningless, so every pass believed the address was fine.
describe('the permanent slug', () => {
  const JARVIS = 'My personal assistant, Jarvis';

  test('carries the mission words and an id suffix', () => {
    expect(workspaceSlug('You are Jarvis, my personal assistant', 'abcdef123456'))
      .toBe('jarvis-ef123456');
    expect(workspaceSlug('Build a durable benchmark runner', '7f159a00-1234-4567-89ab-cdef01234567'))
      .toBe('build-a-durable-9a001234');
    // No "you are"/"named" phrasing, so there is no persona to lift: the
    // address is the mission's own opening words, same as the provisional title.
    expect(workspaceSlug(JARVIS, 'abcdef123456')).toBe('my-personal-assistant-ef123456');
  });

  test('is whole words only — a shared address never ends mid-word', () => {
    // "Reconcile the quarterly reconciliation ledger" would cut inside
    // `reconciliation` at any pure character cap.
    const slug = workspaceSlug('Reconcile the quarterly reconciliation ledger', 'abcdef123456');
    expect(slug).toBe('reconcile-the-quarterly-ef123456');
    for (const word of slug.split('-').slice(0, -1)) {
      expect('Reconcile the quarterly reconciliation ledger'.toLowerCase().split(/[^a-z0-9]+/)).toContain(word);
    }
  });

  test('the memorable pair is reached only when the mission has no words', () => {
    expect(workspaceSlug('', 'abcdef123456')).toBe('evergreen-birch-ef123456');
    expect(workspaceSlug('日本語のみ', 'abcdef123456')).toBe('evergreen-birch-ef123456');
  });

  test('is a valid workspace name whatever the mission contains', () => {
    for (const mission of [JARVIS, '  ', '###', 'a'.repeat(400), 'Ship it!! 🚀 now/then?']) {
      const slug = workspaceSlug(mission, '7f159a00-1234-4567-89ab-cdef01234567');
      // The same guard user-do.ts applies before it becomes a DO name.
      expect(slug).toMatch(/^[a-zA-Z0-9._-]{1,64}$/);
    }
  });

  test('the suffix reads id digits the memorable words do not', () => {
    // Sharing them made the whole slug a function of the first four hex digits:
    // 65,536 addresses across a GLOBAL Durable Object namespace, where a
    // collision fails the second owner's create in claimOwner.
    const a = workspaceSlug('', 'abcd0000ffff');
    const b = workspaceSlug('', 'abcd1111eeee');
    expect(a.startsWith('evergreen-birch-')).toBe(true);
    expect(b.startsWith('evergreen-birch-')).toBe(true);
    expect(a).not.toBe(b);
  });

  // THE GATE for this whole class. Four "naming fixes" between 2026-07-13 and
  // 2026-08-16 each improved mission→title and left mission→slug alone, because
  // nothing tied them together. They are one reading now, and any future change
  // to one that does not reach the other fails right here.
  test('the address and the title are one reading of the mission', () => {
    const id = '7f159a00-1234-4567-89ab-cdef01234567';
    for (const mission of [
      'You are Jarvis, my personal assistant',
      'Build a durable benchmark runner',
      'Audit the OAuth callback flow for anything an attacker reaches',
      'Ship it!! 🚀 now/then?',
    ]) {
      const titleWords = workspaceTitleFromMission(mission)
        .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const slugWords = workspaceSlug(mission, id).split('-').slice(0, -1);
      expect(slugWords.length).toBeGreaterThan(0);
      expect(slugWords).toEqual(titleWords.slice(0, slugWords.length));
    }
  });
});

describe('the mission-derived title', () => {
  test('prefers a stated persona over copying the whole prompt', () => {
    expect(fallbackWorkspaceIdentity('You are Jarvis, my personal assistant', 'abcdef123456')).toEqual({
      name: 'jarvis-ef123456',
      displayName: 'Jarvis',
      nameOrigin: 'auto',
    });
  });

  test('falls back to the mission text, and to a memorable pair only when there is none', () => {
    const id = '7f159a00-1234-4567-89ab-cdef01234567';

    expect(fallbackWorkspaceIdentity('Build a durable benchmark runner', id).displayName)
      .toBe('Build a durable benchmark runner');
    expect(fallbackWorkspaceIdentity('', id)).toEqual({
      name: 'brisk-heron-9a001234',
      displayName: 'Brisk Heron',
      nameOrigin: 'auto',
    });
  });

  test('parses the model JSON title through one shared parser', () => {
    expect(parseWorkspaceTitle('```json\n{"title":"OAuth Flow Auditor"}\n```')).toBe('OAuth Flow Auditor');
  });

  test('invalid model naming output returns null', () => {
    expect(parseWorkspaceTitle('hello world')).toBe(null);
    expect(parseWorkspaceTitle('{"title":"   "}')).toBe(null);
  });

  test('the naming prompt asks for a JSON title, and no longer for a slug', () => {
    const prompt = workspaceTitlePrompt('Build a durable benchmark runner');

    expect(prompt).toContain('Return a concise JSON object');
    expect(prompt).toContain('title');
    expect(prompt).not.toContain('slug');
    expect(prompt).toContain('Mission:');
  });
});

// Workspaces created before mission-derived titling carry their raw slug as
// their display name. planWorkspaceTitle is the single decision behind both
// the first-turn title and that lazy heal.
describe('automatic workspace titling — the decision', () => {
  const MISSION = 'Audit the OAuth callback flow\n\nstart with the token exchange';
  const legacy: WorkspaceTitleState = {
    slug: 'workspace-1a4e20',
    displayName: 'workspace-1a4e20',
    nameOrigin: 'auto',
    mission: MISSION,
  };

  test('a workspace still showing its raw slug is titled from its mission', () => {
    expect(planWorkspaceTitle(legacy)).toEqual({
      provisional: 'Audit the OAuth callback flow',
      mission: MISSION,
    });
    expect(planWorkspaceTitle({ ...legacy, displayName: '  workspace-1a4e20  ' })?.provisional)
      .toBe('Audit the OAuth callback flow');
    expect(planWorkspaceTitle({ ...legacy, displayName: null })?.provisional)
      .toBe('Audit the OAuth callback flow');
  });

  test('a name the operator chose is never touched', () => {
    expect(planWorkspaceTitle({ ...legacy, nameOrigin: 'user' })).toBe(null);
    expect(planWorkspaceTitle({ ...legacy, displayName: 'Jarvis', nameOrigin: 'user' })).toBe(null);
    expect(planWorkspaceTitle({ ...legacy, displayName: null, nameOrigin: 'user' })).toBe(null);
  });

  test('a workspace that already carries a generated title is left alone', () => {
    expect(planWorkspaceTitle({ ...legacy, displayName: 'OAuth Callback Audit' })).toBe(null);
  });

  test('a workspace that was never titled still gets one, without clobbering its shown name first', () => {
    expect(planWorkspaceTitle({ ...legacy, displayName: 'OAuth Callback Audit', nameOrigin: null }))
      .toEqual({ provisional: null, mission: MISSION });
  });

  test('no mission to title from is a no-op', () => {
    expect(planWorkspaceTitle({ ...legacy, mission: '' })).toBe(null);
    expect(planWorkspaceTitle({ ...legacy, mission: '   \n ' })).toBe(null);
    // The generic missions seeded for workspaces created without one describe
    // Proteus, not the workspace — titling from them would be noise.
    expect(planWorkspaceTitle({ ...legacy, mission: summarizeSoul(renderSoulMarkdown({ name: 'Proteus' })) })).toBe(null);
    expect(planWorkspaceTitle({ ...legacy, mission: summarizeSoul(DEFAULT_SOUL_MD) })).toBe(null);
  });

  test('a stated persona wins over the opening sentence', () => {
    expect(planWorkspaceTitle({ ...legacy, mission: 'You are Jarvis, my personal assistant' })?.provisional)
      .toBe('Jarvis');
  });
});

describe('automatic workspace titling — applying it', () => {
  /** A backend's persistence: display name plus the 'auto' origin mark. */
  function workspace(state: Partial<WorkspaceTitleState> = {}) {
    const stored: WorkspaceTitleState = {
      slug: 'workspace-1a4e20',
      displayName: 'workspace-1a4e20',
      nameOrigin: 'auto',
      mission: 'Audit the OAuth callback flow',
      ...state,
    };
    const persisted: string[] = [];
    const persist = (title: string) => {
      persisted.push(title);
      stored.displayName = title;
      stored.nameOrigin = 'auto';
    };
    return { stored, persisted, persist };
  }

  test('heals once: deterministic title first, generated title second, later visits do nothing', async () => {
    const { stored, persisted, persist } = workspace();
    const suggest = async () => 'OAuth Callback Audit';

    expect(await applyWorkspaceTitle(stored, { persist, suggest })).toBe('OAuth Callback Audit');
    expect(persisted).toEqual(['Audit the OAuth callback flow', 'OAuth Callback Audit']);
    expect(stored).toMatchObject({ displayName: 'OAuth Callback Audit', nameOrigin: 'auto' });

    expect(await applyWorkspaceTitle(stored, { persist, suggest })).toBe(null);
    expect(persisted).toHaveLength(2);
  });

  test('the deterministic title lands before generation, so its failure cannot leave the placeholder', async () => {
    const { stored, persisted, persist } = workspace();

    // The failure reaches the caller — cf's maybeAutoTitleWorkspace and the
    // CLI's autoTitleLocalWorkspace both log it. Absorbed here, a dead review
    // model and a refused `persist` would both report "titled".
    await expect(applyWorkspaceTitle(stored, {
      persist,
      suggest: async () => { throw new Error('no model configured'); },
    })).rejects.toThrow('no model configured');
    expect(persisted).toEqual(['Audit the OAuth callback flow']);
    expect(stored).toMatchObject({ displayName: 'Audit the OAuth callback flow', nameOrigin: 'auto' });
    expect(planWorkspaceTitle(stored)).toBe(null);
  });

  test('a name the operator chose is never overwritten, and no model is called', async () => {
    const { stored, persisted, persist } = workspace({ nameOrigin: 'user' });
    let suggested = 0;

    expect(await applyWorkspaceTitle(stored, {
      persist,
      suggest: async () => { suggested += 1; return 'OAuth Callback Audit'; },
    })).toBe(null);
    expect(persisted).toEqual([]);
    expect(suggested).toBe(0);
    expect(stored.displayName).toBe('workspace-1a4e20');
  });

  test('a repeated or empty suggestion never writes twice', async () => {
    const { stored, persisted, persist } = workspace();

    await applyWorkspaceTitle(stored, { persist, suggest: async () => 'Audit the OAuth callback flow' });
    expect(persisted).toEqual(['Audit the OAuth callback flow']);

    const fresh = workspace();
    await applyWorkspaceTitle(fresh.stored, { persist: fresh.persist, suggest: async () => '  ' });
    expect(fresh.persisted).toEqual(['Audit the OAuth callback flow']);
  });

  test('without a titling model the deterministic title is still applied', async () => {
    const { stored, persisted, persist } = workspace();

    expect(await applyWorkspaceTitle(stored, { persist })).toBe('Audit the OAuth callback flow');
    expect(persisted).toEqual(['Audit the OAuth callback flow']);
  });
});
