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
  mintSubordinateName,
  workspaceSlug,
  type WorkspaceTitleState,
} from '../src/index';

// A permanent workspace address appears in URLs, Durable Object names, logs,
// and shared links. It is neutral; mission text stays in the editable title.
describe('the permanent slug', () => {
  test('is a memorable neutral pair with a stable id suffix', () => {
    expect(workspaceSlug('abcdef123456')).toBe('evergreen-birch-ef123456');
    expect(workspaceSlug('7f159a00-1234-4567-89ab-cdef01234567'))
      .toBe('brisk-heron-9a001234');
  });

  test('never embeds mission text', () => {
    const id = 'abcdef123456';
    const jarvis = fallbackWorkspaceIdentity('You are Jarvis, my personal assistant', id);
    const benchmark = fallbackWorkspaceIdentity('Build a durable benchmark runner', id);
    expect(jarvis.name).toBe('evergreen-birch-ef123456');
    expect(benchmark.name).toBe(jarvis.name);
    expect(jarvis.displayName).toBe('Jarvis');
    expect(benchmark.displayName).toBe('Build a durable benchmark runner');
  });

  test('is valid and unique beyond the memorable-word digits', () => {
    const a = workspaceSlug('abcd0000ffff');
    const b = workspaceSlug('abcd1111eeee');
    expect(a).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(b).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(a.startsWith('evergreen-birch-')).toBe(true);
    expect(b.startsWith('evergreen-birch-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('the mission-derived title', () => {
  test('prefers a stated persona over copying the whole prompt', () => {
    expect(fallbackWorkspaceIdentity('You are Jarvis, my personal assistant', 'abcdef123456')).toEqual({
      name: 'evergreen-birch-ef123456',
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
    // Kinu, not the workspace — titling from them would be noise.
    expect(planWorkspaceTitle({ ...legacy, mission: summarizeSoul(renderSoulMarkdown({ name: 'Kinu' })) })).toBe(null);
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

  test('a manual rename that lands during title generation rejects the stale suggestion', async () => {
    const { stored, persisted, persist } = workspace();
    let resolveSuggestion: ((value: string) => void) | undefined;
    const suggestion = new Promise<string>((resolve) => { resolveSuggestion = resolve; });
    const pending = applyWorkspaceTitle(stored, {
      persist: (title) => {
        if (stored.nameOrigin === 'user') return false;
        persist(title);
        return true;
      },
      suggest: () => suggestion,
    });
    await Promise.resolve();
    stored.displayName = 'Jarvis';
    stored.nameOrigin = 'user';
    if (resolveSuggestion === undefined) throw new Error('suggestion was never requested');
    resolveSuggestion('OAuth Callback Audit');

    expect(await pending).toBe(null);
    expect(persisted).toEqual(['Audit the OAuth callback flow']);
    expect(stored).toMatchObject({ displayName: 'Jarvis', nameOrigin: 'user' });
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

/**
 * The ONE minting rule both backends call, and the slug bound they used to
 * believe was theirs.
 *
 * Each backend inlined the same slug-and-suffix shape and then disagreed on the
 * suffix — `nanoid(6)` over 36 characters on Cloudflare, six hex digits of a UUID
 * locally — so identical roles minted names of two different collision strengths
 * depending on where the agent ran. Both also cut the slug at 48 AFTER the
 * slugifier had already cut it at 24, so the bound they wrote could never take
 * effect; the slug is module-private now for exactly that reason, and these
 * assertions read it where a caller does.
 */
describe('a minted subordinate name', () => {
  /** The slug half, with the random suffix removed. */
  const slugOf = (name: string): string => name.slice(0, name.lastIndexOf('-'));

  test('lowercases, hyphenates, trims and caps the role at 24 characters', () => {
    expect(slugOf(mintSubordinateName('Research Rust Frameworks'))).toBe('research-rust-frameworks');
    expect(slugOf(mintSubordinateName('  Build a Benchmark!!  '))).toBe('build-a-benchmark');
    // 24, not 48: the bound both call sites wrote after the slugifier was dead
    // code, and the 24 they were really getting is the 24 they keep.
    expect(slugOf(mintSubordinateName('A'.repeat(40)))).toBe('a'.repeat(24));
  });

  test('a role that slugifies to nothing is named for what it is', () => {
    // Never a bare suffix: the name is what a roster shows and what an operator
    // addresses, and `-a1b2c3` says nothing about who it is.
    expect(mintSubordinateName('!!!')).toMatch(/^subordinate-[a-z0-9]{6}$/);
    expect(mintSubordinateName('')).toMatch(/^subordinate-[a-z0-9]{6}$/);
  });

  test('satisfies the name contract spawnSubordinate enforces', () => {
    // Lowercase, URL-safe, at most 64 — the same predicate core/subordinates
    // applies, restated here because this is the only producer of these names.
    for (const role of ['Research Rust Frameworks', 'ask-auditor', 'A'.repeat(40), '!!!']) {
      expect(mintSubordinateName(role)).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    }
  });

  test('two children of one role do not collide', () => {
    const minted = new Set(Array.from({ length: 64 }, () => mintSubordinateName('auditor')));
    expect(minted.size).toBe(64);
    // One entropy source, and it is the 36-character alphabet rather than the
    // 16 of the hex suffix the local backend used to mint.
    for (const name of minted) expect(name).toMatch(/^auditor-[a-z0-9]{6}$/);
  });
});
