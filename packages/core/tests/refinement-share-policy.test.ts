import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { sha256Hex } from '../src/safety/argument-digest';
import { EffectApprovals, partCallVerdict, resolvePartCall, serverAuthority } from '../src/slates/share-policy';
import { ShareGrantSchema } from '../src/slates/sharing';
import { SlateConsentSchema } from '../src/slates/share-modes';
import { JsonValueSchema } from '../src/utils/json';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/share-policy-cases.json');

const Root = v.record(v.string(), v.string());

const Call = v.object({ server: v.string(), root: Root, tool: v.string(), contained: v.boolean() });

const EffectCall = v.object({
  workspace: v.string(), slate: v.string(), revision: v.string(), server: v.string(), tool: v.string(), root: Root, payload: JsonValueSchema,
});

const ConsentAsk = v.object({
  server: v.string(), root: Root, tools: v.array(v.string()), effects: v.boolean(), revision: v.string(),
});

const Verdict = v.variant('kind', [
  v.object({ kind: v.literal('run') }),
  v.object({ kind: v.literal('needs-consent'), ask: ConsentAsk }),
  v.object({ kind: v.literal('needs-approval') }),
]);

const Authority = v.variant('kind', [
  v.object({ kind: v.literal('owner') }),
  v.object({ kind: v.literal('none') }),
  v.object({ kind: v.literal('grant'), grant: ShareGrantSchema }),
]);

const ApprovalStep = v.variant('op', [
  v.object({
    op: v.literal('ask'), call: v.number(),
    expected: v.object({ idText: v.string(), server: v.string(), tool: v.string(), root: Root, payload: JsonValueSchema }),
  }),
  v.object({ op: v.literal('decide'), call: v.number(), approve: v.boolean(), expected: v.boolean() }),
  v.object({ op: v.literal('take'), call: v.number(), expected: v.boolean() }),
]);

const Fixture = v.object({
  fixture: v.literal('share-policy-cases'), model: v.literal('Kinu.SharingNimbus'), seed: v.string(),
  cases: v.array(v.variant('kind', [
    v.object({
      kind: v.literal('contained'), expected: v.boolean(),
      descriptor: v.object({ readOnly: v.optional(v.literal(true)), closedWorld: v.optional(v.literal(true)) }),
    }),
    v.object({
      kind: v.literal('server'), revision: v.string(), expected: Authority,
      shares: v.array(v.object({ mode: v.picklist(['own', 'owner']), grant: ShareGrantSchema, grantRevision: v.nullable(v.string()) })),
    }),
    v.object({ kind: v.literal('part'), consent: v.nullable(SlateConsentSchema), call: Call, revision: v.string(), approved: v.boolean(), expected: Verdict }),
    v.object({ kind: v.literal('approvals'), calls: v.array(EffectCall), idTexts: v.array(v.string()), steps: v.array(ApprovalStep) }),
  ])),
});

const { cases } = v.parse(Fixture, JSON.parse(readFileSync(FIXTURE, 'utf8')));

describe('share-policy refines the SharingNimbus decisions', () => {
  test('the generated corpus covers every decision and every exact-call field', () => {
    expect(cases.length).toBeGreaterThan(400);
    expect(new Set(cases.flatMap((c) => (c.kind === 'server' ? [c.expected.kind] : []))))
      .toEqual(new Set(['owner', 'none', 'grant']));
    expect(new Set(cases.flatMap((c) => (c.kind === 'part' ? [c.expected.kind] : []))))
      .toEqual(new Set(['run', 'needs-consent', 'needs-approval']));
    expect(cases.filter((c) => c.kind === 'contained').length).toBe(4);
    const books = cases.filter((c) => c.kind === 'approvals');

    expect(books.length).toBeGreaterThan(50);

    for (const book of books) {
      expect(book.calls.length).toBe(book.idTexts.length);
      // Canonical roots and nested objects agree despite insertion order. Each
      // other call differs in a bound field, array order or a delegated URL.
      expect(book.idTexts[0]).toBe(book.idTexts[1]);
      expect(new Set(book.idTexts).size).toBe(book.calls.length - 1);
      expect(book.idTexts[9]).not.toBe(book.idTexts[10]);
      expect(book.idTexts[0]).not.toBe(book.idTexts[11]);
      expect(new Set(book.steps.flatMap((s) => (s.op === 'take' ? [s.expected] : []))))
        .toEqual(new Set([true, false]));
      expect(new Set(book.steps.flatMap((s) => (s.op === 'decide' ? [s.expected] : []))))
        .toEqual(new Set([true, false]));
    }
  });

  test.each(cases.map((c, i) => [i, c] as const))('Lean case %d', (_i, c) => {
    if (c.kind === 'contained') {
      // Contained is what a call to a tool with these marks resolves to (`resolvePartCall`).
      const resolved = resolvePartCall([{ serverName: 'Refined', name: 'tool', ...c.descriptor }], { server: 'mcp.Refined', tool: 'tool', args: [{}] });

      expect(resolved.kind === 'resolved' && resolved.call.contained).toBe(c.expected);

      return;
    }

    if (c.kind === 'server') {
      expect(serverAuthority(c.shares, c.revision)).toEqual(c.expected);

      return;
    }

    if (c.kind === 'part') {
      expect(partCallVerdict(c.consent, c.call, c.revision, c.approved)).toEqual(c.expected);

      return;
    }

    const approvals = new EffectApprovals();
    // The model supplies canonical call text, not idOf's result. Hashing it
    // independently checks the deployed canonicalization as well as the book.
    const ids = c.idTexts.map((text) => sha256Hex(text, 32));

    for (const [i, call] of c.calls.entries()) expect(EffectApprovals.idOf(call)).toBe(ids[i]);

    for (const step of c.steps) {
      const call = c.calls[step.call];
      const id = ids[step.call];

      if (call === undefined || id === undefined) throw new Error(`Fixture names missing call ${step.call}`);

      if (step.op === 'ask') {
        const { idText, ...fields } = step.expected;

        expect(approvals.ask(call)).toEqual({ id: sha256Hex(idText, 32), ...fields });
      } else if (step.op === 'decide') {
        expect(approvals.decide(id, step.approve)).toBe(step.expected);
      } else {
        expect(approvals.take(call)).toBe(step.expected);
      }
    }
  });
});
