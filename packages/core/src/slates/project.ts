import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { renderIssues } from '../utils/json';
import { SLATE_READ_MODELS } from './read-models';

const Name = v.pipe(v.string(), v.minLength(1));
const SourcePath = v.pipe(Name, v.check((path) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..'), 'must name a file inside this Slate'));
const Binding = v.variant('kind', [
  v.strictObject({ kind: v.literal('namespace'), namespace: Name, members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('rpc'), methods: v.pipe(v.array(v.picklist(SLATE_READ_MODELS)), v.minLength(1)) }),
  v.strictObject({ kind: v.literal('mcp'), server: Name, tools: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('slate'), id: Name }),
]);
const SlateMetadata = v.strictObject({
  runtime: v.optional(v.picklist(['worker', 'node']), 'worker'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  title: v.optional(Name),
  bindings: v.optional(v.record(Name, Binding), () => ({})),
});
const Project = v.object({
  name: v.optional(Name),
  description: v.optional(v.string()),
  main: v.optional(SourcePath),
  browser: v.optional(SourcePath),
  scripts: v.optional(v.object({ dev: v.optional(Name), start: v.optional(Name), build: v.optional(Name) })),
  slate: v.optional(SlateMetadata, () => ({ runtime: 'worker', bindings: {} })),
});

export type SlateProject = v.InferOutput<typeof Project>;
export type SlateBinding = v.InferOutput<typeof Binding>;

export function parseSlateProject<Input>(input: Input): SlateProject {
  const parsed = v.safeParse(Project, input);
  if (!parsed.success) throw new KinuError('bad_input', `package.json: ${renderIssues(parsed.issues)}`);
  const project = parsed.output;
  if (project.slate.runtime === 'worker' && project.main === undefined) {
    throw new KinuError('bad_input', 'package.json main must name the Worker module that exports a fetch handler');
  }
  if (project.slate.runtime === 'node') {
    if (project.slate.port === undefined) throw new KinuError('bad_input', 'package.json slate.port must name the server port');
    if (project.scripts?.dev === undefined && project.scripts?.start === undefined) {
      throw new KinuError('bad_input', 'package.json scripts.dev or scripts.start must start the server');
    }
  }
  return project;
}

export function slateExecutorName(project: SlateProject): 'workspace' | 'sandbox' {
  return project.slate.runtime === 'worker' ? 'workspace' : 'sandbox';
}
