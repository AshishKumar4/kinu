import * as v from 'valibot';

const Named = v.pipe(v.string(), v.minLength(1));

const Authority = v.variant('kind', [
  v.object({ kind: v.literal('owner'), recordedOn: v.pipe(v.string(), v.isoDate()), reference: Named, requirement: Named }),
  v.object({ kind: v.literal('spec'), standard: Named, clause: Named, reference: Named }),
]);

const Requirement = v.variant('kind', [
  v.object({ kind: v.literal('copy'), value: v.string(), authority: Authority }),
  v.object({ kind: v.literal('css'), values: v.record(Named, v.union([v.string(), v.number()])), authority: Authority }),
]);

type TestRequirement = v.InferOutput<typeof Requirement>;

export const TEST_REQUIREMENTS = {
  untitledWorkspace: {
    kind: 'copy',
    value: 'Untitled workspace',
    authority: {
      kind: 'owner',
      recordedOn: '2026-09-15',
      reference: '269ff163c7df4fa1e6ed6c3e4ebcce83ad1c8f74',
      requirement: 'An unnamed workspace is labelled Untitled, never by its slug; retained by the owner-approved test audit, item 28.',
    },
  },
  wcagTextContrast: {
    kind: 'css',
    values: { normal: 4.5, large: 3, largePixels: 24, largeBoldPixels: 14 * 96 / 72, boldWeight: 700 },
    authority: {
      kind: 'spec',
      standard: 'WCAG 2.2',
      clause: '1.4.3 Contrast (Minimum)',
      reference: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
    },
  },
  wcagNonTextContrast: {
    kind: 'css',
    values: { minimum: 3 },
    authority: {
      kind: 'spec',
      standard: 'WCAG 2.2',
      clause: '1.4.11 Non-text Contrast',
      reference: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html',
    },
  },
} as const satisfies Record<string, TestRequirement>;

interface RequirementsInput {
  readonly registry: unknown;
  readonly reads: ReadonlySet<string>;
}

export function judgeRequirements({ registry, reads }: RequirementsInput) {
  const parsed = v.safeParse(v.record(Named, Requirement), registry);

  if (!parsed.success) {
    return {
      invalid: parsed.issues.map((issue) => `${issue.path?.map((part) => String(part.key)).join('.') ?? '(registry)'}: ${issue.message}`),
      unread: [], unknown: [],
    };
  }

  const names = new Set(Object.keys(parsed.output));

  return {
    invalid: [],
    unread: [...names].filter((name) => !reads.has(name)).sort(),
    unknown: [...reads].filter((name) => !names.has(name)).sort(),
  };
}
