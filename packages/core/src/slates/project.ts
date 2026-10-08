import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { renderIssues, type JsonPrimitive } from '../utils/json';
import { SLATE_INLINE_HEIGHT } from './host-context';

const Name = v.pipe(v.string(), v.minLength(1));

const SourcePath = v.pipe(Name, v.check((path) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..'), 'must name a file inside this Slate'));

const SlateMetadata = v.strictObject({
  runtime: v.optional(v.picklist(['worker', 'node']), 'worker'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  title: v.optional(Name),
  inline: v.optional(v.strictObject({
    height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(SLATE_INLINE_HEIGHT.min), v.maxValue(SLATE_INLINE_HEIGHT.max)), SLATE_INLINE_HEIGHT.default),
  }), () => ({ height: SLATE_INLINE_HEIGHT.default })),
});

const Project = v.object({
  name: v.optional(Name),
  description: v.optional(v.string()),
  main: v.optional(SourcePath),
  browser: v.optional(SourcePath),
  scripts: v.optional(v.object({ dev: v.optional(Name), start: v.optional(Name), build: v.optional(Name) })),
  slate: v.optional(SlateMetadata, () => ({ runtime: 'worker' })),
});

export type SlateProject = v.InferOutput<typeof Project>;

/** Pre-validation input; accepts readonly arrays from `as const` literals. */
type PackageDocument = JsonPrimitive | readonly PackageDocument[] | { readonly [key: string]: PackageDocument };

export function parseSlateProject(input: PackageDocument): SlateProject {
  return settleSync(slateProject(input));
}

export function slateProject(input: PackageDocument): Effect.Effect<SlateProject, KinuError> {
  const parsed = v.safeParse(Project, input);

  if (!parsed.success) return Effect.fail(new KinuError('bad_input', `package.json: ${renderIssues(parsed.issues)}`));
  const project = parsed.output;

  if (project.slate.runtime === 'node') {
    if (project.slate.port === undefined) return Effect.fail(new KinuError('bad_input', 'package.json slate.port must name the server port'));

    if (project.scripts?.dev === undefined && project.scripts?.start === undefined) {
      return Effect.fail(new KinuError('bad_input', 'package.json scripts.dev or scripts.start must start the server'));
    }
  }

  return Effect.succeed(project);
}
