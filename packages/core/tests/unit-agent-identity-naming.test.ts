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
  type WorkspaceTitleState,
} from '../src/index.ts';

// The slug is the workspace's PERMANENT address (its URL, and the Durable
// Object name on the cloud backend); the display name is what anyone reads and
// can be regenerated or renamed at will. So they come from different places:
// the slug from the id alone, the title from the mission.
describe('the permanent slug', () => {
  const JARVIS = 'My personal assistant, Jarvis';

  test('is a memorable pair fixed by the id alone', () => {
    expect(workspaceSlug('abcdef123456')).toBe('evergreen-birch-abcd');
    expect(workspaceSlug('7f159a00-1234-4567-89ab-cdef01234567')).toBe('brisk-heron-7f15');
  });

  test('a mission cannot leak into it, however it is worded', () => {
    for (const mission of [JARVIS, 'You are Jarvis, my personal assistant', 'Build a durable benchmark runner', '']) {
      const { name } = fallbackWorkspaceIdentity(mission, 'abcdef123456');
      expect(name).toBe(workspaceSlug('abcdef123456'));
      expect(name).not.toContain('jarvis');
      expect(name).not.toContain('personal');
      expect(name).not.toContain('benchmark');
    }
  });
});

describe('the mission-derived title', () => {
  test('prefers a stated persona over copying the whole prompt', () => {
    expect(fallbackWorkspaceIdentity('You are Jarvis, my personal assistant', 'abcdef123456')).toEqual({
      name: workspaceSlug('abcdef123456'),
      displayName: 'Jarvis',
      nameOrigin: 'auto',
    });
  });

  test('falls back to the mission text, and to a memorable pair only when there is none', () => {
    const id = '7f159a00-1234-4567-89ab-cdef01234567';

    expect(fallbackWorkspaceIdentity('Build a durable benchmark runner', id).displayName)
      .toBe('Build a durable benchmark runner');
    expect(fallbackWorkspaceIdentity('', id)).toEqual({
      name: 'brisk-heron-7f15',
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

  test('a generation failure is non-fatal: the deterministic title stands and the heal stays done', async () => {
    const { stored, persisted, persist } = workspace();

    expect(await applyWorkspaceTitle(stored, {
      persist,
      suggest: async () => { throw new Error('no model configured'); },
    })).toBe('Audit the OAuth callback flow');
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
