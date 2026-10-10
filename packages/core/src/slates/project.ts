import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { renderIssues, type JsonPrimitive } from '../utils/json';

const Name = v.pipe(v.string(), v.minLength(1));

const SourcePath = v.pipe(Name, v.check((path) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..'), 'must name a file inside this Slate'));

/** `title` is the one name a person sees for a slate: its tab, its card, its shares, and what saving a page writes. */
/** A slate runs in the workspace's worker runtime; a Node server is a sandbox process with an exposed port. */
const NODE_ELSEWHERE = 'slates run in the workspace\'s worker runtime: run a Node server through the sandbox and expose its port';

const SlateMetadata = v.strictObject({
  runtime: v.optional(v.literal('worker', NODE_ELSEWHERE), 'worker'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  title: v.optional(Name),
});

const Project = v.object({
  description: v.optional(v.string()),
  main: v.optional(SourcePath),
  browser: v.optional(SourcePath),
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

  return Effect.succeed(parsed.output);
}

/** What a person sees a slate called: its `slate.title`, or its directory's name when it has none. */
export function slateTitle(project: SlateProject, id: string): string {
  return project.slate.title ?? id;
}
